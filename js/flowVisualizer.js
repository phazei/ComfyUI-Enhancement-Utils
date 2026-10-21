/**
 * Flow Visualizer extension -- animated overlay of a workflow's effective data flow.
 *
 * Every real node is coloured by its depth (longest path from a source) on a
 * red -> violet spectrum, every link is drawn as a gradient between its two
 * ends, and a dashed pulse wave repeatedly travels from the sources through
 * the graph one depth step per time unit. Nodes that will not run (muted,
 * not upstream of an output node, cut off) are greyed out. The overlay is
 * simply on or off; while on it follows the selection: with nodes selected
 * only their upstream + downstream closure is highlighted (everything else
 * dimmed), with nothing selected the whole workflow is shown.
 *
 * Visual vocabulary (one meaning per style):
 *   - dashed line          -- ghost link (Set/Get style virtual hop, no noodle)
 *   - hollow diamond       -- lazy input (at the link's target end / switch slot)
 *   - diamond badge        -- switch node (has active lazy inputs)
 *   - "?" badge + faint outline -- conditional node (may not run)
 *   - pulsing ring         -- the switch(es) gating a selected conditional node
 *
 * The flow model comes from `flowGraph.js` (pure, no DOM). This file owns the
 * drawing: a dedicated `<canvas>` laid over the graph canvas, its own
 * requestAnimationFrame loop (only while the overlay is on), change
 * detection / debounced model rebuilds, the context menus, settings and
 * commands.
 *
 * Overlay placement: the canvas is appended as the LAST child of the graph
 * canvas container (`#graph-canvas-container`, the parent of
 * `app.canvas.canvas`) with `position: absolute` and NO z-index. Inside that
 * container everything we must cover (the LiteGraph canvas, the Vue
 * TransformPane, the Vue LinkOverlayCanvas, the classic DOM-widget layer)
 * paints at the z-index:auto/0 level in DOM order, so being last puts us on
 * top of them. Everything that must stay above us has an explicit positive
 * z-index (splitter overlay with side/bottom panels, minimap and canvas menu
 * z-999, selection toolbox, title editor, tooltip, selection rectangle) or is
 * a later body-level element (context menus, dialogs, toasts). Vue inserts
 * its own GraphCanvas children before the fragment's end anchor, so they
 * never land after our element.
 *
 * Link geometry mirrors the frontend's `_renderAllLinkSegments` /
 * `LitegraphLinkAdapter.renderLinkDirect` / `CanvasPathRenderer` (spline,
 * linear and straight modes, reroute control points), so the overlay sits on
 * the real noodles, and still draws when links are hidden.
 *
 * Last run: "Show last run" restyles nodes by what happened in the last run
 * (record from the profiler, `GET /enhutils/profiler/run` plus live
 * `enhutils.profiler.node_state` events; logic in `flowRun.js`): ran nodes
 * keep their colours, skipped / blocked / not-reached ones are greyed (and
 * the links that fed only them), cached / blocked / failed / changed-since
 * nodes get a badge, and the ambient waves stop. A replay bar (parked at the
 * end) animates the run in its real order: pulses travel into each node, then a running
 * ring holds on it for a time scaled by its real duration; a floating bar at
 * the bottom plays / pauses it and scrubs through it. Both go through
 * `registerFlowStateProvider(fn)`, which other features can use too.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { buildFlowModel, computeFlowSignature, nodeKey, linkKey } from "./flowGraph.js";
import { findNodeByExecutionId, focusNode } from "./utils.js";
import { registerCanvasMenuSection } from "./canvasMenu.js";
import {
    normalizeRun, createLiveRun, applyNodeState, computeRunView, buildReplayTimeline, replayEventAt,
    replayStatusAt, aggregateStatus, replaySteps, replayStepAt, replayStepTarget, replayBrackets,
} from "./flowRun.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const EXTENSION_NAME = "phazei.FlowVisualizer";
const LOG_PREFIX = "[EnhancementUtils]";

const SETTING_SHOW_GRADIENT = "EnhUtils.Flow.ShowGradient";
const SETTING_PULSE_COLOR = "EnhUtils.Flow.PulseColor";
const SETTING_SECONDS_PER_STEP = "EnhUtils.Flow.SecondsPerStep";
const SETTING_WAVE_INTERVAL = "EnhUtils.Flow.WaveInterval";
const SETTING_LINE_WIDTH = "EnhUtils.Flow.LineWidth";
const SETTING_OPACITY = "EnhUtils.Flow.Opacity";
const SETTING_DIM_STRENGTH = "EnhUtils.Flow.DimStrength";
const SETTING_MARK_LAZY = "EnhUtils.Flow.MarkLazy";
const SETTING_SOURCE_PLACEMENT = "EnhUtils.Flow.SourcePlacement";
const SETTING_LINES_UNDER = "EnhUtils.Flow.LinesUnderNodes";
const SETTING_REPLAY_DURATION = "EnhUtils.Flow.ReplayDuration";
const SETTING_REPLAY_MIN_NODE = "EnhUtils.Flow.ReplayMinNodeMs";

/** Profiler endpoint with the per-node record of the last run. */
const RUN_ENDPOINT = "/enhutils/profiler/run";

const PULSE_COLOR_DEPTH = "Shift with depth";
const PULSE_COLOR_WAVE = "One colour per wave";
const PLACEMENT_START = "At start";
const PLACEMENT_LATE = "Just before first use";

/** How often the cheap change signature is compared (ms). */
const SIGNATURE_INTERVAL_MS = 250;
/** Debounce between a detected change and the model rebuild (ms). */
const REBUILD_DEBOUNCE_MS = 150;
/** Consecutive failing frames before the overlay turns itself off. */
const MAX_CONSECUTIVE_ERRORS = 120;
/** How often the hint anchor (free canvas panel area) is re-measured (ms). */
const HINT_ANCHOR_INTERVAL_MS = 500;

/** Hue span of the depth spectrum: 0 = red (depth 0) ... 280 = violet (maxDepth). */
const HUE_SPAN = 280;
/** Golden angle, used to give each wave its own hue in "one colour per wave" mode. */
const GOLDEN_ANGLE = 137.508;

/** Pulse dash length in graph units (with a screen-pixel minimum). */
const DASH_GRAPH_LENGTH = 40;
const DASH_MIN_SCREEN_PX = 18;

/** Subgraph IO node ids (`SUBGRAPH_INPUT_ID` / `SUBGRAPH_OUTPUT_ID`, strings since 1.46). */
const SUBGRAPH_INPUT_ID = "-10";
const SUBGRAPH_OUTPUT_ID = "-20";

/** LinkDirection enum values (litegraph `globalEnums.ts`). */
const DIR_UP = 1;
const DIR_DOWN = 2;
const DIR_LEFT = 3;
const DIR_RIGHT = 4;
const DIR_CENTER = 5;

/** LinkRenderType values (litegraph `globalEnums.ts`). */
const RENDER_STRAIGHT = 0;
const RENDER_LINEAR = 1;
const RENDER_SPLINE = 2;

/** `Reroute.maxSplineOffset` -- cap on reroute control-point distance. */
const REROUTE_MAX_SPLINE_OFFSET = 80;

/** Switch / conditional badge size in screen px (graph size capped at BADGE_MAX_SCALE x this). */
const BADGE_SCREEN_PX = 14;
/** Lazy-input diamond half-size in screen px. */
const LAZY_DIAMOND_SCREEN_PX = 5;
/** At extreme zoom-out, marks stop growing in graph units past this multiple (they shrink on screen). */
const BADGE_MAX_SCALE = 4;
/**
 * How long a newly executing node must keep running before the trace
 * switches to it (ms). The ring follows immediately; this only stops a run of
 * fast nodes from flickering the dimming.
 */
const RUN_TRACE_SETTLE_MS = 150;
/** How long the running ring fades out after a node finishes (ms). */
const RUN_AFTERGLOW_MS = 500;
/** Flash intensity held while a wave is inside a container's depth span (peak is 1). */
const FLASH_SUSTAIN = 0.35;
/** Max gates named in the gate hint before "+N more". */
const GATE_HINT_MAX = 3;
/** Max characters of one gate title in the hint. */
const GATE_TITLE_MAX = 40;

/** How long a "nothing to replay" style notice stays up (ms). */
const NOTICE_MS = 3000;
/** How often the run view re-checks for nodes changed since the run (ms). */
const RUN_VIEW_REFRESH_MS = 500;

const GREY = "rgb(128,128,128)";
/** Outline opacity of greyed (won't run / didn't run) nodes -- about what selection dimming leaves. */
const GREY_OUTLINE_ALPHA = 0.15;
const WASH_FILL = "rgba(20,20,20,0.55)";
const BADGE_BG = "rgba(0,0,0,0.8)";
const GATE_RING = "#fff";

/**
 * Last-run status badges (top-left corner of the node): glyph + colour.
 * Ran and skipped nodes get none (normal colours / grey wash say it).
 */
const RUN_BADGES = Object.freeze({
    cached: { glyph: "\u21BA", color: "#7ec8ff" },
    blocked: { glyph: "\u2298", color: "#b0b0b0" },
    error: { glyph: "!", color: "#ff5252" },
    interrupted: { glyph: "!", color: "#ffb020" },
    changed: { glyph: "\u0394", color: "#e8e8e8" },
});
/** Outline colour override for failed nodes. */
const RUN_OUTLINE_COLORS = Object.freeze({ error: RUN_BADGES.error.color, interrupted: RUN_BADGES.interrupted.color });
/** Run statuses that grey a node out (it did not run). */
const RUN_GREY = new Set(["skipped", "blocked", "not_reached"]);
/** Run statuses that settle a node's fate (its conditional "?" styling no longer applies). */
const RUN_SETTLED = new Set(["ran", "cached", "blocked", "error", "interrupted", "skipped", "not_reached"]);
/** Small integer per status, for the static-layer hash. */
const STATUS_CODES = new Map([...RUN_SETTLED, "running", "pending", "changed"].map((s, i) => [s, i + 1]));

/**
 * Hash code of a runtime status.
 *
 * @param {string|null} status - Status.
 * @returns {number} 0 for none, else a small positive integer.
 */
function statusCode(status) {
    return status ? STATUS_CODES.get(status) ?? 31 : 0;
}

/** Precomputed `hsl()` strings for integer hues 0..360. */
const HUE_COLORS = [];
for (let h = 0; h <= 360; h++) HUE_COLORS.push(`hsl(${h}, 90%, 55%)`);

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

/** User-configurable values (mirrors the settings). */
const config = {
    showGradient: true,
    pulseColor: "depth",
    secondsPerStep: 0.6,
    waveInterval: 5,
    lineWidth: 3,
    opacity: 0.75,
    dimStrength: 0.8,
    markLazy: true,
    sourcePlacement: "start",
    linesUnder: false,
    replayDuration: 12,
    replayMinNodeMs: 500,
};

/** Mutable renderer state. */
const state = {
    /** "off" | "on" (on = follows the selection; nothing selected = whole workflow). */
    mode: "off",
    /** Overlay was turned on by "Trace flow from here": turn it off again when the selection is cleared. */
    transient: false,
    /** Graph the transient trace was last seen with a selection in (navigation doesn't count as deselecting). */
    transientGraph: null,
    /** @type {HTMLCanvasElement|null} */
    overlay: null,
    /** @type {CanvasRenderingContext2D|null} */
    ctx: null,
    rafId: 0,
    /** performance.now() when the overlay was turned on (wave clock origin). */
    epoch: 0,

    model: null,
    modelRoot: null,
    modelVersion: 0,
    signature: null,
    lastSignatureCheck: 0,
    rebuildTimer: 0,
    /** Set when the model must be rebuilt at the next check without waiting for a signature change. */
    modelDirty: true,
    /** Rebuild right away (no debounce) at the next check. */
    rebuildNow: true,
    modelError: false,

    viewGraph: null,
    trace: null,
    traceKey: null,
    traceGraph: null,
    selectionCount: 0,
    /** Union of `getGateTrace` over the selected conditional nodes, or null. */
    gate: null,
    /** Hint line naming the gates, or "". */
    gateHint: "",

    /** Exec id of the node the backend is executing (`executing` event), or null. */
    runId: null,
    /** performance.now() when `runId` last changed. */
    runSince: 0,
    /** Running node traced while nothing is selected (after RUN_TRACE_SETTLE_MS), or null. */
    runTraceId: null,
    /** Cached `runId` -> node lookup: { id, modelVersion, node }. */
    runNode: { id: null, modelVersion: -1, node: null },

    frame: 0,
    consecutiveErrors: 0,

    hintAnchor: { x: 12, y: 12, w: 0, time: 0 },

    /** Bumped by every settings change (invalidates the static layer). */
    configVersion: 0,
    /** Cached static line layer (steady links, lazy diamonds): offscreen canvas + what it was rendered for. */
    staticLines: { canvas: null, ctx: null, hash: -1, modelVersion: -1, traceKey: null, configVersion: -1 },
    /** Cached static node layer (washes, outlines, badges). */
    staticNodes: { canvas: null, ctx: null, hash: -1, modelVersion: -1, traceKey: null, configVersion: -1 },
    /**
     * Separate line-layer canvas, used only while lines are drawn under nodes.
     * Vue renderer: in the DOM right after the LiteGraph canvas (below the
     * node layer). Classic renderer: detached, composited into the LiteGraph
     * canvas from its `onRender` hook (after links, before nodes).
     */
    lines: { canvas: null, ctx: null },
    /** LiteGraph canvases whose `onRender` is already hooked. */
    hookedCanvases: new WeakSet(),
};

/**
 * Last run ("Show last run" / "Replay last run"). The record is kept current
 * from the profiler's WebSocket events whether or not it is shown.
 */
const lastRun = {
    /** Run view on: nodes show what happened in the last run. */
    show: false,
    /** Normalised run (flowRun.js), or null. */
    run: null,
    /** Bumped on every change of `run`. */
    version: 0,
    /** A fetch is in flight. */
    fetching: false,
    /** The endpoint failed (old backend?); shown as a hint. */
    unavailable: false,
    /** Prompt id a mid-run fetch (for the queued prompt) was already made for. */
    promptFetchedFor: null,
    /** Cached computeRunView result and what it was computed for. */
    view: null,
    viewKey: "",
    /** performance.now() of the last computeRunView. */
    viewTime: 0,
    /**
     * Open replay or null: { pending, timeline, steps, promptId, eventIndex, time, playing, clock }.
     * `pending` = waiting for a fetch / the model to build the timeline. `time` is the
     * replay position (s); while `playing` it is `(performance.now() - clock) / 1000`.
     * It stays open (paused at the end) until closed.
     */
    replay: null,
    /** Replay time (s) of the current frame. */
    replayTime: 0,
    /** Transient notice { text, until } or null. */
    notice: null,
    /** Root graph id the last run was shown on (switching workflows hides it). */
    graphId: null,
};

/** Cached sampled link / ghost geometry: key -> geometry entry. */
const geomCache = new Map();
/** Cached link gradients: key -> { x0, y0, x1, y1, h0, h1, grad }. */
const gradCache = new Map();
/** Messages already logged by `warnOnce`. */
const warned = new Set();
/** Registered runtime flow-state providers. */
const flowStateProviders = [];

// ═══════════════════════════════════════════════════════════════════════════
// Small Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Log a warning once per distinct key.
 *
 * @param {string} key - Dedup key (also the message).
 * @param {*} [detail] - Optional extra value (e.g. the caught error).
 * @returns {void}
 */
function warnOnce(key, detail) {
    if (warned.has(key)) return;
    warned.add(key);
    if (detail !== undefined) console.warn(`${LOG_PREFIX} Flow visualizer: ${key}`, detail);
    else console.warn(`${LOG_PREFIX} Flow visualizer: ${key}`);
}

/**
 * Clamp a number into a range, falling back for non-finite input.
 *
 * @param {*} value - Raw value (setting values may arrive as strings).
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @param {number} fallback - Used when `value` is not a finite number.
 * @returns {number} Clamped number.
 */
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Hue for a time/depth position on the whole-workflow scale.
 *
 * @param {number} t - Position in depth units.
 * @param {number} maxDepth - Model max depth (>= 1).
 * @returns {number} Hue in degrees, 0 (red) .. HUE_SPAN (violet).
 */
function hueOf(t, maxDepth) {
    if (!Number.isFinite(t)) return 0;
    const f = Math.min(1, Math.max(0, t / maxDepth));
    return f * HUE_SPAN;
}

/**
 * Colour string for a hue.
 *
 * @param {number} hue - Hue in degrees (any value, wrapped into 0..360).
 * @returns {string} Precomputed `hsl()` string.
 */
function hueColor(hue) {
    let h = Math.round(hue) % 360;
    if (h < 0) h += 360;
    return HUE_COLORS[h];
}

/**
 * Whether a value looks like a LiteGraph node (excludes groups, reroutes and subgraph IO nodes).
 *
 * @param {*} item - Selected item.
 * @returns {boolean} True for graph nodes.
 */
function isGraphNode(item) {
    if (!item) return false;
    try {
        if (typeof LGraphNode !== "undefined" && item instanceof LGraphNode) return true;
    } catch {
        // fall through to duck typing
    }
    return Array.isArray(item.inputs) && Array.isArray(item.outputs) && "mode" in item && item.id != null;
}

/**
 * Node list of a graph.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @returns {Array<Object>} Nodes (never null).
 */
function getGraphNodes(graph) {
    return graph?._nodes || graph?.nodes || [];
}

/**
 * Add a rounded rectangle to the current path (falls back to a plain rect).
 *
 * @param {CanvasRenderingContext2D} ctx - Target context.
 * @param {number} x - Left.
 * @param {number} y - Top.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @param {number} r - Corner radius.
 * @returns {void}
 */
function addRoundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
    else ctx.rect(x, y, w, h);
}

// ═══════════════════════════════════════════════════════════════════════════
// Runtime State Providers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register a runtime flow-state provider. Providers override the static
 * styling of real nodes (and, aggregated, of subgraph containers); the
 * built-in one is the last-run view below.
 *
 * `fn(execId)` returns `null` (no opinion) or `{ status }` with status one of
 * "ran" | "cached" | "blocked" | "error" | "interrupted" | "skipped" |
 * "not_reached" | "pending" | "running" | "changed":
 *   - "skipped" / "blocked" / "not_reached" grey the node out
 *   - "running" flashes it and draws the running ring
 *   - "cached" / "blocked" / "error" / "interrupted" / "changed" add a badge
 *   - "pending" is only dimmed during a replay
 * With no provider answering, the overlay shows the static model only.
 *
 * @param {function(string): (null|{status: string})} fn - Provider.
 * @returns {function(): void} Unregister function.
 */
export function registerFlowStateProvider(fn) {
    if (typeof fn !== "function") return () => {};
    flowStateProviders.push(fn);
    return () => {
        const i = flowStateProviders.indexOf(fn);
        if (i >= 0) flowStateProviders.splice(i, 1);
    };
}

/** Scratch list of statuses for `getRuntimeStatus`. */
const statusScratch = [];

/**
 * Combined runtime status of a node (or a container: all its exec ids) from
 * all providers: the strongest one (running > error > interrupted > changed >
 * ran > cached > blocked > pending > not_reached > skipped).
 *
 * @param {Array<string>} execIds - Exec ids of the node.
 * @returns {string|null} Status, or null when no provider has an opinion.
 */
