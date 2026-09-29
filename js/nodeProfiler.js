/**
 * Node Profiler extension -- displays execution time badges on nodes.
 *
 * Uses the LGraphBadge API (node.badges) which works on both the legacy
 * LiteGraph canvas renderer and the Nodes 2.0 Vue renderer.
 *
 * Reactivity strategy:
 * - Badge getters do a **live lookup** from the module-level profilingData Map
 *   every time they are called. No cached state on the node, no Vue refs.
 * - For the LiteGraph canvas renderer: setDirtyCanvas() triggers repaints,
 *   which calls drawBadges() -> our getter -> live data.
 * - For the Nodes 2.0 Vue renderer: direct DOM manipulation via
 *   [data-node-id] selectors. The node.badges API cannot be made
 *   reactive from external JS (badges array lacks shallowReactive
 *   treatment, bundled Vue refs are invisible to the frontend's
 *   reactivity, and usePartitionedBadges captures nodeData as a
 *   closure). DOM badges are injected as absolutely-positioned divs
 *   inside the node container.
 * - Post-execution: one final DOM update per profiled node. After that,
 *   badge values are static until the next execution clears the data.
 *
 * Features:
 * - Per-node timing badge after execution (e.g. "1.23s" or "456ms").
 * - Live elapsed-time counter on the currently executing node (100ms tick).
 * - Full subgraph support: subgraph container nodes show aggregated totals.
 * - Profiling data persists across graph/subgraph navigation and tab switches
 *   (stored in module-level Maps, not on node objects).
 * - Configurable via ComfyUI settings (enable/disable).
 *
 * Based on techniques from comfyui-profiler, ComfyUI-Dev-Utils, and ComfyUI-Easy-Use.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getUniqueIdFromNode, findNodeByExecutionId } from "./utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

const SETTING_ENABLED = "EnhUtils.Profiler.Enabled";
const SETTING_CONSOLE_SUMMARY = "EnhUtils.Profiler.ConsoleSummary";

let enabled = true;
const precision = 2;

// ═══════════════════════════════════════════════════════════════════════════
// Profiling Data Store
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-node timing data, keyed by colon-delimited execution ID (e.g. "5:12:3").
 * Stored externally so data survives graph/subgraph navigation and tab switches.
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

/** Interval ID for the badge refresh timer during execution. */
let refreshTimerId = null;

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
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
// Badge Text Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the profiling display text for a node via live lookup.
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
// Badge Attachment
// ═══════════════════════════════════════════════════════════════════════════

/** Badge colors -- eggplant purple to visually distinguish from other badges. */
const BADGE_FG = "#FFF";
const BADGE_BG = "#2B0954";

/**
 * Create a badge getter function for a node. Returns a new function
 * reference each time so that splicing it into node.badges triggers
 * the Vue renderer's reactive proxy.
 *
 * The getter does a live lookup via getProfilingText() -- no cached
 * state, no Vue refs. It always returns the current data from the
 * module-level profilingData Map.
 *
 * @param {Object} node - The LiteGraph node.
 * @returns {Function} A getter function that returns an LGraphBadge.
 */
function makeBadgeGetter(node) {
    return () => {
        // In Vue (Nodes 2.0) mode, the DOM overlay handles badge display.
        // Return empty here to avoid duplicate badges.
        if (isVueRenderer()) {
            return new LGraphBadge({ text: "" });
        }
        if (!enabled) {
            return new LGraphBadge({ text: "" });
        }
        const text = getProfilingText(node);
        if (!text) {
            return new LGraphBadge({ text: "" });
        }
        return new LGraphBadge({
            text,
            fgColor: BADGE_FG,
            bgColor: BADGE_BG,
        });
    };
}

/**
 * Attach a profiler badge getter to a node instance.
 *
 * Pushes a getter function onto node.badges and records its index.
 * The getter does a live lookup from profilingData -- no timing
 * sensitivity, works correctly whether called during nodeCreated
 * (before node.graph is set) or after full graph configuration.
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function attachBadge(node) {
    if (node._enhutils_profiler_patched) return;
    node._enhutils_profiler_patched = true;

    node.badges.push(makeBadgeGetter(node));
}

// ═══════════════════════════════════════════════════════════════════════════
// Vue Reactivity -- DOM Badge Overlay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update the profiler badge for a node in the Vue (Nodes 2.0) renderer
 * by directly manipulating the DOM.
 *
 * The node.badges API cannot be made reactive from external JS because:
 * 1. The badges array lacks the shallowReactive + Object.defineProperty
 *    interception that widgets/inputs/outputs receive.
 * 2. Vue refs from a bundled Vue instance are invisible to the frontend's
 *    Vue reactivity system (dual-runtime problem).
 * 3. The usePartitionedBadges composable captures nodeData as a closure
 *    parameter, so even re-extracting VueNodeData doesn't update it.
 *
 * Instead, we find the node's DOM element via [data-node-id] and inject
 * a small absolutely-positioned badge div. This works because the node
 * container has position:absolute and isolation:isolate.
 *
 * @param {Object} node - The LiteGraph node.
 * @param {string} text - Badge text to display, or "" to hide.
 */
