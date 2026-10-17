"""
Tests for the profiler's run-state tracking (``profiler/hooks.py``).

ComfyUI is not imported: minimal ``execution`` / ``server`` stand-ins are put
in ``sys.modules`` before loading the hooks module from its file, then a run
is simulated the way ``execution.py`` drives it (``execution_start``,
``executing`` events, ``execute`` calls returning SUCCESS / PENDING /
FAILURE, ``execution_success``, ``executing`` with ``node=None``).

Run: ``python tests/test_profiler_hooks.py`` (or with pytest).
"""

import asyncio
import enum
import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Stand-ins ──────────────────────────────────────────────────────────────

class ExecutionResult(enum.Enum):
    """Mirror of execution.ExecutionResult."""
    SUCCESS = 0
    FAILURE = 1
    PENDING = 2


class ExecutionBlocker:
    """Mirror of comfy_execution.graph.ExecutionBlocker."""
    def __init__(self, message):
        self.message = message


class InterruptProcessingException(Exception):
    """Same class name as comfy.model_management's."""


class CacheEntry:
    """Mirror of execution.CacheEntry (only ``outputs`` is read)."""
    def __init__(self, outputs):
        self.outputs = outputs


class FakePromptServer:
    """Records every send_sync call."""
    def __init__(self):
        self.client_id = "client"
        self.sent = []

    def send_sync(self, event, data, sid=None):
        self.sent.append((event, data))


class FakeDynPrompt:
    """Minimal DynamicPrompt."""
    def __init__(self, prompt):
        self.prompt = prompt

    def get_node(self, node_id):
        return self.prompt[node_id]

    def get_original_prompt(self):
        return self.prompt

    def get_display_node_id(self, node_id):
        return node_id


class FakeExecutionList:
    """Only the per-node input cache is read."""
    def __init__(self):
        self.execution_cache = {}


# Scripted results for the fake execute: node id -> list of results (popped in order).
SCRIPT = {}


async def fake_execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id,
                       execution_list, pending_subgraph_results, pending_async_nodes, *args, **kwargs):
    """Stand-in for execution.execute: returns the next scripted result."""
    return SCRIPT[current_item].pop(0)


