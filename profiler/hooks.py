"""
Profiler hooks -- monkey-patches ComfyUI's execution pipeline to measure
per-node execution time, record what happened to every node of the last run,
and broadcast both via WebSocket.

Two patches are installed:

1. ``PromptServer.send_sync`` intercept -- listens for built-in ComfyUI events:
   - ``execution_start``: initializes state for a new prompt.
   - ``executing`` with a node ID: records ``time.perf_counter()`` as that
     node's start time and marks it running.
   - ``execution_success`` / ``execution_error`` / ``execution_interrupted``:
     the run's outcome.
   - ``executing`` with ``node=None``: execution finished -- emits
     ``enhutils.profiler.execution_end`` and logs the console summary.

2. ``execution.execute`` wrapper -- fires after each call to compute elapsed
   time, emit ``enhutils.profiler.executed`` and classify the node:
   - **ran**: an ``executing`` event was sent for it (the backend only sends
     one for nodes it actually runs).
   - **cached**: ``execute`` was called but no ``executing`` was ever sent --
     the output came from the cache (``execution.py`` returns early). Most
     cached nodes never reach ``execute`` at all: the execution list links
     to a cached input instead of queueing it. Those are recorded when a
     consumer starts running (``executing``) and one of its linked inputs is
     in the ``execution_cached`` set.
   - **blocked**: it ran, but an input it received was an ``ExecutionBlocker``,
     so its function was never called (the backend still sends ``executing``
     before looking at the inputs). The node that *produced* the blocker ran.
   - **error** / **interrupted**: ``execute`` returned FAILURE.
   Nodes of the prompt that never reach ``execute`` (an untaken lazy branch,
   or not needed by the queued outputs) are absent from the record; the
   frontend calls them skipped.

WebSocket events emitted:
- ``enhutils.profiler.executed``       -- per-node: {node, execution_time}
- ``enhutils.profiler.node_state``     -- per state change: {prompt_id, node, state, display, start, end, order}
- ``enhutils.profiler.execution_end``  -- total:    {prompt_id, total_time}

``execution_time`` / ``total_time`` are in milliseconds (int); ``start`` /
``end`` are seconds since the run started (float).
"""

import inspect
import logging
import threading
import time

import execution
import server

logger = logging.getLogger("enhutils.profiler")

# ── Per-Prompt State ───────────────────────────────────────────────────────

console_summary_enabled: bool = True
"""Log the per-node summary to the console when execution ends. Set by the
frontend's ``EnhUtils.Profiler.ConsoleSummary`` setting via
``PATCH /enhutils/profiler/settings``."""

_lock = threading.Lock()
"""Guards ``_state`` mutation against copies made by HTTP handlers (the
executor runs in its own thread)."""

_state: dict | None = None
"""
Mutable dict holding data for the current (or last) prompt:
    {
        "prompt_id":    str,
        "start_time":   float,              # perf_counter at execution_start
        "end_time":     float | None,       # perf_counter when execution finished
        "status":       str,                # running | success | error | interrupted | done
        "error_node":   str | None,         # node_id of the execution_error
        "workflow_id":  str,                # extra_pnginfo.workflow.id, "" if unknown
        "prompt":       dict | None,        # exec_id -> {class_type, inputs} of the queued prompt
        "node_starts":  dict[str, float],   # exec_id -> perf_counter at node start
        "node_times":   dict[str, float],   # exec_id -> elapsed seconds
        "node_classes": dict[str, str],     # exec_id -> class_type
        "exec_counts":  dict[str, int],     # exec_id -> number of `executing` events
        "cached_nodes": set[str],           # prompt nodes with a cached output (`execution_cached`)
        "run":          dict[str, dict],    # exec_id -> run record (see _make_record)
        "seq":          int,                # completion counter (record "order")
    }
Reset on each ``execution_start``.
"""


def _reset_state(prompt_id: str = "") -> None:
    """Initialize fresh profiling state for a new prompt."""
    global _state
    with _lock:
        _state = {
            "prompt_id": prompt_id,
            "start_time": time.perf_counter(),
            "end_time": None,
            "status": "running",
            "error_node": None,
            "workflow_id": "",
            "prompt": None,
            "node_starts": {},
            "node_times": {},
            "node_classes": {},
            "exec_counts": {},
            "cached_nodes": set(),
            "run": {},
            "seq": 0,
        }


