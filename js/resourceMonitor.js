/**
 * Resource Monitor frontend extension.
 *
 * Displays real-time system stats (CPU, RAM, HDD, GPU utilization, VRAM,
 * temperature, power draw) as horizontal colored bars in the ComfyUI menu bar.
 * Hovering over any bar shows a single historical sparkline graph popup.
 * Clicking any bar pins a multi-chart grid showing all metrics at once;
 * clicking again (or clicking outside) dismisses it.
 *
 * Architecture:
 * - The Python backend pushes stats via WebSocket event "enhutils.monitor".
 * - This extension listens for those events and updates the DOM bars.
 * - Settings are persisted via ComfyUI's settings system and pushed to the
 *   backend via HTTP PATCH/GET endpoints under /enhutils/monitor/.
 * - Historical data is stored in per-metric ring buffers (MetricHistory).
 * - An electricity cost accumulator tracks session power consumption.
 *
 * Based on crystian/ComfyUI-Crystools, rewritten in plain JS with fixes for:
 * - CSS loading breakage (Crystools PRs #164, #228)
 * - Settings API compatibility (Crystools PR #149)
 * - Console spam on missing GPU data (Crystools PR #234)
 * - Frontend positioning for new menu layouts
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    MetricHistory,
    showGraphPopup,
    showMultiGraphPopup,
    hideGraphPopup,
    isPopupPinned,
    setPopupDirty,
} from "./resourceMonitorGraph.js";

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

/** Bar colors (must match CSS). Used for the graph popup line color. */
const BAR_COLORS = {
    cpu:   "#E8960C",
    ram:   "#0AA015",
    disk:  "#6B5B7B",
    gpu:   "#0C86F4",
    vram:  "#0EA5A5",
    temp:  "#FF6600",  // Dynamic in bar, but use orange as the chart color.
    power: "#E05020",
};

/** Default US average electricity cost per kWh. */
const DEFAULT_COST_PER_KWH = 0.16;

/** Default history duration in minutes (0 = unlimited). */
const DEFAULT_HISTORY_MINUTES = 5;

/** Available history duration options (minutes; 0 = unlimited). */
const HISTORY_DURATION_OPTIONS = [5, 10, 20, 30, 60, 0];

/**
 * Maximum rows the bars may wrap into when the menu is narrow. Wrapped rows
 * split the ~40px menu row height, so more than 2 squashes the labels.
 * Enforced via a computed min-width in updateRootMinWidth().
 */
const MAX_ROWS = 2;

/**
 * Root class for the legacy vertical .comfy-menu (Comfy.UseNewMenu = Disabled),
 * where the row-oriented flex sizing and min-width don't apply.
 */
const LEGACY_MENU_CLASS = "enhutils-legacy-menu";

/** Layout constants mirrored from resourceMonitor.css -- keep in sync. */
const BAR_MIN_WIDTH = 60;   // .enhutils-monitor { min-width }
const BAR_GAP = 4;          // #enhutils-monitor-root { gap }
const ROOT_PADDING_X = 8;   // #enhutils-monitor-root { padding: 0 4px } -- both sides

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format bytes to a human-readable string (e.g., "12.50 GB").
 * @param {number} bytes
 * @returns {string}
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

/**
 * Calculate ring buffer capacity from history duration and poll rate.
 * @param {number} minutes - History duration in minutes (0 = unlimited).
 * @param {number} rateSec - Polling interval in seconds.
 * @returns {number} Capacity (0 = unlimited).
 */
