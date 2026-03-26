/**
 * Resource Monitor frontend extension.
 *
 * Displays real-time system stats (CPU, RAM, HDD, GPU utilization, VRAM,
 * temperature) as horizontal colored bars in the ComfyUI menu bar.
 *
 * Architecture:
 * - The Python backend pushes stats via WebSocket event "enhutils.monitor".
 * - This extension listens for those events and updates the DOM bars.
 * - Settings are persisted via ComfyUI's settings system and pushed to the
 *   backend via HTTP PATCH/GET endpoints under /enhutils/monitor/.
 *
 * Based on crystian/ComfyUI-Crystools, rewritten in plain JS with fixes for:
 * - CSS loading breakage (Crystools PRs #164, #228)
 * - Settings API compatibility (Crystools PR #149)
 * - Console spam on missing GPU data (Crystools PR #234)
 * - Frontend positioning for new menu layouts
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Constants ──────────────────────────────────────────────────────────────

const EXTENSION_NAME = "phazei.ResourceMonitor";
const WS_EVENT = "enhutils.monitor";
const API_BASE = "/enhutils/monitor";

/**
 * Setting definitions for each built-in metric.
 * GPU metrics are dynamically added after querying available GPUs.
 * Disk bar label is updated dynamically based on the selected partition.
 */
const BASE_METRICS = [
    { id: "cpu",  label: "CPU",   symbol: "%",  cssClass: "cpu" },
    { id: "ram",  label: "RAM",   symbol: "%",  cssClass: "ram" },
    { id: "disk", label: "Disk",  symbol: "%",  cssClass: "disk" },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format bytes to a human-readable string (e.g., "12.50 GB").
 */
function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + units[i];
}

/**
 * Inject a <link> tag for our CSS file, resolved relative to this script.
 */
function loadStylesheet() {
    const cssUrl = new URL("resourceMonitor.css", import.meta.url);
    if (!document.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        document.head.appendChild(link);
    }
}

// ── Monitor Bar DOM Creation ───────────────────────────────────────────────

/**
 * Create a single monitor bar element.
 *
 * Structure:
 *   <div class="enhutils-monitor {cssClass}">
 *     <div class="enhutils-slider"></div>
 *     <div class="enhutils-label-name">CPU</div>
 *     <div class="enhutils-label-value">0%</div>
 *   </div>
 *
 * @param {string} cssClass - CSS class for color theming (cpu, ram, disk, gpu, vram, temp).
 * @param {string} label - Display label (e.g., "CPU", "GPU 0").
 * @returns {{element: HTMLElement, slider: HTMLElement, nameEl: HTMLElement, valueEl: HTMLElement}}
 */
function createMonitorBar(cssClass, label) {
    const el = document.createElement("div");
    el.className = `enhutils-monitor ${cssClass}`;
    el.title = label;

    const slider = document.createElement("div");
    slider.className = "enhutils-slider";
    el.appendChild(slider);

    const nameEl = document.createElement("div");
    nameEl.className = "enhutils-label-name";
    nameEl.textContent = label;
    el.appendChild(nameEl);

    const valueEl = document.createElement("div");
    valueEl.className = "enhutils-label-value";
    valueEl.textContent = "0%";
    el.appendChild(valueEl);

    return { element: el, slider, nameEl, valueEl };
}

/**
 * Update a monitor bar with new data.
 *
 * @param {Object} bar - The bar refs from createMonitorBar().
 * @param {string} label - Base label (e.g., "CPU"). Updates the top-left name.
 * @param {number} percent - Current percentage (0-100). -1 means disabled/hidden.
 * @param {string} symbol - Unit symbol ("%" or a degree sign).
 * @param {Object} [extra] - Optional extra data for tooltip: {used, total, maxUsed}.
 */