function getRuntimeStatus(execIds) {
    if (flowStateProviders.length === 0 || !execIds?.length) return null;
    statusScratch.length = 0;
    for (const fn of flowStateProviders) {
        for (const id of execIds) {
            let r = null;
            try {
                r = fn(id);
            } catch (err) {
                warnOnce("a flow state provider threw", err);
            }
            const status = r?.status;
            if (!status) continue;
            if (status === "running") return status;
            statusScratch.push(status);
        }
    }
    return statusScratch.length ? aggregateStatus(statusScratch) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Last Run
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace the last-run record and invalidate what was derived from it.
 *
 * @param {Object|null} run - Normalised run.
 * @returns {void}
 */
function setLastRun(run) {
    lastRun.run = run;
    lastRun.version++;
}

/**
 * Fetch the profiler's record of the current / last run. Never throws.
 *
 * @returns {Promise<void>} Resolves when done (also on failure).
 */
async function fetchLastRun() {
    if (lastRun.fetching) return;
    lastRun.fetching = true;
    try {
        const res = await api.fetchApi(RUN_ENDPOINT);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const run = normalizeRun(await res.json());
        lastRun.unavailable = false;
        // A response that predates the live run we are already tracking must not replace it.
        const live = lastRun.run;
        if (live?.status === "running" && run?.promptId !== live.promptId && run?.status !== "running") return;
        setLastRun(run);
    } catch (err) {
        lastRun.unavailable = true;
        warnOnce("could not load the last run from the profiler", err);
    } finally {
        lastRun.fetching = false;
    }
}

/**
 * A prompt started executing: start a fresh live record.
 *
 * @param {Object} detail - `execution_start` detail { prompt_id }.
 * @returns {void}
 */
function onRunStart(detail) {
    setLastRun(createLiveRun(detail?.prompt_id));
}

/**
 * Live per-node state from the profiler. The queued prompt (needed for
 * skipped / changed) is not in these events, so it is fetched once per run.
 *
 * @param {Object} detail - `enhutils.profiler.node_state` detail.
 * @returns {void}
 */
function onNodeState(detail) {
    if (!detail || typeof detail !== "object") return;
    const promptId = detail.prompt_id == null ? "" : String(detail.prompt_id);
    if (!lastRun.run || (promptId && lastRun.run.promptId !== promptId)) lastRun.run = createLiveRun(promptId);
    if (applyNodeState(lastRun.run, detail)) lastRun.version++;
    if (lastRun.show && !lastRun.run.prompt && lastRun.promptFetchedFor !== promptId) {
        lastRun.promptFetchedFor = promptId;
        fetchLastRun();
    }
}

/**
 * The run finished: fetch the final record when it is on screen (otherwise
 * it is fetched when the view is shown).
 *
 * @returns {void}
 */
function onRunEnd() {
    if (lastRun.show) fetchLastRun();
}

/**
 * Run-view statuses for the current model (recomputed when the run, model or
 * workflow changed).
 *
 * @param {Object} model - Flow model.
 * @returns {Object|null} computeRunView result, or null when there is no run.
 */
function getRunView(model) {
    if (!lastRun.run || !model) {
        lastRun.view = null;
        lastRun.viewKey = "";
        return null;
    }
    const workflowId = app.graph?.id ?? "";
    const key = `${lastRun.version}|${state.modelVersion}|${workflowId}`;
    // Widget edits don't change the model, so "changed since the run" is
    // also re-checked on a timer (cheap: one pass over the real nodes).
    const now = performance.now();
    if (key !== lastRun.viewKey || now - lastRun.viewTime >= RUN_VIEW_REFRESH_MS) {
        lastRun.viewKey = key;
        lastRun.viewTime = now;
        lastRun.view = computeRunView(lastRun.run, model, { workflowId, rootGraph: app.graph });
    }
    return lastRun.view;
}

/**
 * Whether the run view is styling the graph this frame.
 *
 * @returns {boolean} True when shown with a usable run.
 */
function runViewActive() {
    return lastRun.show && !!lastRun.view && !lastRun.view.foreign;
}

/**
 * Built-in flow-state provider: the last run (final statuses, or the replay's
 * statuses at the current replay time).
 *
 * @param {string} execId - Exec id.
 * @returns {null|{status: string}} Status.
 */
function lastRunProvider(execId) {
    if (!runViewActive()) return null;
    const statuses = lastRun.view.statuses;
    const replay = lastRun.replay;
    if (replayAnimating()) {
        const status = replayStatusAt(replay.timeline, statuses, execId, lastRun.replayTime);
        return status ? { status } : null;
    }
    const status = statuses.get(execId);
    // Live run: the running ring follows the `executing` event instead (a
    // lazy switch stays "running" in the record while its branch executes).
    if (!status || status === "running") return null;
    return { status };
}
registerFlowStateProvider(lastRunProvider);

/**
 * Final (not replay-time) run status of an exec id, for link greying.
 *
 * @param {string} execId - Exec id.
 * @returns {string|null} Status.
 */
function finalRunStatus(execId) {
    return runViewActive() ? lastRun.view.statuses.get(execId) ?? null : null;
}

/**
 * Final (not replay-time) run status of a node / container's exec ids.
 *
 * @param {Array<string>} execIds - Exec ids.
 * @returns {string|null} Aggregated status.
 */
function finalStatusOf(execIds) {
    if (!runViewActive() || !execIds?.length) return null;
    const list = [];
    for (const id of execIds) {
        const s = finalRunStatus(id);
        if (s) list.push(s);
    }
    return list.length ? aggregateStatus(list) : null;
}

/**
 * Whether a link / ghost carried nothing in the last run: every node it
 * feeds was skipped, blocked or not reached.
 *
 * @param {Object|null} info - Link / virtual info (with `toIds`).
 * @returns {boolean} True to draw it grey.
 */
function linkIdleInRun(info) {
    const ids = info?.toIds;
    if (!ids?.length || !runViewActive()) return false;
    for (const id of ids) {
        const s = finalRunStatus(id);
        if (!s || !RUN_GREY.has(s)) return false;
    }
    return true;
}

/**
 * A fresh replay state (no timeline yet).
 *
 * @returns {Object} Replay state.
 */
function newReplay() {
    return {
        timeline: null, steps: [], brackets: [], builtKey: "", eventIndex: -1,
        time: 0, playing: false, clock: 0, unavailable: "",
    };
}

/**
 * Show / hide the last run. Showing turns the overlay on and opens the replay
 * bar at step 0 (the finished picture); hiding turns the overlay off
 * altogether.
 *
 * @param {boolean} on - Show.
 * @returns {void}
 */
function showLastRun(on) {
    if (!on) {
        if (lastRun.show) setMode("off");
        return;
    }
    if (state.mode === "off") setMode("on");
    lastRun.show = true;
    lastRun.graphId = app.graph?.id ?? null;
    lastRun.replay = newReplay();
    lastRun.replayTime = 0;
    fetchLastRun();
}

/**
 * Flow-visualization toggle (menu "Show" / "Hide", command). While the last
 * run is shown it switches to the plain visualization instead of hiding.
 *
 * @returns {void}
 */
function toggleFlow() {
    if (lastRun.show) {
        lastRun.show = false;
        lastRun.replay = null;
        lastRun.replayTime = 0;
        if (state.mode === "off") setMode("on");
        return;
    }
    toggleMode();
}

/**
 * Why the replay can't be used right now ("" when it can).
 *
 * @param {Object} model - Flow model.
 * @returns {string} Reason shown in the (dimmed) bar.
 */
function replayUnavailableReason(model) {
    const run = lastRun.run;
    if (!run) {
        return lastRun.fetching ? "Loading the last run..." :
            lastRun.unavailable ? "Last run unavailable (profiler endpoint not reachable)" : "Nothing has run yet";
    }
    if (run.status === "running") return "Running... the replay is available when the run finishes";
    const view = getRunView(model);
    if (!view) return "Loading the last run...";
    if (view.foreign) return "The last run was a different workflow";
    return "";
}

/**
 * Advance the replay. (Re)builds the timeline whenever a finished run arrives
 * -- parked at step 0 (time 0, the finished picture); while a run is
 * live (or there is nothing usable) the bar is disabled. Playback stops at
 * the end and stays there.
 *
 * @param {Object} model - Flow model.
 * @returns {void}
 */
function updateReplay(model) {
    const replay = lastRun.replay;
    if (!replay) return;
    const reason = replayUnavailableReason(model);
    if (reason) {
        replay.unavailable = reason;
        replay.timeline = null;
        replay.steps = [];
        replay.brackets = [];
        replay.builtKey = "";
        replay.playing = false;
        replay.eventIndex = -1;
        lastRun.replayTime = 0;
        return;
    }
    const run = lastRun.run;
    const key = `${run.promptId}|${run.status}|${run.nodes?.size ?? 0}`;
    if (key !== replay.builtKey) {
        replay.builtKey = key;
        const timeline = buildReplayTimeline(run, model, {
            maxDuration: config.replayDuration,
            minNodeMs: config.replayMinNodeMs,
        });
        replay.timeline = timeline;
        replay.steps = replaySteps(timeline);
        replay.brackets = replayBrackets(replay.steps, REPLAY_BRACKET_LEVELS);
        replay.time = 0; // step 0: the finished picture, handle at the start
        replay.playing = false;
        replay.clock = performance.now() - replay.time * 1000;
    }
    if (!replay.timeline.events.length) {
        replay.unavailable = "Nothing to replay -- no node of this workflow ran";
        replay.playing = false;
        lastRun.replayTime = 0;
        return;
    }
    replay.unavailable = "";
    if (replay.playing) {
        replay.time = (performance.now() - replay.clock) / 1000;
        if (replay.time >= replay.timeline.duration) {
            replay.time = replay.timeline.duration;
            replay.playing = false;
        }
    }
    lastRun.replayTime = replay.time;
    replay.eventIndex = replayEventAt(replay.timeline, replay.time);
}

/**
 * Whether the replay is between its ends (step 0 and the end both show the
 * finished run, like the plain run view).
 *
 * @returns {boolean} True while statuses follow the replay time.
 */
function replayAnimating() {
    const replay = lastRun.replay;
    return replayUsable() && replay.time > 0 && replay.time < replay.timeline.duration;
}

/**
 * Whether the replay can be played / scrubbed now.
 *
 * @returns {boolean} True when a non-empty timeline is built.
 */
function replayUsable() {
    return !!lastRun.replay?.timeline?.events.length && !lastRun.replay.unavailable;
}
/**
 * Play / pause the replay. Playing from the end starts over.
 *
 * @param {boolean} [play] - Play (default: toggle).
 * @returns {void}
 */
function setReplayPlaying(play) {
    const replay = lastRun.replay;
    if (!replayUsable()) return;
    const on = play ?? !replay.playing;
    if (on && replay.time >= replay.timeline.duration - 1e-3) replay.time = 0;
    replay.playing = on;
    replay.clock = performance.now() - replay.time * 1000;
}

/**
 * Move the replay to time `t` (clamped); keeps playing if it was.
 *
 * @param {number} t - Replay time (s).
 * @returns {void}
 */
function seekReplay(t) {
    const replay = lastRun.replay;
    if (!replayUsable() || !Number.isFinite(t)) return;
    replay.time = Math.min(replay.timeline.duration, Math.max(0, t));
    replay.clock = performance.now() - replay.time * 1000;
    lastRun.replayTime = replay.time;
    replay.eventIndex = replayEventAt(replay.timeline, replay.time);
}

/**
 * Pause and jump to the next / previous step.
 *
 * @param {number} dir - +1 forward, -1 backward.
 * @returns {void}
 */
function stepReplay(dir) {
    const replay = lastRun.replay;
    if (!replayUsable()) return;
    replay.playing = false;
    seekReplay(replayStepTarget(replay.steps, replay.timeline.duration, replay.time, dir));
}

/**
 * Text for the replay bar: the step at the current time.
 *
 * @param {Object|null} model - Flow model.
 * @returns {{label: string, count: string}} Step description and "k / N".
 */
function replayStepText(model) {
    const replay = lastRun.replay;
    if (!replayUsable()) return { label: replay?.unavailable || "Loading the last run...", count: "" };
    const steps = replay.steps;
    const total = steps.length;
    const i = replayAnimating() ? replayStepAt(steps, replay.time) : -1;
    if (i < 0) {
        // Both ends show the finished run (step 0 and after the last step).
        return { label: `Last run -- ${total} step${total === 1 ? "" : "s"}`, count: `${replay.time <= 0 ? 0 : total} / ${total}` };
    }
    const step = steps[i];
    const count = `${i + 1} / ${total}`;
    if (step.status === "cached") {
        const n = step.events.length;
        return { label: `${n} cached node${n === 1 ? "" : "s"} (output reused)`, count };
    }
    const ev = step.events[0];
    const node = model?.nodes?.get(ev.execId)?.node;
    const title = node ? formatNodeTitle(node) : ev.execId;
    return { label: `${title} (#${ev.execId}) -- ${ev.status} ${formatSeconds(ev.time)}`, count };
}

/**
 * Show a transient hint.
 *
 * @param {string} text - Hint text.
 * @returns {void}
 */
function setNotice(text) {
    lastRun.notice = { text, until: performance.now() + NOTICE_MS };
}

/**
 * Format seconds for hints ("850 ms", "12.3 s", "2 min 5 s").
 *
 * @param {number} s - Seconds.
 * @returns {string} Text.
 */
function formatSeconds(s) {
    if (!Number.isFinite(s)) return "?";
    if (s < 1) return `${Math.round(s * 1000)} ms`;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Order and wording of the counts in the run summary hint. */
const SUMMARY_PARTS = [
    ["ran", "ran"], ["cached", "cached"], ["skipped", "skipped"], ["blocked", "blocked"],
    ["error", "failed"], ["interrupted", "interrupted"], ["not_reached", "not reached"],
    ["running", "running"], ["pending", "pending"], ["changed", "changed since"],
];

/**
 * Hint lines for the run view / replay.
 *
 * @param {Object} model - Flow model.
 * @param {Array<string>} out - Receives the lines.
 * @returns {void}
 */
function pushRunHints(model, out) {
    const notice = lastRun.notice;
    if (notice) {
        if (performance.now() < notice.until) out.push(notice.text);
        else lastRun.notice = null;
    }
    if (!lastRun.show) return;
    const run = lastRun.run;
    const view = lastRun.view;
    // No run / another workflow's run: the (disabled) replay bar says so.
    if (!run || view?.foreign) return;
    // The replay's current step is shown in the replay bar.
    const counts = view?.counts ?? {};
    const parts = [];
    for (const [key, label] of SUMMARY_PARTS) {
        if (counts[key]) parts.push(`${counts[key]} ${label}`);
    }
    const outcome = run.status === "running" ? "running" :
        run.status === "success" || run.status === "done" ? `finished in ${formatSeconds(run.total)}` :
            `${run.status} after ${formatSeconds(run.total)}`;
    out.push(`Last run: ${outcome}${parts.length ? ` -- ${parts.join(", ")}` : ""}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Link Geometry
// ═══════════════════════════════════════════════════════════════════════════

// ── Scratch Buffers ─────────────────────────────────────────────────────────

/** Growable scratch polyline used while sampling a path (x,y pairs). */
const pathBuf = { data: new Float64Array(4096), n: 0 };

/** Scratch geometry signature (compared against the cached one). */
const sigBuf = { data: new Float64Array(256), n: 0 };

/** Scratch endpoint record filled by `resolveLinkEndpoints`. */
const endpoints = { sx: 0, sy: 0, sdir: 0, ex: 0, ey: 0, edir: 0 };

/** Scratch [cos, sin] pair. */
const angleOut = [0, 0];

/** Scratch node bounds [x, y, w, h]. */
const boundsOut = [0, 0, 0, 0];

/**
 * Append a point to the scratch polyline, skipping exact duplicates of the last point.
 *
 * @param {number} x - X in graph units.
 * @param {number} y - Y in graph units.
 * @returns {void}
 */
function pathPush(x, y) {
    let { data, n } = pathBuf;
    if (n > 0 && data[2 * n - 2] === x && data[2 * n - 1] === y) return;
    if (2 * n + 2 > data.length) {
        const bigger = new Float64Array(data.length * 2);
        bigger.set(data);
        pathBuf.data = data = bigger;
    }
    data[2 * n] = x;
    data[2 * n + 1] = y;
    pathBuf.n = n + 1;
}

/**
 * Append a value to the scratch signature.
 *
 * @param {number} v - Value.
 * @returns {void}
 */
function sigPush(v) {
    let { data, n } = sigBuf;
    if (n + 1 > data.length) {
        const bigger = new Float64Array(data.length * 2);
        bigger.set(data);
        sigBuf.data = data = bigger;
    }
    data[n] = v;
    sigBuf.n = n + 1;
}

/**
 * X component of a LinkDirection unit offset.
 *
 * @param {number} dir - LinkDirection value.
 * @returns {number} -1, 0 or 1.
 */
function dirDX(dir) {
    return dir === DIR_LEFT ? -1 : dir === DIR_RIGHT ? 1 : 0;
}

/**
 * Y component of a LinkDirection unit offset.
 *
 * @param {number} dir - LinkDirection value.
 * @returns {number} -1, 0 or 1.
 */
function dirDY(dir) {
    return dir === DIR_UP ? -1 : dir === DIR_DOWN ? 1 : 0;
}

// ── Segment Builders ────────────────────────────────────────────────────────

/**
 * Sample one cubic bezier link segment into the scratch polyline. Control
 * points follow `LitegraphLinkAdapter.renderLinkDirect`: an explicit control
 * offset when given, else an offset of 0.25 * distance along the slot
 * direction (CENTER / NONE => no offset).
 *
 * @param {number} ax - Start x.
 * @param {number} ay - Start y.
 * @param {number} bx - End x.
 * @param {number} by - End y.
 * @param {number} startDir - LinkDirection at the start.
 * @param {number} endDir - LinkDirection at the end.
 * @param {number[]|null} sc - Explicit start control offset [dx, dy], or null.
 * @param {number[]|null} ec - Explicit end control offset [dx, dy], or null.
 * @returns {void}
 */
function addSplineSegment(ax, ay, bx, by, startDir, endDir, sc, ec) {
    const dist = Math.hypot(bx - ax, by - ay);
    const off = dist * 0.25;
    const c1x = sc ? ax + (sc[0] || 0) : ax + dirDX(startDir) * off;
    const c1y = sc ? ay + (sc[1] || 0) : ay + dirDY(startDir) * off;
    const c2x = ec ? bx + (ec[0] || 0) : bx + dirDX(endDir) * off;
    const c2y = ec ? by + (ec[1] || 0) : by + dirDY(endDir) * off;

    const steps = Math.max(8, Math.min(48, Math.ceil(dist / 14)));
    pathPush(ax, ay);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const b0 = u * u * u;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const b3 = t * t * t;
        pathPush(b0 * ax + b1 * c1x + b2 * c2x + b3 * bx, b0 * ay + b1 * c1y + b2 * c2y + b3 * by);
    }
}

/**
 * Add one LINEAR_LINK segment (pathRenderer `buildLinearPath`, l = 15):
 * start -> start + dir*l -> end + dir*l -> end.
 *
 * @param {number} ax - Start x.
 * @param {number} ay - Start y.
 * @param {number} bx - End x.
 * @param {number} by - End y.
 * @param {number} startDir - LinkDirection at the start.
 * @param {number} endDir - LinkDirection at the end.
 * @returns {void}
 */
function addLinearSegment(ax, ay, bx, by, startDir, endDir) {
    const l = 15;
    pathPush(ax, ay);
    pathPush(ax + dirDX(startDir) * l, ay + dirDY(startDir) * l);
    pathPush(bx + dirDX(endDir) * l, by + dirDY(endDir) * l);
    pathPush(bx, by);
}

/**
 * Add one STRAIGHT_LINK segment (pathRenderer `buildStraightPath`, l = 10):
 * right-angled path through the horizontal midpoint.
 *
 * @param {number} ax - Start x.
 * @param {number} ay - Start y.
 * @param {number} bx - End x.
 * @param {number} by - End y.
 * @param {number} startDir - LinkDirection at the start.
 * @param {number} endDir - LinkDirection at the end.
 * @returns {void}
 */
function addStraightSegment(ax, ay, bx, by, startDir, endDir) {
    const l = 10;
    const iax = ax + dirDX(startDir) * l;
    const iay = ay + dirDY(startDir) * l;
    const ibx = bx + dirDX(endDir) * l;
    const iby = by + dirDY(endDir) * l;
    const midX = (iax + ibx) * 0.5;
    pathPush(ax, ay);
    pathPush(iax, iay);
    pathPush(midX, iay);
    pathPush(midX, iby);
    pathPush(ibx, iby);
    pathPush(bx, by);
}

/**
 * Add one segment in the given render mode.
 *
 * @param {number} mode - RENDER_* value.
 * @param {number} ax - Start x.
 * @param {number} ay - Start y.
 * @param {number} bx - End x.
 * @param {number} by - End y.
 * @param {number} startDir - LinkDirection at the start.
 * @param {number} endDir - LinkDirection at the end.
 * @param {number[]|null} sc - Spline start control offset or null.
 * @param {number[]|null} ec - Spline end control offset or null.
 * @returns {void}
 */
function addSegment(mode, ax, ay, bx, by, startDir, endDir, sc, ec) {
    if (mode === RENDER_LINEAR) addLinearSegment(ax, ay, bx, by, startDir, endDir);
    else if (mode === RENDER_STRAIGHT) addStraightSegment(ax, ay, bx, by, startDir, endDir);
    else addSplineSegment(ax, ay, bx, by, startDir, endDir, sc, ec);
}

// ── Reroutes ────────────────────────────────────────────────────────────────

/**
 * Reroute chain of a link, ordered from the origin side to the target side.
 *
 * @param {Object} graph - Graph owning the link.
 * @param {Object} link - The link.
 * @returns {Array<Object>} Reroutes (possibly empty).
 */
function getLinkReroutes(graph, link) {
    if (link.parentId === undefined || link.parentId === null) return [];
    try {
        if (typeof LLink !== "undefined" && typeof LLink.getReroutes === "function") {
            return LLink.getReroutes(graph, link) || [];
        }
    } catch {
        // fall back to walking the chain by hand
    }
    const chain = [];
    const seen = new Set();
    let id = link.parentId;
    const reroutes = graph.reroutes;
    while (id !== undefined && id !== null && !seen.has(id)) {
        seen.add(id);
        const r = reroutes?.get?.(id);
        if (!r) break;
        chain.unshift(r);
        id = r.parentId;
    }
    return chain;
}

/**
 * Direction (cos, sin) of a reroute's spline tangent. Uses the values the
 * frontend computed in `Reroute.calculateAngle` when available; when links
 * are hidden those are never computed, so this falls back to the same
 * formula for a single link (average of incoming and outgoing angles).
 *
 * @param {Object} reroute - The reroute.
 * @param {number} px - Previous point x.
 * @param {number} py - Previous point y.
 * @param {number} nx - Next point x.
 * @param {number} ny - Next point y.
 * @param {number[]} out - Receives [cos, sin].
 * @returns {boolean} True when the frontend's cached values were used.
 */
function rerouteAngle(reroute, px, py, nx, ny, out) {
    const c = reroute.cos;
    const s = reroute.sin;
    if (Number.isFinite(c) && Number.isFinite(s) && (c !== 0 || s !== 0)) {
        out[0] = c;
        out[1] = s;
        return true;
    }
    const [rx, ry] = reroute.pos;
    const sum = Math.atan2(ny - ry, nx - rx);
    const origin = Math.atan2(ry - py, rx - px);
    let diff = (origin - sum) * 0.5;
    if (Math.abs(diff) > Math.PI * 0.5) diff += Math.PI;
    const a = origin - diff;
    out[0] = Math.cos(a);
    out[1] = Math.sin(a);
    return false;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

/**
 * Resolve the screen-independent endpoints of a link in the viewed graph:
 * node slot positions (`getOutputPos` / `getInputPos`, which handle Vue mode
 * and collapsed nodes) or subgraph IO node slot positions.
 *
 * @param {Object} graph - The viewed graph.
 * @param {Object} link - The link.
 * @param {Object} out - Receives sx, sy, sdir, ex, ey, edir.
 * @returns {boolean} False when an end cannot be resolved.
 */
function resolveLinkEndpoints(graph, link, out) {
    const originId = String(link.origin_id);
    const targetId = String(link.target_id);
    let startPos = null;
    let endPos = null;
    let sdir = 0;
    let edir = 0;

    // End first: subgraph-input links take the target input's direction for both ends.
    if (targetId === SUBGRAPH_OUTPUT_ID) {
        endPos = graph.outputNode?.slots?.[link.target_slot]?.pos;
    } else {
        const target = graph.getNodeById?.(link.target_id);
        if (!target) return false;
        const input = target.inputs?.[link.target_slot];
        if (!input) return false;
        endPos = target.getInputPos(link.target_slot);
        edir = input.dir || 0;
    }

    if (originId === SUBGRAPH_INPUT_ID) {
        startPos = graph.inputNode?.slots?.[link.origin_slot]?.pos;
        sdir = edir;
    } else {
        const origin = graph.getNodeById?.(link.origin_id);
        if (!origin) return false;
        if (link.origin_slot === -1) {
            startPos = [origin.pos[0] + 10, origin.pos[1] + 10];
        } else {
            const output = origin.outputs?.[link.origin_slot];
            if (!output) return false;
            startPos = origin.getOutputPos(link.origin_slot);
            sdir = output.dir || 0;
        }
    }

    if (!startPos || !endPos) return false;
    out.sx = startPos[0];
    out.sy = startPos[1];
    out.ex = endPos[0];
    out.ey = endPos[1];
    out.sdir = sdir;
    out.edir = edir;
    return Number.isFinite(out.sx) && Number.isFinite(out.sy) && Number.isFinite(out.ex) && Number.isFinite(out.ey);
}

// ── Geometry Cache ──────────────────────────────────────────────────────────

/**
 * Fill the scratch signature with everything a link's path depends on.
 *
 * @param {number} mode - Render mode.
 * @param {Object} ep - Endpoints record.
 * @param {Array<Object>} reroutes - Reroute chain.
 * @param {boolean} ghost - Ghost (virtual) segment flag.
 * @returns {void}
 */
function fillSignature(mode, ep, reroutes, ghost) {
    sigBuf.n = 0;
    sigPush(mode);
    sigPush(ghost ? 1 : 0);
    sigPush(ep.sx);
    sigPush(ep.sy);
    sigPush(ep.sdir);
    sigPush(ep.ex);
    sigPush(ep.ey);
    sigPush(ep.edir);
    for (const r of reroutes) {
        const p = r.pos;
        sigPush(p[0]);
        sigPush(p[1]);
        sigPush(r.cos || 0);
        sigPush(r.sin || 0);
        sigPush(r.controlPoint?.[0] || 0);
        sigPush(r.controlPoint?.[1] || 0);
    }
}

/**
 * Whether the cached signature equals the scratch signature.
 *
 * @param {Float64Array|null} cached - Cached signature.
 * @returns {boolean} True when unchanged.
 */
function signatureMatches(cached) {
    if (!cached || cached.length !== sigBuf.n) return false;
    const d = sigBuf.data;
    for (let i = 0; i < cached.length; i++) {
        if (cached[i] !== d[i]) return false;
    }
    return true;
}

/**
 * Sample the full path of a link (all reroute segments) into the scratch
 * polyline, mirroring `LGraphCanvas._renderAllLinkSegments`.
 *
 * @param {number} mode - Render mode.
 * @param {Object} ep - Endpoints record.
 * @param {Array<Object>} reroutes - Reroute chain (origin side first).
 * @returns {void}
 */
function sampleLinkPath(mode, ep, reroutes) {
    pathBuf.n = 0;
    const startDir = ep.sdir || DIR_RIGHT;
    const endDir = ep.edir || DIR_LEFT;

    if (!reroutes.length) {
        addSegment(mode, ep.sx, ep.sy, ep.ex, ep.ey, startDir, endDir, null, null);
        return;
    }

    let startControl = null;
    let px = ep.sx;
    let py = ep.sy;
    for (let j = 0; j < reroutes.length; j++) {
        const r = reroutes[j];
        const rx = r.pos[0];
        const ry = r.pos[1];
        const next = reroutes[j + 1]?.pos;
        const nx = next ? next[0] : ep.ex;
        const ny = next ? next[1] : ep.ey;

        // End control of this segment = the reroute's control point.
        const usedCached = rerouteAngle(r, px, py, nx, ny, angleOut);
        let endControl;
        if (usedCached && r.controlPoint) {
            endControl = [r.controlPoint[0], r.controlPoint[1]];
        } else {
            const d = Math.min(REROUTE_MAX_SPLINE_OFFSET, Math.hypot(rx - px, ry - py) * 0.25);
            endControl = [-d * angleOut[0], -d * angleOut[1]];
        }

        addSegment(mode, px, py, rx, ry, startControl ? DIR_CENTER : startDir, DIR_CENTER, startControl, endControl);

        // Start control for the next segment.
        const dist = Math.min(REROUTE_MAX_SPLINE_OFFSET, Math.hypot(nx - rx, ny - ry) * 0.25);
        startControl = [dist * angleOut[0], dist * angleOut[1]];
        px = rx;
        py = ry;
    }
    addSegment(mode, px, py, ep.ex, ep.ey, DIR_CENTER, endDir, startControl, null);
}

/**
 * Sample a ghost (virtual Set/Get hop) path: a plain spline between two anchors.
 *
 * @param {Object} ep - Endpoints record.
 * @returns {void}
 */
function sampleGhostPath(ep) {
    pathBuf.n = 0;
    addSplineSegment(ep.sx, ep.sy, ep.ex, ep.ey, DIR_RIGHT, DIR_LEFT, null, null);
}

/**
 * Freeze the scratch polyline into a cache entry: points, cumulative lengths,
 * bounding box and a Path2D for the full stroke.
 *
 * @param {Object} entry - Cache entry to (re)fill.
 * @returns {void}
 */
function commitGeometry(entry) {
    const n = pathBuf.n;
    const src = pathBuf.data;
    const pts = new Float32Array(Math.max(2, n * 2));
    const cum = new Float32Array(Math.max(1, n));
    let len = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const path = typeof Path2D !== "undefined" ? new Path2D() : null;
    for (let i = 0; i < n; i++) {
        const x = src[2 * i];
        const y = src[2 * i + 1];
        pts[2 * i] = x;
        pts[2 * i + 1] = y;
        if (i > 0) len += Math.hypot(x - src[2 * i - 2], y - src[2 * i - 1]);
        cum[i] = len;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (path) {
            if (i === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
        }
    }
    entry.sig = sigBuf.data.slice(0, sigBuf.n);
    entry.pts = pts;
    entry.cum = cum;
    entry.n = n;
    entry.len = len;
    entry.minX = minX;
    entry.minY = minY;
    entry.maxX = maxX;
    entry.maxY = maxY;
    entry.path = path;
    entry.ver = ++geometryVersion;
}

/**
 * Get (or rebuild) the cached geometry for a link or ghost segment. The
 * scratch signature must already be filled.
 *
 * @param {*} key - Cache key.
 * @param {boolean} ghost - Ghost segment (plain spline) instead of a link path.
 * @param {number} mode - Render mode (links only).
 * @param {Object} ep - Endpoints record.
 * @param {Array<Object>} reroutes - Reroute chain (links only).
 * @returns {Object|null} Geometry entry, or null for degenerate paths.
 */
function getGeometry(key, ghost, mode, ep, reroutes) {
    let entry = geomCache.get(key);
    if (!entry) {
        entry = { sig: null, seen: 0, n: 0 };
        geomCache.set(key, entry);
    }
    entry.seen = state.frame;
    if (!signatureMatches(entry.sig)) {
        if (ghost) sampleGhostPath(ep);
        else sampleLinkPath(mode, ep, reroutes);
        commitGeometry(entry);
    }
    return entry.n >= 2 ? entry : null;
}

/**
 * Conservative pre-cull of a link before sampling: bounding box of the
 * endpoints and reroutes, padded by the largest possible spline bulge.
 *
 * @param {Object} ep - Endpoints record.
 * @param {Array<Object>} reroutes - Reroute chain.
 * @param {Object} view - Visible area { x0, y0, x1, y1 } in graph units.
 * @returns {boolean} True when the link may be visible.
 */
function mayBeVisible(ep, reroutes, view) {
    let minX = Math.min(ep.sx, ep.ex);
    let maxX = Math.max(ep.sx, ep.ex);
    let minY = Math.min(ep.sy, ep.ey);
    let maxY = Math.max(ep.sy, ep.ey);
    for (const r of reroutes) {
        const p = r.pos;
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.25 + REROUTE_MAX_SPLINE_OFFSET;
    return !(maxX + pad < view.x0 || minX - pad > view.x1 || maxY + pad < view.y0 || minY - pad > view.y1);
}

/**
 * Whether a cached geometry's bounding box intersects the visible area.
 *
 * @param {Object} g - Geometry entry.
 * @param {Object} view - Visible area.
 * @returns {boolean} True when visible.
 */
function geometryVisible(g, view) {
    return !(g.maxX < view.x0 || g.minX > view.x1 || g.maxY < view.y0 || g.minY > view.y1);
}

// ── Polyline Sub-ranges ─────────────────────────────────────────────────────

/**
 * Index of the last polyline vertex whose cumulative length is <= s.
 *
 * @param {Float32Array} cum - Cumulative lengths.
 * @param {number} n - Vertex count.
 * @param {number} s - Arc length.
 * @returns {number} Vertex index in [0, n-2].
 */
function findSegmentIndex(cum, n, s) {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
    }
    return Math.min(lo, n - 2);
}

/**
 * Stroke the part of a polyline between arc lengths s0 and s1.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context.
 * @param {Object} g - Geometry entry.
 * @param {number} s0 - Start arc length (clamped to [0, len]).
 * @param {number} s1 - End arc length (clamped to [0, len]).
 * @returns {void}
 */
function strokeSubPath(ctx, g, s0, s1) {
    const { pts, cum, n, len } = g;
    s0 = Math.max(0, Math.min(len, s0));
    s1 = Math.max(0, Math.min(len, s1));
    if (s1 - s0 <= 1e-6) return;

    const i0 = findSegmentIndex(cum, n, s0);
    const segLen0 = cum[i0 + 1] - cum[i0] || 1;
    const f0 = (s0 - cum[i0]) / segLen0;
    ctx.beginPath();
    ctx.moveTo(pts[2 * i0] + (pts[2 * i0 + 2] - pts[2 * i0]) * f0, pts[2 * i0 + 1] + (pts[2 * i0 + 3] - pts[2 * i0 + 1]) * f0);

    let i = i0 + 1;
    while (i < n && cum[i] < s1) {
        ctx.lineTo(pts[2 * i], pts[2 * i + 1]);
        i++;
    }
    const i1 = findSegmentIndex(cum, n, s1);
    const segLen1 = cum[i1 + 1] - cum[i1] || 1;
    const f1 = (s1 - cum[i1]) / segLen1;
    ctx.lineTo(pts[2 * i1] + (pts[2 * i1 + 2] - pts[2 * i1]) * f1, pts[2 * i1 + 1] + (pts[2 * i1 + 3] - pts[2 * i1 + 1]) * f1);
    ctx.stroke();
}

/**
 * Stroke a whole cached polyline.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context.
 * @param {Object} g - Geometry entry.
 * @returns {void}
 */
function strokeFullPath(ctx, g) {
    if (g.path) {
        ctx.stroke(g.path);
        return;
    }
    strokeSubPath(ctx, g, 0, g.len);
}

/**
 * Linear gradient from the start to the end of a geometry, cached per key.
 *
 * @param {CanvasRenderingContext2D} ctx - Context creating the gradient.
 * @param {*} key - Cache key.
 * @param {Object} g - Geometry entry.
 * @param {number} h0 - Start hue.
 * @param {number} h1 - End hue.
 * @returns {CanvasGradient} The gradient.
 */
function getGradient(ctx, key, g, h0, h1) {
    const x0 = g.pts[0];
    const y0 = g.pts[1];
    const x1 = g.pts[2 * g.n - 2];
    const y1 = g.pts[2 * g.n - 1];
    const cached = gradCache.get(key);
    if (cached && cached.x0 === x0 && cached.y0 === y0 && cached.x1 === x1 && cached.y1 === y1 &&
        cached.h0 === h0 && cached.h1 === h1) {
        return cached.grad;
    }
    // A zero-length gradient vector would paint nothing -- nudge it.
    const grad = ctx.createLinearGradient(x0, y0, x1 === x0 && y1 === y0 ? x1 + 1 : x1, y1);
    grad.addColorStop(0, hueColor(h0));
    grad.addColorStop(1, hueColor(h1));
    gradCache.set(key, { x0, y0, x1, y1, h0, h1, grad });
    return grad;
}

/**
 * Bounds of a node including its title bar, in graph units. Prefers
 * `node.boundingRect` (kept current by the canvas, handles collapsed nodes,
 * title modes and Vue sizing) and falls back to pos/size.
 *
 * @param {Object} node - The node.
 * @param {number[]} out - Receives [x, y, w, h].
 * @returns {number[]} `out`.
 */
function getNodeBounds(node, out) {
    const br = node.boundingRect;
    if (br && br[2] > 0 && br[3] > 0) {
        out[0] = br[0];
        out[1] = br[1];
        out[2] = br[2];
        out[3] = br[3];
        return out;
    }
    const titleH = LiteGraph?.NODE_TITLE_HEIGHT || 30;
    if (node.flags?.collapsed) {
        out[2] = node._collapsed_width || LiteGraph?.NODE_COLLAPSED_WIDTH || 80;
        out[3] = titleH;
    } else {
        out[2] = node.size?.[0] || 100;
        out[3] = (node.size?.[1] || 0) + titleH;
    }
    out[0] = node.pos[0];
    out[1] = node.pos[1] - titleH;
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Model & Selection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the change signature without ever throwing.
 *
 * @param {Object} rootGraph - Root graph.
 * @returns {string|null} Signature, or null on failure.
 */
function safeSignature(rootGraph) {
    try {
        return computeFlowSignature(rootGraph);
    } catch (err) {
        warnOnce("failed to compute the change signature", err);
        return null;
    }
}

/**
 * Rebuild the flow model for the current root graph.
 *
 * @returns {void}
 */
function rebuildModel() {
    state.rebuildTimer = 0;
    if (state.mode === "off") return;
    const root = app.graph;
    if (!root) return;
    try {
        state.model = buildFlowModel(root, { sourcePlacement: config.sourcePlacement });
        state.modelError = false;
    } catch (err) {
        state.modelError = true;
        warnOnce("failed to build the flow model", err);
    }
    state.modelRoot = root;
    state.modelVersion++;
    state.traceKey = null;
}

/**
 * Schedule a debounced model rebuild.
 *
 * @returns {void}
 */
function scheduleRebuild() {
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(rebuildModel, REBUILD_DEBOUNCE_MS);
}

/**
 * Per-frame change detection: rebuild immediately when requested or when
 * the root graph object changed, otherwise compare the cheap signature every
 * SIGNATURE_INTERVAL_MS and debounce a rebuild on change.
 *
 * @param {number} now - Frame timestamp (ms).
 * @param {Object} rootGraph - Root graph.
 * @returns {void}
 */
function updateModel(now, rootGraph) {
    if (state.modelRoot !== rootGraph) state.rebuildNow = true;
    if (state.rebuildNow) {
        state.rebuildNow = false;
        state.modelDirty = false;
        state.lastSignatureCheck = now;
        state.signature = safeSignature(rootGraph);
        if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
        rebuildModel();
        return;
    }
    if (now - state.lastSignatureCheck < SIGNATURE_INTERVAL_MS) return;
    state.lastSignatureCheck = now;
    const sig = safeSignature(rootGraph);
    if (sig !== state.signature || state.modelDirty) {
        state.signature = sig;
        state.modelDirty = false;
        scheduleRebuild();
    }
}

/** Scratch array of selected nodes. */
const selectedScratch = [];

/**
 * Collect the selected nodes of the viewed graph. Prefers `selectedItems`
 * (a Set of positionables incl. groups/reroutes, filtered to nodes) and
 * falls back to the legacy `selected_nodes` record.
 *
 * @param {Object} canvas - LGraphCanvas.
 * @param {Object} graph - Viewed graph.
 * @param {Array<Object>} out - Receives the nodes.
 * @returns {Array<Object>} `out`.
 */
function getSelectedNodes(canvas, graph, out) {
    out.length = 0;
    const items = canvas.selectedItems;
    if (items && typeof items.size === "number" && typeof items[Symbol.iterator] === "function") {
        for (const item of items) {
            if (isGraphNode(item) && (!item.graph || item.graph === graph)) out.push(item);
        }
        return out;
    }
    const legacy = canvas.selected_nodes;
    if (legacy) {
        for (const id in legacy) {
            const node = legacy[id];
            if (isGraphNode(node) && (!node.graph || node.graph === graph)) out.push(node);
        }
    }
    return out;
}

/**
 * Recompute the selection trace when the selection, viewed graph or model changed.
 *
 * @param {Object} model - Flow model.
 * @param {Object} graph - Viewed graph.
 * @returns {void}
 */
function updateTrace(model, graph) {
    const selected = getSelectedNodes(app.canvas, graph, selectedScratch);
    state.selectionCount = selected.length;
    // Nothing selected while a workflow runs: trace the running node as if
    // it were selected. A real selection always wins.
    let traceGraph = graph;
    let nodes = selected;
    let key = `${state.modelVersion}|`;
    if (selected.length) {
        for (const node of selected) key += `${node.id},`;
    } else {
        // Replay playhead on a node: trace it like the live running node.
        const runId = replayTraceId() ?? state.runTraceId;
        const runNode = runId ? resolveRunNode(runId) : null;
        if (runNode?.graph) {
            traceGraph = runNode.graph;
            nodes = [runNode];
            key += `run:${runId}`;
        }
    }
    if (key === state.traceKey && graph === state.traceGraph) return;
    state.traceKey = key;
    state.traceGraph = graph;
    state.trace = null;
    state.gate = null;
    state.gateHint = "";
    if (!nodes.length) return;
    try {
        state.trace = model.traceSelection(traceGraph, nodes.slice());
    } catch (err) {
        warnOnce("failed to trace the selection", err);
    }
    state.gate = collectGateTrace(model, traceGraph, nodes);
    state.gateHint = state.gate ? formatGateHint(state.gate.gates) : "";
}

/**
 * Exec id of the node the replay playhead is on, or null (no replay running,
 * at either end, or on the shared cached step).
 *
 * @returns {string|null} Exec id, or null.
 */
function replayTraceId() {
    const replay = lastRun.replay;
    if (!lastRun.show || !replay?.steps || !replayAnimating()) return null;
    const step = replay.steps[replayStepAt(replay.steps, replay.time)];
    return step && step.status !== "cached" ? step.events[0]?.execId ?? null : null;
}

// ── Running Node ──────────────────────────────────────────────────────────

/**
 * Track the node the backend is executing. Called from the `executing`
 * WebSocket event (detail = display node exec id, or null when done) and
 * cleared when the run ends. Cheap, so it also runs while the overlay is off.
 *
 * @param {string|null} id - Exec id, or null.
 * @returns {void}
 */
function setRunningId(id) {
    const next = id === null || id === undefined || id === "" ? null : String(id);
    if (next === state.runId) return;
    const now = performance.now();
    // The node that just finished leaves an afterglow, so nodes faster than
    // a frame still visibly blink.
    if (state.runId) runAfterglow.set(state.runId, now);
    if (runAfterglow.size > 64) pruneAfterglow(now); // overlay off: nothing else prunes
    state.runId = next;
    state.runSince = now;
    // Nothing running -> drop the trace straight away (no settle delay).
    if (!next) state.runTraceId = null;
}

/** Exec id -> performance.now() when it stopped running (pruned after RUN_AFTERGLOW_MS). */
const runAfterglow = new Map();

/**
 * Afterglow strength of a node (1 = just finished, 0 = gone): the strongest
 * over its exec ids, including nodes expanded from them / inside a container.
 *
 * @param {Array<string>} execIds - Node exec ids.
 * @param {number} now - Frame timestamp (ms).
 * @returns {number} 0..1.
 */
function afterglowOf(execIds, now) {
    let best = 0;
    for (const [id, at] of runAfterglow) {
        const v = 1 - (now - at) / RUN_AFTERGLOW_MS;
        if (v > best && isRunningIn(execIds, id)) best = v;
    }
    return best;
}

/**
 * Drop expired afterglows.
 *
 * @param {number} now - Frame timestamp (ms).
 * @returns {void}
 */
function pruneAfterglow(now) {
    for (const [id, at] of runAfterglow) {
        if (now - at >= RUN_AFTERGLOW_MS) runAfterglow.delete(id);
    }
}

/**
 * Advance the running-node trace: it switches to the running node once that
 * node has run for RUN_TRACE_SETTLE_MS (or at once when nothing is traced).
 *
 * @param {number} now - Frame timestamp (ms).
 * @returns {void}
 */
function updateRunTrace(now) {
    const id = state.runId;
    if (id === state.runTraceId) return;
    if (!id || !state.runTraceId || now - state.runSince >= RUN_TRACE_SETTLE_MS) state.runTraceId = id;
}

/**
 * Node object for a running exec id (cached per id and model version).
 * Ids of nodes created by node expansion are not in the graph; trailing
 * segments are dropped until a node is found, so the run is attributed to
 * the nearest real ancestor.
 *
 * @param {string} id - Exec id.
 * @returns {Object|null} The node, or null.
 */
function resolveRunNode(id) {
    const cache = state.runNode;
    if (cache.id === id && cache.modelVersion === state.modelVersion) return cache.node;
    let node = null;
    try {
        const parts = String(id).split(":");
        while (parts.length && !node) {
            node = findNodeByExecutionId(parts.join(":"), app.graph);
            parts.pop();
        }
    } catch (err) {
        warnOnce("failed to find the running node", err);
        node = null;
    }
    cache.id = id;
    cache.modelVersion = state.modelVersion;
    cache.node = node;
    return node;
}

/**
 * Hint line for the running node.
 *
 * @param {Object|null} node - Running node.
 * @param {string} id - Running exec id (shown in full, e.g. "#13:5" inside a subgraph).
 * @returns {string} "Running: <title> (#id)", or "".
 */
function formatRunHint(node, id) {
    if (!node) return "";
    return `Running: ${formatNodeTitle(node)} (#${id})`;
}

/**
 * A node's display title for hints, truncated to GATE_TITLE_MAX.
 *
 * @param {Object} node - The node.
 * @returns {string} Title.
 */
function formatNodeTitle(node) {
    let title = node?.type;
    try {
        title = node.getTitle?.() || node.title || node.type;
    } catch {
        // keep the type
    }
    title = String(title ?? "");
    if (title.length > GATE_TITLE_MAX) title = `${title.slice(0, GATE_TITLE_MAX - 1)}…`;
    return title;
}

/**
 * Union of `model.getGateTrace` over the selected conditional nodes.
 * Tolerates models without the getter (returns null).
 *
 * @param {Object} model - Flow model.
 * @param {Object} graph - Viewed graph.
 * @param {Array<Object>} nodes - Selected nodes.
 * @returns {Object|null} { gates, nodeKeys, linkKeys, virtualKeys } or null when nothing gates the selection.
 */
function collectGateTrace(model, graph, nodes) {
    if (typeof model.getGateTrace !== "function") return null;
    let result = null;
    const seenGates = new Set();
    for (const node of nodes) {
        try {
            const info = model.getNodeInfo(graph, node);
            if (!info?.conditional) continue;
            const gt = model.getGateTrace(graph, node);
            if (!gt) continue;
            if (!result) {
                result = { gates: [], nodeKeys: new Set(), linkKeys: new Set(), virtualKeys: new Set() };
            }
            for (const gate of gt.gates ?? []) {
                const id = gate?.execId ?? gate;
                if (seenGates.has(id)) continue;
                seenGates.add(id);
                result.gates.push(gate);
            }
            for (const k of gt.nodeKeys ?? []) result.nodeKeys.add(k);
            for (const k of gt.linkKeys ?? []) result.linkKeys.add(k);
            for (const k of gt.virtualKeys ?? []) result.virtualKeys.add(k);
        } catch (err) {
            warnOnce("failed to read the gate trace", err);
        }
    }
    return result && (result.gates.length || result.nodeKeys.size) ? result : null;
}

/**
 * Display label of a gate: "<title> (#<execId>)", title truncated.
 *
 * @param {Object} gate - Gate record { execId, node, title }.
 * @returns {string} Label.
 */
function gateLabel(gate) {
    let title = String(gate?.title || gate?.node?.title || gate?.node?.type || "switch");
    if (title.length > GATE_TITLE_MAX) title = `${title.slice(0, GATE_TITLE_MAX - 3)}...`;
    return `${title} (#${gate?.execId ?? gate?.node?.id ?? "?"})`;
}

/**
 * Hint line for the gates of the selection.
 *
 * @param {Array<Object>} gates - Gate records.
 * @returns {string} "Conditional: depends on A (#1), B (#2) +N more", or "".
 */
function formatGateHint(gates) {
    if (!gates?.length) return "";
    const shown = gates.slice(0, GATE_HINT_MAX).map(gateLabel).join(", ");
    const more = gates.length > GATE_HINT_MAX ? ` +${gates.length - GATE_HINT_MAX} more` : "";
    return `Conditional: depends on ${shown}${more}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay Canvas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create (once) and attach the overlay canvas as the last child of the graph
 * canvas container. See the module docstring for why this placement works.
 *
 * @param {HTMLCanvasElement} mainEl - The LiteGraph canvas element.
 * @returns {HTMLCanvasElement|null} The overlay, or null when it cannot be placed.
 */
function ensureOverlay(mainEl) {
    const parent = mainEl.parentElement;
    if (!parent) return null;
    if (!state.overlay) {
        state.overlay = createOverlayCanvas("enhutils-flow-overlay");
        state.ctx = state.overlay.getContext("2d");
    }
    if (state.overlay.parentElement !== parent) parent.appendChild(state.overlay);
    return state.ctx ? state.overlay : null;
}

/**
 * Create a full-size, click-through overlay canvas element.
 *
 * @param {string} className - CSS class (lets tests / users find it).
 * @returns {HTMLCanvasElement} The canvas.
 */
function createOverlayCanvas(className) {
    const el = document.createElement("canvas");
    el.className = className;
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: "block",
    });
    return el;
}

/**
 * Whether the Nodes 2.0 (Vue) renderer is active: nodes are DOM elements
 * above the LiteGraph canvas instead of being painted into it.
 *
 * @returns {boolean} True in Vue node mode.
 */
function isVueNodesMode() {
    return !!globalThis.LiteGraph?.vueNodesMode;
}

/**
 * Whether the line layer must be painted from inside LiteGraph's own draw
 * (lines under nodes, classic renderer: nodes live in the same canvas).
 *
 * @returns {boolean} True when frames are rendered from the `onRender` hook.
 */
function rendersInHost() {
    return config.linesUnder && !isVueNodesMode();
}

/**
 * Create / place the separate line-layer canvas used while lines are drawn
 * under nodes. Vue: in the DOM right after the LiteGraph canvas, so the node
 * layer covers it. Classic: detached (composited by `onRenderHook`).
 *
 * @param {HTMLCanvasElement} mainEl - The LiteGraph canvas element.
 * @returns {CanvasRenderingContext2D|null} Its context, or null when unavailable.
 */
function ensureLinesCanvas(mainEl) {
    const ln = state.lines;
    if (!ln.canvas) {
        ln.canvas = createOverlayCanvas("enhutils-flow-lines");
        ln.ctx = ln.canvas.getContext("2d");
    }
    const el = ln.canvas;
    if (isVueNodesMode()) {
        const parent = mainEl.parentElement;
        if (parent && (el.parentElement !== parent || el.previousSibling !== mainEl)) {
            parent.insertBefore(el, mainEl.nextSibling);
        }
    } else if (el.parentElement) {
        el.remove();
    }
    if (el.width !== mainEl.width || el.height !== mainEl.height) {
        el.width = mainEl.width;
        el.height = mainEl.height;
    }
    return ln.ctx;
}

/**
 * Detach the line-layer canvas and release its backing store.
 *
 * @returns {void}
 */
function removeLinesCanvas() {
    const el = state.lines.canvas;
    if (!el || (!el.parentElement && !el.width)) return;
    el.remove();
    el.width = 0;
    el.height = 0;
}

/**
 * Hook LiteGraph's `onRender` (called once per front-canvas draw, after the
 * background and links and before the nodes) on the current canvas. Chains
 * any existing handler. The hook does nothing unless lines are drawn under
 * nodes in the classic renderer.
 *
 * @param {Object} canvas - LGraphCanvas.
 * @returns {void}
 */
function installRenderHook(canvas) {
    if (!canvas || state.hookedCanvases.has(canvas)) return;
    state.hookedCanvases.add(canvas);
    const prev = canvas.onRender;
    canvas.onRender = function (el, ctx) {
        prev?.call(this, el, ctx);
        onRenderHook(this, ctx);
    };
}

/**
 * Classic renderer, lines under nodes: render the whole overlay frame in sync
 * with LiteGraph's draw, then paint the line layer into its canvas below the
 * nodes about to be drawn. Never throws into LiteGraph.
 *
 * @param {Object} canvas - LGraphCanvas being drawn.
 * @param {CanvasRenderingContext2D} ctx - Its context.
 * @returns {void}
 */
function onRenderHook(canvas, ctx) {
    if (state.mode === "off" || canvas !== app.canvas || !rendersInHost()) return;
    safeRenderFrame(performance.now());
    const lines = state.lines.canvas;
    if (state.mode === "off" || !lines || !lines.width || !ctx) return;
    try {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.drawImage(lines, 0, 0);
        ctx.restore();
    } catch (err) {
        warnOnce("failed to draw the line layer under the nodes", err);
    }
}

/**
 * Detach the overlay canvas and release its backing store.
 *
 * @returns {void}
 */
function removeOverlay() {
    const el = state.overlay;
    if (!el) return;
    el.remove();
    el.width = 0;
    el.height = 0;
}

/**
 * Re-measure where hints go: bottom-centre of the free canvas panel (the
 * area not covered by side / bottom panels), relative to the overlay. The
 * bottom-left corner is taken by LiteGraph's render info, the bottom-right
 * by the canvas menu / minimap.
 *
 * @param {number} now - Frame timestamp (ms).
 * @param {number} cssW - Overlay width in CSS px.
 * @param {number} cssH - Overlay height in CSS px.
 * @returns {Object} Anchor { x, y } (bottom-centre, CSS px).
 */
function updateHintAnchor(now, cssW, cssH) {
    const anchor = state.hintAnchor;
    if (now - anchor.time < HINT_ANCHOR_INTERVAL_MS) return anchor;
    anchor.time = now;
    anchor.x = cssW / 2;
    anchor.y = cssH - 12;
    anchor.w = cssW;
    try {
        const panel = document.querySelector(".graph-canvas-panel");
        if (panel && state.overlay) {
            const pr = panel.getBoundingClientRect();
            const or = state.overlay.getBoundingClientRect();
            if (pr.width > 40 && pr.height > 40) {
                anchor.x = pr.left - or.left + pr.width / 2;
                anchor.w = pr.width;
                anchor.y = Math.min(cssH - 4, pr.bottom - or.top - 12);
            }
        }
    } catch {
        // keep the fallback anchor
    }
    return anchor;
}

/**
 * Draw small hint labels in screen space, stacked upward from the anchor.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context.
 * @param {number} dpr - Device pixel ratio used for the overlay.
 * @param {Array<string>} hints - Lines to draw.
 * @param {number} now - Frame timestamp (ms).
 * @param {number} cssW - Overlay width in CSS px.
 * @param {number} cssH - Overlay height in CSS px.
 * @returns {void}
 */
function drawHints(ctx, dpr, hints, now, cssW, cssH) {
    if (!hints.length) return;
    const anchor = updateHintAnchor(now, cssW, cssH);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    // Stack above the replay bar when it is up.
    let y = anchor.y - (replayBar.el?.isConnected ? replayBar.height + REPLAY_BAR_GAP : 0);
    for (let i = hints.length - 1; i >= 0; i--) {
        const text = hints[i];
        const w = ctx.measureText(text).width + 16;
        const h = 22;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        const x = Math.max(4, anchor.x - w / 2);
        ctx.beginPath();
        addRoundRect(ctx, x, y - h, w, h, 6);
        ctx.fill();
        ctx.fillStyle = "#eee";
        ctx.fillText(text, x + 8, y - h / 2);
        y -= h + 4;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Replay Bar
// ═══════════════════════════════════════════════════════════════════════════
//
// Floating controls at the bottom of the canvas while a replay is open:
// play / pause, the current step (click = go to the node), a timeline track
// (one segment per step, coloured like its node; drag or click to scrub) and
// close. Keys while it has focus: Space play/pause, Left/Right step,
// Home/End, Esc close. It sits in the canvas container (above the overlay)
// at the hint anchor; the hints stack above it.

/** Gap between the bar and the hints above it (px). */
const REPLAY_BAR_GAP = 8;
/** Max bar width (px). */
const REPLAY_BAR_MAX_W = 620;
/** Track height without subgraph brackets (CSS px). */
const REPLAY_TRACK_H = 18;
/** Subgraph nesting levels bracketed under the track. */
const REPLAY_BRACKET_LEVELS = 2;
/** Height of one bracket row under the track (CSS px). */
const REPLAY_BRACKET_ROW = 5;
/** Horizontal room for the playhead knob at both ends of the track (CSS px). */
const REPLAY_TRACK_PAD = 6;

/** Bar elements and drag state (el null until first shown). */
const replayBar = {
    /** @type {HTMLDivElement|null} */
    el: null,
    playBtn: null,
    playIcon: null,
    label: null,
    count: null,
    /** @type {HTMLCanvasElement|null} */
    track: null,
    /** Height of the bar when last laid out (px), for stacking the hints. */
    height: 0,
    /** What the track was last drawn for. */
    drawKey: "",
    dragging: false,
    wasPlaying: false,
    /** Exec id of the step in the label (click target). */
    labelId: null,
    /** Subgraph bracket under the cursor, or null. */
    hoverBracket: null,
    /** Middle column (label + track), dimmed when disabled. */
    mid: null,
    /** Bar is dimmed / inert (live run, nothing to replay). */
    disabled: null,
};

/**
 * Small icon button for the bar.
 *
 * @param {string} icon - PrimeIcons class (e.g. "pi-play").
 * @param {string} title - Tooltip.
 * @param {Function} onClick - Click handler.
 * @returns {{btn: HTMLButtonElement, icon: HTMLElement}} Button and its icon.
 */
function replayButton(icon, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = title;
    btn.tabIndex = -1;
    Object.assign(btn.style, {
        flex: "0 0 auto",
        width: "30px",
        height: "30px",
        border: "none",
        borderRadius: "50%",
        background: "rgba(255,255,255,0.08)",
        color: "#eee",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0",
    });
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    i.style.fontSize = "13px";
    btn.appendChild(i);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
        replayBar.el?.focus({ preventScroll: true });
    });
    return { btn, icon: i };
}

/**
 * Replay time under a client x on the track.
 *
 * @param {number} clientX - Pointer x.
 * @returns {number} Replay time (s).
 */
function trackTimeAt(clientX) {
    const replay = lastRun.replay;
    const r = replayBar.track?.getBoundingClientRect();
    const span = (r?.width ?? 0) - REPLAY_TRACK_PAD * 2;
    if (!replay?.timeline || span <= 0) return 0;
    return ((clientX - r.left - REPLAY_TRACK_PAD) / span) * replay.timeline.duration;
}

/**
 * Bracket rows drawn under the track (0 when the run has no subgraph steps).
 *
 * @param {Object} replay - Open replay.
 * @returns {number} Rows.
 */
function bracketRows(replay) {
    let rows = 0;
    for (const b of replay?.brackets ?? []) rows = Math.max(rows, b.level);
    return rows;
}

/**
 * Subgraph bracket under a client point (the band below the segments), or null.
 *
 * @param {number} clientX - Pointer x.
 * @param {number} clientY - Pointer y.
 * @returns {Object|null} Bracket.
 */
function bracketAt(clientX, clientY) {
    const replay = lastRun.replay;
    const rows = bracketRows(replay);
    const r = replayBar.track?.getBoundingClientRect();
    if (!rows || !r) return null;
    const y = clientY - r.top;
    if (y < REPLAY_TRACK_H - 3) return null;
    const level = Math.min(rows, Math.max(1, Math.floor((y - REPLAY_TRACK_H) / REPLAY_BRACKET_ROW) + 1));
    const t = trackTimeAt(clientX);
    return replay.brackets.find((b) => b.level === level && t >= b.t0 && t < b.t2) ?? null;
}

/**
 * Tooltip text of a subgraph bracket: container path and step range.
 *
 * @param {Object} bracket - Bracket (from replayBrackets).
 * @returns {string} Text.
 */
function bracketText(bracket) {
    const parts = bracket.execId.split(":");
    const names = parts.map((_, i) => {
        const id = parts.slice(0, i + 1).join(":");
        const node = findNodeByExecutionId(id);
        return node ? String(node.title ?? node.type ?? id) : id;
    });
    const steps = bracket.first === bracket.last ? `step ${bracket.first + 1}` : `steps ${bracket.first + 1}–${bracket.last + 1}`;
    return `Subgraph: ${names.join(" › ")} (#${bracket.execId})\n${steps}`;
}

/**
 * Create the bar (once).
 *
 * @returns {HTMLDivElement} Bar element.
 */
function createReplayBar() {
    const el = document.createElement("div");
    el.className = "enhutils-flow-replay";
    el.tabIndex = 0;
    Object.assign(el.style, {
        position: "absolute",
        zIndex: "5",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "6px 8px",
        borderRadius: "10px",
        background: "rgba(20,20,20,0.88)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
        color: "#eee",
        font: "12px sans-serif",
        pointerEvents: "auto",
        outline: "none",
        transform: "translateX(-50%)",
        boxSizing: "border-box",
        userSelect: "none",
    });

    const play = replayButton("pi-play", "Play / pause (Space)", () => setReplayPlaying());
    replayBar.playBtn = play.btn;
    replayBar.playIcon = play.icon;

    const mid = document.createElement("div");
    Object.assign(mid.style, { flex: "1 1 auto", minWidth: "0", display: "flex", flexDirection: "column", gap: "4px" });
    const row = document.createElement("div");
    // Fixed line box: emoji in node titles have taller glyphs and would make the bar jiggle.
    Object.assign(row.style, { display: "flex", gap: "8px", alignItems: "center", minWidth: "0", height: "16px", lineHeight: "16px", overflow: "hidden" });
    const label = document.createElement("span");
    Object.assign(label.style, { flex: "1 1 auto", minWidth: "0", height: "16px", lineHeight: "16px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    label.title = "Go to this node";
    label.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = replayBar.labelId;
        if (id) focusNode(findNodeByExecutionId(id));
    });
    const count = document.createElement("span");
    Object.assign(count.style, { flex: "0 0 auto", opacity: "0.6", fontVariantNumeric: "tabular-nums" });
    row.append(label, count);

    const track = document.createElement("canvas");
    track.title = "Drag to scrub; Left / Right = previous / next step";
    Object.assign(track.style, { width: "100%", height: `${REPLAY_TRACK_H}px`, cursor: "pointer", display: "block", touchAction: "none" });
    track.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        el.focus({ preventScroll: true });
        const replay = lastRun.replay;
        if (!replay?.timeline) return;
        try {
            track.setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        replayBar.dragging = true;
        replayBar.wasPlaying = replay.playing;
        replay.playing = false;
        seekReplay(trackTimeAt(e.clientX));
    });
    track.addEventListener("pointermove", (e) => {
        if (replayBar.dragging) seekReplay(trackTimeAt(e.clientX));
        replayBar.hoverBracket = replayBar.dragging ? null : bracketAt(e.clientX, e.clientY);
    });
    track.addEventListener("pointerleave", () => {
        replayBar.hoverBracket = null;
    });
    const endDrag = () => {
        if (!replayBar.dragging) return;
        replayBar.dragging = false;
        const replay = lastRun.replay;
        if (replayBar.wasPlaying && replay?.timeline && replay.time < replay.timeline.duration) setReplayPlaying(true);
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    track.addEventListener("lostpointercapture", endDrag);
    mid.append(row, track);

    const close = replayButton("pi-times", "Close the last run (Esc)", () => showLastRun(false));

    el.append(play.btn, mid, close.btn);
    // Keep the canvas from reacting to clicks / wheel on the bar.
    for (const type of ["pointerdown", "mousedown", "wheel", "contextmenu", "dblclick"]) {
        el.addEventListener(type, (e) => e.stopPropagation());
    }
    el.addEventListener("keydown", onReplayKey);

    replayBar.el = el;
    replayBar.label = label;
    replayBar.mid = mid;
    replayBar.count = count;
    replayBar.track = track;
    return el;
}

/**
 * Leave the viewed subgraph (one level up), like ComfyUI's Esc.
 *
 * @returns {boolean} True when a subgraph was open (and was left).
 */
function exitSubgraph() {
    const canvas = app.canvas;
    const graph = canvas?.graph;
    if (!graph || graph === app.graph) return false;
    try {
        const run = app.extensionManager?.command?.execute;
        if (typeof run === "function") {
            Promise.resolve(run.call(app.extensionManager.command, "Comfy.Graph.ExitSubgraph")).catch((err) =>
                warnOnce("failed to exit the subgraph", err));
        } else {
            canvas.setGraph(graph.rootGraph ?? app.graph);
        }
    } catch (err) {
        warnOnce("failed to exit the subgraph", err);
    }
    return true;
}

/**
 * Keyboard control while the bar has focus.
 *
 * @param {KeyboardEvent} e - Key event.
 * @returns {void}
 */
function onReplayKey(e) {
    const replay = lastRun.replay;
    let handled = true;
    switch (e.key) {
        case " ":
        case "k":
            setReplayPlaying();
            break;
        case "ArrowRight":
            stepReplay(1);
            break;
        case "ArrowLeft":
            stepReplay(-1);
            break;
        case "Home":
            if (replay) replay.playing = false;
            seekReplay(0);
            break;
        case "End":
            if (replay) replay.playing = false;
            seekReplay(replay?.timeline?.duration ?? 0);
            break;
        case "Escape":
            // Inside a subgraph Esc goes up a level first (ComfyUI's own Esc action).
            if (!exitSubgraph()) showLastRun(false);
            break;
        default:
            handled = false;
    }
    if (handled) {
        e.preventDefault();
        e.stopPropagation();
    }
}

/**
 * Colour of a step's segment on the track.
 *
 * @param {Object} step - Replay step.
 * @param {Object|null} model - Flow model.
 * @param {number} maxDepth - Model max depth.
 * @returns {string} CSS colour.
 */
function stepColor(step, model, maxDepth) {
    if (step.status === "cached") return RUN_BADGES.cached.color;
    if (step.status === "blocked") return RUN_BADGES.blocked.color;
    if (RUN_OUTLINE_COLORS[step.status]) return RUN_OUTLINE_COLORS[step.status];
    const depth = model?.nodes?.get(step.events[0]?.execId)?.depth;
    return hueColor(hueOf(depth ?? 0, maxDepth));
}

/**
 * Draw the track: one segment per step (played ones solid, the current one
 * taller, upcoming ones faint), subgraph brackets under it (one row per
 * nesting level; the one at the playhead or under the cursor brighter) and
 * the playhead.
 *
 * @param {Object} replay - Open replay with a timeline.
 * @param {Object|null} model - Flow model.
 * @returns {void}
 */
function drawReplayTrack(replay, model) {
    const track = replayBar.track;
    const rows = bracketRows(replay);
    const cssH = REPLAY_TRACK_H + rows * REPLAY_BRACKET_ROW;
    const hStyle = `${cssH}px`;
    if (track.style.height !== hStyle) track.style.height = hStyle;
    const cssW = track.clientWidth;
    if (!cssW) return;
    const dpr = window.devicePixelRatio || 1;
    const hover = replayBar.hoverBracket;
    const key = `${cssW}|${cssH}|${dpr}|${replay.time.toFixed(4)}|${replay.steps.length}|${model?.maxDepth}|` +
        `${replay.promptId}|${hover ? `${hover.level}:${hover.first}` : ""}`;
    if (key === replayBar.drawKey) return;
    replayBar.drawKey = key;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (track.width !== w) track.width = w;
    if (track.height !== h) track.height = h;
    const ctx = track.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const dur = replay.timeline.duration || 1;
    const pad = REPLAY_TRACK_PAD;
    const span = cssW - pad * 2;

    // Subgraph brackets: a line under the steps with short ticks up at both ends.
    for (const b of replay.brackets ?? []) {
        const x0 = pad + (b.t0 / dur) * span + 1;
        const x1 = pad + (b.t2 / dur) * span - 1;
        const y = REPLAY_TRACK_H + (b.level - 1) * REPLAY_BRACKET_ROW + 1;
        const lineW = b.level === 1 ? 2 : 1;
        const lit = b === hover || (replay.time >= b.t0 && replay.time < b.t2);
        ctx.globalAlpha = lit ? 0.9 : 0.4;
        ctx.fillStyle = "#fff";
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), lineW);
        if (x1 - x0 > 4) {
            ctx.fillRect(x0, y - 3, 1, 3 + lineW);
            ctx.fillRect(x1 - 1, y - 3, 1, 3 + lineW);
        }
    }
    ctx.globalAlpha = 1;

    const mid = REPLAY_TRACK_H / 2;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    addRoundRect(ctx, pad, mid - 3, span, 6, 3);
    ctx.fill();
    const maxDepth = Math.max(1, Number(model?.maxDepth) || 1);
    const cur = replayAnimating() ? replayStepAt(replay.steps, replay.time) : -1;
    replay.steps.forEach((step, i) => {
        const x0 = pad + (step.t0 / dur) * span;
        const x1 = pad + (step.t2 / dur) * span;
        const gap = x1 - x0 > 4 ? 1 : 0;
        const tall = i === cur;
        const sh = tall ? 10 : 6;
        ctx.globalAlpha = tall ? 1 : step.t2 <= replay.time ? 0.85 : 0.3;
        ctx.fillStyle = stepColor(step, model, maxDepth);
        ctx.fillRect(x0 + gap, mid - sh / 2, Math.max(1, x1 - x0 - gap * 2), sh);
    });
    ctx.globalAlpha = 1;
    const x = pad + (Math.min(dur, Math.max(0, replay.time)) / dur) * span;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - 1, 1, 2, REPLAY_TRACK_H - 2);
    ctx.beginPath();
    ctx.arc(x, mid, 5, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * Show / update / hide the bar for this frame. Positioned at the hint anchor
 * (bottom-centre of the free canvas area).
 *
 * @param {Object|null} model - Flow model.
 * @param {number} now - Frame timestamp (ms).
 * @param {number} cssW - Overlay width (CSS px).
 * @param {number} cssH - Overlay height (CSS px).
 * @returns {void}
 */
function updateReplayBar(model, now, cssW, cssH) {
    const replay = lastRun.replay;
    const overlay = state.overlay;
    if (!replay || !overlay?.parentElement) {
        removeReplayBar();
        return;
    }
    const el = replayBar.el ?? createReplayBar();
    if (el.parentElement !== overlay.parentElement) overlay.parentElement.appendChild(el);
    const anchor = updateHintAnchor(now, cssW, cssH);
    const width = Math.max(240, Math.min(REPLAY_BAR_MAX_W, (anchor.w || cssW) - 40));
    el.style.width = `${width}px`;
    el.style.left = `${overlay.offsetLeft + anchor.x}px`;
    replayBar.height = el.offsetHeight;
    el.style.top = `${overlay.offsetTop + anchor.y - replayBar.height}px`;

    // Live run / nothing usable: dimmed and inert except for close.
    const disabled = !replayUsable();
    if (replayBar.disabled !== disabled) {
        replayBar.disabled = disabled;
        for (const part of [replayBar.playBtn, replayBar.mid]) {
            part.style.opacity = disabled ? "0.45" : "1";
            part.style.pointerEvents = disabled ? "none" : "auto";
        }
        if (disabled) replayBar.dragging = false;
    }
    const playing = !!replay.playing;
    const icon = playing ? "pi pi-pause" : "pi pi-play";
    if (replayBar.playIcon.className !== icon) replayBar.playIcon.className = icon;
    const text = replayStepText(model);
    if (replayBar.label.textContent !== text.label) replayBar.label.textContent = text.label;
    if (replayBar.count.textContent !== text.count) replayBar.count.textContent = text.count;
    const step = replayAnimating() ? replay.steps[replayStepAt(replay.steps, replay.time)] : null;
    replayBar.labelId = step && step.status !== "cached" ? step.events[0]?.execId ?? null : null;
    replayBar.label.style.cursor = replayBar.labelId ? "pointer" : "default";
    if (disabled) {
        if (replayBar.drawKey !== "disabled") {
            replayBar.drawKey = "disabled";
            replayBar.track.style.height = `px`;
            replayBar.track.getContext("2d")?.clearRect(0, 0, replayBar.track.width, replayBar.track.height);
        }
    } else {
        drawReplayTrack(replay, model);
    }
}

/**
 * Detach the bar.
 *
 * @returns {void}
 */
function removeReplayBar() {
    replayBar.dragging = false;
    replayBar.hoverBracket = null;
    replayBar.disabled = null;
    replayBar.height = 0;
    replayBar.drawKey = "";
    replayBar.el?.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
// Badge Tooltips
// ═══════════════════════════════════════════════════════════════════════════
// The overlay is click-through (pointer-events: none), so the cursor is
// watched with a passive capture-phase listener and hit-tested against the
// badge positions every frame (same formulas as the drawing passes). The
// tooltip is a body-level element that ignores the mouse too.

/** Last known cursor: client coords, whether it is over the graph canvas area, buttons held. */
const pointer = { x: 0, y: 0, inside: false, buttons: 0, installed: false };
/** @type {HTMLDivElement|null} */
let tooltipEl = null;
/** Text currently shown (avoids DOM writes every frame). */
let tooltipText = "";

/**
 * Start tracking the cursor (once). Capture phase, passive: never interferes
 * with the canvas.
 *
 * @returns {void}
 */
function installPointerTracking() {
    if (pointer.installed) return;
    pointer.installed = true;
    const track = (e) => {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.buttons = e.buttons;
        const host = app.canvas?.canvas?.parentElement;
        pointer.inside = !!host && e.target instanceof Node && host.contains(e.target) &&
            !replayBar.el?.contains(e.target);
    };
    window.addEventListener("pointermove", track, { capture: true, passive: true });
    window.addEventListener("pointerdown", (e) => {
        track(e);
        hideTooltip();
    }, { capture: true, passive: true });
    window.addEventListener("wheel", () => hideTooltip(), { capture: true, passive: true });
    document.addEventListener("pointerleave", () => {
        pointer.inside = false;
        hideTooltip();
    });
}

/**
 * Show the tooltip above an anchor box (a node's badge row), or near the
 * cursor without one. Anchoring keeps it clear of the cursor whatever its
 * size (large accessibility cursors covered a below-right tooltip).
 *
 * @param {string} text - Text (newlines allowed).
 * @param {{left: number, top: number, bottom: number}|null} [anchor] - Screen box to sit above.
 * @returns {void}
 */
function showTooltip(text, anchor = null) {
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "enhutils-flow-tooltip";
        Object.assign(tooltipEl.style, {
            position: "fixed",
            zIndex: "10000",
            pointerEvents: "none",
            maxWidth: "560px",
            padding: "5px 8px",
            borderRadius: "6px",
            background: "rgba(0,0,0,0.85)",
            color: "#eee",
            font: "12px sans-serif",
            whiteSpace: "pre-line",
            boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
        });
    }
    if (!tooltipEl.isConnected) document.body.appendChild(tooltipEl);
    if (text !== tooltipText) {
        tooltipText = text;
        tooltipEl.textContent = text;
    }
    tooltipEl.style.display = "block";
    const w = tooltipEl.offsetWidth;
    const h = tooltipEl.offsetHeight;
    let x;
    let y;
    if (anchor) {
        x = Math.min(anchor.left, window.innerWidth - w - 4);
        // Above the anchor; below it only when there is no room at the top.
        y = anchor.top - h - TOOLTIP_GAP >= 4 ? anchor.top - h - TOOLTIP_GAP : anchor.bottom + TOOLTIP_GAP;
    } else {
        x = Math.min(pointer.x + 14, window.innerWidth - w - 4);
        y = pointer.y + 18 + h > window.innerHeight ? pointer.y - h - 8 : pointer.y + 18;
    }
    tooltipEl.style.left = `${Math.max(4, x)}px`;
    tooltipEl.style.top = `${Math.max(4, y)}px`;
}

/** Gap between a badge tooltip and the node it describes (screen px). */
const TOOLTIP_GAP = 6;

/**
 * Hide the tooltip.
 *
 * @returns {void}
 */
function hideTooltip() {
    tooltipHold = null;
    if (tooltipEl && tooltipText !== "") {
        tooltipEl.style.display = "none";
        tooltipText = "";
    }
}

/** Tooltip text per run status. */
const RUN_TOOLTIPS = Object.freeze({
    cached: "Cached -- its output was reused from an earlier run, it didn't run",
    blocked: "Blocked -- an input carried an execution blocker, so it didn't run",
    error: "Failed",
    interrupted: "Interrupted -- the run was stopped here",
    changed: "Changed since run",
});

/**
 * Run details of a node (summed time, first error message / change reason).
 *
 * @param {Array<string>} execIds - Node exec ids.
 * @returns {{time: number, message: string|null, reason: string|null}} Details.
 */
function runDetailsOf(execIds) {
    const out = { time: 0, message: null, reason: null };
    const details = lastRun.view?.details;
    if (!details) return out;
    for (const id of execIds ?? []) {
        const d = details.get(id);
        if (!d) continue;
        out.time += d.time ?? 0;
        out.message ??= d.message;
        out.reason ??= d.reason;
    }
    return out;
}

/** Max changed inner nodes named in a subgraph container's tooltip. */
const CONTAINER_CHANGES_MAX = 4;

/**
 * Tooltip lines naming the changed nodes inside a subgraph container, each
 * with its first change reason.
 *
 * @param {Array<string>} execIds - Container's exec ids.
 * @param {Object} model - Flow model.
 * @returns {string} Lines (each starting with a newline), or "".
 */
function containerChangeLines(execIds, model) {
    const details = lastRun.view?.details;
    if (!details) return "";
    const lines = [];
    let total = 0;
    for (const id of execIds ?? []) {
        const reason = details.get(id)?.reason;
        if (!reason) continue;
        total++;
        if (lines.length >= CONTAINER_CHANGES_MAX) continue;
        const node = model.nodes?.get(id)?.node;
        const more = reason.includes("\n") ? " …" : "";
        lines.push(`\n• ${node ? formatNodeTitle(node) : "node"} (#${id}): ${reason.split("\n")[0]}${more}`);
    }
    if (total > lines.length) lines.push(`\n+${total - lines.length} more`);
    return lines.join("");
}

/**
 * Tooltip text for a hit badge.
 *
 * @param {Object} hit - { kind, item, slot }.
 * @param {Object} model - Flow model.
 * @param {Object} graph - Viewed graph.
 * @returns {string} Text, or "".
 */
function tooltipTextFor(hit, model, graph) {
    const it = hit.item;
    const node = it.node;
    const info = it.info;
    const head = `${formatNodeTitle(node)} (#${info.kind === "container" ? node?.id : info.execIds?.[0] ?? node?.id})`;
    if (hit.kind === "run") {
        const d = runDetailsOf(info.execIds);
        const status = it.badge;
        if (status === "changed") {
            // The changes are the information; no explanation line.
            if (info.kind === "container") {
                const lines = containerChangeLines(info.execIds, model);
                return `${head}\nChanged since run, inside subgraph${lines ? `:${lines}` : ""}`;
            }
            return `${head}\nChanged since run:${d.reason ? `\n${d.reason}` : " something unknown"}`;
        }
        let text = RUN_TOOLTIPS[status] ?? status;
        if (status === "error" && d.message) text += `: ${d.message}`;
        if ((status === "error" || status === "interrupted") && d.time > 0) text += `\nRan ${formatSeconds(d.time)}`;
        if (info.kind === "container") {
            text = `Subgraph: something inside is ${status}\n${text}`;
        }
        return `${head}\n${text}`;
    }
    if (hit.kind === "switch") return `${head}\nSwitch -- has lazy inputs: only the branch it picks is evaluated`;
    if (hit.kind === "lazy") {
        const name = node?.inputs?.[hit.slot]?.label || node?.inputs?.[hit.slot]?.name || `input ${hit.slot}`;
        return `${head}\nLazy input "${name}" -- evaluated only if the node asks for it`;
    }
    if (hit.kind === "conditional") {
        let gates = [];
        try {
            gates = model.getGateTrace?.(graph, node)?.gates ?? [];
        } catch {
            gates = [];
        }
        const shown = gates.slice(0, GATE_HINT_MAX).map(gateLabel).join(", ");
        const more = gates.length > GATE_HINT_MAX ? ` +${gates.length - GATE_HINT_MAX} more` : "";
        return `${head}\nMay not run -- only feeds some branches of a switch` +
            (shown ? `\nDepends on: ${shown}${more}` : "");
    }
    return "";
}

/** Min hover radius of a badge / lazy diamond (screen px; drawn ones are smaller). */
const BADGE_HIT_SCREEN_PX = 12;
/** Half-height of the band along a node's top edge that picks its nearest badge (screen px). */
const BADGE_BAND_SCREEN_PX = 16;

/** Tooltip held open while the cursor stays over its node: { node, kind, slot } or null. */
let tooltipHold = null;

/**
 * Hover geometry shared by the hit test and the hold check.
 *
 * @param {number} lw - Line width (graph units).
 * @param {number} scale - Canvas zoom.
 * @returns {{pad: number, b: number, r: number, hitR: number, band: number}} Graph-unit sizes.
 */
function badgeMetrics(lw, scale) {
    const b = markSize(BADGE_SCREEN_PX, scale);
    return {
        pad: lw * 0.5 + 2 / scale,
        b,
        r: markSize(LAZY_DIAMOND_SCREEN_PX, scale),
        hitR: Math.max(b * 0.7, BADGE_HIT_SCREEN_PX / scale),
        band: Math.max(b * 0.9, BADGE_BAND_SCREEN_PX / scale),
    };
}

/**
 * Badges a node item currently shows, at the positions drawRunMarks /
 * drawNodeMarks use. `top` marks the ones centred on the node's top edge.
 *
 * @param {Object} it - Node item.
 * @param {Object} m - badgeMetrics().
 * @returns {Array<{kind: string, x: number, y: number, rad: number, slot?: number, top: boolean}>} Badges.
 */
function itemBadges(it, m) {
    const { pad, b, r, hitR } = m;
    const info = it.info;
    const top = it.y - pad;
    const out = [];
    if (it.badge && RUN_BADGES[it.badge]) {
        out.push({ kind: "run", x: it.x - pad + Math.max(b * 0.9, 8 + pad), y: top, rad: hitR, top: true });
    }
    if (!config.markLazy) return out;
    const isHop = info.kind === "virtual" || info.kind === "bypassed";
    const conditional = !!info.conditional && !isHop && !it.settled;
    let cx = it.x + it.w + pad - Math.max(b * 0.9, 8 + pad);
    if (info.isSwitch) {
        out.push({ kind: "switch", x: cx, y: top, rad: hitR, top: true });
        for (const slot of info.lazySlots ?? []) {
            let p = null;
            try {
                p = it.node.getInputPos(slot);
            } catch {
                p = null;
            }
            if (p) out.push({ kind: "lazy", x: p[0], y: p[1], rad: Math.max(r * 1.6, hitR), slot, top: false });
        }
        cx -= b * 1.3;
    }
    if (conditional) out.push({ kind: "conditional", x: cx, y: top, rad: hitR, top: true });
    return out;
}

/**
 * Whether a graph point is over a node item, including the badge band above
 * its top edge.
 *
 * @param {Object} it - Node item.
 * @param {number} gx - Graph x.
 * @param {number} gy - Graph y.
 * @param {Object} m - badgeMetrics().
 * @returns {boolean} Inside.
 */
function overItem(it, gx, gy, m) {
    const e = m.pad + m.band;
    return gx >= it.x - e && gx <= it.x + it.w + e && gy >= it.y - e && gy <= it.y + it.h + m.pad;
}

/**
 * Hit-test the badges of this frame's node items against a graph point.
 * A badge is hit within its (enlarged) radius; failing that, a point in the
 * band along a node's top edge picks that node's horizontally nearest top
 * badge, so the tiny marks don't need precise aim.
 *
 * @param {number} gx - Graph x.
 * @param {number} gy - Graph y.
 * @param {Object} m - badgeMetrics().
 * @returns {Object|null} { kind, item, slot } or null.
 */
function hitTestBadges(gx, gy, m) {
    const dim = state.trace ? 1 - config.dimStrength : 1;
    let banded = null;
    for (let i = nodeItemCount - 1; i >= 0; i--) {
        const it = nodeItems[i];
        if (!it.node) continue;
        if (!it.inTrace && dim <= 0.001) continue;
        if (!overItem(it, gx, gy, m)) continue;
        const badges = itemBadges(it, m);
        let best = null;
        let bestD = Infinity;
        for (const bd of badges) {
            const d = (gx - bd.x) ** 2 + (gy - bd.y) ** 2;
            if (d <= bd.rad * bd.rad && d < bestD) {
                best = bd;
                bestD = d;
            }
        }
        if (best) return { kind: best.kind, item: it, slot: best.slot };
        if (banded || Math.abs(gy - (it.y - m.pad)) > m.band) continue;
        let dx = Infinity;
        for (const bd of badges) {
            if (bd.top && Math.abs(gx - bd.x) < dx) {
                dx = Math.abs(gx - bd.x);
                banded = { kind: bd.kind, item: it, slot: bd.slot };
            }
        }
    }
    return banded;
}

/**
 * The held tooltip's hit for this frame, while the cursor is still over its
 * node and the badge still exists.
 *
 * @param {number} gx - Graph x.
 * @param {number} gy - Graph y.
 * @param {Object} m - badgeMetrics().
 * @returns {Object|null} { kind, item, slot } or null.
 */
function heldHit(gx, gy, m) {
    const hold = tooltipHold;
    if (!hold) return null;
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        if (it.node !== hold.node) continue;
        if (!overItem(it, gx, gy, m)) return null;
        const still = itemBadges(it, m).some((bd) => bd.kind === hold.kind && bd.slot === hold.slot);
        return still ? { kind: hold.kind, item: it, slot: hold.slot } : null;
    }
    return null;
}

/**
 * Per-frame tooltip update (call while the node items still hold their nodes).
 *
 * @param {Object} model - Flow model.
 * @param {Object} graph - Viewed graph.
 * @param {HTMLCanvasElement} mainEl - LiteGraph canvas element.
 * @param {number} lw - Line width (graph units).
 * @param {number} scale - Canvas zoom.
 * @param {number} ox - Canvas offset x.
 * @param {number} oy - Canvas offset y.
 * @returns {void}
 */
function updateTooltip(model, graph, mainEl, lw, scale, ox, oy) {
    installPointerTracking();
    const bracket = replayBar.el?.isConnected && !pointer.buttons ? replayBar.hoverBracket : null;
    if (bracket) {
        showTooltip(bracketText(bracket));
        return;
    }
    if (!pointer.inside || pointer.buttons) {
        hideTooltip();
        return;
    }
    const rect = mainEl.getBoundingClientRect();
    const sx = pointer.x - rect.left;
    const sy = pointer.y - rect.top;
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
        hideTooltip();
        return;
    }
    // screen = (graph + offset) * scale  (DragAndScale.convertOffsetToCanvas)
    const gx = sx / scale - ox;
    const gy = sy / scale - oy;
    const m = badgeMetrics(lw, scale);
    // A badge under the cursor wins; otherwise an open tooltip stays while
    // the cursor is anywhere over its node.
    const hit = hitTestBadges(gx, gy, m) ?? heldHit(gx, gy, m);
    const text = hit ? tooltipTextFor(hit, model, graph) : "";
    if (!text) {
        hideTooltip();
        return;
    }
    const it = hit.item;
    tooltipHold = { node: it.node, kind: hit.kind, slot: hit.slot };
    // Anchor above the node's badge row (badges are centred on its top edge).
    const r = m.b * 0.55;
    const toScreenY = (y) => (y + oy) * scale + rect.top;
    showTooltip(text, {
        left: (it.x - m.pad + ox) * scale + rect.left,
        top: toScreenY(it.y - m.pad - r),
        bottom: toScreenY(it.y - m.pad + r),
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Frame Rendering
// ═══════════════════════════════════════════════════════════════════════════

// ── Per-frame Pools ─────────────────────────────────────────────────────────

/** Visible link / ghost render items (reused across frames). */
const linkItems = [];
let linkItemCount = 0;

/** Visible node render items (reused across frames). */
const nodeItems = [];
let nodeItemCount = 0;

/** Live waves this frame: position (depth units) and hue. */
const waves = { w: new Float64Array(64), hue: new Float64Array(64), n: 0 };

/** Visible area in graph units (with margin). */
const view = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Hint lines for this frame. */
const hintLines = [];

/** Timestamp of the frame being rendered (ms). */
let frameNow = 0;

// ── Static Layer Hash ───────────────────────────────────────────────────────
// The steady layer (washes, gradient links, outlines) only changes when the
// view, geometry, node bounds, trace, model or settings change. The
// collectors fold everything it depends on into `frameHash`; the layer is
// re-rendered into an offscreen canvas only when the hash changes, so the
// per-frame cost while idle is one drawImage plus the pulses.

const FNV_OFFSET = 2166136261;
let frameHash = FNV_OFFSET;
/** Monotonic id handed to each (re)built geometry entry. */
let geometryVersion = 0;

/**
 * Fold a number into the per-frame static-layer hash.
 *
 * @param {number} v - Value (floats are quantised to 1/1000).
 * @returns {void}
 */
function hashMix(v) {
    frameHash = Math.imul(frameHash ^ (Math.round(v * 1000) | 0), 16777619) >>> 0;
}

/**
 * Offscreen canvas holding a cached static layer, sized like the overlay.
 *
 * @param {Object} st - Cache record (`state.staticLines` / `state.staticNodes`).
 * @param {number} width - Pixel width.
 * @param {number} height - Pixel height.
 * @returns {HTMLCanvasElement|null} The canvas, or null when unavailable.
 */
function ensureStaticCanvas(st, width, height) {
    if (!st.canvas) {
        st.canvas = document.createElement("canvas");
        st.ctx = st.canvas.getContext("2d");
        st.hash = -1;
    }
    if (!st.ctx) return null;
    if (st.canvas.width !== width || st.canvas.height !== height) {
        st.canvas.width = width;
        st.canvas.height = height;
        st.hash = -1;
    }
    return st.canvas;
}

/**
 * Draw a cached static layer onto `ctx`, re-rendering the cache first when
 * the frame hash, model, trace or config changed since it was drawn.
 * Leaves `ctx` with an identity transform.
 *
 * @param {CanvasRenderingContext2D} ctx - Destination context.
 * @param {Object} st - Cache record (`state.staticLines` / `state.staticNodes`).
 * @param {HTMLCanvasElement} overlay - Overlay (gives the pixel size).
 * @param {number} k - Graph -> device pixel scale (dpr * zoom).
 * @param {number} ox - Canvas offset x (graph units).
 * @param {number} oy - Canvas offset y (graph units).
 * @param {function(CanvasRenderingContext2D): void} draw - Paints the layer (graph transform set).
 * @returns {void}
 */
function drawCachedLayer(ctx, st, overlay, k, ox, oy, draw) {
    const sc = ensureStaticCanvas(st, overlay.width, overlay.height);
    if (sc && (st.hash !== frameHash || st.modelVersion !== state.modelVersion ||
        st.traceKey !== state.traceKey || st.configVersion !== state.configVersion)) {
        st.hash = frameHash;
        st.modelVersion = state.modelVersion;
        st.traceKey = state.traceKey;
        st.configVersion = state.configVersion;
        const sctx = st.ctx;
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalAlpha = 1;
        sctx.clearRect(0, 0, sc.width, sc.height);
        sctx.setTransform(k, 0, 0, k, k * ox, k * oy);
        draw(sctx);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (sc) {
        ctx.globalAlpha = 1;
        ctx.drawImage(sc, 0, 0);
    }
}

/**
 * Next reusable link item.
 *
 * @returns {Object} Link item.
 */
function nextLinkItem() {
    let item = linkItems[linkItemCount];
    if (!item) {
        item = { key: null, runKey: null, geom: null, info: null, ghost: false, inTrace: true, diamond: false, gate: false, idle: false };
        linkItems.push(item);
    }
    linkItemCount++;
    return item;
}

/**
 * Next reusable node item.
 *
 * @returns {Object} Node item.
 */
function nextNodeItem() {
    let item = nodeItems[nodeItemCount];
    if (!item) {
        item = {
            node: null, info: null, x: 0, y: 0, w: 0, h: 0, inTrace: true, status: null, grey: false, gate: false,
            running: false, settled: false, pending: false, glow: 0, badge: null,
        };
        nodeItems.push(item);
    }
    nodeItemCount++;
    return item;
}

// ── Collection ──────────────────────────────────────────────────────────────

/**
 * Lay out one link of the viewed graph and queue it when visible.
 *
 * @param {Object} graph - Viewed graph.
 * @param {Object} link - The link.
 * @param {Object} model - Flow model.
 * @param {number} renderMode - RENDER_* value.
 * @returns {void}
 */
function collectLink(graph, link, model, renderMode) {
    if (String(link.origin_id) === "-1" || String(link.target_id) === "-1") return; // floating
    if (!resolveLinkEndpoints(graph, link, endpoints)) return;
    const reroutes = getLinkReroutes(graph, link);
    if (!mayBeVisible(endpoints, reroutes, view)) return;
    fillSignature(renderMode, endpoints, reroutes, false);
    const g = getGeometry(link.id, false, renderMode, endpoints, reroutes);
    if (!g || !geometryVisible(g, view)) return;

    const item = nextLinkItem();
    item.key = link.id;
    item.geom = g;
    item.info = model.getLinkInfo(graph, link.id);
    item.ghost = false;
    const info = item.info;
    const needKey = state.trace || state.gate || lastRun.replay?.timeline;
    const key = needKey ? linkKey(graph, link.id) : null;
    item.runKey = key;
    item.inTrace = state.trace ? state.trace.linkKeys.has(key) : true;
    item.gate = state.gate ? state.gate.linkKeys.has(key) : false;
    item.diamond = !!(info?.lazy && info.active) && !lazySlotCoveredBySwitch(graph, link, model);
    item.idle = linkIdleInRun(info);
    hashMix(g.ver);
    hashMix((item.inTrace ? 1 : 2) + (item.diamond ? 4 : 0) + (item.idle ? 16 : 0));
}

/**
 * Whether a lazy link's target slot already gets a diamond from its switch
 * node (`info.lazySlots`), so the link-end diamond would only double it.
 * Only called for active lazy links (rare), so the key lookup is fine.
 *
 * @param {Object} graph - Viewed graph.
 * @param {Object} link - The link.
 * @param {Object} model - Flow model.
 * @returns {boolean} True when the switch marks the slot itself.
 */
function lazySlotCoveredBySwitch(graph, link, model) {
    if (String(link.target_id) === SUBGRAPH_OUTPUT_ID) return false;
    const target = graph.getNodeById?.(link.target_id);
    if (!target) return false;
    const tinfo = model.getNodeInfo(graph, target);
    if (!tinfo?.isSwitch) return false;
    return (tinfo.lazySlots ?? []).includes(link.target_slot);
}

/**
 * Queue all visible links of the viewed graph.
 *
 * @param {Object} graph - Viewed graph.
 * @param {Object} model - Flow model.
 * @param {number} renderMode - RENDER_* value.
 * @returns {void}
 */
function collectLinks(graph, model, renderMode) {
    const links = graph.links;
    if (!links) return;
    const iter = links instanceof Map ? links.values() : Object.values(links);
    for (const link of iter) {
        if (!link || link.id == null) continue;
        try {
            collectLink(graph, link, model, renderMode);
        } catch (err) {
            warnOnce("failed to lay out a link", err);
        }
    }
}

/**
 * Queue the visible ghost segments (Set/Get style virtual hops) of the viewed graph.
 *
 * @param {Object} graph - Viewed graph.
 * @param {Object} model - Flow model.
 * @returns {void}
 */
function collectGhosts(graph, model) {
    let segs;
    try {
        segs = model.getVirtualSegments(graph);
    } catch (err) {
        warnOnce("failed to read virtual segments", err);
        return;
    }
    if (!segs?.length) return;
    const titleH = LiteGraph?.NODE_TITLE_HEIGHT || 30;
    for (const seg of segs) {
        try {
            const from = seg.fromNode;
            const to = seg.toNode;
            if (!from || !to) continue;
            if ((from.graph && from.graph !== graph) || (to.graph && to.graph !== graph)) continue;

            const fb = getNodeBounds(from, boundsOut);
            endpoints.sx = fb[0] + fb[2];
            endpoints.sy = fb[1] + Math.min(titleH, fb[3]) * 0.5;
            const tb = getNodeBounds(to, boundsOut);
            endpoints.ex = tb[0];
            endpoints.ey = tb[1] + Math.min(titleH, tb[3]) * 0.5;
            if (seg.toInput >= 0 && to.inputs?.[seg.toInput] && !to.flags?.collapsed) {
                // Implicit link (e.g. Use Everywhere): ends on the target's input slot.
                const p = to.getInputPos(seg.toInput);
                if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
                    endpoints.ex = p[0];
                    endpoints.ey = p[1];
                }
            } else if (seg.toSlot >= 0 && to.outputs?.[seg.toSlot] && !to.flags?.collapsed) {
                const p = to.getOutputPos(seg.toSlot);
                if (p && Number.isFinite(p[1])) endpoints.ey = p[1];
            }
            endpoints.sdir = DIR_RIGHT;
            endpoints.edir = DIR_LEFT;

            if (!mayBeVisible(endpoints, [], view)) continue;
            fillSignature(RENDER_SPLINE, endpoints, [], true);
            const key = `V|${seg.key}`;
            const g = getGeometry(key, true, RENDER_SPLINE, endpoints, null);
            if (!g || !geometryVisible(g, view)) continue;

            const item = nextLinkItem();
            item.key = key;
            item.geom = g;
            item.info = seg;
            item.ghost = true;
            item.runKey = seg.key;
            item.idle = linkIdleInRun(seg);
            item.inTrace = state.trace ? state.trace.virtualKeys.has(seg.key) : true;
            item.gate = state.gate ? state.gate.virtualKeys.has(seg.key) : false;
            item.diamond = !!(seg.lazy && seg.active);
            hashMix(g.ver);
            hashMix((item.inTrace ? 3 : 5) + (item.diamond ? 8 : 0) + (item.idle ? 32 : 0));
        } catch (err) {
            warnOnce("failed to lay out a virtual segment", err);
        }
    }
}

/**
 * Whether the running exec id belongs to one of a node's exec ids: an exact
 * match, or a node created from it by expansion (`"<id>:..."`). A container's
 * exec ids are those of all its real descendants, so it matches while any of
 * them runs.
 *
 * @param {Array<string>} execIds - Node exec ids.
 * @param {string} runId - Running exec id.
 * @returns {boolean} True when the node (or something inside it) is running.
 */
function isRunningIn(execIds, runId) {
    for (const id of execIds ?? []) {
        if (runId === id || runId.startsWith(`${id}:`)) return true;
    }
    return false;
}

/**
 * Queue the visible nodes of the viewed graph that are part of the flow.
 *
 * @param {Object} graph - Viewed graph.
 * @param {Object} model - Flow model.
 * @returns {void}
 */
function collectNodes(graph, model) {
    for (const node of getGraphNodes(graph)) {
        try {
            const info = model.getNodeInfo(graph, node);
            if (!info) continue;
            const b = getNodeBounds(node, boundsOut);
            if (b[0] + b[2] < view.x0 || b[0] > view.x1 || b[1] + b[3] < view.y0 || b[1] > view.y1) continue;

            const item = nextNodeItem();
            item.node = node;
            item.info = info;
            item.x = b[0];
            item.y = b[1];
            item.w = b[2];
            item.h = b[3];
            const key = state.trace || state.gate ? nodeKey(graph, node) : null;
            item.inTrace = state.trace ? state.trace.nodeKeys.has(key) : true;
            item.gate = state.gate ? state.gate.nodeKeys.has(key) : false;
            const work = info.kind === "real" || info.kind === "container";
            item.status = work ? getRuntimeStatus(info.execIds) : null;
            item.running = item.status === "running" ||
                (!!state.runId && work && isRunningIn(info.execIds, state.runId));
            // A settled run status replaces the static "may not run" styling.
            item.settled = RUN_SETTLED.has(item.status);
            item.grey = info.kind === "muted" || (!info.active && !item.settled) || RUN_GREY.has(item.status) ||
                !Number.isFinite(info.depth);
            item.pending = item.status === "pending" && replayAnimating();
            // Corner badge: the final run status, also while a replay hasn't reached the node yet.
            item.badge = work && replayAnimating() ? finalStatusOf(info.execIds) : item.status;
            item.glow = !item.running && work && runAfterglow.size ? afterglowOf(info.execIds, frameNow) : 0;
            hashMix(b[0]);
            hashMix(b[1]);
            hashMix(b[2]);
            hashMix(b[3]);
            hashMix((item.grey ? 1 : 0) + (item.inTrace ? 2 : 0) + (item.pending ? 4 : 0) + statusCode(item.status) * 8 + statusCode(item.badge) * 512);
        } catch (err) {
            warnOnce("failed to read node info", err);
        }
    }
}

/**
 * Compute the waves alive at this moment.
 *
 * @param {number} now - Frame timestamp (ms).
 * @param {number} maxDepth - Model max depth.
 * @returns {void}
 */
function computeWaves(now, maxDepth) {
    waves.n = 0;
    // The run view shows what happened, not the predicted flow: no ambient waves.
    if (runViewActive()) return;
    const T = (now - state.epoch) / 1000 / config.secondsPerStep;
    const interval = Math.max(0.05, config.waveInterval / config.secondsPerStep);
    const life = maxDepth + 1;
    const kMax = Math.floor(T / interval);
    const kMin = Math.max(0, Math.ceil((T - life) / interval));
    for (let k = kMax; k >= kMin && waves.n < waves.w.length; k--) {
        const w = T - k * interval;
        if (w < 0 || w > life) continue;
        waves.w[waves.n] = w;
        waves.hue[waves.n] = config.pulseColor === "wave" ? k * GOLDEN_ANGLE : hueOf(w, maxDepth);
        waves.n++;
    }
}

// ── Drawing Passes ──────────────────────────────────────────────────────────

/**
 * Grey wash over nodes that will not run, plus a lighter wash over nodes
 * outside the selection trace (drawn below everything else). Inactive
 * styling is never weakened by the trace dimming.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {boolean} tracing - A selection trace is active.
 * @returns {void}
 */
function drawWashes(ctx, tracing) {
    ctx.fillStyle = WASH_FILL;
    const traceAlpha = config.dimStrength * 0.8;
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        const kind = it.info.kind;
        if (it.grey) {
            if (kind === "virtual" || kind === "bypassed") continue;
            ctx.globalAlpha = 1;
        } else if (it.pending) {
            // Replay: not reached yet.
            ctx.globalAlpha = 0.6;
        } else if (tracing && !it.inTrace && traceAlpha > 0.01) {
            ctx.globalAlpha = traceAlpha;
        } else {
            continue;
        }
        ctx.beginPath();
        addRoundRect(ctx, it.x, it.y, it.w, it.h, 8);
        ctx.fill();
    }
}

/**
 * Steady layer: gradient links / ghosts, grey for inactive or unresolved ones.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dim - Alpha multiplier outside the trace.
 * @returns {void}
 */
function drawSteadyLinks(ctx, maxDepth, lw, scale, dim) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const opacity = config.opacity;
    // Dashes mean exactly one thing: a ghost (virtual) link.
    const ghostDash = [8 / scale, 6 / scale];
    const noDash = [];
    for (let i = 0; i < linkItemCount; i++) {
        const it = linkItems[i];
        const a = it.inTrace ? 1 : dim;
        if (a <= 0.001) continue;
        const info = it.info;
        ctx.setLineDash(it.ghost ? ghostDash : noDash);
        if (!info || !info.active || it.idle) {
            ctx.globalAlpha = 0.3 * opacity * a;
            ctx.strokeStyle = GREY;
            ctx.lineWidth = lw * 0.6;
        } else {
            ctx.globalAlpha = opacity * a;
            ctx.strokeStyle = getGradient(ctx, it.key, it.geom, hueOf(info.t0, maxDepth), hueOf(info.t1, maxDepth));
            ctx.lineWidth = it.ghost ? lw * 0.75 : lw;
        }
        strokeFullPath(ctx, it.geom);
    }
    ctx.setLineDash(noDash);
}

/**
 * Size of a constant-screen-size mark in graph units: `px / scale`, but it
 * stops growing in graph units past BADGE_MAX_SCALE x `px` when zoomed far
 * out (so marks never dwarf the nodes they sit on).
 *
 * @param {number} px - Size in screen px.
 * @param {number} scale - Canvas zoom.
 * @returns {number} Size in graph units.
 */
function markSize(px, scale) {
    return Math.min(px / scale, px * BADGE_MAX_SCALE);
}

/**
 * Add an axis-aligned diamond to the current path.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Half-diagonal.
 * @returns {void}
 */
function addDiamond(ctx, cx, cy, r) {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
}

/**
 * Hollow diamond marking a lazy input, with a dark backing so it reads on
 * top of the slot dot.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Half-diagonal (graph units).
 * @param {string} color - Stroke colour.
 * @param {number} alpha - Opacity.
 * @returns {void}
 */
function drawLazyDiamond(ctx, cx, cy, r, color, alpha) {
    ctx.beginPath();
    addDiamond(ctx, cx, cy, r);
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = BADGE_BG;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.45;
    ctx.stroke();
}

/**
 * Hollow diamonds at the target end of lazy links (those whose slot is not
 * already marked by its switch node).
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} maxDepth - Model max depth.
 * @param {number} scale - Canvas zoom.
 * @param {number} dim - Alpha multiplier outside the trace.
 * @returns {void}
 */
function drawLinkDiamonds(ctx, maxDepth, scale, dim) {
    const r = markSize(LAZY_DIAMOND_SCREEN_PX, scale);
    ctx.setLineDash([]);
    ctx.lineJoin = "miter";
    for (let i = 0; i < linkItemCount; i++) {
        const it = linkItems[i];
        if (!it.diamond) continue;
        const a = it.inTrace ? 1 : dim;
        if (a <= 0.001) continue;
        const g = it.geom;
        drawLazyDiamond(ctx, g.pts[2 * g.n - 2], g.pts[2 * g.n - 1], r, hueColor(hueOf(it.info.t1, maxDepth)), a);
    }
    ctx.lineJoin = "round";
}

/**
 * Node marks: switch diamond badge and lazy-slot diamonds, "?" badge for
 * conditional real nodes and containers. Badges sit on the top edge of the outline near the
 * top-right corner, at constant screen size.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dim - Alpha multiplier outside the trace.
 * @returns {void}
 */
function drawNodeMarks(ctx, maxDepth, lw, scale, dim) {
    const pad = lw * 0.5 + 2 / scale;
    const b = markSize(BADGE_SCREEN_PX, scale);
    const r = markSize(LAZY_DIAMOND_SCREEN_PX, scale);
    const font = `bold ${(b * 0.8).toFixed(2)}px sans-serif`;
    ctx.setLineDash([]);
    ctx.lineJoin = "miter";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        const info = it.info;
        const isSwitch = !!info.isSwitch;
        // Hops (Set/Get, reroutes, bypassed nodes) are wiring, not work that
        // runs: they keep the faint outline but get no "?" badge (they would
        // otherwise dominate the badges on Set/Get-heavy workflows).
        const isHop = info.kind === "virtual" || info.kind === "bypassed";
        const conditional = !!info.conditional && !isHop && !it.settled;
        if (!isSwitch && !conditional) continue;
        const a = it.inTrace ? 1 : dim;
        if (a <= 0.001) continue;
        const color = it.grey ? GREY : hueColor(hueOf(info.depth, maxDepth));

        // Lazy input slots of a switch (drawn even when their links are off-screen).
        if (isSwitch && it.node) {
            for (const slot of info.lazySlots ?? []) {
                let p = null;
                try {
                    p = it.node.getInputPos(slot);
                } catch {
                    p = null;
                }
                if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) drawLazyDiamond(ctx, p[0], p[1], r, color, a);
            }
        }

        const top = it.y - pad;
        const right = it.x + it.w + pad;
        let cx = right - Math.max(b * 0.9, 8 + pad);
        if (isSwitch) {
            ctx.beginPath();
            addDiamond(ctx, cx, top, b * 0.6);
            ctx.globalAlpha = a;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = BADGE_BG;
            ctx.lineWidth = b * 0.12;
            ctx.stroke();
            cx -= b * 1.3;
        }
        if (conditional) {
            ctx.beginPath();
            ctx.arc(cx, top, b * 0.55, 0, Math.PI * 2);
            ctx.globalAlpha = a;
            ctx.fillStyle = BADGE_BG;
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = b * 0.1;
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.font = font;
            ctx.fillText("?", cx, top + b * 0.04);
        }
    }
    ctx.lineJoin = "round";
}

/**
 * Last-run marks: a coloured outline on failed nodes and a status badge
 * (cached / blocked / failed / interrupted / changed since the run) at the
 * top-left corner, at constant screen size. Drawn whatever the gradient /
 * marks settings say -- they are the run view's content.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dim - Alpha multiplier outside the trace.
 * @returns {void}
 */
function drawRunMarks(ctx, lw, scale, dim) {
    const pad = lw * 0.5 + 2 / scale;
    const b = markSize(BADGE_SCREEN_PX, scale);
    const font = `bold ${(b * 0.8).toFixed(2)}px sans-serif`;
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        const a = it.inTrace ? 1 : dim;
        if (a <= 0.001) continue;
        const outline = RUN_OUTLINE_COLORS[it.status];
        if (outline) {
            ctx.globalAlpha = a;
            ctx.strokeStyle = outline;
            ctx.lineWidth = lw;
            ctx.beginPath();
            addRoundRect(ctx, it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2, 8 + pad);
            ctx.stroke();
        }
        const badge = it.badge ? RUN_BADGES[it.badge] : null;
        if (!badge) continue;
        const cx = it.x - pad + Math.max(b * 0.9, 8 + pad);
        const cy = it.y - pad;
        ctx.beginPath();
        ctx.arc(cx, cy, b * 0.55, 0, Math.PI * 2);
        ctx.globalAlpha = a;
        ctx.fillStyle = BADGE_BG;
        ctx.fill();
        ctx.strokeStyle = badge.color;
        ctx.lineWidth = b * 0.1;
        ctx.stroke();
        ctx.fillStyle = badge.color;
        ctx.font = font;
        ctx.fillText(badge.glyph, cx, cy + b * 0.04);
    }
}