def _rel(t: float) -> float:
    """Seconds since the current run started."""
    return round(t - _state["start_time"], 6) if _state is not None else 0.0


def _make_record(display) -> dict:
    """New run record for one exec id."""
    return {"state": "running", "display": display, "start": None, "end": None, "order": None}


def _emit_node_state(prompt_server, exec_id: str, rec: dict) -> None:
    """Send one node's run record to the client that queued the prompt."""
    if _state is None:
        return
    try:
        _original_send_sync(
            prompt_server,
            event="enhutils.profiler.node_state",
            data={"prompt_id": _state["prompt_id"], "node": exec_id, **rec},
            sid=getattr(prompt_server, "client_id", None),
        )
    except Exception as e:
        logger.debug(f"Failed to send node_state event: {e}")


# ── Patch 1: PromptServer.send_sync Intercept ─────────────────────────────

_original_send_sync = server.PromptServer.send_sync


def _patched_send_sync(self, event, data, sid=None):
    """Intercept built-in ComfyUI events to capture node start times, the
    run outcome, and emit the profiler summary when execution finishes."""
    if event == "execution_start":
        prompt_id = data.get("prompt_id", "") if isinstance(data, dict) else ""
        _reset_state(prompt_id)

    # Forward the original event first so ComfyUI's own handling isn't delayed.
    _original_send_sync(self, event=event, data=data, sid=sid)

    if _state is None or not isinstance(data, dict):
        return
    try:
        if event == "executing":
            node_id = data.get("node")
            if node_id is not None:
                _on_node_executing(self, str(node_id), data.get("display_node"))
            else:
                # node=None means execution finished.
                with _lock:
                    _state["end_time"] = time.perf_counter()
                    if _state["status"] == "running":
                        _state["status"] = "done"
                _emit_execution_end(self, sid)
        elif event == "execution_cached":
            nodes = data.get("nodes") or []
            with _lock:
                _state["cached_nodes"] = {str(n) for n in nodes}
        elif event == "execution_success":
            with _lock:
                _state["status"] = "success"
        elif event == "execution_error":
            # A noisy ExecutionBlocker reports an error but the run goes on.
            if data.get("exception_type") != "ExecutionBlocked":
                with _lock:
                    _state["status"] = "error"
                    node = data.get("node_id")
                    _state["error_node"] = str(node) if node is not None else None
        elif event == "execution_interrupted":
            with _lock:
                _state["status"] = "interrupted"
    except Exception as e:
        logger.debug(f"Profiler failed to handle {event}: {e}")


def _on_node_executing(prompt_server, node_id: str, display) -> None:
    """A node is about to run: record its start time and mark it running.
    A node can be announced more than once (lazy inputs, async results); the
    last start wins, matching ``node_times``."""
    now = time.perf_counter()
    with _lock:
        _state["node_starts"][node_id] = now
        _state["exec_counts"][node_id] = _state["exec_counts"].get(node_id, 0) + 1
        snapshots = _mark_cached_inputs(node_id, now)
        rec = _state["run"].get(node_id)
        if rec is None:
            rec = _state["run"][node_id] = _make_record(str(display) if display is not None else node_id)
        rec["state"] = "running"
        rec["start"] = _rel(now)
        rec["end"] = None
        snapshots.append((node_id, dict(rec)))
    for exec_id, snapshot in snapshots:
        _emit_node_state(prompt_server, exec_id, snapshot)