function updateDomBadge(node, text) {
    const nodeEl = document.querySelector(
        `[data-node-id="${node.id}"]`
    );
    if (!nodeEl) return;

    let badge = nodeEl.querySelector(".enhutils-profiler-badge");

    if (!text) {
        if (badge) badge.style.display = "none";
        return;
    }

    if (!badge) {
        badge = document.createElement("div");
        badge.className = "enhutils-profiler-badge";
        badge.style.cssText = [
            "position: absolute",
            "bottom: -20px",
            "right: 8px",
            "background: #2B0954",
            "color: #fff",
            "font-size: 11px",
            "font-family: sans-serif",
            "padding: 2px 6px",
            "border-radius: 4px",
            "border: 2px solid #BA91EB",
            "pointer-events: none",
            "z-index: 10",
            "line-height: 1.2",
        ].join(";");
        nodeEl.appendChild(badge);
    }

    badge.textContent = text;
    badge.style.display = "";
}

/**
 * Detect whether the Vue (Nodes 2.0) renderer is active by checking
 * for a Vue-rendered node container in the DOM.
 *
 * @returns {boolean} True if Nodes 2.0 is active.
 */
function isVueRenderer() {
    return document.querySelector("[data-node-id]") !== null;
}

/**
 * Update a node's badge in both renderers.
 *
 * - LiteGraph: setDirtyCanvas triggers drawBadges() which calls the getter.
 * - Vue: directly updates the DOM badge overlay.
 *
 * @param {Object} node - The LiteGraph node.
 */
