"""
Resource monitor HTTP API routes.

Provides endpoints for the frontend to:
- Change monitor settings (rate, enabled metrics, disk path).
- Start/stop the monitor.
- Query available GPU and disk devices.
- Toggle per-GPU metric collection.

Registered on PromptServer via aiohttp route decorators.
"""

import logging

from aiohttp import web
import server

from .collector import monitor_instance

logger = logging.getLogger("enhutils.monitor.routes")


# ── Settings Endpoint ───────────────────────────────────────────────────────

@server.PromptServer.instance.routes.patch("/enhutils/monitor")
async def update_settings(request: web.Request) -> web.Response:
    """Update monitor settings.

    JSON body (all fields optional):
        rate (float): Polling interval in seconds (0 = pause).
        switchCPU (bool): Enable/disable CPU monitoring.
        switchRAM (bool): Enable/disable RAM monitoring.
        switchDisk (bool): Enable/disable disk monitoring.
        whichDisk (str): Disk partition to monitor (mount point), or "none" to hide.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    hw = monitor_instance.hardware

    if "switchCPU" in body:
        hw.cpu_enabled = bool(body["switchCPU"])
    if "switchRAM" in body:
        hw.ram_enabled = bool(body["switchRAM"])
    if "switchDisk" in body:
        hw.disk_enabled = bool(body["switchDisk"])
    if "whichDisk" in body:
        hw.disk_path = str(body["whichDisk"])

    if "rate" in body:
        new_rate = float(body["rate"])
        old_rate = monitor_instance.rate
        monitor_instance.rate = new_rate

        if new_rate <= 0:
            monitor_instance.stop()
        elif old_rate <= 0 and new_rate > 0:
            monitor_instance.start()
        elif monitor_instance.is_running:
            # Rate changed while running; restart to pick up new interval.
            monitor_instance.start()

    return web.json_response({"status": "ok"})


# ── Start / Stop ────────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.post("/enhutils/monitor/switch")
async def switch_monitor(request: web.Request) -> web.Response:
    """Start or stop the monitor entirely.

    JSON body:
        monitor (bool): true to start, false to stop.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    if body.get("monitor", False):
        if not monitor_instance.is_running:
            monitor_instance.start()
    else:
        monitor_instance.stop()

    return web.json_response({"status": "ok"})


# ── Device Discovery ────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.get("/enhutils/monitor/disk")
async def get_disk_list(_request: web.Request) -> web.Response:
    """Return a list of disk partition mount points, plus 'none' to disable."""
    from .hardware import HardwareInfo
    partitions = HardwareInfo.get_disk_partitions()
    return web.json_response(partitions)


@server.PromptServer.instance.routes.get("/enhutils/monitor/gpu")
async def get_gpu_list(_request: web.Request) -> web.Response:
    """Return a list of monitored GPUs with their index and name."""
    gpus = monitor_instance.gpu_monitor.get_gpu_list()
    return web.json_response(gpus)


# ── Per-GPU Toggles ─────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.patch("/enhutils/monitor/gpu/{index}")
async def update_gpu_settings(request: web.Request) -> web.Response:
    """Toggle per-GPU metric collection.

    Path param:
        index (int): GPU index (within monitored GPUs, not global device index).

    JSON body (all fields optional):
        utilization (bool): Toggle GPU utilization monitoring.
        vram (bool): Toggle VRAM monitoring.
        temperature (bool): Toggle temperature monitoring.
    """
    try:
        idx = int(request.match_info["index"])
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid request"}, status=400)

    gpu = monitor_instance.gpu_monitor
    if idx < 0 or idx >= gpu.device_count:
        return web.json_response({"error": "GPU index out of range"}, status=404)

    if "utilization" in body:
        gpu.gpu_utilization_enabled[idx] = bool(body["utilization"])
    if "vram" in body:
        gpu.gpu_vram_enabled[idx] = bool(body["vram"])
    if "temperature" in body:
        gpu.gpu_temperature_enabled[idx] = bool(body["temperature"])

    return web.json_response({"status": "ok"})
