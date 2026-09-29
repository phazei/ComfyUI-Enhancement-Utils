"""
Profiler HTTP API routes.

Provides endpoints for the frontend to:
- Retrieve profiling results on page load or refresh, so that timing badges
  can be restored without re-running the workflow.
- Update profiler settings (console summary on/off).

Registered on PromptServer via aiohttp route decorators.
"""

import logging

from aiohttp import web
import server

from . import hooks
from .hooks import get_all_times, get_elapsed

logger = logging.getLogger("enhutils.profiler.routes")


@server.PromptServer.instance.routes.get("/enhutils/profiler/results")
async def get_profiler_results(_request: web.Request) -> web.Response:
    """Return the most recent profiling data.

    Response JSON:
        node_times (dict):   exec_id -> elapsed seconds (float).
        node_classes (dict): exec_id -> class_type string.
        prompt_id (str):     The prompt ID of the profiled execution.
        total_elapsed (float): Total seconds since execution started.
    """
    data = get_all_times()
    data["total_elapsed"] = get_elapsed()
    return web.json_response(data)


@server.PromptServer.instance.routes.patch("/enhutils/profiler/settings")
async def update_profiler_settings(request: web.Request) -> web.Response:
    """Update profiler settings.

    JSON body (all fields optional):
        console_summary (bool): Log the per-node summary to the console
            when execution ends.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    if "console_summary" in body:
        hooks.console_summary_enabled = bool(body["console_summary"])

    return web.json_response({"status": "ok"})
