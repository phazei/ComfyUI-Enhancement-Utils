/**
 * Node Profiler extension -- displays execution time badges on nodes.
 *
 * Features:
 * - Per-node timing badge drawn above the title bar after execution.
 * - Live elapsed-time counter on the currently executing node.
 * - Full subgraph support: badges display inside subgraphs, and subgraph
 *   container nodes show the aggregated total time of their internal nodes.
 * - Profiling data persists across graph/subgraph navigation (stored externally,
 *   not on node objects) and only clears on the next execution_start.
 * - Configurable via ComfyUI settings (enable/disable, decimal precision).
 *
 * Based on techniques from comfyui-profiler, ComfyUI-Dev-Utils, and ComfyUI-Easy-Use.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getUniqueIdFromNode } from "./utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

const SETTING_ENABLED = "EnhUtils.Profiler.Enabled";

let enabled = true;
const precision = 2;

// ═══════════════════════════════════════════════════════════════════════════
// Profiling Data Store
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-node timing data, keyed by colon-delimited execution ID (e.g. "5:12:3").
 * Stored externally so data survives graph/subgraph navigation.
 *
 * @type {Map<string, {selfTime: number}>}
 *   selfTime is in milliseconds.
 */
const profilingData = new Map();

/**
 * Aggregated times for subgraph container nodes, keyed by the container's
 * execution ID (which is a prefix of its children's IDs).
 *
 * @type {Map<string, number>}
 *   Value is total milliseconds of all nodes inside the subgraph.
 */
const subgraphTotals = new Map();

// ── Live Timer State ──────────────────────────────────────────────────────

/** The execution ID of the currently executing node, or null. */
let activeExecId = null;

/** High-resolution timestamp (performance.now) when the active node started. */
let activeStartTime = 0;

/** Interval ID for the canvas refresh timer during execution. */
let refreshTimerId = null;

// ═══════════════════════════════════════════════════════════════════════════
// Live Timer Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start a 100ms interval that forces canvas repaints for live badge updates.
 */
function startRefreshTimer() {
    if (refreshTimerId != null) return;
    refreshTimerId = setInterval(() => {
        app.graph.setDirtyCanvas(true, false);
    }, 100);
}

/**
 * Stop the canvas refresh timer.
 */
