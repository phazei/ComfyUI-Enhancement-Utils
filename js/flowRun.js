/**
 * Flow run model -- pure logic behind the Flow Visualizer's "Show last run"
 * and "Replay last run".
 *
 * Input is the profiler's record of the last run (`GET /enhutils/profiler/run`,
 * kept current by `enhutils.profiler.node_state` WebSocket events), see
 * `profiler/hooks.py`: per exec id a state (ran / cached / blocked / error /
 * interrupted, or running while in progress), timing and display id, plus the
 * queued prompt (exec id -> {class_type, inputs}) and the workflow id.
 *
 * This module maps that record onto a flow model from `flowGraph.js`:
 *   - `computeRunView`   -- a display status per real node, including
 *     "skipped" (queued but never reached), "not_reached" (the run stopped
 *     first), "pending" (run still going) and "changed" (the node differs from
 *     what was queued: new, different class, different input links or widget
 *     values), plus counts and a "different workflow" verdict.
 *   - `buildReplayTimeline` -- the run's real execution order as a compressed
 *     animation timeline: per node a travel phase (pulses run along the links
 *     that fed it) and a work phase (scaled by the node's real time).
 *
 * Pure like flowGraph.js: no DOM, no `app` import, never throws on malformed
 * input. Unit-tested under Node with mock graphs.
 */

import { linkKey } from "./flowGraph.js";

// ── Constants ─────────────────────────────────────────────────────────────

/** States the backend reports for a node that is done. */
export const FINAL_STATES = Object.freeze(["ran", "cached", "blocked", "error", "interrupted"]);
const FINAL = new Set(FINAL_STATES);

/**
 * Display statuses, strongest first. A node or container with several
 * records (node expansion, subgraph children) shows the strongest one.
 * "changed" outranks ran / cached / blocked so a subgraph shows its Δ when
 * anything inside it was edited since the run.
 */
const PRIORITY = Object.freeze([
    "running", "error", "interrupted", "changed", "ran", "cached", "blocked", "pending", "not_reached", "skipped",
]);
const RANK = new Map(PRIORITY.map((s, i) => [s, i]));

/** Replay: pulse travel time into a node (s). */
const TRAVEL_S = 0.25;
/** Replay: default minimum hold per node (ms). */
const DEFAULT_MIN_NODE_MS = 500;
/** Replay: extra hold = EXTRA_PER_DECADE_S * log10(1 + time / EXTRA_REF_S) -- ~0.03 s at 10 ms, 0.8 s at 1 s, 2.4 s at 100 s. */
const EXTRA_PER_DECADE_S = 0.8;
const EXTRA_REF_S = 0.1;
/** Default cap on the whole replay (seconds). */
const DEFAULT_MAX_DURATION = 12;
/** Without a workflow id: below this share of matching nodes the run is from another workflow. */
const FOREIGN_MATCH_RATIO = 0.5;

/** Widget values compared to the prompt with this relative tolerance. */
const NUMBER_TOLERANCE = 1e-6;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Finite number or null.
 *
 * @param {*} v - Value.
 * @returns {number|null} Number, or null.
 */