/**
 * Steady node outlines in depth colours (faint when conditional).
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dim - Alpha multiplier outside the trace.
 * @returns {void}
 */
function drawNodeOutlines(ctx, maxDepth, lw, scale, dim) {
    const pad = lw * 0.5 + 2 / scale;
    ctx.setLineDash([]);
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        const info = it.info;
        const a = it.inTrace ? 1 : dim;
        if (a <= 0.001) continue;
        const hop = info.kind === "virtual" || info.kind === "bypassed";
        if (it.grey) {
            // Recessive, like the selection dimming: the wash says "didn't
            // run"; a bright border would read as highlighted.
            if (hop) continue;
            ctx.globalAlpha = GREY_OUTLINE_ALPHA * a;
            ctx.strokeStyle = GREY;
            ctx.lineWidth = lw * 0.35;
        } else {
            const faded = (config.markLazy && info.conditional && !it.settled) ||
                it.status === "cached" || it.status === "changed";
            ctx.globalAlpha = config.opacity * a * (faded ? 0.5 : 1);
            ctx.lineWidth = lw * (hop ? 0.35 : 0.6);
            if (RUN_OUTLINE_COLORS[it.status]) continue; // drawn by drawRunMarks
            if (info.kind === "container" && Number.isFinite(info.depthEnd) && info.depthEnd !== info.depth) {
                const grad = ctx.createLinearGradient(it.x, it.y, it.x + it.w, it.y);
                grad.addColorStop(0, hueColor(hueOf(info.depth, maxDepth)));
                grad.addColorStop(1, hueColor(hueOf(info.depthEnd, maxDepth)));
                ctx.strokeStyle = grad;
            } else {
                ctx.strokeStyle = hueColor(hueOf(info.depth, maxDepth));
            }
        }
        ctx.beginPath();
        addRoundRect(ctx, it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2, 8 + pad);
        ctx.stroke();
    }
}

