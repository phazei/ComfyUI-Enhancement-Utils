"""
GPU monitoring abstraction layer.

Provides GPU utilization, VRAM usage, and temperature via pynvml (NVIDIA).
Gracefully degrades to a no-op if pynvml is unavailable, the system has no
NVIDIA GPU, or ZLUDA is detected (AMD GPUs faking CUDA).

Improvements over Crystools:
- All pynvml calls wrapped in try/except (no crashes on malformed data).
- GPU names decoded with errors='replace' (no UnicodeDecodeError).
- Functional ZLUDA detection (tests deviceGetCount, not string matching).
- Respects CUDA_VISIBLE_DEVICES environment variable.
"""

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger("enhutils.monitor.gpu")

# ── Data Structures ─────────────────────────────────────────────────────────


@dataclass
class GPUStats:
    """Stats for a single GPU device."""
    index: int = 0
    name: str = "Unknown"
    gpu_utilization: float = -1.0
    gpu_temperature: float = -1.0
    vram_total: int = 0
    vram_used: int = 0
    vram_used_percent: float = -1.0


@dataclass
class GPUInfo:
    """Aggregate GPU info for all monitored devices."""
    device_type: str = "cpu"
    gpus: list[GPUStats] = field(default_factory=list)


# ── GPU Monitor ─────────────────────────────────────────────────────────────


class GPUMonitor:
    """Monitors NVIDIA GPU(s) via pynvml. No-op on unsupported systems."""

    def __init__(self):
        self._available = False
        self._handles: list = []
        self._gpu_names: list[str] = []
        self._visible_indices: list[int] | None = None
        self._pynvml = None

        # Switches for which metrics to collect (toggled per-GPU via API).
        self.gpu_utilization_enabled: list[bool] = []
        self.gpu_vram_enabled: list[bool] = []
        self.gpu_temperature_enabled: list[bool] = []

        self._init_pynvml()

    def _init_pynvml(self):
        """Try to initialize pynvml. Silently disable if unavailable."""
        try:
            import pynvml
            pynvml.nvmlInit()
        except Exception as e:
            logger.info(f"pynvml not available ({e}). GPU monitoring disabled.")
            return

        self._pynvml = pynvml

        # Functional ZLUDA detection: if pynvml loads but reports 0 devices,
        # it's likely ZLUDA (AMD translation layer) or a broken driver.
        try:
            device_count = pynvml.nvmlDeviceGetCount()
        except Exception:
            device_count = 0

        if device_count == 0:
            logger.info("pynvml reports 0 devices. GPU monitoring disabled (ZLUDA or no NVIDIA GPU).")
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass
            self._pynvml = None
            return

        # Parse CUDA_VISIBLE_DEVICES to only monitor GPUs ComfyUI actually uses.
        self._visible_indices = self._parse_visible_devices(device_count)
        indices_to_monitor = self._visible_indices if self._visible_indices is not None else list(range(device_count))

        for idx in indices_to_monitor:
            try:
                handle = pynvml.nvmlDeviceGetHandleByIndex(idx)
                self._handles.append(handle)

                # Decode GPU name safely (some drivers return non-UTF-8 bytes).
                try:
                    raw_name = pynvml.nvmlDeviceGetName(handle)
                    name = raw_name.decode("utf-8", errors="replace") if isinstance(raw_name, bytes) else str(raw_name)
                except Exception:
                    name = f"GPU {idx}"

                self._gpu_names.append(name)
                self.gpu_utilization_enabled.append(True)
                self.gpu_vram_enabled.append(True)
                self.gpu_temperature_enabled.append(True)

                logger.info(f"Monitoring GPU {idx}: {name}")
            except Exception as e:
                logger.warning(f"Failed to get handle for GPU {idx}: {e}")

        if self._handles:
            self._available = True
            try:
                driver = pynvml.nvmlSystemGetDriverVersion()
                if isinstance(driver, bytes):
                    driver = driver.decode("utf-8", errors="replace")
                logger.info(f"NVIDIA driver version: {driver}")
            except Exception:
                pass
        else:
            logger.info("No usable GPU handles obtained. GPU monitoring disabled.")
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass
            self._pynvml = None

    @staticmethod
    def _parse_visible_devices(total_count: int) -> list[int] | None:
        """Parse the CUDA_VISIBLE_DEVICES environment variable.

        Returns:
            List of integer device indices to monitor, or None to monitor all.
        """
        env = os.environ.get("CUDA_VISIBLE_DEVICES")
        if not env:
            return None

        indices = []
        for part in env.split(","):
            part = part.strip()
            try:
                idx = int(part)
                if 0 <= idx < total_count:
                    indices.append(idx)
            except ValueError:
                # UUID-based device specification; skip filtering for now.
                return None

        return indices if indices else None

    @property
    def available(self) -> bool:
        return self._available

    @property
    def device_count(self) -> int:
        return len(self._handles)

    def get_gpu_list(self) -> list[dict]:
        """Return a list of {index, name} dicts for all monitored GPUs."""
        return [
            {"index": i, "name": self._gpu_names[i]}
            for i in range(len(self._handles))
        ]

    def get_stats(self) -> GPUInfo:
        """Collect current stats for all monitored GPUs."""
        if not self._available:
            return GPUInfo(device_type="cpu")

        pynvml = self._pynvml
        gpus = []

        for i, handle in enumerate(self._handles):
            stats = GPUStats(index=i, name=self._gpu_names[i])

            # GPU utilization %.
            if self.gpu_utilization_enabled[i]:
                try:
                    rates = pynvml.nvmlDeviceGetUtilizationRates(handle)
                    stats.gpu_utilization = float(rates.gpu)
                except Exception:
                    stats.gpu_utilization = -1.0

            # VRAM usage.
            if self.gpu_vram_enabled[i]:
                try:
                    mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                    stats.vram_total = mem.total
                    stats.vram_used = mem.used
                    stats.vram_used_percent = (mem.used / mem.total * 100) if mem.total > 0 else 0.0
                except Exception:
                    pass

            # Temperature.
            if self.gpu_temperature_enabled[i]:
                try:
                    stats.gpu_temperature = float(
                        pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
                    )
                except Exception:
                    stats.gpu_temperature = -1.0

            gpus.append(stats)

        return GPUInfo(device_type="cuda", gpus=gpus)

    def shutdown(self):
        """Clean up pynvml resources."""
        if self._pynvml:
            try:
                self._pynvml.nvmlShutdown()
            except Exception:
                pass
            self._pynvml = None
            self._available = False