function num(v) {
    const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Strongest of several statuses (see PRIORITY).
 *
 * @param {Iterable<string|null>} statuses - Statuses (nulls ignored).
 * @returns {string|null} Strongest status, or null.
 */
export function aggregateStatus(statuses) {
    let best = null;
    let bestRank = Infinity;
    for (const s of statuses ?? []) {
        if (!s) continue;
        const r = RANK.has(s) ? RANK.get(s) : PRIORITY.length;
        if (r < bestRank) {
            best = s;
            bestRank = r;
        }
    }
    return best;
}

// ── Run Records ───────────────────────────────────────────────────────────

/**
 * Normalise the backend's run JSON.
 *
 * @param {Object} raw - `GET /enhutils/profiler/run` response.
 * @returns {Object|null} Run { promptId, workflowId, status, errorNode, total,
 *   nodes: Map<execId, rec>, prompt: Map<execId, {class_type, inputs}>|null },
 *   or null when nothing has run.
 */
export function normalizeRun(raw) {
    if (!raw || typeof raw !== "object") return null;
    const status = String(raw.status ?? "none");
    if (status === "none") return null;
    const run = createLiveRun(raw.prompt_id);
    run.workflowId = raw.workflow_id == null ? "" : String(raw.workflow_id);
    run.status = status;
    run.errorNode = raw.error_node == null ? null : String(raw.error_node);
    run.total = num(raw.total) ?? 0;
    if (raw.nodes && typeof raw.nodes === "object") {
        for (const [id, rec] of Object.entries(raw.nodes)) setRecord(run, id, rec);
    }
    if (raw.prompt && typeof raw.prompt === "object") {
        const prompt = new Map();
        for (const [id, entry] of Object.entries(raw.prompt)) {
            if (entry && typeof entry === "object") prompt.set(String(id), entry);
        }
        run.prompt = prompt.size ? prompt : null;
    }
    return run;
}

/**
 * Empty record for a run that just started (filled by `applyNodeState`).
 *
 * @param {string} promptId - Prompt id.
 * @returns {Object} Run (see normalizeRun).
 */
export function createLiveRun(promptId) {
    return {
        promptId: promptId == null ? "" : String(promptId),
        workflowId: "",
        status: "running",
        errorNode: null,
        total: 0,
        nodes: new Map(),
        prompt: null,
    };
}

/**
 * Store one node record.
 *
 * @param {Object} run - Run.
 * @param {string} id - Exec id.
 * @param {Object} rec - Raw record { state, display, start, end, order, time }.
 * @returns {boolean} True when stored.
 */
function setRecord(run, id, rec) {
    if (id == null || !rec || typeof rec !== "object") return false;
    const execId = String(id);
    run.nodes.set(execId, {
        state: rec.state == null ? "running" : String(rec.state),
        display: rec.display == null ? execId : String(rec.display),
        start: num(rec.start),
        end: num(rec.end),
        order: num(rec.order),
        time: num(rec.time) ?? run.nodes.get(execId)?.time ?? null,
        message: rec.message == null ? run.nodes.get(execId)?.message ?? null : String(rec.message),
    });
    return true;
}

/**
 * Apply a live `enhutils.profiler.node_state` message.
 *
 * @param {Object} run - Run.
 * @param {Object} msg - { prompt_id, node, state, display, start, end, order }.
 * @returns {boolean} True when the run changed.
 */
export function applyNodeState(run, msg) {
    if (!run || !msg || typeof msg !== "object") return false;
    if (msg.prompt_id != null && run.promptId && String(msg.prompt_id) !== run.promptId) return false;
    return setRecord(run, msg.node, msg);
}

// ── Change Detection ──────────────────────────────────────────────────────

/** Max change reasons listed per node (then "+N more"). */
const MAX_REASONS = 6;
/** Max differing spots shown per value (JSON paths or text hunks). */
const MAX_SPOTS = 3;
/** Values up to this length are shown whole. */
const SHORT_VALUE = 40;
/** Context characters shown on each side of a text difference. */
const DIFF_CONTEXT = 18;
/** Max length of the old / new part of one text difference. */
const DIFF_PART_MAX = 40;
/** Myers diff gives up past this many edits (falls back to one window). */
const DIFF_MAX_EDITS = 200;

/**
 * Whether a prompt input value is a link: exactly `[nodeId, outputIndex]`.
 * Widgets can hold lists too (e.g. the bounding-box editor state), so a
 * plain `Array.isArray` is not enough.
 *
 * @param {*} v - Prompt input value.
 * @returns {boolean} True for a link.
 */
export function isPromptLink(v) {
    return Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") &&
        Number.isInteger(v[1]);
}

/**
 * Cut a string to `max` characters in the middle.
 *
 * @param {string} s - Text.
 * @param {number} max - Max length.
 * @returns {string} Text.
 */
function clip(s, max) {
    if (s.length <= max) return s;
    const half = Math.floor((max - 1) / 2);
    return `${s.slice(0, half)}…${s.slice(s.length - (max - 1 - half))}`;
}

/**
 * Short display form of a scalar value.
 *
 * @param {*} v - Value.
 * @returns {string} Text (strings quoted).
 */
function showValue(v) {
    if (v === undefined) return "∅";
    if (typeof v === "number") return String(Number.isInteger(v) ? v : Number(v.toFixed(4)));
    if (typeof v === "string") return `"${clip(v, SHORT_VALUE)}"`;
    if (v !== null && typeof v === "object") return clip(JSON.stringify(v) ?? "", SHORT_VALUE);
    return String(v);
}

/**
 * Parse a string that looks like a JSON object / array.
 *
 * @param {*} v - Value.
 * @returns {*} Parsed value, or undefined.
 */
function parseJsonish(v) {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    if (!(s.startsWith("{") || s.startsWith("["))) return undefined;
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}

/**
 * Structural difference of two JSON values: the paths that differ.
 *
 * @param {*} a - Before.
 * @param {*} b - After.
 * @param {string} path - Path so far.
 * @param {Array<string>} out - Receives "path: a → b" lines.
 * @param {Object} counter - { n } total differences found (may exceed out.length).
 * @returns {void}
 */
function diffJson(a, b, path, out, counter) {
    const objA = a !== null && typeof a === "object";
    const objB = b !== null && typeof b === "object";
    if (objA && objB && Array.isArray(a) === Array.isArray(b)) {
        const keys = Array.isArray(a)
            ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
            : [...new Set([...Object.keys(a), ...Object.keys(b)])];
        for (const k of keys) {
            const sub = Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : String(k);
            diffJson(a[k], b[k], sub, out, counter);
        }
        return;
    }
    if (a === b || (objA && objB && JSON.stringify(a) === JSON.stringify(b))) return;
    if (typeof a === "number" && typeof b === "number" &&
        Math.abs(a - b) <= NUMBER_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))) return;
    counter.n++;
    if (out.length < MAX_SPOTS) out.push(`${path || "(value)"}: ${showValue(a)} → ${showValue(b)}`);
}