/**
 * Pulse layer: a short bright dash per live wave on every active link /
 * ghost whose time span the wave is crossing.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawPulses(ctx, maxDepth, lw, scale, dpr) {
    if (!waves.n) return;
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    const dashBase = Math.max(DASH_GRAPH_LENGTH, DASH_MIN_SCREEN_PX / scale);
    for (let i = 0; i < linkItemCount; i++) {
        const it = linkItems[i];
        const info = it.info;
        if (!it.inTrace || !info || !info.active || it.idle) continue;
        const g = it.geom;
        const t0 = info.t0;
        const dt = info.t1 - t0;
        if (!Number.isFinite(t0) || !Number.isFinite(dt)) continue;
        const dashLen = Math.min(g.len, dashBase);
        const baseAlpha = 1;

        for (let k = 0; k < waves.n; k++) {
            const w = waves.w[k];
            if (w < t0) continue;
            let s0;
            let s1;
            let alpha = baseAlpha;
            if (dt < 1e-3) {
                // Zero-length span: flash the whole link briefly.
                const age = w - t0;
                if (age > 0.25) continue;
                alpha *= 1 - age / 0.25;
                s0 = 0;
                s1 = g.len;
            } else {
                const head = ((w - t0) / dt) * g.len;
                if (head - dashLen >= g.len) continue;
                s0 = head - dashLen;
                s1 = head;
            }
            const color = hueColor(waves.hue[k]);
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 10 * dpr;
            ctx.lineWidth = lw * 1.5;
            strokeSubPath(ctx, g, s0, s1);
            ctx.shadowBlur = 0;
            ctx.globalAlpha = alpha * 0.6;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = lw * 0.5;
            strokeSubPath(ctx, g, s0, s1);
        }
    }
    ctx.shadowBlur = 0;
}

/** Replay: link / ghost key -> head position (0..1) along it this frame. */
const replayHeads = new Map();