function historyCapacity(minutes, rateSec) {
    if (minutes === 0) return 0; // Unlimited mode.
    const rate = Math.max(rateSec, 0.5); // Avoid division by zero.
    return Math.ceil((minutes * 60) / rate);
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
 * @param {string} cssClass - CSS class for color theming (cpu, ram, disk, gpu, vram, temp, power).
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
 * Set the root's min-width so the visible bars never wrap past MAX_ROWS rows.
 * Cleared in the legacy vertical menu. Called whenever a bar is shown/hidden.
 *
 * @param {HTMLElement|null} root - The #enhutils-monitor-root element.
 */
function updateRootMinWidth(root) {
    if (!root) return;
    let value = "";
    if (!root.classList.contains(LEGACY_MENU_CLASS)) {
        const visible = root.querySelectorAll(".enhutils-monitor:not(.hidden)").length;
        const cols = Math.ceil(visible / MAX_ROWS);
        const width = cols > 0
            ? cols * BAR_MIN_WIDTH + (cols - 1) * BAR_GAP + ROOT_PADDING_X
            : 0;
        value = `${width}px`;
    }
    if (root.style.minWidth !== value) root.style.minWidth = value;
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
    const wasHidden = bar.element.classList.contains("hidden");
    if (percent < 0) {
        if (!wasHidden) {
            bar.element.classList.add("hidden");
            updateRootMinWidth(bar.element.parentElement);
        }
        return;
    }
    if (wasHidden) {
        bar.element.classList.remove("hidden");
        updateRootMinWidth(bar.element.parentElement);
    }

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

            // Non-NVML devices (AMD, Intel) only report VRAM.
            if (!gpu.vram_only) {
                // GPU utilization bar.
                const gpuBar = createMonitorBar("gpu", `GPU${suffix}`);
                bars[`gpu_${idx}`] = gpuBar;
                root.appendChild(gpuBar.element);
            }

            // VRAM bar.
            const vramBar = createMonitorBar("vram", `VRAM${suffix}`);
            bars[`vram_${idx}`] = vramBar;
            root.appendChild(vramBar.element);

            if (!gpu.vram_only) {
                // Temperature bar.
                const tempBar = createMonitorBar("temp", `Temp${suffix}`);
                bars[`temp_${idx}`] = tempBar;
                root.appendChild(tempBar.element);

                // Power bar.
                const powerBar = createMonitorBar("power", `Pwr${suffix}`);
                bars[`power_${idx}`] = powerBar;
                root.appendChild(powerBar.element);
            }

            maxVramUsed[idx] = 0;
        }

        // ── History Tracking ───────────────────────────────────────────

        /** Current poll rate in seconds (updated when setting changes). */
        let currentRate = 1;

        /** Current history duration in minutes (0 = unlimited). */
        let historyMinutes = DEFAULT_HISTORY_MINUTES;

        /**
         * Per-metric history buffers.
         * Keys match bar keys: "cpu", "ram", "disk", "gpu_0", "vram_0", "temp_0", "power_0", etc.
         * @type {Object<string, MetricHistory>}
         */
        const histories = {};

        /** Create a history buffer for a metric key if it doesn't exist. */
        const ensureHistory = (key) => {
            const cap = historyCapacity(historyMinutes, currentRate);
            if (!histories[key]) {
                histories[key] = new MetricHistory(cap);
            }
            return histories[key];
        };

        /** Resize all history buffers (called when duration or rate changes). */
        const resizeAllHistories = () => {
            const cap = historyCapacity(historyMinutes, currentRate);
            for (const key in histories) {
                histories[key].resize(cap);
            }
        };

        /** Clear all frontend history buffers. */
        const clearAllHistories = () => {
            for (const key in histories) {
                histories[key].clear();
            }
        };

        /**
         * Fetch history from the backend and pre-fill the frontend buffers.
         * Called on page load and when the duration setting changes.
         */
        const fetchAndLoadHistory = async () => {
            try {
                const durationSec = historyMinutes > 0 ? historyMinutes * 60 : 0;
                const resp = await api.fetchApi(
                    `${API_BASE}/history?duration=${durationSec}`
                );
                if (!resp.ok) return;
                const data = await resp.json();

                // Pre-fill each metric's history from backend data.
                const metrics = data.metrics || {};
                for (const [key, entries] of Object.entries(metrics)) {
                    const history = ensureHistory(key);
                    // Backend sends {t: epoch_seconds, v: value}; convert to {time: ms, value}.
                    const converted = entries.map((e) => ({
                        time: e.t * 1000,
                        value: e.v,
                    }));
                    history.loadFromArray(converted);
                }

                // Restore cost accumulator from backend.
                if (typeof data.total_watt_seconds === "number") {
                    totalWattSeconds = data.total_watt_seconds;
                }
            } catch (e) {
                // Backend not ready or no history yet; that's fine.
            }
        };

        // Pre-create histories for base metrics.
        for (const metric of BASE_METRICS) {
            ensureHistory(metric.id);
        }
        // Pre-create histories for GPU metrics.
        for (const gpu of gpuList) {
            const idx = gpu.index;
            ensureHistory(`gpu_${idx}`);
            ensureHistory(`vram_${idx}`);
            ensureHistory(`temp_${idx}`);
            ensureHistory(`power_${idx}`);
        }

        // ── Electricity Cost Tracking ──────────────────────────────────

        /**
         * Accumulated watt-seconds for the current session.
         * Sourced from the backend via WebSocket payload and history fetch.
         */
        let totalWattSeconds = 0;

        // Fetch existing history from backend (survives page refresh).
        await fetchAndLoadHistory();

        /** Cost per kWh (updated from settings). */
        let costPerKwh = DEFAULT_COST_PER_KWH;

        /** Currency symbol (updated from settings). */
        let currencySymbol = "$";

        /**
         * Get the current session electricity cost string.
         * @returns {string} e.g., "Session: 0.42 kWh ($0.07)"
         */
        const getCostString = () => {
            const kwh = totalWattSeconds / 3_600_000;
            const cost = kwh * costPerKwh;
            if (kwh < 0.001) return "";
            return `Session: ${kwh.toFixed(3)} kWh (${currencySymbol}${cost.toFixed(4)})`;
        };

        // ── Graph Popup Wiring (Hover + Click) ───────────────────────

        /**
         * Metadata for each bar, used to configure the graph popup.
         * Populated after bars are created.
         * @type {Object<string, {color: string, label: string, unit: string, yMax: number, getExtra: function|null}>}
         */
        const barMeta = {};

        /**
         * Ordered list of metric keys, used to build the all-metrics grid.
         * Populated in the same order bars are added to the DOM.
         * @type {string[]}
         */
        const metricOrder = [];

        /**
         * Collect all visible metrics for the multi-graph popup.
         * Filters out metrics whose bar is hidden or whose history is empty.
         * @returns {Array<{key: string, history: MetricHistory, color: string, label: string, unit: string, yMax: number, extraLine: string|null, getExtra: function|null}>}
         */
        const collectAllMetrics = () => {
            const result = [];
            for (const key of metricOrder) {
                const meta = barMeta[key];
                const history = histories[key];
                const bar = bars[key];
                if (!meta || !history || history.size < 1) continue;
                // Skip hidden (disabled) bars.
                if (bar?.element?.classList.contains("hidden")) continue;
                result.push({
                    key,
                    history,
                    color: meta.color,
                    label: meta.label,
                    unit: meta.unit,
                    yMax: meta.yMax,
                    extraLine: null,
                    getExtra: meta.getExtra || null,
                });
            }
            return result;
        };

        /**
         * Register a bar for hover and click popup behavior.
         *
         * - Hover: shows single-metric graph (unless popup is pinned).
         * - Click: toggles between pinned all-metrics grid and unpinned.
         *
         * @param {string} key - Metric key (e.g., "cpu", "gpu_0").
         * @param {Object} bar - Bar refs from createMonitorBar().
         * @param {Object} meta - Graph metadata {color, label, unit, yMax, getExtra}.
         */
        const registerBarHover = (key, bar, meta) => {
            barMeta[key] = meta;
            metricOrder.push(key);

            // Hover: show single chart (only when not pinned).
            bar.element.addEventListener("mouseenter", () => {
                if (isPopupPinned()) return;
                const history = histories[key];
                if (!history || history.size < 1) return;
                showGraphPopup(bar.element, history, {
                    color: meta.color,
                    label: meta.label,
                    unit: meta.unit,
                    yMax: meta.yMax,
                    extraLine: meta.getExtra ? meta.getExtra() : null,
                });
            });

            bar.element.addEventListener("mouseleave", () => {
                hideGraphPopup(); // No-op if pinned (handled inside hideGraphPopup).
            });

            // Click: toggle between pinned all-metrics view and unpinned.
            bar.element.addEventListener("click", (e) => {
                e.stopPropagation();
                if (isPopupPinned()) {
                    // Already pinned -- unpin and hide.
                    hideGraphPopup(true);
                } else {
                    // Pin and show all metrics.
                    const metrics = collectAllMetrics();
                    if (metrics.length > 0) {
                        showMultiGraphPopup(root, metrics);
                    }
                }
            });
        };

        // Dismiss pinned popup when clicking anywhere outside the monitor bars.
        document.addEventListener("click", (e) => {
            if (!isPopupPinned()) return;
            // If the click is inside the monitor root, individual bar handlers manage it.
            if (root.contains(e.target)) return;
            hideGraphPopup(true);
        });

        // ── Right-Click Context Menu ───────────────────────────────────

        const ctxMenu = document.createElement("div");
        ctxMenu.className = "enhutils-monitor-context-menu";
        ctxMenu.style.display = "none";
        document.body.appendChild(ctxMenu);

        const ctxClear = document.createElement("div");
        ctxClear.className = "enhutils-context-item";
        ctxClear.textContent = "Clear History";
        ctxMenu.appendChild(ctxClear);

        /** Hide the context menu. */
        const hideContextMenu = () => { ctxMenu.style.display = "none"; };

        // Show context menu on right-click anywhere on the monitor root.
        root.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            ctxMenu.style.left = e.clientX + "px";
            ctxMenu.style.top = e.clientY + "px";
            ctxMenu.style.display = "block";
        });

        // Clear history action.
        ctxClear.addEventListener("click", async (e) => {
            e.stopPropagation();
            hideContextMenu();
            hideGraphPopup(true);
            try {
                await api.fetchApi(`${API_BASE}/history/clear`, { method: "POST" });
            } catch (err) { /* ignore */ }
            clearAllHistories();
            totalWattSeconds = 0;
        });

        // Dismiss context menu on any click elsewhere.
        document.addEventListener("click", hideContextMenu);

        // Register base metric bar hovers.
        registerBarHover("cpu", bars.cpu, {
            color: BAR_COLORS.cpu, label: "CPU", unit: "%", yMax: 100, getExtra: null,
        });
        registerBarHover("ram", bars.ram, {
            color: BAR_COLORS.ram, label: "RAM", unit: "%", yMax: 100, getExtra: null,
        });
        registerBarHover("disk", bars.disk, {
            color: BAR_COLORS.disk, label: "Disk", unit: "%", yMax: 100, getExtra: null,
        });

        // Register per-GPU bar hovers.
        for (const gpu of gpuList) {
            const idx = gpu.index;
            const suffix = gpuList.length > 1 ? ` ${idx}` : "";

            // Registration order sets the order of charts in the pinned popup,
            // so it follows the DOM order of the bars created above.
            if (!gpu.vram_only) {
                registerBarHover(`gpu_${idx}`, bars[`gpu_${idx}`], {
                    color: BAR_COLORS.gpu, label: `GPU${suffix}`, unit: "%", yMax: 100, getExtra: null,
                });
            }

            registerBarHover(`vram_${idx}`, bars[`vram_${idx}`], {
                color: BAR_COLORS.vram, label: `VRAM${suffix}`, unit: "%", yMax: 100, getExtra: null,
            });

            if (!gpu.vram_only) {
                registerBarHover(`temp_${idx}`, bars[`temp_${idx}`], {
                    color: BAR_COLORS.temp, label: `Temp${suffix}`, unit: "\u00B0", yMax: 100, getExtra: null,
                });

                // Power bar hover shows cost info as extra line.
                registerBarHover(`power_${idx}`, bars[`power_${idx}`], {
                    color: BAR_COLORS.power,
                    label: `Power${suffix}`,
                    unit: "W",
                    yMax: 600,  // Will be updated dynamically from TDP.
                    getExtra: getCostString,
                });
            }
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
                root.classList.remove(LEGACY_MENU_CLASS);
                updateRootMinWidth(root);
                return;
            }
            // Legacy: insert after the queue button (vertical menu).
            root.classList.add(LEGACY_MENU_CLASS);
            updateRootMinWidth(root);
            const queueBtn = document.getElementById("queue-button");
            if (queueBtn?.parentElement) {
                queueBtn.parentElement.insertBefore(root, queueBtn.nextSibling);
                return;
            }
            // Fallback: append to body (will still show, just not ideal).
            document.body.appendChild(root);
        };

        // Position on load and reposition when menu type changes. Also sets
        // the initial min-width; updateMonitorBar() keeps it current.
        positionMonitor();
        api.addEventListener("Comfy.UseNewMenu", positionMonitor);

        // ── Listen for stats updates ───────────────────────────────────

        /** Current disk label, updated when the disk setting changes. */
        let diskLabel = "Disk";

        /** Tracks the last known power limit per GPU to set graph yMax. */
        const powerLimits = {};

        api.addEventListener(WS_EVENT, (event) => {
            const data = event?.detail;
            if (!data) return;

            // Base metrics (respect enabled toggles).
            if (enabled.cpu) {
                updateMonitorBar(bars.cpu, "CPU", data.cpu_utilization);
                ensureHistory("cpu").push(data.cpu_utilization);
            } else {
                updateMonitorBar(bars.cpu, "CPU", -1);
            }

            if (enabled.ram) {
                updateMonitorBar(bars.ram, "RAM", data.ram_used_percent, "%", {
                    used: data.ram_used,
                    total: data.ram_total,
                });
                ensureHistory("ram").push(data.ram_used_percent);
            } else {
                updateMonitorBar(bars.ram, "RAM", -1);
            }

            // Disk: show -1 (hidden) when path is "none" or no data.
            const diskPercent = (data.disk_path && data.disk_path !== "none")
                ? data.disk_used_percent
                : -1;
            updateMonitorBar(bars.disk, diskLabel, diskPercent, "%", {
                used: data.disk_used,
                total: data.disk_total,
            });
            if (diskPercent >= 0) {
                ensureHistory("disk").push(diskPercent);
            }

            // Per-GPU metrics.
            if (Array.isArray(data.gpus)) {
                for (let i = 0; i < data.gpus.length; i++) {
                    const gpu = data.gpus[i];
                    const suffix = data.gpus.length > 1 ? ` ${i}` : "";

                    const ge = gpuEnabled[i] || { gpu: true, vram: true, temp: true, power: true };

                    // GPU utilization.
                    if (bars[`gpu_${i}`]) {
                        if (ge.gpu) {
                            updateMonitorBar(bars[`gpu_${i}`], `GPU${suffix}`, gpu.gpu_utilization);
                            if (gpu.gpu_utilization >= 0) {
                                ensureHistory(`gpu_${i}`).push(gpu.gpu_utilization);
                            }
                        } else {
                            updateMonitorBar(bars[`gpu_${i}`], `GPU${suffix}`, -1);
                        }
                    }

                    // VRAM.
                    if (bars[`vram_${i}`]) {
                        if (ge.vram) {
                            // Track max VRAM used.
                            if (gpu.vram_used > (maxVramUsed[i] || 0)) {
                                maxVramUsed[i] = gpu.vram_used;
                            }
                            updateMonitorBar(bars[`vram_${i}`], `VRAM${suffix}`,
                                gpu.vram_used_percent, "%", {
                                used: gpu.vram_used,
                                total: gpu.vram_total,
                                maxUsed: maxVramUsed[i],
                            });
                            if (gpu.vram_used_percent >= 0) {
                                ensureHistory(`vram_${i}`).push(gpu.vram_used_percent);
                            }
                        } else {
                            updateMonitorBar(bars[`vram_${i}`], `VRAM${suffix}`, -1);
                        }
                    }

                    // Temperature.
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
                                ensureHistory(`temp_${i}`).push(temp);
                            }
                            // Display as degrees, with percent = temp (capped at 100 for bar width).
                            updateMonitorBar(tempBar, `Temp${suffix}`, temp >= 0 ? Math.min(temp, 100) : -1, "\u00B0");
                            // Override value to show actual temp (might be > 100).
                            if (temp >= 0) {
                                tempBar.valueEl.textContent = `${Math.round(temp)}\u00B0`;
                            }
                        }
                    }

                    // Power draw.
                    if (bars[`power_${i}`]) {
                        const watts = gpu.gpu_power_usage;
                        const limit = gpu.gpu_power_limit;
                        const powerBar = bars[`power_${i}`];

                        if (!ge.power || watts < 0) {
                            updateMonitorBar(powerBar, `Pwr${suffix}`, -1);
                        } else {
                            // Update power limit for graph yMax.
                            if (limit > 0) {
                                powerLimits[i] = limit;
                                // Update the graph popup yMax if we have it.
                                if (barMeta[`power_${i}`]) {
                                    barMeta[`power_${i}`].yMax = limit;
                                }
                            }

                            // Bar fill = percentage of TDP.
                            const tdp = powerLimits[i] || limit || 1;
                            const pct = Math.min(100, (watts / tdp) * 100);

                            // Use updateMonitorBar for the fill, then override the label.
                            updateMonitorBar(powerBar, `Pwr${suffix}`, pct, "W", {
                                used: watts * 1_000_000_000, // Not really bytes, but formatBytes won't be used here.
                                total: tdp * 1_000_000_000,
                            });
                            // Override the value text to show actual watts instead of percent.
                            powerBar.valueEl.textContent = `${Math.round(watts)}W`;
                            // Override tooltip to show watts / TDP.
                            powerBar.element.title = `Power: ${Math.round(watts)}W / ${Math.round(tdp)}W TDP`;

                            ensureHistory(`power_${i}`).push(watts);

                            // Append cost to tooltip.
                            const costStr = getCostString();
                            if (costStr) {
                                powerBar.element.title += `\n${costStr}`;
                            }
                        }
                    }
                }
            }

            // Update cost accumulator from backend.
            if (typeof data.total_watt_seconds === "number") {
                totalWattSeconds = data.total_watt_seconds;
            }

            // Notify the graph popup that new data is available.
            setPopupDirty();
        });

        // ── Register settings ──────────────────────────────────────────
        //
        // NOTE: ComfyUI renders settings in reverse registration order,
        // so we register bottom-to-top. Desired display order:
        //   Rate, History, CPU, RAM, Disk, GPU, VRAM, Temp, Power, Cost, Currency

        /** Track which metrics are enabled so the WS listener can respect them. */
        const enabled = { cpu: true, ram: true };
        const gpuEnabled = {};

        // ── Electricity cost settings (registered first = displayed last) ──

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.ElectricityCurrency",
            name: "Resource Monitor - Currency symbol",
            type: "text",
            defaultValue: "$",
            onChange: (value) => {
                currencySymbol = value || "$";
            },
        });

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.ElectricityCostPerKwh",
            name: "Resource Monitor - Electricity cost per kWh",
            type: "slider",
            defaultValue: DEFAULT_COST_PER_KWH,
            attrs: { min: 0, max: 1, step: 0.01 },
            onChange: (value) => {
                costPerKwh = parseFloat(value) || DEFAULT_COST_PER_KWH;
            },
        });

        // ── Per-GPU toggles (registered first = displayed last) ────────

        // Reverse GPU list so multi-GPU systems show GPU 0 first in settings.
        const gpuListReversed = [...gpuList].reverse();

        for (const gpu of gpuListReversed) {
            const idx = gpu.index;
            const suffix = gpuList.length > 1 ? ` ${idx}` : "";

            gpuEnabled[idx] = { gpu: true, vram: true, temp: true, power: true };

            // VRAM-only devices (AMD, Intel) have no utilization/temp/power,
            // so only the VRAM toggle below is registered for them.
            if (!gpu.vram_only) {
                app.ui.settings.addSetting({
                    id: `EnhUtils.Monitor.ShowPower${idx}`,
                    name: `Resource Monitor - Show Power${suffix}`,
                    type: "boolean",
                    defaultValue: true,
                    onChange: async (value) => {
                        gpuEnabled[idx].power = value;
                        if (!value && bars[`power_${idx}`]) {
                            updateMonitorBar(bars[`power_${idx}`], `Pwr${suffix}`, -1);
                        }
                        try {
                            await api.fetchApi(`${API_BASE}/gpu/${idx}`, {
                                method: "PATCH",
                                body: JSON.stringify({ power: value }),
                            });
                        } catch (e) { /* ignore */ }
                    },
                });

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
            }

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

            if (!gpu.vram_only) {
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

        // ── History Duration ───────────────────────────────────────────

        app.ui.settings.addSetting({
            id: "EnhUtils.Monitor.HistoryDuration",
            name: "Resource Monitor - History duration",
            type: "combo",
            defaultValue: DEFAULT_HISTORY_MINUTES,
            options: HISTORY_DURATION_OPTIONS.map((m) => ({
                text: m === 0 ? "Unlimited" : `${m} min`,
                value: m,
            })),
            onChange: async (value) => {
                historyMinutes = parseInt(value, 10);
                if (isNaN(historyMinutes)) historyMinutes = DEFAULT_HISTORY_MINUTES;
                resizeAllHistories();
                // Re-fetch history from backend for the new duration window.
                await fetchAndLoadHistory();
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
                currentRate = parseFloat(value) || 1;
                resizeAllHistories();
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