/** Tokens: words, single whitespace runs, single punctuation characters. */
const TOKEN_RE = /[A-Za-z0-9_.-]+|\s+|[^\sA-Za-z0-9_.-]/g;

/**
 * Myers O(ND) diff of two token arrays.
 *
 * @param {Array<string>} a - Before tokens.
 * @param {Array<string>} b - After tokens.
 * @returns {Array<[string, string]>|null} Ops ["=" | "-" | "+", token], or null past DIFF_MAX_EDITS.
 */
function myers(a, b) {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, DIFF_MAX_EDITS);
    const off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                // Backtrack.
                const ops = [];
                let cx = n;
                let cy = m;
                for (let dd = d; dd > 0; dd--) {
                    const pv = trace[dd];
                    const kk = cx - cy;
                    const prevK = kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1]) ? kk + 1 : kk - 1;
                    const px = pv[off + prevK];
                    const py = px - prevK;
                    while (cx > px && cy > py) {
                        ops.push(["=", a[--cx]]);
                        cy--;
                    }
                    if (cx === px) ops.push(["+", b[--cy]]);
                    else ops.push(["-", a[--cx]]);
                }
                while (cx > 0 && cy > 0) {
                    ops.push(["=", a[--cx]]);
                    cy--;
                }
                return ops.reverse();
            }
        }
        v = v.slice();
    }
    return null;
}

/**
 * Excerpts of a long text around the spots that differ:
 * `…context «old» → «new» context…` per spot.
 *
 * @param {string} a - Before.
 * @param {string} b - After.
 * @returns {{spots: Array<string>, total: number}} Excerpts and how many spots differ.
 */
function diffText(a, b) {
    const ta = a.match(TOKEN_RE) ?? [];
    const tb = b.match(TOKEN_RE) ?? [];
    // Common prefix / suffix (cheap, and keeps the diff small).
    let pre = 0;
    while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
    let suf = 0;
    while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
    const midA = ta.slice(pre, ta.length - suf);
    const midB = tb.slice(pre, tb.length - suf);
    let ops = myers(midA, midB);
    if (!ops) ops = [...midA.map((t) => ["-", t]), ...midB.map((t) => ["+", t])]; // one window
    ops = [...ta.slice(0, pre).map((t) => ["=", t]), ...ops, ...ta.slice(ta.length - suf).map((t) => ["=", t])];

    // Group into hunks; equal runs shorter than 3 tokens join neighbouring hunks.
    const hunks = [];
    let i = 0;
    while (i < ops.length) {
        if (ops[i][0] === "=") {
            i++;
            continue;
        }
        const start = i;
        let end = i;
        while (end < ops.length) {
            if (ops[end][0] !== "=") {
                end++;
                continue;
            }
            let eq = end;
            while (eq < ops.length && ops[eq][0] === "=") eq++;
            if (eq < ops.length && eq - end < 3) end = eq;
            else break;
        }
        hunks.push([start, end]);
        i = end;
    }
    const spots = [];
    for (const [s, e] of hunks.slice(0, MAX_SPOTS)) {
        let del = "";
        let ins = "";
        for (let j = s; j < e; j++) {
            const [op, t] = ops[j];
            if (op !== "+") del += t;
            if (op !== "-") ins += t;
        }
        let left = "";
        for (let j = s - 1; j >= 0 && ops[j][0] !== "-" && left.length < DIFF_CONTEXT; j--) {
            if (ops[j][0] === "=") left = ops[j][1] + left;
        }
        let right = "";
        for (let j = e; j < ops.length && right.length < DIFF_CONTEXT; j++) {
            if (ops[j][0] === "=") right += ops[j][1];
        }
        left = left.length > DIFF_CONTEXT ? left.slice(left.length - DIFF_CONTEXT) : left;
        right = right.length > DIFF_CONTEXT ? right.slice(0, DIFF_CONTEXT) : right;
        const lead = s > 0 && left.length >= DIFF_CONTEXT ? "…" : "";
        const tail = e < ops.length && right.length >= DIFF_CONTEXT ? "…" : "";
        const flat = (x) => x.replace(/\s+/g, " ");
        const d = flat(clip(del, DIFF_PART_MAX));
        const n = flat(clip(ins, DIFF_PART_MAX));
        // Pure insertion / deletion: one side only.
        const change = !del ? `+«${n}»` : !ins ? `−«${d}»` : `«${d}» → «${n}»`;
        spots.push(`${lead}${flat(left)}${change}${flat(right)}${tail}`);
    }
    return { spots, total: hunks.length };
}

