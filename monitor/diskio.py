"""
Disk I/O activity monitor.

Reports, for the monitored disk, the percentage of time it was busy
("active time", like Windows Task Manager's Disk %) plus read/write
throughput, all averaged over the interval since the previous sample.

Backends:
- **Windows**: PDH performance counters on the drive letter
  (``\\LogicalDisk(D:)\\% Idle Time`` -> active = 100 - idle, and
  ``Disk Read/Write Bytes/sec``) via ctypes. No extra dependencies.
- **Linux**: ``psutil.disk_io_counters(perdisk=True)`` ``busy_time`` delta
  for the block device backing the mount point (``/dev/mapper`` symlinks are
  resolved to ``dm-N``).
- **Fallback** (macOS, unmapped devices): the busiest physical disk's
  ``read_time + write_time`` delta, and system-wide throughput.

The first sample after start or a disk change has no interval to average
over, so it reports -1 (bar hidden) until the next poll.

:class:`AllDisksIOMonitor` samples every mounted disk and reports the
busiest one's active time with throughput summed across all disks.
"""

import logging
import os
import sys
import time

import psutil

logger = logging.getLogger("enhutils.monitor.diskio")


class DiskIOSample:
    """One disk I/O reading. -1 means unavailable."""

    def __init__(self, active_percent: float = -1.0, read_bps: float = -1.0, write_bps: float = -1.0):
        self.active_percent = active_percent
        self.read_bps = read_bps
        self.write_bps = write_bps


# ── Windows (PDH) ───────────────────────────────────────────────────────────

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _PDH_FMT_DOUBLE = 0x00000200
    _PDH_FMT_NOCAP100 = 0x00008000

    class _PdhFmtCounterValue(ctypes.Structure):
        # PDH_FMT_COUNTERVALUE: DWORD CStatus + union (double at offset 8).
        _fields_ = [("CStatus", wintypes.DWORD), ("doubleValue", ctypes.c_double)]

    class _PdhDriveCounters:
        """PDH query for one drive letter's idle time and throughput."""

        def __init__(self, drive: str):
            self._pdh = ctypes.WinDLL("pdh")
            self._query = ctypes.c_void_p()
            if self._pdh.PdhOpenQueryW(None, None, ctypes.byref(self._query)) != 0:
                raise OSError("PdhOpenQueryW failed")
            self._counters = {}
            self._primed = False
            try:
                for key, name in (
                    ("idle", "% Idle Time"),
                    ("read", "Disk Read Bytes/sec"),
                    ("write", "Disk Write Bytes/sec"),
                ):
                    handle = ctypes.c_void_p()
                    path = f"\\LogicalDisk({drive})\\{name}"
                    status = self._pdh.PdhAddEnglishCounterW(self._query, path, None, ctypes.byref(handle))
                    if status != 0:
                        raise OSError(f"PdhAddEnglishCounterW({path}) failed: 0x{status & 0xFFFFFFFF:08X}")
                    self._counters[key] = handle
            except Exception:
                self.close()
                raise

        def _value(self, key: str) -> float | None:
            value = _PdhFmtCounterValue()
            status = self._pdh.PdhGetFormattedCounterValue(
                self._counters[key], _PDH_FMT_DOUBLE | _PDH_FMT_NOCAP100, None, ctypes.byref(value)
            )
            return value.doubleValue if status == 0 else None

        def sample(self) -> DiskIOSample:
            if self._pdh.PdhCollectQueryData(self._query) != 0:
                return DiskIOSample()
            # Rate counters need two collections a poll interval apart; the
            # first one only establishes the baseline.
            if not self._primed:
                self._primed = True
                return DiskIOSample()
            idle, read, write = self._value("idle"), self._value("read"), self._value("write")
            if idle is None:
                return DiskIOSample()
            return DiskIOSample(
                active_percent=min(100.0, max(0.0, 100.0 - idle)),
                read_bps=read if read is not None else -1.0,
                write_bps=write if write is not None else -1.0,
            )

        def close(self):
            if self._query:
                self._pdh.PdhCloseQuery(self._query)
                self._query = ctypes.c_void_p()


# ── psutil (Linux / fallback) ───────────────────────────────────────────────

def _device_key_for_mount(mount: str) -> str | None:
    """Map a mount point to its ``psutil.disk_io_counters(perdisk=True)`` key."""
    try:
        for part in psutil.disk_partitions(all=False):
            if part.mountpoint == mount and part.device.startswith("/dev/"):
                return os.path.basename(os.path.realpath(part.device))
    except Exception:
        pass
    return None