/**
 * Replay pulses: during a node's travel phase, a dash runs along every link /
 * ghost that fed it (from nodes that were reached), in the node's depth colour.
 *
 * @param {CanvasRenderingContext2D} ctx - Line-layer context (graph transform).
 * @param {Object} model - Flow model.
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawReplayPulses(ctx, model, maxDepth, lw, scale, dpr) {
    const replay = lastRun.replay;
    const ev = replayAnimating() ? replay.timeline.events[replay.eventIndex] : null;
    if (!ev?.segs.length) return;
    const t = lastRun.replayTime;
    if (t >= ev.t1 || ev.t1 <= ev.t0) return;
    const p = (t - ev.t0) / (ev.t1 - ev.t0);
    replayHeads.clear();
    for (const s of ev.segs) {
        if (p < s.f0 || p > s.f1 || s.f1 <= s.f0) continue;
        const local = (p - s.f0) / (s.f1 - s.f0);
        replayHeads.set(s.key, Math.max(replayHeads.get(s.key) ?? 0, local));
    }
    if (!replayHeads.size) return;
    const color = hueColor(hueOf(model.nodes?.get(ev.execId)?.depth ?? 0, maxDepth));
    const dashBase = Math.max(DASH_GRAPH_LENGTH, DASH_MIN_SCREEN_PX / scale);
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    for (let i = 0; i < linkItemCount; i++) {
        const it = linkItems[i];
        const local = it.runKey == null ? undefined : replayHeads.get(it.runKey);
        if (local === undefined) continue;
        const g = it.geom;
        const dashLen = Math.min(g.len, dashBase * 1.5);
        const head = local * (g.len + dashLen);
        const s0 = Math.max(0, head - dashLen);
        const s1 = Math.min(g.len, head);
        if (s1 <= s0) continue;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * dpr;
        ctx.lineWidth = lw * 1.8;
        strokeSubPath(ctx, g, s0, s1);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = lw * 0.6;
        strokeSubPath(ctx, g, s0, s1);
    }
    ctx.shadowBlur = 0;
}

/**
 * Node flash layer: a glowing, thicker outline when a wave reaches a node
 * (or continuously while a runtime provider reports "running").
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay context (graph transform).
 * @param {number} now - Frame timestamp (ms).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawNodeFlashes(ctx, now, maxDepth, lw, scale, dpr) {
    const pad = lw * 0.5 + 2 / scale;
    ctx.setLineDash([]);
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        const info = it.info;
        if (!it.inTrace || it.grey) continue;
        const depth = info.depth;
        const depthEnd = Number.isFinite(info.depthEnd) ? info.depthEnd : depth;
        let intensity = 0;
        if (it.status === "running") intensity = 0.6 + 0.4 * Math.sin(now / 150);
        for (let k = 0; k < waves.n; k++) {
            const w = waves.w[k];
            // Full flash as the wave enters / leaves the node's span; a span
            // (subgraph container) only holds a dimmer glow while the wave is
            // inside, so long-running containers don't sit at peak brightness.
            const edge = Math.min(Math.abs(w - depth), Math.abs(w - depthEnd));
            let v = edge < 0.5 ? 1 - edge / 0.5 : 0;
            if (w > depth && w < depthEnd) v = Math.max(v, FLASH_SUSTAIN);
            if (v > intensity) intensity = v;
        }
        if (intensity <= 0.01) continue;
        const hop = info.kind === "virtual" || info.kind === "bypassed";
        const color = hueColor(hueOf((depth + depthEnd) * 0.5, maxDepth));
        ctx.globalAlpha = intensity;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 14 * dpr * intensity;
        ctx.lineWidth = lw * (hop ? 0.5 : 0.8) * (1 + intensity);
        ctx.beginPath();
        addRoundRect(ctx, it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2, 8 + pad);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;
}

/**
 * Gate highlight, link half: when the selection holds conditional nodes,
 * light up the lazy links / ghosts that carry the selection's influence into
 * the switches gating them (`drawGateRings` rings the switches themselves).
 *
 * @param {CanvasRenderingContext2D} ctx - Line-layer context (graph transform).
 * @param {number} now - Frame timestamp (ms).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawGateLinks(ctx, now, maxDepth, lw, scale, dpr) {
    if (!state.gate) return;
    const p = 0.55 + 0.45 * Math.sin(now / 220);
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 0; i < linkItemCount; i++) {
        const it = linkItems[i];
        if (!it.gate) continue;
        const color = hueColor(hueOf(it.info?.t1, maxDepth));
        ctx.globalAlpha = 0.5 + 0.5 * p;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * dpr * p;
        ctx.lineWidth = lw * 2;
        strokeFullPath(ctx, it.geom);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.4 + 0.4 * p;
        ctx.strokeStyle = GATE_RING;
        ctx.lineWidth = lw * 0.6;
        strokeFullPath(ctx, it.geom);
    }
    ctx.shadowBlur = 0;
}

/**
 * Gate highlight, node half: a pulsing ring around each gating switch.
 *
 * @param {CanvasRenderingContext2D} ctx - Node-layer context (graph transform).
 * @param {number} now - Frame timestamp (ms).
 * @param {number} maxDepth - Model max depth.
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawGateRings(ctx, now, maxDepth, lw, scale, dpr) {
    if (!state.gate) return;
    const p = 0.55 + 0.45 * Math.sin(now / 220);
    ctx.setLineDash([]);
    const pad = lw * 2 + 6 / scale;
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        if (!it.gate) continue;
        const info = it.info;
        const color = Number.isFinite(info.depth) ? hueColor(hueOf(info.depth, maxDepth)) : GATE_RING;
        ctx.globalAlpha = 0.5 + 0.5 * p;
        ctx.strokeStyle = GATE_RING;
        ctx.shadowColor = color;
        ctx.shadowBlur = 18 * dpr * p;
        ctx.lineWidth = lw * (0.7 + 0.5 * p);
        ctx.beginPath();
        addRoundRect(ctx, it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2, 10 + pad);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;
}

/**
 * Running-node ring: a bright white, pulsing ring around the node the backend
 * is executing (or the subgraph containing it, or the node a replay is at), drawn on top of everything
 * else so it stays visible over the flow colours. Same style as the gate
 * ring, but wider and faster so the two can be told apart when both show.
 *
 * @param {CanvasRenderingContext2D} ctx - Node-layer context (graph transform).
 * @param {number} now - Frame timestamp (ms).
 * @param {number} lw - Line width in graph units.
 * @param {number} scale - Canvas zoom.
 * @param {number} dpr - Device pixel ratio.
 * @returns {void}
 */