/**
 * Lines describing how a widget value changed: the whole value when short,
 * the differing JSON paths for JSON (objects or JSON text), else excerpts
 * around each differing spot of the text.
 *
 * @param {string} name - Widget name.
 * @param {*} before - Queued value.
 * @param {*} after - Current value.
 * @returns {Array<string>} Lines.
 */
export function describeValueChange(name, before, after) {
    const ja = typeof before === "object" ? before : parseJsonish(before);
    const jb = typeof after === "object" ? after : parseJsonish(after);
    if (ja !== undefined && jb !== undefined && ja !== null && jb !== null) {
        const out = [];
        const counter = { n: 0 };
        diffJson(ja, jb, "", out, counter);
        if (out.length) {
            const more = counter.n > out.length ? ` (+${counter.n - out.length} more)` : "";
            return out.map((line, i) => `${name}${line.startsWith("[") ? "" : "."}${line}${i === out.length - 1 ? more : ""}`);
        }
    }
    if (typeof before === "string" && typeof after === "string" &&
        (before.length > SHORT_VALUE || after.length > SHORT_VALUE)) {
        const { spots, total } = diffText(before, after);
        if (spots.length) {
            const more = total > spots.length ? ` (+${total - spots.length} more)` : "";
            return spots.map((s, i) => `${name}: ${s}${i === spots.length - 1 ? more : ""}`);
        }
    }
    return [`${name} ${showValue(before)} → ${showValue(after)}`];
}

/**
 * Undo the frontend's queue-time wrapping of widget values
 * (`executionUtil.ts` `unwrapExportedWidgetValue`): arrays are sent as
 * `{__value__: [...]}` so the backend doesn't read them as links, curves as
 * `{__type__: "CURVE", __value__}`.
 *
 * @param {*} v - Prompt input value.
 * @returns {*} The widget value as the widget holds it.
 */
function unwrapQueued(v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && "__value__" in v &&
        (v.__type__ === "CURVE" || Array.isArray(v.__value__))) {
        return v.__value__;
    }
    return v;
}

/**
 * Whether a widget's current value differs from the queued one. Ignored:
 * widgets that change themselves on queue (seed "control after generate" ->
 * `linkedWidgets`), widgets whose value is rewritten when queued (an own
 * `serializeValue`, e.g. dynamic prompts or Save Image's `%date%` prefix; the
 * DOM-widget prototype method is plain), and dynamic-prompt text. Object
 * values are compared structurally.
 *
 * @param {Object} widget - Widget.
 * @param {*} queued - Value in the prompt.
 * @returns {boolean} True when it changed.
 */