function updateMonitorBar(bar, label, percent, symbol = "%", extra = null) {
    if (percent < 0) {
        bar.element.classList.add("hidden");
        return;
    }
    bar.element.classList.remove("hidden");

    const pct = Math.min(100, Math.max(0, percent));
    bar.slider.style.width = `${pct}%`;
    bar.nameEl.textContent = label;
    bar.valueEl.textContent = `${Math.round(pct)}${symbol}`;

    // Build detailed tooltip.
    let tooltip = `${label}: ${pct.toFixed(1)}${symbol}`;
    if (extra?.used != null && extra?.total != null) {
        tooltip += `\n${formatBytes(extra.used)} / ${formatBytes(extra.total)}`;
        if (extra.maxUsed != null) {
            tooltip += `\nMax: ${formatBytes(extra.maxUsed)}`;
        }
    }
    bar.element.title = tooltip;
}

// ── Extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: EXTENSION_NAME,

    async setup() {
        loadStylesheet();

        // ── Create root container ──────────────────────────────────────

        const root = document.createElement("div");
        root.id = "enhutils-monitor-root";

        // ── Create base metric bars ────────────────────────────────────

        const bars = {};

        for (const metric of BASE_METRICS) {
            const bar = createMonitorBar(metric.cssClass, metric.label);
            bars[metric.id] = bar;
            root.appendChild(bar.element);
        }

        // ── Query GPUs and create per-GPU bars ─────────────────────────

        let gpuList = [];
        try {
            const resp = await api.fetchApi(`${API_BASE}/gpu`);
            if (resp.ok) gpuList = await resp.json();
        } catch (e) {
            // No GPU endpoint or server not ready; that's fine.
        }

        /** Track max VRAM used per GPU (resets on page refresh). */
        const maxVramUsed = {};

        for (const gpu of gpuList) {
            const idx = gpu.index;
            const suffix = gpuList.length > 1 ? ` ${idx}` : "";

            // GPU utilization bar.
            const gpuBar = createMonitorBar("gpu", `GPU${suffix}`);
            bars[`gpu_${idx}`] = gpuBar;
            root.appendChild(gpuBar.element);

            // VRAM bar.
            const vramBar = createMonitorBar("vram", `VRAM${suffix}`);
            bars[`vram_${idx}`] = vramBar;
            root.appendChild(vramBar.element);

            // Temperature bar.
            const tempBar = createMonitorBar("temp", `Temp${suffix}`);
            bars[`temp_${idx}`] = tempBar;
            root.appendChild(tempBar.element);

            maxVramUsed[idx] = 0;
        }

        // ── Position in menu bar ───────────────────────────────────────

        /**
         * Insert the monitor into the correct location in the ComfyUI menu.
         * Handles both old sidebar menu and new top/bottom menu layouts.
         */
        const positionMonitor = () => {
            // New menu: insert before the settings group.
            if (app.menu?.settingsGroup?.element) {
                const target = app.menu.settingsGroup.element;
                target.parentElement?.insertBefore(root, target);
                return;
            }
            // Legacy: insert after the queue button.
            const queueBtn = document.getElementById("queue-button");
            if (queueBtn?.parentElement) {
                queueBtn.parentElement.insertBefore(root, queueBtn.nextSibling);
                return;
            }
            // Fallback: append to body (will still show, just not ideal).
            document.body.appendChild(root);
        };

        // Position on load and reposition when menu type changes.
        positionMonitor();
        api.addEventListener("Comfy.UseNewMenu", positionMonitor);

        // ── Listen for stats updates ───────────────────────────────────

        /** Current disk label, updated when the disk setting changes. */
        let diskLabel = "Disk";

        api.addEventListener(WS_EVENT, (event) => {
            const data = event?.detail;
            if (!data) return;

            // Base metrics (respect enabled toggles).
            updateMonitorBar(bars.cpu, "CPU", enabled.cpu ? data.cpu_utilization : -1);
            updateMonitorBar(bars.ram, "RAM", enabled.ram ? data.ram_used_percent : -1, "%", {
                used: data.ram_used,
                total: data.ram_total,
            });

            // Disk: show -1 (hidden) when path is "none" or no data.
            const diskPercent = (data.disk_path && data.disk_path !== "none")
                ? data.disk_used_percent
                : -1;
            updateMonitorBar(bars.disk, diskLabel, diskPercent, "%", {
                used: data.disk_used,
                total: data.disk_total,
            });

            // Per-GPU metrics.
            if (Array.isArray(data.gpus)) {
                for (let i = 0; i < data.gpus.length; i++) {
                    const gpu = data.gpus[i];
                    const suffix = data.gpus.length > 1 ? ` ${i}` : "";

                    const ge = gpuEnabled[i] || { gpu: true, vram: true, temp: true };

                    if (bars[`gpu_${i}`]) {
                        updateMonitorBar(bars[`gpu_${i}`], `GPU${suffix}`,
                            ge.gpu ? gpu.gpu_utilization : -1);
                    }

                    if (bars[`vram_${i}`]) {
                        // Track max VRAM used.
                        if (gpu.vram_used > (maxVramUsed[i] || 0)) {
                            maxVramUsed[i] = gpu.vram_used;
                        }
                        updateMonitorBar(bars[`vram_${i}`], `VRAM${suffix}`,
                            ge.vram ? gpu.vram_used_percent : -1, "%", {
                            used: gpu.vram_used,
                            total: gpu.vram_total,
                            maxUsed: maxVramUsed[i],
                        });
                    }

                    if (bars[`temp_${i}`]) {
                        const temp = gpu.gpu_temperature;
                        const tempBar = bars[`temp_${i}`];

                        if (!ge.temp) {
                            updateMonitorBar(tempBar, `Temp${suffix}`, -1);
                        } else {
                            // Temperature uses a red-green gradient based on temp value.
                            if (temp >= 0) {
                                const ratio = Math.min(100, Math.max(0, temp));
                                tempBar.slider.style.background =
                                    `color-mix(in srgb, #ff0000 ${ratio}%, #00ff00)`;
                            }
                            // Display as degrees, with percent = temp (capped at 100 for bar width).
                            updateMonitorBar(tempBar, `Temp${suffix}`, temp >= 0 ? Math.min(temp, 100) : -1, "\u00B0");
                            // Override value to show actual temp (might be > 100).
                            if (temp >= 0) {
                                tempBar.valueEl.textContent = `${Math.round(temp)}\u00B0`;
                            }
                        }
                    }
                }
            }
        });

        // ── Register settings ──────────────────────────────────────────
        //
        // NOTE: ComfyUI renders settings in reverse registration order,
        // so we register bottom-to-top. Desired display order:
        //   Rate, CPU, RAM, Disk, GPU, VRAM, Temp

        /** Track which metrics are enabled so the WS listener can respect them. */
        const enabled = { cpu: true, ram: true };
        const gpuEnabled = {};

        // ── Per-GPU toggles (registered first = displayed last) ────────

        // Reverse GPU list so multi-GPU systems show GPU 0 first in settings.
        const gpuListReversed = [...gpuList].reverse();

        for (const gpu of gpuListReversed) {
            const idx = gpu.index;
            const suffix = gpuList.length > 1 ? ` ${idx}` : "";

            gpuEnabled[idx] = { gpu: true, vram: true, temp: true };

            app.ui.settings.addSetting({
                id: `EnhUtils.Monitor.ShowTemp${idx}`,
                name: `Resource Monitor - Show Temperature${suffix}`,
                type: "boolean",
                defaultValue: true,
                onChange: async (value) => {
                    gpuEnabled[idx].temp = value;
                    if (!value && bars[`temp_${idx}`]) {
                        updateMonitorBar(bars[`temp_${idx}`], `Temp${suffix}`, -1);
                    }
                    try {
                        await api.fetchApi(`${API_BASE}/gpu/${idx}`, {
                            method: "PATCH",
                            body: JSON.stringify({ temperature: value }),
                        });
                    } catch (e) { /* ignore */ }
                },
            });

            app.ui.settings.addSetting({
                id: `EnhUtils.Monitor.ShowVram${idx}`,
                name: `Resource Monitor - Show VRAM${suffix}`,
                type: "boolean",
                defaultValue: true,
                onChange: async (value) => {
                    gpuEnabled[idx].vram = value;
                    if (!value && bars[`vram_${idx}`]) {
                        updateMonitorBar(bars[`vram_${idx}`], `VRAM${suffix}`, -1);
                    }
                    try {
                        await api.fetchApi(`${API_BASE}/gpu/${idx}`, {
                            method: "PATCH",
                            body: JSON.stringify({ vram: value }),
                        });
                    } catch (e) { /* ignore */ }
                },
            });

            app.ui.settings.addSetting({
                id: `EnhUtils.Monitor.ShowGpu${idx}`,
                name: `Resource Monitor - Show GPU${suffix} utilization`,
                type: "boolean",
                defaultValue: true,
                onChange: async (value) => {
                    gpuEnabled[idx].gpu = value;
                    if (!value && bars[`gpu_${idx}`]) {
                        updateMonitorBar(bars[`gpu_${idx}`], `GPU${suffix}`, -1);
                    }
                    try {
                        await api.fetchApi(`${API_BASE}/gpu/${idx}`, {
                            method: "PATCH",
                            body: JSON.stringify({ utilization: value }),
                        });
                    } catch (e) { /* ignore */ }
                },
            });
        }

        // ── Disk ───────────────────────────────────────────────────────

        let partitions = ["none", "/"];
        try {
            const resp = await api.fetchApi(`${API_BASE}/disk`);
            if (resp.ok) partitions = await resp.json();
        } catch (e) { /* ignore */ }

        const defaultDisk = partitions.find((p) => p !== "none") || "none";

        /** Derive a short label from a mount point / drive letter. */
        const getDiskLabel = (path) => {
            if (!path || path === "none") return "Disk";
            if (/^[A-Z]:\\?$/i.test(path.replace(/\\$/, ""))) return `Disk ${path[0]}:`;
            if (path === "/") return "Disk /";
            const short = path.length > 8 ? "\u2026" + path.slice(-7) : path;
            return `Disk ${short}`;
        };

        diskLabel = getDiskLabel(defaultDisk);

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.WhichDisk",
            name: "Resource Monitor - Disk partition (select 'none' to hide)",
            type: "combo",
            defaultValue: defaultDisk,
            options: partitions,
            onChange: async (value) => {
                diskLabel = getDiskLabel(value);
                if (value === "none") updateMonitorBar(bars.disk, diskLabel, -1);
                try {
                    await api.fetchApi(`${API_BASE}`, {
                        method: "PATCH",
                        body: JSON.stringify({ whichDisk: value }),
                    });
                } catch (e) { /* ignore */ }
            },
        });

        // ── RAM ────────────────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.ShowRam",
            name: "Resource Monitor - Show RAM",
            type: "boolean",
            defaultValue: true,
            onChange: async (value) => {
                enabled.ram = value;
                if (!value) updateMonitorBar(bars.ram, "RAM", -1);
                try {
                    await api.fetchApi(`${API_BASE}`, {
                        method: "PATCH",
                        body: JSON.stringify({ switchRAM: value }),
                    });
                } catch (e) { /* ignore */ }
            },
        });

        // ── CPU ────────────────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.ShowCpu",
            name: "Resource Monitor - Show CPU",
            type: "boolean",
            defaultValue: true,
            onChange: async (value) => {
                enabled.cpu = value;
                if (!value) updateMonitorBar(bars.cpu, "CPU", -1);
                try {
                    await api.fetchApi(`${API_BASE}`, {
                        method: "PATCH",
                        body: JSON.stringify({ switchCPU: value }),
                    });
                } catch (e) { /* ignore */ }
            },
        });

        // ── Rate (registered last = displayed first) ───────────────────

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.Rate",
            name: "Resource Monitor - Update rate (seconds)",
            type: "slider",
            defaultValue: 1,
            attrs: { min: 0, max: 10, step: 0.5 },
            onChange: async (value) => {
                try {
                    await api.fetchApi(`${API_BASE}`, {
                        method: "PATCH",
                        body: JSON.stringify({ rate: value }),
                    });
                } catch (e) { /* ignore */ }
            },
        });
    },
});