function refreshBadge(node) {
    if (isVueRenderer()) {
        const text = enabled ? getProfilingText(node) : "";
        updateDomBadge(node, text);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph Walking
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

// ═══════════════════════════════════════════════════════════════════════════
// Live Timer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update badges for all nodes that should be ticking during execution.
 * Called every 100ms by the refresh timer.
 *
 * - Splices the active node's badge (triggers Vue re-render).
 * - Splices ancestor subgraph container badges.
 * - Calls setDirtyCanvas for the LiteGraph canvas renderer.
 */
function updateLiveBadges() {
    if (!activeExecId) return;

    const useVue = isVueRenderer();

    // Update the actively executing node's badge.
    const activeNode = findNodeByExecutionId(activeExecId);
    if (activeNode && useVue) {
        refreshBadge(activeNode);
    }

    // Update ancestor subgraph container badges.
    const parts = activeExecId.split(":");
    if (parts.length > 1) {
        for (let depth = 1; depth < parts.length; depth++) {
            const prefix = parts.slice(0, depth).join(":");
            const containerNode = findNodeByExecutionId(prefix);
            if (containerNode && useVue) {
                refreshBadge(containerNode);
            }
        }
    }

    // Canvas renderer repaint (no-op in Vue mode but harmless).
    app.graph?.setDirtyCanvas?.(true, false);
}

/**
 * Start the 100ms live timer interval.
 */
function startRefreshTimer() {
    if (refreshTimerId != null) return;
    refreshTimerId = setInterval(updateLiveBadges, 100);
}

/**
 * Stop the live timer interval.
 */
function stopRefreshTimer() {
    if (refreshTimerId != null) {
        clearInterval(refreshTimerId);
        refreshTimerId = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-Execution Badge Updates
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After execution ends, refresh all profiled nodes' badges so the Vue
 * renderer picks up the final timing values. Also refreshes subgraph
 * container badges.
 */
function refreshAllProfiledBadges() {
    if (isVueRenderer()) {
        // Walk all nodes in the current graph and update DOM badges for
        // any that have profiling data. This catches nodes that weren't
        // updated during execution (e.g. 0ms nodes, nodes in the current
        // view that were resolved by exec ID from a different graph level).
        const currentGraph = app.canvas?.graph ?? app.graph;
        if (currentGraph) {
            for (const node of currentGraph.nodes ?? []) {
                refreshBadge(node);
            }
        }
    }

    // Canvas renderer repaint.
    app.graph?.setDirtyCanvas?.(true, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.NodeProfiler",

    setup() {
        // ── Settings ───────────────────────────────────────────────
        // Registered bottom-to-top (ComfyUI displays them in reverse order).

        app.ui.settings.addSetting({
            id: SETTING_CONSOLE_SUMMARY,
            name: "Node Profiler - Console summary",
            type: "boolean",
            defaultValue: true,
            tooltip: "Log the per-node execution profile to the ComfyUI server console " +
                "after each run. Independent of the badges.",
            onChange(v) {
                // Server-side flag; resent on every page load via this onChange.
                api.fetchApi("/enhutils/profiler/settings", {
                    method: "PATCH",
                    body: JSON.stringify({ console_summary: !!v }),
                }).catch(() => { /* older backend; ignore */ });
            },
        });

        app.ui.settings.addSetting({
            id: SETTING_ENABLED,
            name: "Node Profiler - Enabled",
            type: "boolean",
            defaultValue: true,
            tooltip: "Show execution time badges on nodes after workflow runs.",
            onChange(v) {
                enabled = v;
                app.graph?.setDirtyCanvas?.(true, false);
            },
        });

        // Read initial value from stored settings.
        try {
            const storedEnabled = app.ui.settings.getSettingValue(SETTING_ENABLED);
            if (storedEnabled != null) enabled = storedEnabled;
        } catch {
            // Settings not available yet; defaults are fine.
        }

        // ── Restore Badges on Load ────────────────────────────────

        // Fetch profiling results from the backend API so badges survive
        // page refreshes. The backend retains timing data from the most
        // recent execution in memory.
        fetch("/enhutils/profiler/results")
            .then((res) => res.ok ? res.json() : null)
            .then((data) => {
                if (!data || !data.node_times) return;
                const nodeTimes = data.node_times;
                if (Object.keys(nodeTimes).length === 0) return;

                for (const [execId, seconds] of Object.entries(nodeTimes)) {
                    profilingData.set(execId, { selfTime: seconds * 1000 });
                }
                computeSubgraphTotals();

                // Defer badge refresh to ensure the graph is fully loaded.
                requestAnimationFrame(() => {
                    refreshAllProfiledBadges();
                });
            })
            .catch(() => {
                // Endpoint not available (older backend); silently ignore.
            });

        // ── Subgraph Navigation Listener ──────────────────────────

        // When the user navigates into or out of a subgraph, the Vue
        // renderer destroys and recreates node DOM elements. Listen for
        // the litegraph:set-graph event to re-inject DOM badges.
        // Use a short delay to ensure Vue has mounted the new node elements.
        if (app.canvas?.canvas) {
            app.canvas.canvas.addEventListener("litegraph:set-graph", () => {
                if (profilingData.size > 0 || subgraphTotals.size > 0) {
                    setTimeout(() => {
                        refreshAllProfiledBadges();
                    }, 50);
                }
            });
        }

        // ── WebSocket Listeners ────────────────────────────────────

        // Clear profiling data when a new execution starts.
        api.addEventListener("execution_start", () => {
            profilingData.clear();
            subgraphTotals.clear();
            activeExecId = null;
            activeStartTime = 0;

            // Remove all DOM badge overlays from the previous run.
            for (const el of document.querySelectorAll(".enhutils-profiler-badge")) {
                el.remove();
            }
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

            // Refresh the finished node's badge immediately so it updates
            // in Vue mode.
            const node = findNodeByExecutionId(execId);
            if (node) refreshBadge(node);

            // Incrementally update subgraph totals so container nodes
            // show a running total as their children complete.
            const parts = execId.split(":");
            for (let depth = 1; depth < parts.length; depth++) {
                const prefix = parts.slice(0, depth).join(":");
                const current = subgraphTotals.get(prefix) || 0;
                subgraphTotals.set(prefix, current + timeMs);

                const containerNode = findNodeByExecutionId(prefix);
                if (containerNode) refreshBadge(containerNode);
            }
        });

        // Execution finished -- compute subgraph aggregates and finalize.
        api.addEventListener("enhutils.profiler.execution_end", () => {
            activeExecId = null;
            activeStartTime = 0;
            stopRefreshTimer();
            computeSubgraphTotals();
            refreshAllProfiledBadges();
        });
    },

    /**
     * Attach a profiler badge getter to each newly created node.
     * The getter does a live lookup, so it works even before node.graph
     * is fully wired up (returns "" until the graph is configured).
     *
     * @param {Object} node - The newly created node instance.
     */
    nodeCreated(node) {
        attachBadge(node);
    },

    /**
     * Attach badges to all existing nodes after a graph is loaded or
     * a workflow tab is switched. Walks into nested subgraphs so badges
     * work at every depth.
     *
     * For the Vue renderer, DOM badges need to be re-injected after Vue
     * has rendered the new node elements. We defer with requestAnimationFrame
     * to ensure the DOM is ready.
     */
    afterConfigureGraph() {
        walkGraph(app.graph, (node) => attachBadge(node));

        // Re-inject DOM badges after Vue has rendered.
        if (profilingData.size > 0 || subgraphTotals.size > 0) {
            requestAnimationFrame(() => {
                refreshAllProfiledBadges();
            });
        }
    },
});