function widgetChanged(widget, queued) {
    if (queued === undefined || queued === null || isPromptLink(queued)) return false;
    if (!widget || widget.linkedWidgets?.length) return false;
    if (widget.options?.serialize === false || widget.serialize === false) return false;
    if (Object.prototype.hasOwnProperty.call(widget, "serializeValue")) return false;
    const value = widget.value;
    if (value === undefined || value === null) return false;
    if (typeof value === "object" || typeof queued === "object") {
        if (typeof value !== "object" || typeof queued !== "object") return false;
        try {
            return JSON.stringify(value) !== JSON.stringify(queued);
        } catch {
            return false;
        }
    }
    if (typeof value === "number" || typeof queued === "number") {
        const a = Number(value);
        const b = Number(queued);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return String(value) !== String(queued);
        return Math.abs(a - b) > NUMBER_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
    }
    const dynamic = widget.dynamicPrompts ?? widget.options?.dynamicPrompts;
    if (typeof value === "string" && dynamic && /[{}]|\/\/|\/\*/.test(value)) return false;
    return String(value) !== String(queued);
}

/** Subgraph input node id (link origin inside a subgraph). */
const SUBGRAPH_INPUT_ID = "-10";

/**
 * A graph's link by id (Map or record storage).
 *
 * @param {Object} graph - Graph.
 * @param {*} id - Link id.
 * @returns {Object|null} Link.
 */
function linkOf(graph, id) {
    try {
        return graph?.getLink?.(id) ?? (graph?.links instanceof Map ? graph.links.get(id) : graph?.links?.[id]) ?? null;
    } catch {
        return null;
    }
}

/**
 * Input slot of a node that carries a widget (by `input.widget.name`, else by name).
 *
 * @param {Object} node - Node.
 * @param {string} name - Widget name.
 * @returns {Object|null} Input slot.
 */
function widgetInput(node, name) {
    for (const inp of node?.inputs ?? []) {
        if (inp?.widget?.name === name) return inp;
    }
    for (const inp of node?.inputs ?? []) {
        if (inp?.name === name) return inp;
    }
    return null;
}

/**
 * The widget whose value is queued for `widget` of a real node. Normally the
 * widget itself. When its input is fed by a noodle from a subgraph input, the
 * queued value comes from the subgraph container's widget for that input
 * (followed up through nested subgraphs); the inner widget keeps a stale
 * value of its own. Returns null when the supplier can't be determined (then
 * the widget isn't compared). Other noodles (legacy primitive nodes) keep the
 * widget itself -- they copy their value into it.
 *
 * @param {Object} flowNode - FlowNode (node, execId).
 * @param {Object} widget - Widget of flowNode.node.
 * @param {Object} [rootGraph] - Root graph (needed to find the containers).
 * @returns {Object|null} Widget-like object with `value`, or null.
 */
function widgetSource(flowNode, widget, rootGraph) {
    let node = flowNode?.node;
    let input = widgetInput(node, widget.name);
    if (input?.link == null) return widget;
    const path = String(flowNode.execId ?? "").split(":");
    path.pop(); // own id -> path of the containers around it
    for (let guard = 0; guard < 32; guard++) {
        const link = linkOf(node.graph, input.link);
        if (!link) return widget; // stale link id: the backend saw no link either
        if (String(link.origin_id) !== SUBGRAPH_INPUT_ID) return guard === 0 ? widget : null;
        // Fed by a subgraph input: go to the container's matching input.
        if (!rootGraph || !path.length) return null;
        let container = null;
        let g = rootGraph;
        for (const id of path) {
            container = g?.getNodeById?.(id) ?? null;
            g = container?.subgraph;
        }
        path.pop();
        if (!container) return null;
        const slotName = node.graph?.inputs?.[link.origin_slot]?.name;
        const outer = slotName != null
            ? (container.inputs ?? []).find((i) => i?.name === slotName) ?? container.inputs?.[link.origin_slot]
            : container.inputs?.[link.origin_slot];
        if (!outer) return null;
        if (outer.link != null) {
            node = container;
            input = outer;
            continue;
        }
        const wname = outer.widget?.name ?? outer.name;
        return (container.widgets ?? []).find((w) => w?.name === wname) ?? null;
    }
    return null;
}

/**
 * Every way a real node differs from what was queued: missing from the
 * prompt, another class, other input sources, other widget values.
 *
 * @param {Object} flowNode - FlowNode from the model (node, inEdges).
 * @param {Object|undefined} entry - Prompt entry { class_type, inputs }.
 * @param {Object} [options] - { rootGraph } -- lets widgets fed through subgraph inputs be
 *   compared against the container widget that supplies them.
 * @returns {Array<string>} Reason lines (empty when unchanged).
 */