def _mark_cached_inputs(node_id: str, now: float) -> list:
    """A node is about to run, so it reads its inputs: every cached node
    feeding it was used from the cache. Those never reach ``execute`` (the
    execution list links to a cached input instead of queueing it), so this
    is the only place they show up. Called with ``_lock`` held.

    Returns:
        ``[(exec_id, record snapshot)]`` of newly recorded cached nodes.
    """
    out = []
    cached = _state["cached_nodes"]
    entry = (_state["prompt"] or {}).get(node_id)
    if not cached or not entry:
        return out
    for value in (entry.get("inputs") or {}).values():
        if not (isinstance(value, list) and len(value) == 2 and isinstance(value[1], int)):
            continue
        src = str(value[0])
        if src not in cached or src in _state["run"]:
            continue
        rec = _state["run"][src] = _make_record(src)
        rec["state"] = "cached"
        rec["start"] = rec["end"] = _rel(now)
        rec["order"] = _state["seq"]
        _state["seq"] += 1
        out.append((src, dict(rec)))
    return out


def _emit_execution_end(prompt_server, sid) -> None:
    """Compute total execution time, log the summary, and emit the end event."""
    if _state is None:
        return

    total_time_s = time.perf_counter() - _state["start_time"]
    total_time_ms = int(total_time_s * 1000)

    # ── Console Summary ────────────────────────────────────────────
    if console_summary_enabled and _state["node_times"]:
        lines = []
        for exec_id, elapsed in list(_state["node_times"].items()):
            class_type = _state["node_classes"].get(exec_id, "?")
            lines.append(f"  #{exec_id} [{class_type}]: {elapsed:.4f}s")
        lines.append(f"  Total: {total_time_s:.4f}s")
        logger.info("Execution profile:\n" + "\n".join(lines))

    # ── WebSocket Event ────────────────────────────────────────────
    try:
        _original_send_sync(
            prompt_server,
            event="enhutils.profiler.execution_end",
            data={
                "prompt_id": _state["prompt_id"],
                "total_time": total_time_ms,
                "status": _state["status"],
            },
            sid=sid,
        )
    except Exception as e:
        logger.debug(f"Failed to send execution_end event: {e}")


server.PromptServer.send_sync = _patched_send_sync
logger.debug("Patched PromptServer.send_sync for profiling.")


# ── Patch 2: execution.execute Wrapper ─────────────────────────────────────

def _capture_prompt(dynprompt, extra_data) -> None:
    """Remember the queued prompt (once per run): its node ids, classes and
    inputs, plus the workflow id, so the frontend can tell skipped nodes and
    nodes changed since the run."""
    if _state is None or _state["prompt"] is not None:
        return
    prompt = {}
    try:
        original = dynprompt.get_original_prompt()
        for node_id, node in original.items():
            if not isinstance(node, dict):
                continue
            prompt[str(node_id)] = {
                "class_type": node.get("class_type", ""),
                "inputs": node.get("inputs", {}),
            }
    except Exception as e:
        logger.debug(f"Profiler could not read the prompt: {e}")
    workflow_id = ""
    try:
        workflow = (extra_data or {}).get("extra_pnginfo", {}).get("workflow", {})
        if isinstance(workflow, dict) and workflow.get("id") is not None:
            workflow_id = str(workflow.get("id"))
    except Exception:
        pass
    with _lock:
        _state["prompt"] = prompt
        _state["workflow_id"] = workflow_id


def _result_kind(result) -> str:
    """``"SUCCESS"`` / ``"FAILURE"`` / ``"PENDING"`` from execute's return value."""
    try:
        first = result[0] if isinstance(result, tuple) and result else result
        return str(getattr(first, "name", first)).upper()
    except Exception:
        return ""


def _is_interrupt(result) -> bool:
    """Whether a FAILURE result was a user interrupt."""
    try:
        ex = result[2]
        return type(ex).__name__ == "InterruptProcessingException"
    except Exception:
        return False


def _error_message(result) -> str:
    """First line of a FAILURE result's exception message (for tooltips)."""
    try:
        details = result[1] or {}
        text = details.get("exception_message") if isinstance(details, dict) else None
        if not text:
            text = str(result[2] or "")
        text = str(text).strip().splitlines()[0] if str(text).strip() else ""
        return text[:300]
    except Exception:
        return ""