function drawRunRings(ctx, now, lw, scale, dpr) {
    if (!state.runId && !replayAnimating() && !runAfterglow.size) return;
    const p = 0.5 + 0.5 * Math.sin(now / 120);
    const pad = lw * 2.5 + 10 / scale;
    ctx.setLineDash([]);
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        if (!it.running) {
            if (it.glow > 0.01) {
                // Afterglow of a node that just finished: the ring fading out.
                ctx.globalAlpha = it.glow;
                ctx.strokeStyle = GATE_RING;
                ctx.shadowColor = GATE_RING;
                ctx.shadowBlur = 16 * dpr * it.glow;
                ctx.lineWidth = lw * (0.6 + 0.8 * it.glow);
                ctx.beginPath();
                addRoundRect(ctx, it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2, 12 + pad);
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
            continue;
        }
        const x = it.x - pad;
        const y = it.y - pad;
        const w = it.w + pad * 2;
        const h = it.h + pad * 2;
        ctx.globalAlpha = 0.75 + 0.25 * p;
        ctx.strokeStyle = GATE_RING;
        ctx.shadowColor = GATE_RING;
        ctx.shadowBlur = (12 + 16 * p) * dpr;
        ctx.lineWidth = lw * (1 + 0.6 * p);
        ctx.beginPath();
        addRoundRect(ctx, x, y, w, h, 12 + pad);
        ctx.stroke();
        // Outer halo that breathes outwards.
        const grow = (2 + 6 * p) / scale;
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.35 * (1 - p) + 0.1;
        ctx.lineWidth = lw * 0.5;
        ctx.beginPath();
        addRoundRect(ctx, x - grow, y - grow, w + grow * 2, h + grow * 2, 12 + pad + grow);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;
}

/**
 * Drop cache entries not used for a while (links deleted, scrolled away).
 *
 * @returns {void}
 */
function pruneCaches() {
    const cutoff = state.frame - 300;
    for (const [key, entry] of geomCache) {
        if (entry.seen < cutoff) {
            geomCache.delete(key);
            gradCache.delete(key);
        }
    }
}

/**
 * Render one overlay frame.
 *
 * @param {number} now - rAF timestamp (ms, performance.now() clock).
 * @returns {void}
 */
function renderFrame(now) {
    state.frame++;
    const canvas = app.canvas;
    const mainEl = canvas?.canvas;
    const ds = canvas?.ds;
    if (!mainEl || !ds) return;
    const overlay = ensureOverlay(mainEl);
    if (!overlay) return;
    const ctx = state.ctx;

    if (overlay.width !== mainEl.width || overlay.height !== mainEl.height) {
        overlay.width = mainEl.width;
        overlay.height = mainEl.height;
        state.hintAnchor.time = 0;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const lines = state.lines;
    if (lines.canvas?.width && lines.ctx) {
        lines.ctx.setTransform(1, 0, 0, 1, 0, 0);
        lines.ctx.clearRect(0, 0, lines.canvas.width, lines.canvas.height);
    }

    // Same DPR rule as ComfyApp.resizeCanvas (min 1).
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const cssW = overlay.width / dpr;
    const cssH = overlay.height / dpr;
    if (cssW <= 0 || cssH <= 0) return;

    const rootGraph = app.graph;
    const graph = canvas.graph;
    if (!rootGraph || !graph) return;

    updateModel(now, rootGraph);
    hintLines.length = 0;
    const model = state.model;
    if (!model) {
        hintLines.push(state.modelError ? "Flow: model unavailable (see console)" : "Flow: building...");
        drawHints(ctx, dpr, hintLines, now, cssW, cssH);
        return;
    }

    if (graph !== state.viewGraph) {
        state.viewGraph = graph;
        geomCache.clear();
        gradCache.clear();
        state.traceKey = null;
    }
    frameNow = now;
    pruneAfterglow(now);
    // The last run belongs to the workflow it was opened on (undo reloads keep the id).
    if (lastRun.show && (app.graph?.id ?? null) !== lastRun.graphId) {
        setMode("off");
        return;
    }
    if (lastRun.show) getRunView(model);
    updateReplay(model);
    updateRunTrace(now);
    updateTrace(model, graph);
    if (checkTransientOff(graph)) return;
    if (state.runId) {
        const runHint = formatRunHint(resolveRunNode(state.runId), state.runId);
        if (runHint) hintLines.push(runHint);
    }
    if (state.gateHint) hintLines.push(state.gateHint);
    if (model.noOutputs) hintLines.push("Flow: no output nodes -- showing all");
    pushRunHints(model, hintLines);
    updateReplayBar(model, now, cssW, cssH);

    const scale = ds.scale || 1;
    const ox = ds.offset[0];
    const oy = ds.offset[1];
    const lw = config.lineWidth / scale;
    const margin = lw * 4 + 20 / scale;
    view.x0 = -ox - margin;
    view.y0 = -oy - margin;
    view.x1 = -ox + cssW / scale + margin;
    view.y1 = -oy + cssH / scale + margin;

    const lrm = canvas.links_render_mode;
    const renderMode = lrm === RENDER_LINEAR || lrm === RENDER_STRAIGHT ? lrm : RENDER_SPLINE;
    const maxDepth = Math.max(1, Number(model.maxDepth) || 1);
    const dim = state.trace ? 1 - config.dimStrength : 1;

    linkItemCount = 0;
    nodeItemCount = 0;
    frameHash = FNV_OFFSET;
    collectLinks(graph, model, renderMode);
    collectGhosts(graph, model);
    collectNodes(graph, model);
    computeWaves(now, maxDepth);

    // graph -> screen: (p + offset) * scale (DragAndScale.convertOffsetToCanvas), times DPR.
    const k = dpr * scale;

    hashMix(k);
    hashMix(ox);
    hashMix(oy);
    hashMix(overlay.width);
    hashMix(overlay.height);
    hashMix(linkItemCount);
    hashMix(nodeItemCount);

    // Two layers, lines below nodes. Lines over nodes: both on the overlay.
    // Lines under nodes: the line layer goes to its own canvas (see ensureLinesCanvas).
    let lctx = ctx;
    if (config.linesUnder) {
        lctx = ensureLinesCanvas(mainEl) || ctx;
        // Resizing in ensureLinesCanvas clears it; otherwise cleared at the top of the frame.
    } else {
        removeLinesCanvas();
    }

    // ── Line layer: cached steady links + lazy diamonds, then pulses ──
    drawCachedLayer(lctx, state.staticLines, overlay, k, ox, oy, (sctx) => {
        if (config.showGradient) drawSteadyLinks(sctx, maxDepth, lw, scale, dim);
        if (config.markLazy) drawLinkDiamonds(sctx, maxDepth, scale, dim);
    });
    lctx.setTransform(k, 0, 0, k, k * ox, k * oy);
    drawPulses(lctx, maxDepth, lw, scale, dpr);
    drawReplayPulses(lctx, model, maxDepth, lw, scale, dpr);
    drawGateLinks(lctx, now, maxDepth, lw, scale, dpr);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = 1;

    // ── Node layer: cached washes / outlines / badges, then flashes ──
    drawCachedLayer(ctx, state.staticNodes, overlay, k, ox, oy, (sctx) => {
        drawWashes(sctx, !!state.trace);
        if (config.showGradient) drawNodeOutlines(sctx, maxDepth, lw, scale, dim);
        if (config.markLazy) drawNodeMarks(sctx, maxDepth, lw, scale, dim);
        drawRunMarks(sctx, lw, scale, dim);
    });
    ctx.setTransform(k, 0, 0, k, k * ox, k * oy);
    drawNodeFlashes(ctx, now, maxDepth, lw, scale, dpr);
    drawGateRings(ctx, now, maxDepth, lw, scale, dpr);
    drawRunRings(ctx, now, lw, scale, dpr);

    try {
        updateTooltip(model, graph, mainEl, lw, scale, ox, oy);
    } catch (err) {
        warnOnce("failed to update the badge tooltip", err);
    }

    // Release node references held by the pools.
    for (let i = 0; i < nodeItemCount; i++) nodeItems[i].node = null;

    drawHints(ctx, dpr, hintLines, now, cssW, cssH);
    if (state.frame % 120 === 0) pruneCaches();
}

// ═══════════════════════════════════════════════════════════════════════════
// Animation Loop & Modes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * rAF callback. Schedules the next frame first so a throwing frame never
 * stops the loop; after MAX_CONSECUTIVE_ERRORS failing frames the overlay
 * turns itself off.
 *
 * @param {number} now - rAF timestamp (ms).
 * @returns {void}
 */
function frame(now) {
    if (state.mode === "off") {
        state.rafId = 0;
        return;
    }
    state.rafId = requestAnimationFrame(frame);
    if (rendersInHost()) {
        // Lines under nodes, classic renderer: the frame is rendered from
        // LiteGraph's onRender so both layers stay in sync with the nodes;
        // just keep its front canvas redrawing for the animation.
        const canvas = app.canvas;
        installRenderHook(canvas);
        canvas?.setDirty?.(true, false);
        return;
    }
    safeRenderFrame(now);
}

/**
 * Render a frame, counting failures; after MAX_CONSECUTIVE_ERRORS failing
 * frames the overlay turns itself off. Never throws.
 *
 * @param {number} now - Frame timestamp (ms).
 * @returns {void}
 */
function safeRenderFrame(now) {
    try {
        renderFrame(now);
        state.consecutiveErrors = 0;
    } catch (err) {
        state.consecutiveErrors++;
        warnOnce("error while drawing a frame", err);
        try {
            state.ctx?.setTransform(1, 0, 0, 1, 0, 0);
            state.ctx.shadowBlur = 0;
            state.ctx.setLineDash([]);
        } catch {
            // ignore
        }
        if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.warn(`${LOG_PREFIX} Flow visualizer: too many drawing errors, turning the overlay off.`);
            setMode("off");
        }
    }
}

/**
 * Start the overlay loop (mode just left "off").
 *
 * @returns {void}
 */
function startLoop() {
    state.epoch = performance.now();
    state.rebuildNow = true;
    state.consecutiveErrors = 0;
    state.viewGraph = null;
    state.traceKey = null;
    if (!state.rafId) state.rafId = requestAnimationFrame(frame);
}

/**
 * Stop the loop, detach the overlay and drop the model (it holds node references).
 *
 * @returns {void}
 */
function stopLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = 0;
    removeOverlay();
    removeLinesCanvas();
    removeReplayBar();
    hideTooltip();
    for (const st of [state.staticLines, state.staticNodes]) {
        if (st.canvas) {
            st.canvas.width = 0;
            st.canvas.height = 0;
        }
        st.hash = -1;
    }
    // Classic + lines under: one more LiteGraph redraw drops the composited lines.
    app.canvas?.setDirty?.(true, false);
    state.model = null;
    state.modelRoot = null;
    state.signature = null;
    state.trace = null;
    state.traceGraph = null;
    state.gate = null;
    state.gateHint = "";
    state.viewGraph = null;
    geomCache.clear();
    gradCache.clear();
    linkItemCount = 0;
    nodeItemCount = 0;
}