export function nodeChangeReasons(flowNode, entry, options = {}) {
    if (!entry) return ["new node (not in the run)"];
    const node = flowNode?.node;
    if (!node) return [];
    const out = [];
    try {
        const cls = node.comfyClass ?? node.type;
        if (entry.class_type && cls && String(entry.class_type) !== String(cls)) {
            return [`node type changed (${entry.class_type} → ${cls})`];
        }
        const inputs = entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {};
        const linked = new Set();
        for (const e of flowNode.inEdges ?? []) {
            const name = node.inputs?.[e.toSlot]?.name;
            if (name == null) continue;
            linked.add(name);
            const queued = inputs[name];
            if (isPromptLink(queued)) {
                if (String(queued[0]) !== e.from || Number(queued[1]) !== e.fromSlot) out.push(`input "${name}" re-linked`);
            } else if (queued === undefined) {
                out.push(`input "${name}" connected`);
            }
            // A plain value where the model sees a link: e.g. a primitive
            // widget feeding it -- not comparable, leave it.
        }
        const slotByName = new Map((node.inputs ?? []).map((inp) => [inp?.name, inp]));
        for (const [name, queued] of Object.entries(inputs)) {
            if (!isPromptLink(queued) || linked.has(name) || !slotByName.has(name)) continue;
            // Still linked on the canvas but untraceable for the model: not a disconnect.
            if (slotByName.get(name)?.link != null) continue;
            out.push(`input "${name}" disconnected`);
        }
        for (const w of node.widgets ?? []) {
            if (!w?.name || linked.has(w.name)) continue;
            // A noodle may feed the widget (through subgraph inputs): compare
            // against the widget that actually supplies the value.
            const source = widgetSource(flowNode, w, options.rootGraph);
            if (!source) continue;
            const queued = unwrapQueued(inputs[w.name]);
            if (widgetChanged(source, queued)) out.push(...describeValueChange(w.name, queued, source.value));
        }
    } catch {
        return out;
    }
    if (out.length > MAX_REASONS) return [...out.slice(0, MAX_REASONS - 1), `+${out.length - MAX_REASONS + 1} more`];
    return out;
}

/**
 * Why a real node differs from what was queued, or null (all reasons, one per line).
 *
 * @param {Object} flowNode - FlowNode from the model.
 * @param {Object|undefined} entry - Prompt entry.
 * @returns {string|null} Reasons joined by newlines, or null.
 */
export function nodeChangeReason(flowNode, entry, options = {}) {
    const reasons = nodeChangeReasons(flowNode, entry, options);
    return reasons.length ? reasons.join("\n") : null;
}

/**
 * Whether a real node differs from what was queued (see nodeChangeReasons).
 *
 * @param {Object} flowNode - FlowNode from the model.
 * @param {Object|undefined} entry - Prompt entry.
 * @returns {boolean} True when it changed since the run.
 */
export function nodeChangedSinceRun(flowNode, entry, options = {}) {
    return nodeChangeReasons(flowNode, entry, options).length > 0;
}

// ── Run View ──────────────────────────────────────────────────────────────

/**
 * Model exec id a run record belongs to: its display id (node expansion
 * reports the expanding node), else its own id.
 *
 * @param {Map<string, Object>} nodes - Model nodes.
 * @param {string} id - Record exec id.
 * @param {Object} rec - Record.
 * @returns {string|null} Model exec id, or null.
 */
function modelIdOf(nodes, id, rec) {
    if (rec?.display && nodes.has(rec.display)) return rec.display;
    return nodes.has(id) ? id : null;
}

/**
 * Display status of every real node of the model for a run.
 *
 * @param {Object|null} run - Run (see normalizeRun).
 * @param {Object} model - Flow model (`nodes`: Map execId -> FlowNode).
 * @param {Object} [options] - Options.
 * @param {string} [options.workflowId] - Id of the workflow on screen (`app.graph.id`).
 * @param {Object} [options.rootGraph] - Root graph, to resolve widgets fed through subgraph inputs.
 * @returns {{statuses: Map<string, string>, details: Map<string, Object>, counts: Object, foreign: boolean,
 *   finished: boolean}} `foreign` = the run belongs to another workflow (no statuses then). `details`:
 *   per exec id { time (s, summed over records), message (error text), reason (why "changed") }.
 */
