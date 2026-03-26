"""
Profiler hooks -- monkey-patches ComfyUI's execution pipeline to measure
per-node execution time and broadcast results via WebSocket.

Two patches are installed:

1. ``PromptServer.send_sync`` intercept -- listens for built-in ComfyUI events:
   - ``execution_start``: initializes timing state for a new prompt.
   - ``executing`` with a node ID: records ``time.perf_counter()`` as that
     node's start time.
   - ``executing`` with ``node=None``: execution finished -- emits
     ``enhutils.profiler.execution_end`` and logs the console summary.

2. ``execution.execute`` wrapper -- fires after each node finishes to compute
   elapsed time and emit ``enhutils.profiler.executed``.

WebSocket events emitted:
- ``enhutils.profiler.executed``       -- per-node: {node, execution_time}
- ``enhutils.profiler.execution_end``  -- total:    {prompt_id, total_time}

All times are in milliseconds (int).
"""

import inspect
import logging
import time

import execution
import server

logger = logging.getLogger("enhutils.profiler")

# ── Per-Prompt State ───────────────────────────────────────────────────────

_state: dict | None = None
"""
Mutable dict holding timing data for the currently executing prompt:
    {
        "prompt_id":    str,
        "start_time":   float,              # perf_counter at execution_start
        "node_starts":  dict[str, float],    # exec_id -> perf_counter at node start
        "node_times":   dict[str, float],    # exec_id -> elapsed seconds
        "node_classes": dict[str, str],      # exec_id -> class_type
    }
Reset on each ``execution_start``.
"""


def _reset_state(prompt_id: str = "") -> None:
    """Initialize fresh profiling state for a new prompt."""
    global _state
    _state = {
        "prompt_id": prompt_id,
        "start_time": time.perf_counter(),
        "node_starts": {},
        "node_times": {},
        "node_classes": {},
    }


# ── Patch 1: PromptServer.send_sync Intercept ─────────────────────────────

_original_send_sync = server.PromptServer.send_sync


def _patched_send_sync(self, event, data, sid=None):
    """Intercept built-in ComfyUI events to capture node start times and
    emit profiler summary when execution finishes."""
    global _state

    if event == "execution_start":
        prompt_id = data.get("prompt_id", "") if isinstance(data, dict) else ""
        _reset_state(prompt_id)

    # Forward the original event first so ComfyUI's own handling isn't delayed.
    _original_send_sync(self, event=event, data=data, sid=sid)

    if event == "executing" and isinstance(data, dict) and _state is not None:
        node_id = data.get("node")
        if node_id is not None:
            # A node is about to execute -- record its start time.
            _state["node_starts"][node_id] = time.perf_counter()
        else:
            # node=None means execution finished.
            _emit_execution_end(self, sid)


def _emit_execution_end(prompt_server, sid) -> None:
    """Compute total execution time, log the summary, and emit the end event."""
    if _state is None:
        return

    total_time_s = time.perf_counter() - _state["start_time"]
    total_time_ms = int(total_time_s * 1000)

    # ── Console Summary ────────────────────────────────────────────
    if _state["node_times"]:
        lines = []
        for exec_id, elapsed in _state["node_times"].items():
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
            },
            sid=sid,
        )
    except Exception as e:
        logger.debug(f"Failed to send execution_end event: {e}")


server.PromptServer.send_sync = _patched_send_sync
logger.debug("Patched PromptServer.send_sync for profiling.")


# ── Patch 2: execution.execute Wrapper ─────────────────────────────────────

def _handle_node_executed(unique_id: str, class_type: str, prompt_server) -> None:
    """Called after a node finishes executing. Computes elapsed time and
    emits the ``enhutils.profiler.executed`` event."""
    if _state is None:
        return

    start = _state["node_starts"].get(unique_id)
    if start is None:
        return

    elapsed = time.perf_counter() - start
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

            result = await _original_execute(
                server, dynprompt, caches, current_item, extra_data,
                executed, prompt_id, execution_list, pending_subgraph_results,
                pending_async_nodes, *args, **kwargs
            )
            _handle_node_executed(unique_id, class_type, server)
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

            result = _original_execute(
                server, dynprompt, caches, current_item, extra_data,
                executed, prompt_id, execution_list, pending_subgraph_results,
                *args, **kwargs
            )
            _handle_node_executed(unique_id, class_type, server)
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