/**
 * Switch the overlay on or off.
 *
 * @param {string} mode - "off" | "on".
 * @returns {void}
 */
function setMode(mode) {
    if (mode !== "off" && mode !== "on") return;
    const prev = state.mode;
    state.mode = mode;
    // Any explicit on/off makes the overlay persistent again; traceFromNode re-arms it.
    state.transient = false;
    state.transientGraph = null;
    state.traceKey = null;
    if (mode === "off") {
        // The run view is part of the overlay.
        lastRun.show = false;
        lastRun.replay = null;
        if (prev !== "off") stopLoop();
    } else if (prev === "off") {
        startLoop();
    }
}

/**
 * Toggle the overlay.
 *
 * @returns {void}
 */
function toggleMode() {
    setMode(state.mode === "off" ? "on" : "off");
}

/**
 * "Trace flow from here": turn the overlay on with the node selected.
 *
 * @param {Object} node - Right-clicked node.
 * @returns {void}
 */
function traceFromNode(node) {
    try {
        const canvas = app.canvas;
        const selected = getSelectedNodes(canvas, canvas.graph, []);
        if (node && !selected.includes(node)) canvas.selectNode?.(node);
    } catch (err) {
        warnOnce("failed to select the node to trace", err);
    }
    setMode("on");
    state.transient = true;
    state.transientGraph = null;
}