function stopRefreshTimer() {
    if (refreshTimerId != null) {
        clearInterval(refreshTimerId);
        refreshTimerId = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Subgraph Aggregation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After execution ends, compute aggregated times for subgraph container nodes.
 *
 * For any execution ID with colons (e.g. "5:12:3"), each prefix identifies a
 * subgraph container in an ancestor graph:
 *   "5"    -> subgraph node 5 in root (contains node "5:12" and "5:12:3")
 *   "5:12" -> subgraph node 12 inside subgraph 5 (contains "5:12:3")
 *
 * We sum the self-times of all descendant nodes for each prefix.
 */
function computeSubgraphTotals() {
    subgraphTotals.clear();

    for (const [execId, data] of profilingData) {
        const parts = execId.split(":");
        if (parts.length <= 1) continue; // Root-level node, no container.

        // Build each prefix and accumulate.
        for (let depth = 1; depth < parts.length; depth++) {
            const prefix = parts.slice(0, depth).join(":");
            const current = subgraphTotals.get(prefix) || 0;
            subgraphTotals.set(prefix, current + data.selfTime);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Badge Drawing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a time value in milliseconds to a display string.
 *
 * @param {number} ms - Time in milliseconds.
 * @returns {string} Formatted string, e.g. "1.23s" or "456ms".
 */
function formatTime(ms) {
    if (ms >= 1000) {
        return (ms / 1000).toFixed(precision) + "s";
    }
    return Math.round(ms) + "ms";
}

/**
 * Draw a profiling badge above a node's title bar.
 *
 * @param {CanvasRenderingContext2D} ctx - The canvas context.
 * @param {string} text - The text to display (e.g. "1.23s").
 */
function drawBadge(ctx, text) {
    if (!text) return;

    const fgColor = LiteGraph.BADGE_FG_COLOR ?? "white";
    const bgColor = LiteGraph.BADGE_BG_COLOR ?? "#0F1F0F";
    const px = 6;
    const py = 4;
    const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;

    ctx.save();
    ctx.font = "12px sans-serif";
    const metrics = ctx.measureText(text);
    const badgeW = metrics.width + px * 2;
    const badgeH = 12 + py * 2;

    // Position above the title bar, with a small gap to match ComfyUI's built-in badges.
    const gap = 2;
    const badgeX = 0;
    const badgeY = -titleH - gap - badgeH;

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
    } else {
        ctx.rect(badgeX, badgeY, badgeW, badgeH);
    }
    ctx.fill();

    ctx.fillStyle = fgColor;
    ctx.textBaseline = "top";
    ctx.fillText(text, badgeX + px, badgeY + py);

    ctx.restore();
}

/**
 * Get the profiling display text for a node, if any.
 *
 * Checks (in order):
 * 1. If this node is the currently executing node -> live elapsed time.
 * 2. If this node has a subgraph total (it's a subgraph container) -> total time.
 * 3. If this node has a self-time from the last execution -> self-time.
 *
 * @param {Object} node - The LiteGraph node.
 * @returns {string} Display text, or empty string if no data.
 */
function getProfilingText(node) {
    let execId;
    try {
        execId = getUniqueIdFromNode(node);
    } catch {
        return "";
    }

    // Live timer for the currently executing node.
    if (activeExecId && execId === activeExecId) {
        const elapsed = performance.now() - activeStartTime;
        return formatTime(elapsed);
    }

    // Check for subgraph aggregate time (subgraph containers).
    // If a descendant node is currently executing, add its live elapsed
    // time so the subgraph badge ticks up smoothly during execution.
    const sgTotal = subgraphTotals.get(execId);
    if (sgTotal != null) {
        let liveExtra = 0;
        if (activeExecId && activeExecId.startsWith(execId + ":")) {
            liveExtra = performance.now() - activeStartTime;
        }
        return formatTime(sgTotal + liveExtra);
    }

    // Regular node self-time.
    const data = profilingData.get(execId);
    if (data) {
        return formatTime(data.selfTime);
    }

    return "";
}

// ═══════════════════════════════════════════════════════════════════════════
// Instance-Level Draw Patching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Walk a graph recursively, calling a callback on every node including
 * those inside nested subgraphs.
 *
 * @param {Object} graph - The graph to walk.
 * @param {Function} callback - Called with (node, graph) for each node.
 */
function walkGraph(graph, callback) {
    for (const node of graph.nodes ?? []) {
        callback(node, graph);
        if (node.subgraph) walkGraph(node.subgraph, callback);
    }
}

/**
 * Patch a single node instance's onDrawForeground to draw our profiling badge.
 *
 * Uses instance-level patching (property on the node object itself) so that
 * it takes priority over prototype-level patches from other extensions
 * (e.g. ComfyUI-Easy-Use). In JavaScript's prototype chain, own properties
 * are found before prototype properties, so our draw always runs last.
 *
 * The captured `orig` may be another extension's prototype-level patch --
 * we call it first (so their badge draws), then draw our badge on top with
 * an opaque background, visually replacing theirs.
 *
 * @param {Object} node - The LiteGraph node instance to patch.
 */
function patchNodeDraw(node) {
    if (node._enhutils_profiler_patched) return;

    const orig = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        const r = orig?.apply(this, arguments);

        if (enabled && !this.flags?.collapsed) {
            const text = getProfilingText(this);
            if (text) drawBadge(ctx, text);
        }

        return r;
    };
    node._enhutils_profiler_patched = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.NodeProfiler",

    setup() {
        // ── Settings ───────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: SETTING_ENABLED,
            name: "Node Profiler - Enabled",
            type: "boolean",
            defaultValue: true,
            tooltip: "Show execution time badges on nodes after workflow runs.",
            onChange(v) { enabled = v; },
        });

        // Read initial value from stored settings.
        try {
            const storedEnabled = app.ui.settings.getSettingValue(SETTING_ENABLED);
            if (storedEnabled != null) enabled = storedEnabled;
        } catch {
            // Settings not available yet; defaults are fine.
        }

        // ── WebSocket Listeners ────────────────────────────────────

        // Clear profiling data when a new execution starts.
        api.addEventListener("execution_start", () => {
            profilingData.clear();
            subgraphTotals.clear();
            activeExecId = null;
            activeStartTime = 0;
        });

        // Track the currently executing node for the live timer.
        api.addEventListener("executing", ({ detail }) => {
            if (!enabled) return;

            const nodeId = detail;
            if (nodeId) {
                activeExecId = String(nodeId);
                activeStartTime = performance.now();
                startRefreshTimer();
            } else {
                // node=null means execution finished (but execution_end
                // event carries the definitive total).
                activeExecId = null;
                activeStartTime = 0;
            }
        });

        // Per-node timing result from the backend.
        api.addEventListener("enhutils.profiler.executed", ({ detail }) => {
            if (!enabled) return;

            const execId = String(detail.node);
            const timeMs = detail.execution_time;

            profilingData.set(execId, { selfTime: timeMs });

            // Incrementally update subgraph totals so container nodes
            // show a running total as their children complete.
            const parts = execId.split(":");
            for (let depth = 1; depth < parts.length; depth++) {
                const prefix = parts.slice(0, depth).join(":");
                const current = subgraphTotals.get(prefix) || 0;
                subgraphTotals.set(prefix, current + timeMs);
            }
        });

        // Execution finished -- compute subgraph aggregates and stop timer.
        api.addEventListener("enhutils.profiler.execution_end", () => {
            activeExecId = null;
            activeStartTime = 0;
            stopRefreshTimer();
            computeSubgraphTotals();
            // Final repaint to show all badges.
            app.graph.setDirtyCanvas(true, false);
        });
    },

    /**
     * Patch each newly created node instance to draw the profiling badge.
     * Instance-level patching ensures we draw last, overriding any
     * prototype-level patches from other profiling extensions.
     *
     * @param {Object} node - The newly created node instance.
     */
    async nodeCreated(node) {
        patchNodeDraw(node);
    },

    /**
     * Patch all existing nodes after a graph is loaded from a saved workflow.
     * Walks into nested subgraphs so badges work at every depth.
     */
    async afterConfigureGraph() {
        walkGraph(app.graph, (node) => patchNodeDraw(node));
    },
});