def load_hooks():
    """Install the stand-in modules and load profiler/hooks.py from its file."""
    execution = types.ModuleType("execution")
    execution.execute = fake_execute
    execution.ExecutionBlocker = ExecutionBlocker
    server = types.ModuleType("server")
    server.PromptServer = FakePromptServer
    sys.modules["execution"] = execution
    sys.modules["server"] = server
    spec = importlib.util.spec_from_file_location("enhutils_profiler_hooks", os.path.join(ROOT, "profiler", "hooks.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, execution


# ── Test ───────────────────────────────────────────────────────────────────

def test_run_states():
    """Cached, ran, blocked, lazy re-entry, error and the run outcome."""
    hooks, execution = load_hooks()
    srv = FakePromptServer()
    prompt = {
        "1": {"class_type": "Loader", "inputs": {"name": "a.safetensors"}},
        "2": {"class_type": "Gate", "inputs": {"x": ["1", 0]}},
        "3": {"class_type": "Consumer", "inputs": {"x": ["2", 0]}},
        "4": {"class_type": "Switch", "inputs": {"a": ["1", 0], "b": ["6", 0]}},
        "5": {"class_type": "Broken", "inputs": {"x": ["4", 0]}},
        "6": {"class_type": "NeverReached", "inputs": {}},
        "7": {"class_type": "CachedOutput", "inputs": {"x": ["8", 0]}},
        "8": {"class_type": "CachedUnused", "inputs": {}},
    }
    dyn = FakeDynPrompt(prompt)
    elist = FakeExecutionList()
    extra = {"extra_pnginfo": {"workflow": {"id": "wf-123"}}}
    S = (ExecutionResult.SUCCESS, None, None)
    SCRIPT.update({
        "7": [S],
        "2": [S],
        "3": [S],
        "4": [(ExecutionResult.PENDING, None, None), S],
        "5": [(ExecutionResult.FAILURE, {}, RuntimeError("boom"))],
    })

    def run(node_id, announce=True):
        if announce:
            srv.send_sync("executing", {"node": node_id, "display_node": node_id, "prompt_id": "p1"})
        return asyncio.run(execution.execute(srv, dyn, None, node_id, extra, set(), "p1", elist, {}, {}, {}))

    srv.send_sync("execution_start", {"prompt_id": "p1"})
    srv.send_sync("execution_cached", {"nodes": ["1", "7", "8"], "prompt_id": "p1"})
    run("7", announce=False)                      # cached output node: execute called, no `executing`
    run("2")                                      # ran (produces the blocker); its cached input 1 is never executed
    elist.execution_cache["3"] = {"2": CacheEntry([[ExecutionBlocker(None)]])}
    run("3")                                      # input blocked
    run("4")                                      # lazy: PENDING ...
    run("4")                                      # ... then ran
    run("5")                                      # error
    srv.send_sync("execution_success", {"prompt_id": "p1"})
    srv.send_sync("executing", {"node": None, "prompt_id": "p1"})

    result = hooks.get_run()
    states = {k: v["state"] for k, v in result["nodes"].items()}
    assert states == {"1": "cached", "2": "ran", "3": "blocked", "4": "ran", "5": "error", "7": "cached"}, states
    assert result["nodes"]["5"]["message"] == "boom"
    assert "6" not in result["nodes"]
    assert "8" not in result["nodes"], "cached but only feeding a cached node: not used"
    assert result["status"] == "success"
    assert result["prompt_id"] == "p1"
    assert result["workflow_id"] == "wf-123"
    assert set(result["prompt"]) == set(prompt)
    assert result["prompt"]["1"]["class_type"] == "Loader"
    orders = [result["nodes"][k]["order"] for k in ("7", "1", "2", "3", "4", "5")]
    assert orders == sorted(orders), orders
    assert all(result["nodes"][k]["end"] is not None for k in states)

    events = [e for e, _ in srv.sent]
    assert "enhutils.profiler.node_state" in events
    assert "enhutils.profiler.execution_end" in events
    end = [d for e, d in srv.sent if e == "enhutils.profiler.execution_end"][-1]
    assert end["status"] == "success"


def test_error_and_interrupt_status():
    """execution_error sets the status unless it is a noisy ExecutionBlocker; interrupts are told apart."""
    hooks, execution = load_hooks()
    srv = FakePromptServer()
    dyn = FakeDynPrompt({"1": {"class_type": "A", "inputs": {}}})
    SCRIPT["1"] = [(ExecutionResult.FAILURE, {}, InterruptProcessingException())]
    srv.send_sync("execution_start", {"prompt_id": "p2"})
    srv.send_sync("executing", {"node": "1", "display_node": "1", "prompt_id": "p2"})
    asyncio.run(execution.execute(srv, dyn, None, "1", {}, set(), "p2", FakeExecutionList(), {}, {}, {}))
    srv.send_sync("execution_error", {"prompt_id": "p2", "node_id": "9", "exception_type": "ExecutionBlocked"})
    assert hooks.get_run()["status"] == "running"
    srv.send_sync("execution_interrupted", {"prompt_id": "p2"})
    srv.send_sync("executing", {"node": None, "prompt_id": "p2"})
    result = hooks.get_run()
    assert result["status"] == "interrupted"
    assert result["nodes"]["1"]["state"] == "interrupted"
    assert result["workflow_id"] == ""


def test_no_run():
    """Before any run, get_run reports status none."""
    hooks, _ = load_hooks()
    assert hooks.get_run()["status"] == "none"


if __name__ == "__main__":
    passed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"ok {name}")
    print(f"{passed} passed")
