"""
Enhancement Utils - Node Execution Profiler.

Measures per-node execution time and pushes results to the frontend via
WebSocket so that timing badges can be displayed on each node. Supports
subgraph nodes by using ComfyUI's colon-delimited execution IDs.

Improvements over community profiler packages:
- Full subgraph support (colon-delimited execution IDs work natively).
- No asyncio.run() inside sync functions (avoids event-loop deadlocks).
- Handles both sync and async execution.execute via inspect.iscoroutinefunction.
- Console summary logged via standard logging, not bare print().

Based on techniques from:
- comfyui-profiler by aigc-apps
- ComfyUI-Dev-Utils by TylerYep
- ComfyUI-Easy-Use by yolain
"""

from .hooks import install_hooks  # noqa: F401 -- triggers monkey-patches on import.