class _PsutilDiskCounters:
    """Busy-time based activity from psutil counter deltas."""

    def __init__(self, mount: str):
        self._key = _device_key_for_mount(mount) if sys.platform.startswith("linux") else None
        self._prev = None
        self._prev_time = 0.0
        self._prev_total = None

    def _read(self):
        """Return ({disk: busy_ms}, (read_bytes, write_bytes)) for the tracked device(s)."""
        perdisk = psutil.disk_io_counters(perdisk=True) or {}
        if self._key and self._key in perdisk:
            c = perdisk[self._key]
            busy = getattr(c, "busy_time", None)
            if busy is None:
                busy = c.read_time + c.write_time
            return {self._key: busy}, (c.read_bytes, c.write_bytes)

        busy = {
            name: getattr(c, "busy_time", c.read_time + c.write_time)
            for name, c in perdisk.items()
        }
        total = psutil.disk_io_counters(perdisk=False)
        return busy, ((total.read_bytes, total.write_bytes) if total else (0, 0))

    def sample(self) -> DiskIOSample:
        now = time.monotonic()
        busy, io_bytes = self._read()
        prev, prev_time, prev_bytes = self._prev, self._prev_time, self._prev_total
        self._prev, self._prev_time, self._prev_total = busy, now, io_bytes

        elapsed = now - prev_time
        if prev is None or elapsed <= 0:
            return DiskIOSample()

        deltas = [busy[name] - prev[name] for name in busy if name in prev]
        if not deltas:
            return DiskIOSample()
        active = min(100.0, max(0.0, max(deltas) / (elapsed * 1000.0) * 100.0))
        return DiskIOSample(
            active_percent=active,
            read_bps=max(0.0, (io_bytes[0] - prev_bytes[0]) / elapsed),
            write_bps=max(0.0, (io_bytes[1] - prev_bytes[1]) / elapsed),
        )

    def close(self):
        pass


# ── Public Monitor ──────────────────────────────────────────────────────────

class DiskIOMonitor:
    """Samples disk I/O activity for a mount point / drive root.

    The backend is (re)created lazily when the monitored path changes. If it
    can't be created (e.g. PDH counters unavailable), samples report -1.
    """

    def __init__(self):
        self._path: str | None = None
        self._backend = None

    def _open(self, path: str):
        if sys.platform == "win32":
            drive = os.path.splitdrive(path)[0]
            if drive:
                try:
                    return _PdhDriveCounters(drive.upper())
                except Exception as e:
                    logger.debug(f"PDH disk counters unavailable for {drive}: {e}; using psutil.")
        return _PsutilDiskCounters(path)

    def sample(self, path: str) -> DiskIOSample:
        """Sample activity for *path*; -1 values on the first call per path or on error."""
        if path != self._path:
            self.close()
            self._path = path
            try:
                self._backend = self._open(path)
            except Exception as e:
                logger.debug(f"Disk I/O monitor unavailable for {path}: {e}")
                self._backend = None
        if self._backend is None:
            return DiskIOSample()
        try:
            return self._backend.sample()
        except Exception as e:
            logger.debug(f"Disk I/O sample failed: {e}")
            return DiskIOSample()

    def close(self):
        """Release the current backend (called on path change)."""
        if self._backend is not None:
            self._backend.close()
        self._backend = None
        self._path = None


class AllDisksIOMonitor:
    """Samples every mounted disk and reports the busiest one.

    ``active_percent`` is the highest active time of any disk (so a spike on
    any drive shows), read/write throughput is summed across all disks, and
    :attr:`busiest` names the disk with the highest active time. The disk
    list is refreshed periodically so newly mounted drives are picked up.
    """

    REFRESH_SECONDS = 30.0

    def __init__(self):
        self._monitors: dict[str, DiskIOMonitor] = {}
        self._last_refresh = 0.0
        self.busiest: str = ""

    def _refresh(self):
        try:
            paths = {p.mountpoint for p in psutil.disk_partitions(all=False)}
        except Exception:
            paths = set()
        for path in set(self._monitors) - paths:
            self._monitors.pop(path).close()
        for path in paths - set(self._monitors):
            self._monitors[path] = DiskIOMonitor()
        self._last_refresh = time.monotonic()

    def sample(self) -> DiskIOSample:
        """Sample all disks; -1 values until at least one disk has a baseline."""
        if time.monotonic() - self._last_refresh > self.REFRESH_SECONDS:
            self._refresh()

        best = None
        read = write = 0.0
        for path, monitor in self._monitors.items():
            s = monitor.sample(path)
            if s.active_percent < 0:
                continue
            if best is None or s.active_percent > best[1].active_percent:
                best = (path, s)
            read += max(s.read_bps, 0.0)
            write += max(s.write_bps, 0.0)

        if best is None:
            self.busiest = ""
            return DiskIOSample()
        self.busiest = best[0]
        return DiskIOSample(active_percent=best[1].active_percent, read_bps=read, write_bps=write)

    def close(self):
        """Release all per-disk backends."""
        for monitor in self._monitors.values():
            monitor.close()
        self._monitors.clear()
        self._last_refresh = 0.0
        self.busiest = ""
