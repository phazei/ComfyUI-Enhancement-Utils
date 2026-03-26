"""
Resource monitor collector.

Runs a background daemon thread that periodically collects system stats and
pushes them to all connected WebSocket clients via PromptServer.send_sync.

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

from .gpu import GPUMonitor
from .hardware import HardwareInfo

logger = logging.getLogger("enhutils.monitor.collector")


class MonitorCollector:
    """Background stats collector that pushes data via WebSocket.

    Attributes:
        rate: Polling interval in seconds. Set to 0 to pause.
        hardware: HardwareInfo instance for stat collection.
        gpu_monitor: GPUMonitor instance for GPU-specific stats.
    """

    def __init__(self, default_rate: float = 1.0):
        self.gpu_monitor = GPUMonitor()
        self.hardware = HardwareInfo(self.gpu_monitor)
        self.rate = default_rate

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

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
        """Async polling loop that collects and broadcasts stats."""
        while not self._stop_event.is_set():
            try:
                data = self.hardware.get_stats().to_dict()
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