def _inputs_blocked(unique_id: str, dynprompt, execution_list) -> bool:
    """Whether any linked input of a node carried an ``ExecutionBlocker``
    (then the backend never called the node's function). Reads the
    execution list's per-node input cache, which is still populated until
    the node is marked complete (after ``execute`` returns)."""
    blocker = getattr(execution, "ExecutionBlocker", None)
    if blocker is None:
        return False
    try:
        inputs = dynprompt.get_node(unique_id).get("inputs", {})
        cache = getattr(execution_list, "execution_cache", {}).get(unique_id) or {}
    except Exception:
        return False
    for value in inputs.values():
        if not (isinstance(value, list) and len(value) == 2 and isinstance(value[1], int)):
            continue
        entry = cache.get(value[0])
        if entry is None:
            continue
        outputs = getattr(entry, "outputs", entry)
        try:
            values = outputs[value[1]]
        except Exception:
            continue
        if isinstance(values, blocker):
            return True
        if isinstance(values, (list, tuple)) and any(isinstance(v, blocker) for v in values):
            return True
    return False


def _record_result(unique_id: str, dynprompt, execution_list, result, prompt_server) -> None:
    """Classify a node after one ``execute`` call and emit its new state.
    A node with no ``executing`` event in this run came from the cache."""
    if _state is None:
        return
    kind = _result_kind(result)
    if kind == "PENDING":
        return  # comes back later (lazy inputs, async, node expansion)
    blocked = kind == "SUCCESS" and _inputs_blocked(unique_id, dynprompt, execution_list)
    now = time.perf_counter()
    with _lock:
        rec = _state["run"].get(unique_id)
        ran = _state["exec_counts"].get(unique_id, 0) > 0
        if rec is None:
            display = unique_id
            try:
                display = str(dynprompt.get_display_node_id(unique_id))
            except Exception:
                pass
            rec = _state["run"][unique_id] = _make_record(display)
            rec["start"] = _rel(now)
        if kind == "FAILURE":
            rec["state"] = "interrupted" if _is_interrupt(result) else "error"
            message = _error_message(result)
            if message:
                rec["message"] = message
        elif not ran:
            rec["state"] = "blocked" if blocked else "cached"
        else:
            rec["state"] = "blocked" if blocked else "ran"
        rec["end"] = _rel(now)
        rec["order"] = _state["seq"]
        _state["seq"] += 1
        snapshot = dict(rec)
    _emit_node_state(prompt_server, unique_id, snapshot)


def _handle_node_executed(unique_id: str, class_type: str, prompt_server) -> None:
    """Called after each ``execute`` call. Computes elapsed time and emits
    the ``enhutils.profiler.executed`` event (nodes that ran only)."""
    if _state is None:
        return

    start = _state["node_starts"].get(unique_id)
    if start is None:
        return

    elapsed = time.perf_counter() - start
    with _lock:
        _state["node_times"][unique_id] = elapsed
        _state["node_classes"][unique_id] = class_type

    try:
        _original_send_sync(
            prompt_server,
            event="enhutils.profiler.executed",
            data={
                "node": unique_id,
                "execution_time": int(elapsed * 1000),
            },
            sid=prompt_server.client_id,
        )
    except Exception as e:
        logger.debug(f"Failed to send profiler.executed event: {e}")


def _before_execute(dynprompt, extra_data) -> None:
    """Pre-call bookkeeping: capture the prompt on the run's first call."""
    if _state is None:
        return
    try:
        _capture_prompt(dynprompt, extra_data)
    except Exception as e:
        logger.debug(f"Profiler prompt capture failed: {e}")


def _after_execute(server_obj, dynprompt, execution_list, unique_id: str, class_type: str, result) -> None:
    """Post-call bookkeeping: timing event and run-state classification."""
    _handle_node_executed(unique_id, class_type, server_obj)
    try:
        _record_result(unique_id, dynprompt, execution_list, result, server_obj)
    except Exception as e:
        logger.debug(f"Profiler failed to classify node {unique_id}: {e}")