/**
 * Transient trace ("Trace flow from here"): turn the overlay off once the
 * user deselects everything. Only a deselect in the graph where a selection
 * was last seen counts -- entering a subgraph (e.g. "Go to gating switch")
 * shows an empty selection there without the user deselecting anything.
 *
 * @param {Object} graph - Viewed graph.
 * @returns {boolean} True when the overlay was turned off.
 */
function checkTransientOff(graph) {
    if (!state.transient) return false;
    if (state.selectionCount > 0) {
        state.transientGraph = graph;
        return false;
    }
    if (state.transientGraph !== graph) return false;
    setMode("off");
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Menus
// ═══════════════════════════════════════════════════════════════════════════

/** Model built on demand for the node menu while the overlay is off. */
const menuModel = { model: null, root: null, signature: null };

/**
 * A flow model for the current workflow: the overlay's own when it is on and
 * current, else one built on demand (cached by change signature).
 *
 * @returns {Object|null} Flow model, or null on failure.
 */
function getMenuModel() {
    const root = app.graph;
    if (!root) return null;
    if (state.mode !== "off" && state.model && state.modelRoot === root) return state.model;
    const sig = safeSignature(root);
    if (menuModel.model && menuModel.root === root && sig !== null && sig === menuModel.signature) {
        return menuModel.model;
    }
    try {
        menuModel.model = buildFlowModel(root, { sourcePlacement: config.sourcePlacement });
        menuModel.root = root;
        menuModel.signature = sig;
    } catch (err) {
        warnOnce("failed to build the flow model for the node menu", err);
        menuModel.model = null;
    }
    return menuModel.model;
}

/**
 * Gates (nearest gating switches) of a conditional node, for the node menu.
 *
 * @param {Object} node - Right-clicked node.
 * @returns {Array<Object>} Gate records with a navigable `node` (possibly empty).
 */
function getNodeGates(node) {
    const graph = node?.graph ?? app.canvas?.graph;
    if (!graph) return [];
    const model = getMenuModel();
    if (!model || typeof model.getGateTrace !== "function") return [];
    const info = model.getNodeInfo(graph, node);
    if (!info?.conditional) return [];
    const gt = model.getGateTrace(graph, node);
    return (gt?.gates ?? []).filter((g) => g?.node);
}

/**
 * Persist a setting through the settings store (fires its onChange), falling
 * back to applying it locally when the store is unavailable.
 *
 * @param {string} id - Setting id.
 * @param {*} value - New value.
 * @returns {void}
 */
function setSetting(id, value) {
    const store = app.extensionManager?.setting;
    if (typeof store?.set === "function") {
        Promise.resolve(store.set(id, value)).catch((err) => warnOnce(`failed to save setting ${id}`, err));
        return;
    }
    SETTINGS.find((s) => s.id === id)?.onChange(value);
}

/**
 * Canvas context-menu entry: a "Flow visualization" submenu with the show /
 * hide toggle, the last-run view and replay, and the lines over / under
 * nodes toggle.
 *
 * @returns {Array<Object|null>} Menu items (null = separator).
 */
function buildCanvasMenuItems() {
    return [
        {
            content: "Flow visualization",
            has_submenu: true,
            submenu: {
                options: [
                    {
                        content: state.mode === "off" || lastRun.show ? "Show" : "Hide",
                        callback: () => toggleFlow(),
                    },
                    {
                        content: lastRun.show ? "Hide last run" : "Show last run",
                        callback: () => showLastRun(!lastRun.show),
                    },
                    {
                        content: config.linesUnder ? "Draw lines over nodes" : "Draw lines under nodes",
                        callback: () => setSetting(SETTING_LINES_UNDER, !config.linesUnder),
                    },
                ],
            },
        },
    ];
}

/**
 * Node context-menu entries: "Trace flow from here" (only while the overlay
 * is off) and, for conditional
 * nodes, "Go to gating switch" (direct item for one gate, submenu for several).
 *
 * @param {Object} node - Right-clicked node.
 * @returns {Array<Object|null>} Menu items (null = separator).
 */
function buildNodeMenuItems(node) {
    // While the overlay is on it already follows the selection (and a
    // right-click selects the node), so the entry only matters when it's off.
    const items = [null];
    if (state.mode === "off") {
        items.push({
            content: "Trace flow from here",
            callback: () => traceFromNode(node),
        });
    }
    let gates = [];
    try {
        gates = getNodeGates(node);
    } catch (err) {
        warnOnce("failed to find the gating switches", err);
    }
    if (gates.length === 1) {
        items.push({ content: "Go to gating switch", callback: () => focusNode(gates[0].node) });
    } else if (gates.length > 1) {
        items.push({
            content: "Go to gating switch",
            has_submenu: true,
            submenu: {
                options: gates.map((gate) => ({ content: gateLabel(gate), callback: () => focusNode(gate.node) })),
            },
        });
    }
    return items.length > 1 ? items : [];
}
// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mark the model for a rebuild after a model-affecting setting changed.
 * Cheap and never turns the overlay on (settings fire onChange at load).
 *
 * @returns {void}
 */
function invalidateModel() {
    if (state.mode !== "off") state.modelDirty = true;
}

/**
 * Settings definitions (registered via the extension's `settings` array).
 * `sortOrder` keeps them in a sensible order (higher = earlier).
 */
const SETTINGS = [
    {
        id: SETTING_SHOW_GRADIENT,
        name: "Flow Visualizer - Show colour gradient",
        type: "boolean",
        defaultValue: true,
        sortOrder: 90,
        tooltip: "Draw every link as a gradient from its source colour to its target colour and outline nodes " +
            "in their depth colour. Pulses and inactive-node greying are shown either way.",
        onChange: (v) => {
            config.showGradient = v !== false;
        },
    },
    {
        id: SETTING_PULSE_COLOR,
        name: "Flow Visualizer - Pulse colour",
        type: "combo",
        options: [PULSE_COLOR_DEPTH, PULSE_COLOR_WAVE],
        defaultValue: PULSE_COLOR_DEPTH,
        sortOrder: 80,
        tooltip: "Shift with depth: a pulse takes the colour of the depth it has reached. " +
            "One colour per wave: each wave keeps its own colour.",
        onChange: (v) => {
            config.pulseColor = v === PULSE_COLOR_WAVE ? "wave" : "depth";
        },
    },
    {
        id: SETTING_SECONDS_PER_STEP,
        name: "Flow Visualizer - Seconds per depth step",
        type: "slider",
        attrs: { min: 0.1, max: 3, step: 0.05 },
        defaultValue: 0.6,
        sortOrder: 70,
        tooltip: "How long a pulse takes to advance one depth level.",
        onChange: (v) => {
            config.secondsPerStep = clampNumber(v, 0.1, 3, 0.6);
        },
    },
    {
        id: SETTING_WAVE_INTERVAL,
        name: "Flow Visualizer - Seconds between waves",
        type: "number",
        attrs: { min: 1, max: 30, step: 0.5 },
        defaultValue: 5,
        sortOrder: 60,
        tooltip: "A new pulse wave starts from the sources this often.",
        onChange: (v) => {
            config.waveInterval = clampNumber(v, 1, 30, 5);
        },
    },
    {
        id: SETTING_LINE_WIDTH,
        name: "Flow Visualizer - Line width (px)",
        type: "number",
        attrs: { min: 1, max: 12, step: 0.5 },
        defaultValue: 3,
        sortOrder: 50,
        tooltip: "Overlay line width in screen pixels (constant at any zoom).",
        onChange: (v) => {
            config.lineWidth = clampNumber(v, 1, 12, 3);
        },
    },
    {
        id: SETTING_OPACITY,
        name: "Flow Visualizer - Opacity",
        type: "slider",
        attrs: { min: 0.1, max: 1, step: 0.05 },
        defaultValue: 0.75,
        sortOrder: 40,
        tooltip: "Opacity of the steady gradient layer.",
        onChange: (v) => {
            config.opacity = clampNumber(v, 0.1, 1, 0.75);
        },
    },
    {
        id: SETTING_DIM_STRENGTH,
        name: "Flow Visualizer - Dim strength (selection)",
        type: "slider",
        attrs: { min: 0, max: 1, step: 0.05 },
        defaultValue: 0.8,
        sortOrder: 30,
        tooltip: "How strongly elements outside the traced selection are dimmed.",
        onChange: (v) => {
            config.dimStrength = clampNumber(v, 0, 1, 0.8);
        },
    },
    {
        id: SETTING_MARK_LAZY,
        name: "Flow Visualizer - Mark switches and conditional nodes",
        type: "boolean",
        defaultValue: true,
        sortOrder: 20,
        tooltip: "Mark lazy inputs with a hollow diamond, switch nodes with a diamond badge, and nodes that " +
            "may not run (only reachable through a switch) with a faint outline and a \"?\" badge.",
        onChange: (v) => {
            config.markLazy = v !== false;
        },
    },
    {
        id: SETTING_LINES_UNDER,
        name: "Flow Visualizer - Draw lines under nodes",
        type: "boolean",
        defaultValue: false,
        sortOrder: 15,
        tooltip: "Draw the flow lines and pulses below the nodes instead of on top of them. Node outlines, " +
            "badges and greying stay on top. Also in the canvas menu under Flow visualization. In the " +
            "classic renderer this redraws the graph canvas every frame while the overlay is on.",
        onChange: (v) => {
            config.linesUnder = v === true;
            // Drop (or start) the line layer composited into the LiteGraph canvas.
            app.canvas?.setDirty?.(true, false);
        },
    },
    {
        id: SETTING_REPLAY_DURATION,
        name: "Flow Visualizer - Replay length (s)",
        type: "number",
        attrs: { min: 3, max: 120, step: 1 },
        defaultValue: 12,
        sortOrder: 12,
        tooltip: "Target length of the last-run replay. Every node holds at least the minimum below, " +
            "plus extra time that grows with how long it really took; only that extra is compressed to fit, " +
            "so workflows with many nodes can take longer.",
        onChange: (v) => {
            config.replayDuration = clampNumber(v, 3, 120, 12);
        },
    },
    {
        id: SETTING_REPLAY_MIN_NODE,
        name: "Flow Visualizer - Replay minimum per node (ms)",
        type: "number",
        attrs: { min: 100, max: 3000, step: 50 },
        defaultValue: 500,
        sortOrder: 11,
        tooltip: "Shortest time a node is shown running during the last-run replay, so fast nodes stay visible. " +
            "All cached nodes share one beat of this length at the start.",
        onChange: (v) => {
            config.replayMinNodeMs = clampNumber(v, 100, 3000, 500);
        },
    },
    {
        id: SETTING_SOURCE_PLACEMENT,
        name: "Flow Visualizer - Source placement",
        type: "combo",
        options: [PLACEMENT_START, PLACEMENT_LATE],
        defaultValue: PLACEMENT_START,
        sortOrder: 10,
        tooltip: "At start: nodes without inputs (loaders, constants) sit at depth 0. " +
            "Just before first use: they move to one step before their first consumer.",
        onChange: (v) => {
            const next = v === PLACEMENT_LATE ? "late" : "start";
            if (next !== config.sourcePlacement) {
                config.sourcePlacement = next;
                menuModel.model = null;
                invalidateModel();
            }
        },
    },
];

// Every settings change invalidates the cached static layer.
for (const setting of SETTINGS) {
    const apply = setting.onChange;
    setting.onChange = (value, oldValue) => {
        apply(value, oldValue);
        state.configVersion++;
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

// Canvas menu: section of the shared Enhancement Utils block (after Follow execution).
registerCanvasMenuSection(30, () => buildCanvasMenuItems());

app.registerExtension({
    name: EXTENSION_NAME,

    settings: SETTINGS,

    commands: [
        {
            id: "EnhUtils.Flow.Toggle",
            label: "Toggle flow visualization",
            icon: "pi pi-sitemap",
            function: () => toggleFlow(),
            active: () => state.mode !== "off" && !lastRun.show,
        },
        {
            id: "EnhUtils.Flow.ShowLastRun",
            label: "Toggle last run (flow visualization)",
            icon: "pi pi-history",
            function: () => showLastRun(!lastRun.show),
            active: () => lastRun.show,
        },
    ],

    /**
     * Node right-click menu items (new extension API).
     *
     * @param {Object} node - The right-clicked node.
     * @returns {Array<Object|null>} Menu items.
     */
    getNodeMenuItems(node) {
        try {
            return buildNodeMenuItems(node);
        } catch (err) {
            warnOnce("failed to build the node menu", err);
            return [];
        }
    },

    /**
     * A workflow was loaded / a tab switched: node objects were replaced, so
     * rebuild right away instead of waiting for the debounced signature check.
     *
     * @returns {void}
     */
    afterConfigureGraph() {
        if (state.mode !== "off") state.rebuildNow = true;
    },

    /**
     * Track the executing node for the running ring / running trace, and
     * keep the last-run record current from the profiler's events.
     *
     * @returns {void}
     */
    setup() {
        try {
            api.addEventListener("executing", ({ detail }) => setRunningId(detail));
            for (const type of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
                api.addEventListener(type, () => setRunningId(null));
            }
            api.addEventListener("execution_start", ({ detail }) => onRunStart(detail));
            api.addEventListener("enhutils.profiler.node_state", ({ detail }) => onNodeState(detail));
            api.addEventListener("enhutils.profiler.execution_end", () => onRunEnd());
        } catch (err) {
            warnOnce("failed to listen for execution events", err);
        }
    },
});