export function computeRunView(run, model, options = {}) {
    const view = { statuses: new Map(), details: new Map(), counts: {}, foreign: false, finished: false };
    /**
     * Detail record of an exec id (created on demand).
     * @param {string} id - Exec id.
     * @returns {Object} { time, message, reason }.
     */
    const detail = (id) => {
        let d = view.details.get(id);
        if (!d) view.details.set(id, (d = { time: 0, message: null, reason: null }));
        return d;
    };
    if (!run || !(model?.nodes instanceof Map)) return view;
    try {
        const nodes = model.nodes;
        view.finished = run.status !== "running";
        const wf = options.workflowId == null ? "" : String(options.workflowId);
        if (run.workflowId && wf && run.workflowId !== wf) {
            view.foreign = true;
            return view;
        }
        if (!run.workflowId && run.prompt?.size) {
            let matches = 0;
            for (const [id, fn] of nodes) {
                const entry = run.prompt.get(id);
                if (entry && String(entry.class_type) === String(fn.node?.comfyClass ?? fn.node?.type)) matches++;
            }
            const base = Math.min(run.prompt.size, nodes.size);
            if (base > 0 && matches < base * FOREIGN_MATCH_RATIO) {
                view.foreign = true;
                return view;
            }
        }

        /** model exec id -> record states */
        const byId = new Map();
        for (const [id, rec] of run.nodes) {
            const mid = modelIdOf(nodes, id, rec);
            if (!mid) continue;
            let state = rec.state;
            if (state === "running" && view.finished) state = "not_reached";
            if (!byId.has(mid)) byId.set(mid, []);
            byId.get(mid).push(state);
            const d = detail(mid);
            d.time += rec.time ?? 0;
            if (rec.message && !d.message) d.message = rec.message;
        }

        for (const [id, fn] of nodes) {
            let status;
            const reason = run.prompt ? nodeChangeReason(fn, run.prompt.get(id), { rootGraph: options.rootGraph }) : null;
            if (reason) {
                status = "changed";
                detail(id).reason = reason;
            } else if (byId.has(id)) {
                status = aggregateStatus(byId.get(id));
            } else if (!view.finished) {
                status = "pending";
            } else if (run.status === "error" || run.status === "interrupted") {
                status = "not_reached";
            } else {
                status = "skipped";
            }
            view.statuses.set(id, status);
            view.counts[status] = (view.counts[status] ?? 0) + 1;
        }
    } catch {
        // keep what we have
    }
    return view;
}

// ── Replay ────────────────────────────────────────────────────────────────

/**
 * Pulse segments of an edge for the replay: its link / ghost segments in
 * path order with their share of the edge ([f0, f1] of 0..1).
 *
 * @param {Object} edge - FlowEdge.
 * @returns {Array<{kind: string, key: string, f0: number, f1: number}>} Segments.
 */
function edgeSegments(edge) {
    const timed = (edge.segments ?? []).filter((s) => s && s.type !== "hop");
    const n = timed.length;
    const out = [];
    timed.forEach((seg, k) => {
        const f0 = k / n;
        const f1 = (k + 1) / n;
        if (seg.type === "link") out.push({ kind: "link", key: linkKey(seg.graph, seg.linkId), f0, f1 });
        else if (seg.type === "virtual") out.push({ kind: "virtual", key: seg.key, f0, f1 });
    });
    return out;
}

/**
 * Animation timeline of a run in real execution order.
 *
 * All cached nodes share one beat at the start (a cached node's whole
 * upstream is unchanged, so its output exists before anything runs). Every
 * other node that was reached gets a slot: a travel phase (pulses along the
 * links that fed it, from nodes that were themselves reached) and a hold of
 * at least `minNodeMs`, plus extra time growing with the log of its real time
 * (so trivial nodes are still visible and a 100 s sampler doesn't dominate).
 * Only the extra time is compressed to fit `maxDuration`; the fixed parts
 * never shrink, so big workflows may run longer than `maxDuration`.
 *
 * @param {Object|null} run - Run.
 * @param {Object} model - Flow model.
 * @param {Object} [options] - Options.
 * @param {number} [options.maxDuration=12] - Target total duration (s); caps the extra time only.
 * @param {number} [options.minNodeMs=500] - Minimum hold per node (and length of the cached beat).
 * @returns {{events: Array<Object>, byId: Map<string, Object>, duration: number, cachedCount: number}}
 *   Events { execId, status, time, t0, t1, t2, segs } sorted by t0 (travel = [t0, t1), hold =
 *   [t1, t2)); the cached events all share the first beat.
 */
