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
 * Future runtime seam: `registerFlowStateProvider(fn)` lets a later feature
 * (e.g. "replay last run") override the static node styling per execution id.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { buildFlowModel, computeFlowSignature, nodeKey, linkKey } from "./flowGraph.js";
import { findNodeByExecutionId, focusNode } from "./utils.js";

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
/** Flash intensity held while a wave is inside a container's depth span (peak is 1). */
const FLASH_SUSTAIN = 0.35;
/** Max gates named in the gate hint before "+N more". */
const GATE_HINT_MAX = 3;
/** Max characters of one gate title in the hint. */
const GATE_TITLE_MAX = 40;

const GREY = "rgb(128,128,128)";
const WASH_FILL = "rgba(20,20,20,0.55)";
const BADGE_BG = "rgba(0,0,0,0.8)";
const GATE_RING = "#fff";

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

    hintAnchor: { x: 12, y: 12, time: 0 },

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
// Runtime State Providers (future seam)
// ═══════════════════════════════════════════════════════════════════════════

/** Statuses that grey a node out (it did not / will not run). */
const STATUS_GREY = new Set(["skipped", "blocked"]);

/**
 * Register a runtime flow-state provider. Providers let a later feature
 * (e.g. replaying the last run from `executing` / `execution_cached` /
 * `executed` WebSocket events) override the static styling of real nodes.
 *
 * `fn(execId)` returns `null` (no opinion) or
 * `{ status: "pending"|"running"|"done"|"cached"|"blocked"|"skipped", order?: number }`.
 * "skipped" / "blocked" grey the node out, "running" makes it flash
 * continuously; other statuses keep the static styling. With no providers
 * registered the overlay shows the static model only.
 *
 * @param {function(string): (null|{status: string, order?: number})} fn - Provider.
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

/**
 * Combined runtime status of a node from all providers. "running" wins over
 * everything; otherwise the first non-null status is used.
 *
 * @param {Array<string>} execIds - Exec ids of the node.
 * @returns {string|null} Status, or null when no provider has an opinion.
 */
