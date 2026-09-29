"""
Resource monitor collector.

Runs a background daemon thread that periodically collects system stats and
pushes them to all connected WebSocket clients via PromptServer.send_sync.

Also maintains an in-memory history of all collected data points so that
frontends can pre-fill their graphs on page load (survives browser refresh
but not ComfyUI restart).

Improvements over Crystools:
- Uses asyncio.new_event_loop() per thread instead of asyncio.run() to avoid
  deadlocks (see Crystools PR #14).
- Proper thread lifecycle management with threading.Event for clean shutdown.
- No module-level auto-start that could crash during import; the singleton
  is created but starts only when the rate is > 0.
"""

import asyncio
import logging
import threading
import time

from .gpu import GPUMonitor
from .hardware import HardwareInfo

logger = logging.getLogger("enhutils.monitor.collector")


class MonitorCollector:
    """Background stats collector that pushes data via WebSocket.

    Attributes:
        rate: Polling interval in seconds. Set to 0 to pause.
        hardware: HardwareInfo instance for stat collection.
        gpu_monitor: GPUMonitor instance for GPU-specific stats.
        history: Dict mapping metric keys to lists of {t, v} entries.
        total_watt_seconds: Accumulated GPU power consumption (all GPUs combined).
    """

    def __init__(self, default_rate: float = 1.0):
        self.gpu_monitor = GPUMonitor()
        self.hardware = HardwareInfo(self.gpu_monitor)
        self.rate = default_rate

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

        # ── History Storage ─────────────────────────────────────────
        # Keys: "cpu", "ram", "disk", "diskio", "gpu_0", "vram_0", "temp_0", "power_0", etc.
        # Values: list of {"t": float (epoch seconds), "v": float (metric value)}
        # Appended from the daemon thread, read from HTTP handler threads.
        # Python's GIL makes list.append() and list copy thread-safe.
        self.history: dict[str, list[dict]] = {}

        # Accumulated watt-seconds across all GPUs for electricity cost tracking.
        # Reset on clear_history(). Accumulated in the poll loop.
        self.total_watt_seconds: float = 0.0

        if self.rate > 0:
            self.start()

    # ── Thread Lifecycle ────────────────────────────────────────────

    def start(self):
        """Start or restart the monitor polling thread."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                self.stop()

            if self.rate <= 0:
                logger.debug("Monitor rate is 0; not starting.")
                return

            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run_loop,
                name="EnhUtils-Monitor",
                daemon=True,
            )
            self._thread.start()
            logger.info(f"Monitor started (rate={self.rate}s).")

    def stop(self):
        """Signal the monitor thread to stop and wait for it."""
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=5)
        self._thread = None
        logger.debug("Monitor stopped.")

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ── History Management ──────────────────────────────────────────

    def _append_history(self, key: str, timestamp: float, value: float):
        """Append a data point to a metric's history list.

        Creates the list if it doesn't exist yet. Called from the daemon
        thread only, so no lock is needed for the append itself.
        """
        if key not in self.history:
            self.history[key] = []
        self.history[key].append({"t": timestamp, "v": value})

    def get_history(self, duration: float = 0) -> dict:
        """Return history data, optionally filtered to a time window.

        Args:
            duration: If > 0, only return entries from the last `duration`
                seconds. If 0, return all entries.

        Returns:
            Dict with "metrics" (dict of key -> list of {t, v}) and
            "total_watt_seconds" (float).
        """
        if duration <= 0:
            # Return everything (snapshot via dict comprehension for safety).
            metrics = {k: list(v) for k, v in self.history.items()}
        else:
            cutoff = time.time() - duration
            metrics = {}
            for k, entries in self.history.items():
                # Entries are chronological; binary search would be faster
                # but a simple filter is fine for the expected data sizes.
                metrics[k] = [e for e in entries if e["t"] >= cutoff]

        return {
            "metrics": metrics,
            "total_watt_seconds": self.total_watt_seconds,
        }

    def clear_history(self):
        """Clear all history data and reset the cost accumulator."""
        self.history.clear()
        self.total_watt_seconds = 0.0
        logger.info("Monitor history cleared.")

    # ── Polling Loop ────────────────────────────────────────────────

    def _run_loop(self):
        """Entry point for the daemon thread.

        Creates a dedicated asyncio event loop for this thread to avoid
        conflicts with the main server loop (fixes deadlock issue from
        Crystools PR #14).
        """
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._poll_loop())
        except Exception as e:
            logger.error(f"Monitor loop crashed: {e}")
        finally:
            loop.close()

    async def _poll_loop(self):
        """Async polling loop that collects, stores, and broadcasts stats."""
        while not self._stop_event.is_set():
            try:
                data = self.hardware.get_stats().to_dict()
                now = time.time()

                # ── Store history ───────────────────────────────────
                if data.get("cpu_utilization", -1) >= 0:
                    self._append_history("cpu", now, data["cpu_utilization"])

                if data.get("ram_used_percent", -1) >= 0:
                    self._append_history("ram", now, data["ram_used_percent"])

                if data.get("disk_path") and data["disk_path"] != "none":
                    if data.get("disk_used_percent", -1) >= 0:
                        self._append_history("disk", now, data["disk_used_percent"])

                if data.get("disk_io_percent", -1) >= 0:
                    self._append_history("diskio", now, data["disk_io_percent"])

                for i, gpu in enumerate(data.get("gpus", [])):
                    if gpu.get("gpu_utilization", -1) >= 0:
                        self._append_history(f"gpu_{i}", now, gpu["gpu_utilization"])
                    if gpu.get("vram_used_percent", -1) >= 0:
                        self._append_history(f"vram_{i}", now, gpu["vram_used_percent"])
                    if gpu.get("gpu_temperature", -1) >= 0:
                        self._append_history(f"temp_{i}", now, gpu["gpu_temperature"])
                    if gpu.get("gpu_power_usage", -1) >= 0:
                        self._append_history(f"power_{i}", now, gpu["gpu_power_usage"])
                        # Accumulate watt-seconds for cost tracking.
                        self.total_watt_seconds += gpu["gpu_power_usage"] * self.rate

                # Include the cost accumulator in the WS payload.
                data["total_watt_seconds"] = self.total_watt_seconds

                await self._send(data)
            except Exception as e:
                logger.debug(f"Monitor poll error: {e}")

            # Use the stop event as a sleep that can be interrupted.
            self._stop_event.wait(timeout=self.rate)

    @staticmethod
    async def _send(data: dict):
        """Push stats to all connected clients via WebSocket.

        The import is deferred because PromptServer may not be ready at
        module load time.
        """
        try:
            import server
            server.PromptServer.instance.send_sync("enhutils.monitor", data)
        except Exception:
            pass  # Server not ready yet; silently skip.


# ── Module-Level Singleton ──────────────────────────────────────────────────
#
# Created on import (triggered by __init__.py -> routes.py -> this module).
# The thread only starts if rate > 0.

monitor_instance = MonitorCollector(default_rate=1.0)