try:
    _original_execute = execution.execute

    if inspect.iscoroutinefunction(_original_execute):
        async def _patched_execute(
            server, dynprompt, caches, current_item, extra_data,
            executed, prompt_id, execution_list, pending_subgraph_results,
            pending_async_nodes, *args, **kwargs
        ):
            """Async wrapper around execution.execute."""
            unique_id = current_item
            class_type = ""
            try:
                class_type = dynprompt.get_node(unique_id)["class_type"]
            except Exception:
                pass
            _before_execute(dynprompt, extra_data)

            result = await _original_execute(
                server, dynprompt, caches, current_item, extra_data,
                executed, prompt_id, execution_list, pending_subgraph_results,
                pending_async_nodes, *args, **kwargs
            )
            _after_execute(server, dynprompt, execution_list, unique_id, class_type, result)
            return result
    else:
        def _patched_execute(
            server, dynprompt, caches, current_item, extra_data,
            executed, prompt_id, execution_list, pending_subgraph_results,
            *args, **kwargs
        ):
            """Sync wrapper around execution.execute."""
            unique_id = current_item
            class_type = ""
            try:
                class_type = dynprompt.get_node(unique_id)["class_type"]
            except Exception:
                pass
            _before_execute(dynprompt, extra_data)

            result = _original_execute(
                server, dynprompt, caches, current_item, extra_data,
                executed, prompt_id, execution_list, pending_subgraph_results,
                *args, **kwargs
            )
            _after_execute(server, dynprompt, execution_list, unique_id, class_type, result)
            return result

    execution.execute = _patched_execute
    logger.debug("Patched execution.execute for profiling.")

except Exception as e:
    logger.warning(f"Could not patch execution.execute: {e}")


# ── Public API ─────────────────────────────────────────────────────────────

def install_hooks() -> None:
    """No-op function. Importing this module is sufficient to install hooks.

    This exists so that ``profiler/__init__.py`` has an explicit import target,
    making it clear that the import has side effects.
    """


def get_elapsed() -> float:
    """Return seconds elapsed since the current execution started.

    Returns 0.0 if no execution is in progress or has completed.
    """
    if _state is None:
        return 0.0
    return time.perf_counter() - _state["start_time"]


def get_node_time(exec_id: str) -> float:
    """Return the execution time in seconds for a specific node.

    Args:
        exec_id: The colon-delimited execution ID (e.g. ``"5:42"``).

    Returns:
        Elapsed seconds, or 0.0 if the node hasn't been profiled.
    """
    if _state is None:
        return 0.0
    return _state["node_times"].get(exec_id, 0.0)


def get_all_times() -> dict:
    """Return a copy of all per-node timing data.

    Returns:
        Dict with keys ``"node_times"`` (exec_id -> seconds),
        ``"node_classes"`` (exec_id -> class_type), and
        ``"prompt_id"`` (str).  Empty dicts if no execution has run.
    """
    if _state is None:
        return {"node_times": {}, "node_classes": {}, "prompt_id": ""}
    with _lock:
        return {
            "node_times": dict(_state["node_times"]),
            "node_classes": dict(_state["node_classes"]),
            "prompt_id": _state["prompt_id"],
        }


def get_run() -> dict:
    """Return what happened to every node of the current / last run.

    Returns:
        Dict with ``prompt_id``, ``workflow_id``, ``status`` (``"none"``
        when nothing has run, else running | success | error | interrupted |
        done), ``error_node``, ``total`` (seconds), ``nodes`` (exec_id ->
        {state, display, start, end, order, time}; ``state`` is one of
        running | ran | cached | blocked | error | interrupted) and
        ``prompt`` (exec_id -> {class_type, inputs} of the queued prompt).
    """
    if _state is None:
        return {"prompt_id": "", "workflow_id": "", "status": "none", "error_node": None,
                "total": 0.0, "nodes": {}, "prompt": {}}
    with _lock:
        end = _state["end_time"] if _state["end_time"] is not None else time.perf_counter()
        nodes = {}
        for exec_id, rec in _state["run"].items():
            item = dict(rec)
            item["time"] = round(_state["node_times"].get(exec_id, 0.0), 6)
            nodes[exec_id] = item
        return {
            "prompt_id": _state["prompt_id"],
            "workflow_id": _state["workflow_id"],
            "status": _state["status"],
            "error_node": _state["error_node"],
            "total": round(end - _state["start_time"], 6),
            "nodes": nodes,
            "prompt": dict(_state["prompt"] or {}),
        }