function getRuntimeStatus(execIds) {
    if (flowStateProviders.length === 0 || !execIds?.length) return null;
    let found = null;
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
            if (!found) found = status;
        }
    }
    return found;
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
        const runNode = state.runTraceId ? resolveRunNode(state.runTraceId) : null;
        if (runNode?.graph) {
            traceGraph = runNode.graph;
            nodes = [runNode];
            key += `run:${state.runTraceId}`;
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
    state.runId = next;
    state.runSince = performance.now();
    // Nothing running -> drop the trace straight away (no settle delay).
    if (!next) state.runTraceId = null;
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
    let title = node.type;
    try {
        title = node.getTitle?.() || node.title || node.type;
    } catch {
        // keep the type
    }
    title = String(title ?? "");
    if (title.length > GATE_TITLE_MAX) title = `${title.slice(0, GATE_TITLE_MAX - 1)}…`;
    return `Running: ${title} (#${id})`;
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
    try {
        const panel = document.querySelector(".graph-canvas-panel");
        if (panel && state.overlay) {
            const pr = panel.getBoundingClientRect();
            const or = state.overlay.getBoundingClientRect();
            if (pr.width > 40 && pr.height > 40) {
                anchor.x = pr.left - or.left + pr.width / 2;
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
    let y = anchor.y;
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
        item = { key: null, geom: null, info: null, ghost: false, inTrace: true, diamond: false, gate: false };
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
    const needKey = state.trace || state.gate;
    const key = needKey ? linkKey(graph, link.id) : null;
    item.inTrace = state.trace ? state.trace.linkKeys.has(key) : true;
    item.gate = state.gate ? state.gate.linkKeys.has(key) : false;
    item.diamond = !!(info?.lazy && info.active) && !lazySlotCoveredBySwitch(graph, link, model);
    hashMix(g.ver);
    hashMix((item.inTrace ? 1 : 2) + (item.diamond ? 4 : 0));
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
            item.inTrace = state.trace ? state.trace.virtualKeys.has(seg.key) : true;
            item.gate = state.gate ? state.gate.virtualKeys.has(seg.key) : false;
            item.diamond = !!(seg.lazy && seg.active);
            hashMix(g.ver);
            hashMix((item.inTrace ? 3 : 5) + (item.diamond ? 8 : 0));
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
            item.status = info.kind === "real" ? getRuntimeStatus(info.execIds) : null;
            item.running = !!state.runId && (info.kind === "real" || info.kind === "container") &&
                isRunningIn(info.execIds, state.runId);
            item.grey = info.kind === "muted" || !info.active || STATUS_GREY.has(item.status) ||
                !Number.isFinite(info.depth);
            hashMix(b[0]);
            hashMix(b[1]);
            hashMix(b[2]);
            hashMix(b[3]);
            // Runtime status only reaches the static layer through `grey`.
            hashMix((item.grey ? 1 : 0) + (item.inTrace ? 2 : 0));
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
        if (!info || !info.active) {
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
        const conditional = !!info.conditional && !isHop;
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
            ctx.globalAlpha = 0.6 * a;
            ctx.strokeStyle = GREY;
            ctx.lineWidth = lw * (hop ? 0.35 : 0.5);
        } else {
            ctx.globalAlpha = config.opacity * a * (config.markLazy && info.conditional ? 0.5 : 1);
            ctx.lineWidth = lw * (hop ? 0.35 : 0.6);
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
        if (!it.inTrace || !info || !info.active) continue;
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
 * is executing (or the subgraph containing it), drawn on top of everything
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
    if (!state.runId) return;
    const p = 0.5 + 0.5 * Math.sin(now / 120);
    const pad = lw * 2.5 + 10 / scale;
    ctx.setLineDash([]);
    for (let i = 0; i < nodeItemCount; i++) {
        const it = nodeItems[i];
        if (!it.running) continue;
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
    updateRunTrace(now);
    updateTrace(model, graph);
    if (checkTransientOff(graph)) return;
    if (state.runId) {
        const runHint = formatRunHint(resolveRunNode(state.runId), state.runId);
        if (runHint) hintLines.push(runHint);
    }
    if (state.gateHint) hintLines.push(state.gateHint);
    if (model.noOutputs) hintLines.push("Flow: no output nodes -- showing all");

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
    drawGateLinks(lctx, now, maxDepth, lw, scale, dpr);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = 1;

    // ── Node layer: cached washes / outlines / badges, then flashes ──
    drawCachedLayer(ctx, state.staticNodes, overlay, k, ox, oy, (sctx) => {
        drawWashes(sctx, !!state.trace);
        if (config.showGradient) drawNodeOutlines(sctx, maxDepth, lw, scale, dim);
        if (config.markLazy) drawNodeMarks(sctx, maxDepth, lw, scale, dim);
    });
    ctx.setTransform(k, 0, 0, k, k * ox, k * oy);
    drawNodeFlashes(ctx, now, maxDepth, lw, scale, dpr);
    drawGateRings(ctx, now, maxDepth, lw, scale, dpr);
    drawRunRings(ctx, now, lw, scale, dpr);

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
 * hide toggle and the lines over / under nodes toggle.
 *
 * @returns {Array<Object|null>} Menu items (null = separator).
 */
function buildCanvasMenuItems() {
    return [
        null,
        {
            content: "Flow visualization",
            has_submenu: true,
            submenu: {
                options: [
                    {
                        content: state.mode === "off" ? "Show" : "Hide",
                        callback: () => toggleMode(),
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

app.registerExtension({
    name: EXTENSION_NAME,

    settings: SETTINGS,

    commands: [
        {
            id: "EnhUtils.Flow.Toggle",
            label: "Toggle flow visualization",
            icon: "pi pi-sitemap",
            function: () => toggleMode(),
            active: () => state.mode !== "off",
        },
    ],

    /**
     * Canvas right-click menu items (new extension API, present in 1.53 and 1.57).
     *
     * @returns {Array<Object|null>} Menu items.
     */
    getCanvasMenuItems() {
        try {
            return buildCanvasMenuItems();
        } catch (err) {
            warnOnce("failed to build the canvas menu", err);
            return [];
        }
    },

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
     * Track the executing node for the running ring / running trace.
     *
     * @returns {void}
     */
    setup() {
        try {
            api.addEventListener("executing", ({ detail }) => setRunningId(detail));
            for (const type of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
                api.addEventListener(type, () => setRunningId(null));
            }
        } catch (err) {
            warnOnce("failed to listen for execution events", err);
        }
    },
});
