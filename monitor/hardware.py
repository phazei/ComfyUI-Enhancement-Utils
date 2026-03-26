"""
Hardware stats collector.

Gathers CPU utilization, RAM usage, and disk usage via psutil.
Delegates GPU stats to the GPUMonitor.

Improvements over Crystools:
- Platform-native CPU name detection (no py-cpuinfo, fast startup).
- Auto-detects ComfyUI's install drive as the default disk to monitor.
- Supports "none" to disable disk monitoring entirely.
- Clean separation of concerns (GPU delegated, not inline).
- All calls wrapped for safety.
"""

import logging
import os
import platform
import sys
from dataclasses import dataclass

import psutil

from .gpu import GPUMonitor, GPUInfo

logger = logging.getLogger("enhutils.monitor.hardware")

# ── Data Structures ─────────────────────────────────────────────────────────


@dataclass
class SystemStats:
    """Complete system stats snapshot."""
    cpu_utilization: float = -1.0
    ram_total: int = 0
    ram_used: int = 0
    ram_used_percent: float = -1.0
    disk_total: int = 0
    disk_used: int = 0
    disk_used_percent: float = -1.0
    disk_path: str = ""
    gpu_info: GPUInfo = None

    def to_dict(self) -> dict:
        """Serialize to a dict suitable for WebSocket transmission."""
        gpu_list = []
        device_type = "cpu"
        if self.gpu_info:
            device_type = self.gpu_info.device_type
            for g in self.gpu_info.gpus:
                gpu_list.append({
                    "gpu_utilization": g.gpu_utilization,
                    "gpu_temperature": g.gpu_temperature,
                    "vram_total": g.vram_total,
                    "vram_used": g.vram_used,
                    "vram_used_percent": g.vram_used_percent,
                })

        return {
            "cpu_utilization": self.cpu_utilization,
            "ram_total": self.ram_total,
            "ram_used": self.ram_used,
            "ram_used_percent": self.ram_used_percent,
            "disk_total": self.disk_total,
            "disk_used": self.disk_used,
            "disk_used_percent": self.disk_used_percent,
            "disk_path": self.disk_path,
            "device_type": device_type,
            "gpus": gpu_list,
        }


# ── CPU Name Detection ──────────────────────────────────────────────────────

def _get_cpu_name() -> str:
    """Get CPU brand string using platform-native methods.

    Avoids the slow py-cpuinfo library which caused multi-second startup
    delays (see Crystools PR #99).
    """
    system = platform.system()

    try:
        if system == "Windows":
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"
            )
            name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
            winreg.CloseKey(key)
            return name.strip()

        elif system == "Linux":
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()

        elif system == "Darwin":
            import subprocess
            result = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                return result.stdout.strip()

    except Exception as e:
        logger.debug(f"CPU name detection failed: {e}")

    return platform.processor() or "Unknown CPU"


# ── Hardware Info Collector ─────────────────────────────────────────────────


class HardwareInfo:
    """Collects system hardware statistics."""

    def __init__(self, gpu_monitor: GPUMonitor):
        self.gpu_monitor = gpu_monitor

        # Which metrics are enabled (toggled via API).
        self.cpu_enabled = True
        self.ram_enabled = True
        self.disk_enabled = True

        # Which disk to monitor. "none" disables disk monitoring.
        # Default: auto-detect the drive ComfyUI is installed on.
        self.disk_path = self._detect_comfyui_drive()

        # Log CPU info once at startup.
        cpu_name = _get_cpu_name()
        cpu_count = psutil.cpu_count(logical=True) or 0
        logger.info(f"CPU: {cpu_name} ({cpu_count} logical cores)")
        logger.info(f"Disk monitor default: {self.disk_path}")

    @staticmethod
    def _detect_comfyui_drive() -> str:
        """Detect the drive/mount point that ComfyUI is installed on.

        Uses folder_paths.base_path if available (ComfyUI's root directory),
        falling back to the current working directory's drive root.
        """
        try:
            import folder_paths
            base = folder_paths.base_path
        except Exception:
            base = os.getcwd()

        # On Windows, extract the drive letter root (e.g., "D:\\").
        if sys.platform == "win32":
            drive = os.path.splitdrive(base)[0]
            return (drive + "\\") if drive else "C:\\"

        # On Unix, return "/" (the root mount point).
        return "/"

    def get_stats(self) -> SystemStats:
        """Collect a snapshot of all enabled system metrics."""
        stats = SystemStats()

        # CPU utilization.
        if self.cpu_enabled:
            try:
                stats.cpu_utilization = psutil.cpu_percent(interval=None)
            except Exception:
                stats.cpu_utilization = -1.0

        # RAM usage.
        if self.ram_enabled:
            try:
                mem = psutil.virtual_memory()
                stats.ram_total = mem.total
                stats.ram_used = mem.used
                stats.ram_used_percent = mem.percent
            except Exception:
                pass

        # Disk usage. Disabled when disk_path is "none".
        if self.disk_enabled and self.disk_path != "none":
            try:
                disk = psutil.disk_usage(self.disk_path)
                stats.disk_total = disk.total
                stats.disk_used = disk.used
                stats.disk_used_percent = disk.percent
                stats.disk_path = self.disk_path
            except Exception:
                pass

        # GPU stats (delegated).
        stats.gpu_info = self.gpu_monitor.get_stats()

        return stats

    @staticmethod
    def get_disk_partitions() -> list[str]:
        """Return a list of disk partition mount points, plus 'none' to disable."""
        try:
            partitions = [p.mountpoint for p in psutil.disk_partitions()]
        except Exception:
            partitions = []
        # Prepend "none" option so users can disable the disk monitor.
        return ["none"] + partitions