export function buildReplayTimeline(run, model, options = {}) {
    const timeline = { events: [], byId: new Map(), duration: 0, cachedCount: 0 };
    if (!run || !(model?.nodes instanceof Map)) return timeline;
    try {
        const nodes = model.nodes;
        const maxDuration = Math.max(1, num(options.maxDuration) ?? DEFAULT_MAX_DURATION);
        const floor = Math.max(0.05, (num(options.minNodeMs) ?? DEFAULT_MIN_NODE_MS) / 1000);

        /** model exec id -> group */
        const groups = new Map();
        for (const [id, rec] of run.nodes) {
            if (!FINAL.has(rec.state)) continue;
            const mid = modelIdOf(nodes, id, rec);
            if (!mid) continue;
            let g = groups.get(mid);
            if (!g) {
                g = { execId: mid, start: Infinity, order: Infinity, time: 0, states: [] };
                groups.set(mid, g);
            }
            g.start = Math.min(g.start, rec.start ?? rec.end ?? Infinity);
            g.order = Math.min(g.order, rec.order ?? Infinity);
            g.time += rec.time ?? 0;
            g.states.push(rec.state);
        }
        const list = [...groups.values()].sort((a, b) => (a.start - b.start) || (a.order - b.order) ||
            a.execId.localeCompare(b.execId));

        const cached = [];
        const steps = [];
        let fixed = 0;
        let extraSum = 0;
        for (const g of list) {
            const status = aggregateStatus(g.states);
            const ev = { execId: g.execId, status, time: g.time, travel: 0, extra: 0, segs: [], t0: 0, t1: 0, t2: 0 };
            if (status === "cached") {
                cached.push(ev);
                continue;
            }
            for (const e of nodes.get(g.execId)?.inEdges ?? []) {
                if (!groups.has(e.from)) continue; // source never reached (untaken branch)
                for (const s of edgeSegments(e)) ev.segs.push(s);
            }
            ev.travel = ev.segs.length ? TRAVEL_S : 0;
            if (status !== "blocked") ev.extra = EXTRA_PER_DECADE_S * Math.log10(1 + Math.max(0, g.time) / EXTRA_REF_S);
            fixed += ev.travel + floor;
            extraSum += ev.extra;
            steps.push(ev);
        }
        if (cached.length) fixed += floor;
        const room = maxDuration - fixed;
        const scale = extraSum > 0 && fixed + extraSum > maxDuration ? Math.max(0, room) / extraSum : 1;

        let t = 0;
        if (cached.length) {
            for (const ev of cached) {
                ev.t0 = 0;
                ev.t1 = 0;
                ev.t2 = floor;
                timeline.events.push(ev);
                timeline.byId.set(ev.execId, ev);
            }
            t = floor;
        }
        for (const ev of steps) {
            ev.t0 = t;
            ev.t1 = t + ev.travel;
            ev.t2 = ev.t1 + floor + ev.extra * scale;
            t = ev.t2;
            timeline.events.push(ev);
            timeline.byId.set(ev.execId, ev);
        }
        timeline.duration = t;
        timeline.cachedCount = cached.length;
    } catch {
        // partial timeline
    }
    return timeline;
}
/**
 * Index of the event playing at time `t` (seconds since the replay
 * started), or -1 before the first / after the last.
 *
 * @param {Object} timeline - Replay timeline.
 * @param {number} t - Replay time (s).
 * @returns {number} Event index, or -1.
 */
export function replayEventAt(timeline, t) {
    const events = timeline?.events ?? [];
    let lo = 0;
    let hi = events.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ev = events[mid];
        if (t < ev.t0) hi = mid - 1;
        else if (t >= ev.t2) lo = mid + 1;
        else return mid;
    }
    return -1;
}

/**
 * Status of a node at replay time `t`: "pending" before its slot, "running"
 * during its work phase, its final status after. Nodes that were never
 * reached keep their run-view status throughout.
 *
 * @param {Object} timeline - Replay timeline.
 * @param {Map<string, string>} statuses - Run-view statuses.
 * @param {string} execId - Exec id.
 * @param {number} t - Replay time (s).
 * @returns {string|null} Status.
 */
export function replayStatusAt(timeline, statuses, execId, t) {
    const ev = timeline?.byId?.get(execId);
    const final = statuses?.get(execId) ?? null;
    if (!ev) return final;
    if (t < ev.t1) return "pending";
    if (t < ev.t2) return "running";
    return final ?? ev.status;
}
