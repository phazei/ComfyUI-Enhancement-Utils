/**
 * Tests for the Graph Arrange layouts (Quick / Smart (dagre) / Advanced (ELK)),
 * imported through js/graphArrangeLayout.js.
 *
 * Runs the real layouts (vendored dagre and elkjs from js/lib/) on small mock
 * graphs and checks the things that broke before: subgraph IO placement,
 * pinned items, empty groups, groups of unconnected nodes, nested groups, and
 * that re-running an arrange moves nothing.
 *
 * Run: node tests/graphArrange.test.mjs
 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The layouts read window.dagre / window.ELK (UMD globals) and LiteGraph constants.
globalThis.window = globalThis;
globalThis.LiteGraph = { NODE_TITLE_HEIGHT: 30, NODE_SLOT_HEIGHT: 20 };
vm.runInThisContext(fs.readFileSync(path.join(root, "js/lib/dagre.min.js"), "utf8"));
vm.runInThisContext(fs.readFileSync(path.join(root, "js/lib/elk.bundled.min.js"), "utf8"));

const {
    withPreservedCenter, arrangeFloatRightGroups, arrangeDagreGroups, arrangeDagre, arrangeELK, setSettingsSource, collectBridgeLinks, computeFlowOrder,
    collectHiddenLinks, placeWrappedLayers, breakLines, findChains, FOLD_RATIO, arrangeGroup, groupAtPoint, pushAlong,
} = await import("../js/graphArrangeLayout.js");
setSettingsSource(() => ({}));

const TITLE_H = 30;

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Minimal LGraphNode: pos/size, slots, pin flag, title-inclusive bounding rect. */
class MockNode {
    constructor(id, type, x, y, w = 200, h = 100, nIn = 1, nOut = 1) {
        this.id = String(id);
        this.type = type;
        this.title = type;
        this.pos = [x, y];
        this.size = [w, h];
        this.flags = {};
        this.inputs = Array.from({ length: nIn }, () => ({ link: null }));
        this.outputs = Array.from({ length: nOut }, () => ({ links: [] }));
    }
    getTitle() { return this.title; }
    get pinned() { return !!this.flags.pinned; }
    pin(v) {
        if (v ?? !this.pinned) this.flags.pinned = true;
        else delete this.flags.pinned;
    }
    get boundingRect() {
        return [this.pos[0], this.pos[1] - TITLE_H, this.size[0], this.size[1] + TITLE_H];
    }
}

/** Minimal LGraphGroup: bounds with LiteGraph's min size, centre-point membership. */
class MockGroup {
    constructor(id, title, x, y, w, h) {
        this.id = id;
        this.title = title;
        this.flags = {};
        this._pos = [x, y];
        this._size = [w, h];
        this._nodes = [];
        this._children = new Set();
        this.graph = null;
    }
    get pos() { return this._pos; }
    set pos(v) { this._pos = [v[0], v[1]]; }
    get size() { return this._size; }
    set size(v) { this._size = [Math.max(140, v[0]), Math.max(80, v[1])]; }
    get _bounding() { return [this._pos[0], this._pos[1], this._size[0], this._size[1]]; }
    get pinned() { return !!this.flags.pinned; }
    pin(v) {
        if (v ?? !this.pinned) this.flags.pinned = true;
        else delete this.flags.pinned;
    }
    recomputeInsideNodes() {
        const [x, y, w, h] = this._bounding;
        this._nodes = this.graph._nodes.filter((n) => {
            const b = n.boundingRect;
            const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
            return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
        });
        this._children = new Set(this._nodes);
    }
}

/** Minimal LGraph / Subgraph. */
class MockGraph {
    constructor({ subgraph = false } = {}) {
        this._nodes = [];
        this._groups = [];
        this.links = {};
        this.nextLink = 1;
        if (subgraph) {
            const io = (x) => ({ pos: [x, 0], size: [128, 80], arrange() {} });
            this.inputNode = io(-1000);
            this.outputNode = io(3000);
        }
    }
    add(item) {
        if (item instanceof MockGroup) {
            item.graph = this;
            this._groups.push(item);
        } else {
            this._nodes.push(item);
        }
        return item;
    }
    connect(a, outSlot, b, inSlot) {
        const id = this.nextLink++;
        this.links[id] = { id, origin_id: a.id, origin_slot: outSlot, target_id: b.id, target_slot: inSlot };
        a.outputs[outSlot].links.push(id);
        b.inputs[inSlot].link = id;
    }
    getNodeById(id) { return this._nodes.find((n) => n.id === String(id)) ?? null; }
    /** Same contract as LGraph.computeExecutionOrder(false, true): topological order, _level = longest path (sources 1). */
    computeExecutionOrder() {
        const indeg = new Map(this._nodes.map((n) => [n.id, 0]));
        for (const l of Object.values(this.links)) indeg.set(l.target_id, indeg.get(l.target_id) + 1);
        const queue = this._nodes.filter((n) => indeg.get(n.id) === 0);
        for (const n of queue) n._level = 1;
        const order = [];
        while (queue.length) {
            const n = queue.shift();
            order.push(n);
            for (const out of n.outputs) {
                for (const lid of out.links) {
                    const t = this.getNodeById(this.links[lid].target_id);
                    t._level = Math.max(t._level || 0, n._level + 1);
                    indeg.set(t.id, indeg.get(t.id) - 1);
                    if (indeg.get(t.id) === 0) queue.push(t);
                }
            }
        }
        return order;
    }
    change() {}
    setDirtyCanvas() {}
}

/**
 * A small text-to-image style graph: loader -> 2 prompts -> sampler -> decode -> save,
 * plus a dead branch, scattered at odd positions.
 */
function buildChain(graph) {
    const n = (id, type, x, y, nIn, nOut) => graph.add(new MockNode(id, type, x, y, 220, 120, nIn, nOut));
    const ckpt = n(1, "CheckpointLoader", 37, 911, 0, 3);
    const pos = n(2, "ClipEncode", 512, 140, 1, 1);
    const neg = n(3, "ClipEncode", 480, 420, 1, 1);
    const latent = n(4, "EmptyLatent", 90, 600, 0, 1);
    const ks = n(5, "KSampler", 900, 333, 4, 1);
    const dec = n(6, "VAEDecode", 1300, 50, 2, 1);
    const save = n(7, "SaveImage", 1700, 700, 1, 0);
    const img = n(8, "EmptyImage", 222, 1500, 0, 1);
    const inv = n(9, "ImageInvert", 777, 1444, 1, 1);
    graph.connect(ckpt, 0, ks, 0);
    graph.connect(ckpt, 1, pos, 0);
    graph.connect(ckpt, 1, neg, 0);
    graph.connect(pos, 0, ks, 1);
    graph.connect(neg, 0, ks, 2);
    graph.connect(latent, 0, ks, 3);
    graph.connect(ks, 0, dec, 0);
    graph.connect(ckpt, 2, dec, 1);
    graph.connect(dec, 0, save, 0);
    graph.connect(img, 0, inv, 0);
    return { ckpt, pos, neg, latent, ks, dec, save, img, inv };
}

/** Group frame around some nodes (title-inclusive), with padding. */
function frameAround(nodes, pad, titlePad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
        const b = n.boundingRect;
        x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
        x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
    }
    return [x0 - pad, y0 - pad - titlePad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad + titlePad];
}

/**
 * Graph with groups: Outer (prompts) holding nested Inner (negative prompt),
 * Lone (one unconnected node), Empty (no members, 420x310). Everything pinned.
 */
function buildGroupedGraph() {
    const graph = new MockGraph();
    const n = buildChain(graph);
    const lone = graph.add(new MockNode(10, "Note", 0, 2500, 200, 80, 0, 0));
    graph.add(new MockGroup(1, "Outer", ...frameAround([n.pos, n.neg], 60, 40)));
    graph.add(new MockGroup(2, "Inner", ...frameAround([n.neg], 15, 34)));
    graph.add(new MockGroup(3, "Lone", ...frameAround([lone], 20, 34)));
    graph.add(new MockGroup(4, "Empty", 3000, 3000, 420, 310));
    for (const g of graph._groups) g.recomputeInsideNodes();
    for (const item of [...graph._nodes, ...graph._groups]) item.pin(true);
    return { graph, nodes: n, lone };
}

/**
 * Groups fed through ungrouped nodes, like a typical workflow: Settings
 * (width value) -> ungrouped Width -> ungrouped /32 -> Models (loader +
 * empty latent fed by /32) -> Sampler -> Output. Models starts with a source
 * node, so ordering groups by their earliest member put it before /32.
 */
function buildFeedThroughGraph() {
    const graph = new MockGraph();
    const n = (id, type, x, y, nIn, nOut) => graph.add(new MockNode(id, type, x, y, 200, 100, nIn, nOut));
    const value = n(1, "Int", 1000, 0, 0, 1);
    const width = n(2, "Width", 0, 1500, 1, 1);
    const div = n(3, "Divide", 300, 1500, 1, 1);
    const loader = n(4, "Loader", 2000, 0, 0, 1);
    const latent = n(5, "EmptyLatent", 2000, 300, 1, 1);
    const ks = n(6, "KSampler", 0, 3000, 2, 1);
    const save = n(7, "Save", 3000, 3000, 1, 0);
    graph.connect(value, 0, width, 0);
    graph.connect(width, 0, div, 0);
    graph.connect(div, 0, latent, 0);
    graph.connect(loader, 0, ks, 0);
    graph.connect(latent, 0, ks, 1);
    graph.connect(ks, 0, save, 0);
    const group = (id, title, nodes) => graph.add(new MockGroup(id, title, ...frameAround(nodes, 30, 34)));
    const groups = {
        Settings: group(1, "Settings", [value]),
        Models: group(2, "Models", [loader, latent]),
        Sampler: group(3, "Sampler", [ks]),
        Output: group(4, "Output", [save]),
    };
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, groups, width, div };
}

/**
 * Two groups that feed each other through ungrouped nodes (A -> x -> B -> y -> A):
 * no order can make every link point forward; the layout must still be stable.
 */
function buildCycleGraph() {
    const graph = new MockGraph();
    const n = (id, x, y, nIn, nOut) => graph.add(new MockNode(id, "N", x, y, 200, 100, nIn, nOut));
    const a1 = n(1, 0, 0, 0, 1);
    const a2 = n(2, 0, 300, 1, 0);
    const x = n(3, 900, 2000, 1, 1);
    const b1 = n(4, 2000, 0, 1, 1);
    const y = n(5, 1500, 2600, 1, 1);
    graph.connect(a1, 0, x, 0);
    graph.connect(x, 0, b1, 0);
    graph.connect(b1, 0, y, 0);
    graph.connect(y, 0, a2, 0);
    graph.add(new MockGroup(1, "A", ...frameAround([a1, a2], 30, 34)));
    graph.add(new MockGroup(2, "B", ...frameAround([b1], 30, 34)));
    for (const g of graph._groups) g.recomputeInsideNodes();
    return graph;
}

/**
 * Set/Get-style virtual node pair (KJ convention): the Get node's
 * `getInputLink` returns the link feeding its Set node.
 */
function addSetGet(graph, setId, getId, setPos, getPos) {
    const set = graph.add(new MockNode(setId, "SetNode", ...setPos, 150, 60, 1, 0));
    const get = graph.add(new MockNode(getId, "GetNode", ...getPos, 150, 60, 0, 1));
    set.isVirtualNode = true;
    get.isVirtualNode = true;
    get.getInputLink = () => graph.links[set.inputs[0].link] ?? null;
    return { set, get };
}

/**
 * Three groups joined only by Set/Get (no drawn link between groups), stacked
 * in reverse order: Load (loader -> Set a), Mid (Get a -> proc -> Set b),
 * End (Get b -> save).
 */
function buildSetGetGraph() {
    const graph = new MockGraph();
    const n = (id, type, x, y, nIn, nOut) => graph.add(new MockNode(id, type, x, y, 200, 100, nIn, nOut));
    const loader = n(1, "Loader", 0, 2000, 0, 1);
    const a = addSetGet(graph, 2, 3, [300, 2000], [0, 1000]);
    const proc = n(4, "Proc", 250, 1000, 1, 1);
    const b = addSetGet(graph, 5, 6, [550, 1000], [0, 0]);
    const save = n(7, "Save", 250, 0, 1, 0);
    graph.connect(loader, 0, a.set, 0);
    graph.connect(a.get, 0, proc, 0);
    graph.connect(proc, 0, b.set, 0);
    graph.connect(b.get, 0, save, 0);
    const group = (id, title, nodes) => graph.add(new MockGroup(id, title, ...frameAround(nodes, 30, 34)));
    const groups = {
        Load: group(1, "Load", [loader, a.set]),
        Mid: group(2, "Mid", [a.get, proc, b.set]),
        End: group(3, "End", [b.get, save]),
    };
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, groups };
}

/**
 * Two groups joined only by a Use Everywhere broadcast, stacked in reverse:
 * Src (loader -> broadcaster), Dst (sampler fed by UE -> save).
 */
function buildUseEverywhereGraph() {
    const graph = new MockGraph();
    const n = (id, type, x, y, nIn, nOut) => graph.add(new MockNode(id, type, x, y, 200, 100, nIn, nOut));
    const loader = n(1, "Loader", 0, 1000, 0, 1);
    const ue = n(2, "UE", 300, 1000, 1, 0);
    const ks = n(3, "KSampler", 0, 0, 1, 1);
    const save = n(4, "Save", 300, 0, 1, 0);
    graph.connect(loader, 0, ue, 0);
    graph.connect(ks, 0, save, 0);
    graph.extra = { ue_links: [{ downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 2 }] };
    const group = (id, title, nodes) => graph.add(new MockGroup(id, title, ...frameAround(nodes, 30, 34)));
    const groups = { Src: group(1, "Src", [loader, ue]), Dst: group(2, "Dst", [ks, save]) };
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, groups };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** [name, layout, wraps into rows]. */
const LAYOUTS = [
    ["Quick", (g) => arrangeFloatRightGroups(g), false],
    ["Smart (dagre)", (g) => arrangeDagreGroups(g), false],
    ["Advanced (ELK)", (g) => arrangeELK(g), true],
];

/** Title-inclusive rect [x, y, w, h] of a node or group. */
const rectOf = (it) => (it instanceof MockNode ? it.boundingRect : it._bounding);

/**
 * Check that a chain of items follows the flow direction: every item starts
 * past the end of the previous one along the flow axis. With `wrap`, items
 * are grouped into rows (bands overlapping across the flow); the next item
 * may instead start a later row, but never an earlier one, and every row
 * runs with the flow (text wrap, no alternating direction).
 *
 * @param {Array<[string, Object]>} chain - [label, node or group] in flow order.
 * @param {{wrap?: boolean, tb?: boolean}} [opts]
 * @returns {Array<string>} Offending "a -> b" pairs.
 */
function flowErrors(chain, { wrap = false, tb = false } = {}) {
    const m0 = (r) => (tb ? r[1] : r[0]), m1 = (r) => (tb ? r[1] + r[3] : r[0] + r[2]);
    const c0 = (r) => (tb ? r[0] : r[1]), c1 = (r) => (tb ? r[0] + r[2] : r[1] + r[3]);
    const rects = chain.map(([, it]) => rectOf(it));
    // Rows: union of items overlapping across the flow.
    const row = rects.map((_, i) => i);
    const find = (i) => (row[i] === i ? i : (row[i] = find(row[i])));
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            if (wrap && c0(rects[i]) < c1(rects[j]) && c0(rects[j]) < c1(rects[i])) row[find(i)] = find(j);
        }
    }
    const roots = [...new Set(rects.map((_, i) => find(i)))]
        .sort((a, b) => Math.min(...rects.filter((_, i) => find(i) === a).map(c0)) - Math.min(...rects.filter((_, i) => find(i) === b).map(c0)));
    const rowIdx = (i) => (wrap ? roots.indexOf(find(i)) : 0);
    const bad = [];
    for (let i = 1; i < chain.length; i++) {
        const a = rects[i - 1], b = rects[i], ra = rowIdx(i - 1), rb = rowIdx(i);
        const ok = rb !== ra ? rb > ra : m0(b) >= m1(a) - 0.5;
        if (!ok) bad.push(`${chain[i - 1][0]} -> ${chain[i][0]}`);
    }
    return bad;
}

/** Pairs of top-level items (groups, ungrouped nodes) that overlap. */
function overlaps(graph) {
    const items = [...graph._groups.map((g) => [g.title, g])];
    for (const n of graph._nodes) if (!graph._groups.some((g) => centreIn(n, g))) items.push(["#" + n.id, n]);
    const bad = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const a = rectOf(items[i][1]), b = rectOf(items[j][1]);
            if (a[0] < b[0] + b[2] - 0.5 && b[0] < a[0] + a[2] - 0.5 && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5) {
                bad.push(`${items[i][0]}/${items[j][0]}`);
            }
        }
    }
    return bad;
}

/** Run one arrange the way the menu does. */
const arrange = (graph, layout) => withPreservedCenter(graph, () => layout(graph));

/** Positions of every node, group and IO node. */
function snapshot(graph) {
    const s = {};
    for (const n of graph._nodes) s["node " + n.id] = [...n.pos];
    for (const g of graph._groups) s["group " + g.title] = [...g.pos, ...g.size];
    if (graph.inputNode) s.input = [...graph.inputNode.pos];
    if (graph.outputNode) s.output = [...graph.outputNode.pos];
    return s;
}

/** Keys whose values differ between two snapshots by more than `tol`. */
function moved(a, b, tol = 0.5) {
    return Object.keys(a).filter((k) => a[k].some((v, i) => Math.abs(v - b[k][i]) > tol));
}

/** Whether a node's centre lies inside a group. */
function centreIn(node, group) {
    const b = node.boundingRect;
    const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    const [x, y, w, h] = group._bounding;
    return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
}

/** Whether group a lies wholly inside group b. */
function groupInside(a, b) {
    const [ax, ay, aw, ah] = a._bounding;
    const [bx, by, bw, bh] = b._bounding;
    return ax >= bx && ay >= by && ax + aw <= bx + bw && ay + ah <= by + bh;
}

let passed = 0;
let failed = 0;
/** Record a check result. */
function check(name, ok, detail = "") {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

for (const [name, layout, wrap] of LAYOUTS) {
    console.log(name);

    // Subgraph without groups: IO nodes flank the nodes, nothing drifts on re-run.
    {
        const graph = new MockGraph({ subgraph: true });
        buildChain(graph);
        await arrange(graph, layout);
        const a = snapshot(graph);
        let minX = Infinity, maxX = -Infinity;
        for (const n of graph._nodes) { minX = Math.min(minX, n.pos[0]); maxX = Math.max(maxX, n.pos[0] + n.size[0]); }
        check("subgraph: input node left of the nodes", Math.abs(graph.inputNode.pos[0] + 128 + 500 - minX) < 1,
            `input x ${graph.inputNode.pos[0]}, nodes from ${minX}`);
        check("subgraph: output node right of the nodes", Math.abs(graph.outputNode.pos[0] - (maxX + 500)) < 1,
            `output x ${graph.outputNode.pos[0]}, nodes to ${maxX}`);
        await arrange(graph, layout);
        const m = moved(a, snapshot(graph));
        check("subgraph: second run moves nothing", m.length === 0, m.join(", "));
    }

    // Groups, everything pinned.
    {
        const { graph, nodes, lone } = buildGroupedGraph();
        const grp = Object.fromEntries(graph._groups.map((g) => [g.title, g]));
        await arrange(graph, layout);
        const a = snapshot(graph);
        const stillPinned = [...graph._nodes, ...graph._groups].filter((x) => x.flags.pinned);
        check("groups: everything unpinned", stillPinned.length === 0, `${stillPinned.length} still pinned`);
        check("groups: members stay in their group",
            centreIn(nodes.pos, grp.Outer) && centreIn(nodes.neg, grp.Outer) && centreIn(nodes.neg, grp.Inner)
            && centreIn(lone, grp.Lone));
        check("groups: nested group stays inside its parent", groupInside(grp.Inner, grp.Outer));
        check("groups: empty group keeps its size", grp.Empty.size[0] === 420 && grp.Empty.size[1] === 310,
            JSON.stringify(grp.Empty.size));
        check("groups: ungrouped nodes stay out of groups",
            [nodes.ckpt, nodes.ks, nodes.save, nodes.img].every((n) => !graph._groups.some((g) => centreIn(n, g))));
        await arrange(graph, layout);
        const m = moved(a, snapshot(graph));
        check("groups: second run moves nothing", m.length === 0, m.join(", "));
    }

    // Groups fed through ungrouped nodes come after their feeders.
    {
        const { graph, groups, width, div } = buildFeedThroughGraph();
        await arrange(graph, layout);
        const chain = [
            ["Settings", groups.Settings], ["Width", width], ["/32", div],
            ["Models", groups.Models], ["Sampler", groups.Sampler], ["Output", groups.Output],
        ];
        const bad = flowErrors(chain, { wrap });
        check("feed-through: Settings, Width, /32, Models, Sampler, Output in flow order", bad.length === 0,
            `overlapping or reversed: ${bad.join(", ")}`);
        const a = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(a, snapshot(graph));
        check("feed-through: second run moves nothing", m.length === 0, m.join(", "));
    }

    // Groups feeding each other: stable, members kept.
    {
        const graph = buildCycleGraph();
        await arrange(graph, layout);
        const a = snapshot(graph);
        const [A, B] = graph._groups;
        check("cycle: members stay in their groups",
            centreIn(graph.getNodeById(1), A) && centreIn(graph.getNodeById(2), A) && centreIn(graph.getNodeById(4), B));
        await arrange(graph, layout);
        const m = moved(a, snapshot(graph));
        check("cycle: second run moves nothing", m.length === 0, m.join(", "));
    }

    // Groups joined only by hidden links (Set/Get, Use Everywhere) are ordered by them.
    {
        const leftToRight = (chain) => flowErrors(chain, { wrap });
        const sg = buildSetGetGraph();
        await arrange(sg.graph, layout);
        const bad = leftToRight([["Load", sg.groups.Load], ["Mid", sg.groups.Mid], ["End", sg.groups.End]]);
        check("set/get: Load, Mid, End in flow order", bad.length === 0, `overlapping or reversed: ${bad.join(", ")}`);
        const a = snapshot(sg.graph);
        await arrange(sg.graph, layout);
        const m = moved(a, snapshot(sg.graph));
        check("set/get: second run moves nothing", m.length === 0, m.join(", "));

        const ue = buildUseEverywhereGraph();
        await arrange(ue.graph, layout);
        const badUe = leftToRight([["Src", ue.groups.Src], ["Dst", ue.groups.Dst]]);
        check("use everywhere: Src before Dst", badUe.length === 0, `overlapping or reversed: ${badUe.join(", ")}`);
    }

    // Links still point forward (left to right) for the main chain.
    {
        const graph = new MockGraph();
        const n = buildChain(graph);
        await arrange(graph, layout);
        const order = [n.ckpt, n.pos, n.ks, n.dec, n.save];
        check("chain: flows left to right", order.every((node, i) => i === 0 || node.pos[0] > order[i - 1].pos[0]),
            order.map((x) => x.pos[0].toFixed(0)).join(" < "));
    }
}

/**
 * A long chain of groups G0 -> G1 -> ... (each one node, 400x250) plus a
 * standalone group with no links, all stacked in a column.
 */
function buildLongGroupChain(count) {
    const graph = new MockGraph();
    const groups = [];
    let prev = null;
    for (let i = 0; i < count; i++) {
        const node = graph.add(new MockNode(i + 1, "N", 0, i * 600, 400, 250, 1, 1));
        if (prev) graph.connect(prev, 0, node, 0);
        prev = node;
        groups.push(graph.add(new MockGroup(i + 1, "G" + i, ...frameAround([node], 30, 34))));
    }
    const alone = graph.add(new MockNode(100, "Alone", 0, count * 600, 300, 200, 1, 1));
    const lone = graph.add(new MockNode(101, "Lone2", 400, count * 600, 300, 200, 0, 1));
    graph.connect(lone, 0, alone, 0);
    const standalone = graph.add(new MockGroup(100, "Standalone", ...frameAround([alone, lone], 30, 34)));
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, groups, standalone };
}

/** Bounds [x0, y0, x1, y1] of a set of groups. */
function boundsOf(items) {
    const rs = items.map(rectOf);
    return [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[0] + r[2])), Math.max(...rs.map((r) => r[1] + r[3]))];
}

// Advanced: rows wrapped like text towards 16:9, standalone groups below, top-to-bottom.
{
    console.log("Advanced (ELK) wrapping");
    for (const tb of [false, true]) {
        const dir = tb ? "TB" : "LR";
        const elk = (g) => arrangeELK(g, { rankdir: dir });
        const { graph, groups, standalone } = buildLongGroupChain(12);
        await arrange(graph, elk);
        const [x0, y0, x1, y1] = boundsOf(groups);
        const aspect = (x1 - x0) / (y1 - y0);
        check(`${dir}: long chain wraps to roughly 16:9`, aspect > 1.78 / 2 && aspect < 1.78 * 2, `aspect ${aspect.toFixed(2)}`);
        const bad = flowErrors(groups.map((g) => [g.title, g]), { wrap: true, tb });
        check(`${dir}: chain follows the rows, each row with the flow`, bad.length === 0, bad.join(", "));
        const ov = overlaps(graph);
        check(`${dir}: no overlapping groups`, ov.length === 0, ov.join(", "));
        check(`${dir}: standalone group below the flow`, standalone.pos[1] >= y1, `${standalone.pos[1]} < ${y1}`);
        const a = snapshot(graph);
        await arrange(graph, elk);
        const m = moved(a, snapshot(graph));
        check(`${dir}: second run moves nothing`, m.length === 0, m.join(", "));
    }

    // Top-to-bottom inside a group: a straight column, not a staircase.
    const graph = new MockGraph();
    const ns = [0, 1, 2, 3].map((i) => graph.add(new MockNode(i + 1, "N", i * 300, i * 50, 200, 100, 1, 1)));
    for (let i = 1; i < ns.length; i++) graph.connect(ns[i - 1], 0, ns[i], 0);
    graph.add(new MockGroup(1, "G", ...frameAround(ns, 30, 34)));
    graph._groups[0].recomputeInsideNodes();
    await arrange(graph, (g) => arrangeELK(g, { rankdir: "TB" }));
    const xs = ns.map((n) => n.pos[0]);
    check("TB: chain inside a group is one column", Math.max(...xs) - Math.min(...xs) < 1, xs.join(", "));
    check("TB: chain inside a group runs downwards", ns.every((n, i) => i === 0 || n.pos[1] > ns[i - 1].pos[1]));
}

/**
 * Satellite: ungrouped `s` takes input from group G (a) and feeds G again (b);
 * G feeds group H. `s` belongs next to G.
 */
function buildSatelliteGraph() {
    const graph = new MockGraph();
    const n = (id, x, y, nIn, nOut) => graph.add(new MockNode(id, "N", x, y, 200, 100, nIn, nOut));
    const a = n(1, 0, 0, 0, 1);
    const b = n(2, 300, 0, 1, 1);
    const s = n(3, 3000, 3000, 1, 1);
    const h = n(4, 6000, 0, 1, 0);
    graph.connect(a, 0, s, 0);
    graph.connect(s, 0, b, 0);
    graph.connect(b, 0, h, 0);
    const G = graph.add(new MockGroup(1, "G", ...frameAround([a, b], 30, 34)));
    const H = graph.add(new MockGroup(2, "H", ...frameAround([h], 30, 34)));
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, G, H, s };
}

/**
 * Two groups feeding each other: A -> B through three links, B -> A through
 * one. B is listed first, so only the link count says A comes first.
 */
function buildWeightedLoopGraph() {
    const graph = new MockGraph();
    const n = (id, x, y, nIn, nOut) => graph.add(new MockNode(id, "N", x, y, 200, 100, nIn, nOut));
    const b = n(1, 0, 0, 3, 1);
    const a = n(2, 0, 1000, 1, 3);
    graph.connect(a, 0, b, 0);
    graph.connect(a, 1, b, 1);
    graph.connect(a, 2, b, 2);
    graph.connect(b, 0, a, 0);
    const B = graph.add(new MockGroup(1, "B", ...frameAround([b], 30, 34)));
    const A = graph.add(new MockGroup(2, "A", ...frameAround([a], 30, 34)));
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, A, B };
}

/**
 * LORAS-style chain cut by a node outside the group: g -> c -> e -> [s] -> st
 * -> ap, with s ungrouped. Listed so st / ap come first in the node list.
 */
function buildBridgeGraph() {
    const graph = new MockGraph();
    const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
    const st = n(1, 0, 0), ap = n(2, 300, 0);
    const g = n(3, 0, 400), c = n(4, 300, 400), e = n(5, 600, 400);
    const s = n(6, 2000, 2000);
    graph.connect(g, 0, c, 0);
    graph.connect(c, 0, e, 0);
    graph.connect(e, 0, s, 0);
    graph.connect(s, 0, st, 0);
    graph.connect(st, 0, ap, 0);
    graph.add(new MockGroup(1, "L", ...frameAround([st, ap, g, c, e], 30, 34)));
    for (const gr of graph._groups) gr.recomputeInsideNodes();
    return { graph, st, ap, g, c, e, s };
}

// Bridges: a path out of a group and back in orders the group's contents.
{
    console.log("Bridge links");
    const { graph, st, e, s } = buildBridgeGraph();
    const b = collectBridgeLinks(graph, [1, 2, 3, 4, 5].map((id) => graph.getNodeById(id)));
    check("bridge e -> st found (through the outside node)", b.length === 1 && b[0].origin_id === e.id && b[0].target_id === st.id,
        JSON.stringify(b));
    check("outside node not part of a bridge", !b.some((l) => l.origin_id === s.id || l.target_id === s.id));
    {
        // Same chain, but the outside node sits in another group: no bridge
        // (the order between groups covers it; hub groups got empty columns).
        const { graph: g2, s: s2 } = buildBridgeGraph();
        g2.add(new MockGroup(2, "Other", ...frameAround([s2], 30, 34)));
        for (const gr of g2._groups) gr.recomputeInsideNodes();
        const members = [1, 2, 3, 4, 5].map((id) => g2.getNodeById(id));
        const nodeToGroup = new Map([...members.map((m) => [m.id, g2._groups[0]]), [s2.id, g2._groups[1]]]);
        const b2 = collectBridgeLinks(g2, members, [], nodeToGroup);
        check("no bridge through another group", b2.length === 0, JSON.stringify(b2));
    }
    for (const [name, layout] of LAYOUTS) {
        for (const dir of name.startsWith("Quick") ? ["LR"] : ["LR", "TB"]) { // Quick is LR only.
            setSettingsSource(() => ({ rankdir: dir }));
            const { graph: gr, st: st2, ap: ap2, e: e2 } = buildBridgeGraph();
            await arrange(gr, layout);
            const k = dir === "LR" ? 0 : 1;
            check(`${name} ${dir}: node fed back from outside comes after the chain end`,
                st2.pos[k] > e2.pos[k] && ap2.pos[k] > st2.pos[k], `e ${e2.pos[k]}, st ${st2.pos[k]}, ap ${ap2.pos[k]}`);
            const ov = overlaps(gr);
            check(`${name} ${dir}: no overlaps`, ov.length === 0, ov.join(", "));
            const a = snapshot(gr);
            await arrange(gr, layout);
            const m = moved(a, snapshot(gr));
            check(`${name} ${dir}: second run moves nothing`, m.length === 0, m.join(", "));
        }
    }
    setSettingsSource(() => ({}));
}

// Flow order: nodes a layout can't tell apart (same column, no links between
// them) are ordered by their place in the whole graph, not the node list.
{
    console.log("Flow order tie-break");
    // Outside chain o1 -> o2 -> o3 -> o4 (ungrouped). In group G: x1 -> x2
    // fed by o4 (late), y1 -> y2 fed by o1 (early). x listed first.
    const buildFed = () => {
        const graph = new MockGraph();
        const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
        const x1 = n(1, 0, 0), x2 = n(2, 300, 0), y1 = n(3, 0, 300), y2 = n(4, 300, 300);
        const o = [n(5, -3000, 0), n(6, -2700, 0), n(7, -2400, 0), n(8, -2100, 0)];
        for (let i = 1; i < o.length; i++) graph.connect(o[i - 1], 0, o[i], 0);
        graph.connect(o[3], 0, x1, 0);
        graph.connect(o[0], 0, y1, 0);
        graph.connect(x1, 0, x2, 0);
        graph.connect(y1, 0, y2, 0);
        graph.add(new MockGroup(1, "G", ...frameAround([x1, x2, y1, y2], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        return { graph, early: y1, late: x1 };
    };
    // In group G, unfed: a 3-chain listed before a 5-chain.
    const buildLengths = () => {
        const graph = new MockGraph();
        const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
        const short = [n(1, 0, 0), n(2, 300, 0), n(3, 600, 0)];
        const long = [n(4, 0, 300), n(5, 300, 300), n(6, 600, 300), n(7, 900, 300), n(8, 1200, 300)];
        for (const c of [short, long]) for (let i = 1; i < c.length; i++) graph.connect(c[i - 1], 0, c[i], 0);
        graph.add(new MockGroup(1, "G", ...frameAround([...short, ...long], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        return { graph, early: long[0], late: short[0] };
    };
    {
        const { graph } = buildFed();
        const f = computeFlowOrder(graph);
        check("computeFlowOrder: counted from the start", f.get("5").from === 0 && f.get("3").from === 1 && f.get("1").from === 4,
            JSON.stringify([...f]));
        check("computeFlowOrder: counted to the end", f.get("5").to === 5 && f.get("3").to === 1 && f.get("2").to === 0, JSON.stringify([...f]));
    }
    for (const [name, layout] of LAYOUTS) {
        for (const dir of name.startsWith("Quick") ? ["LR"] : ["LR", "TB"]) {
            for (const [label, build] of [["fed earlier", buildFed], ["longer chain", buildLengths]]) {
                setSettingsSource(() => ({ rankdir: dir }));
                const { graph, early, late } = build();
                await arrange(graph, layout);
                const k = dir === "LR" ? 1 : 0;
                const along = 1 - k;
                check(`${name} ${dir}: ${label} first`,
                    Math.abs(early.pos[along] - late.pos[along]) < 1 && early.pos[k] < late.pos[k],
                    `early ${early.pos.map(Math.round)}, late ${late.pos.map(Math.round)}`);
                const a = snapshot(graph);
                await arrange(graph, layout);
                const m = moved(a, snapshot(graph));
                check(`${name} ${dir}: ${label}: second run moves nothing`, m.length === 0, m.join(", "));
            }
        }
    }
    setSettingsSource(() => ({}));
}

// Satellites, loops broken by link count, collapsed nodes -- every layout.
for (const [name, layout, wrap] of LAYOUTS) {
    console.log(name + " (satellites, loops, collapsed)");
    setSettingsSource(() => ({}));
    {
        const { graph, G, H, s } = buildSatelliteGraph();
        await arrange(graph, layout);
        const [gx, gy, gw, gh] = G._bounding;
        const sr = s.boundingRect;
        check("satellite: right next to its group", sr[0] >= gx + gw && sr[0] - (gx + gw) <= 100 && sr[1] < gy + gh && sr[1] + sr[3] > gy,
            `group ${[gx, gy, gw, gh].map(Math.round)}, node ${sr.map(Math.round)}`);
        check("satellite: stays out of the group", !centreIn(s, G));
        const ov = overlaps(graph);
        check("satellite: no overlaps", ov.length === 0, ov.join(", "));
        // After = to the right of the satellite, or (Advanced wraps) in a later row.
        const after = H.pos[0] >= sr[0] + sr[2] - 0.5 || (wrap && H.pos[1] >= Math.max(gy + gh, sr[1] + sr[3]) - 0.5);
        check("satellite: group it feeds comes after", after, `H ${[...H.pos, ...H.size].map(Math.round)}, node ${sr.map(Math.round)}`);
        const a = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(a, snapshot(graph));
        check("satellite: second run moves nothing", m.length === 0, m.join(", "));
    }
    {
        const { graph, A, B } = buildWeightedLoopGraph();
        await arrange(graph, layout);
        check("loop: group with more outgoing links comes first", A.pos[0] + A.size[0] <= B.pos[0] + 0.5,
            `A ${A.pos[0]}..${A.pos[0] + A.size[0]}, B ${B.pos[0]}`);
    }
    {
        const graph = new MockGraph();
        const a = graph.add(new MockNode(1, "Set", 0, 0, 230, 40, 1, 1));
        const b = graph.add(new MockNode(2, "N", 1000, 0, 200, 100, 1, 1));
        const c = graph.add(new MockNode(3, "N", 2000, 0, 200, 100, 1, 1));
        a.flags.collapsed = true;
        graph.connect(a, 0, b, 0);
        graph.connect(b, 0, c, 0);
        await arrange(graph, layout);
        check("collapsed node takes its collapsed width (80), not its size (230)", b.pos[0] - a.pos[0] < 230,
            `gap ${b.pos[0] - a.pos[0]}`);
    }
}

// TB: satellites still go to the right of their group, level with the feeder.
for (const [name, layout] of [["Smart (dagre)", arrangeDagreGroups], ["Advanced (ELK)", arrangeELK]]) {
    console.log(name + " TB satellites");
    setSettingsSource(() => ({ rankdir: "TB" }));
    const { graph, G, s } = buildSatelliteGraph();
    const feeder = graph.getNodeById(1);
    await arrange(graph, layout);
    const [gx, , gw] = G._bounding;
    const sr = s.boundingRect;
    check("TB satellite: right of its group", sr[0] >= gx + gw && sr[0] - (gx + gw) <= 100, `group x ${gx}..${gx + gw}, node x ${sr[0]}`);
    check("TB satellite: level with the node feeding it", Math.abs(sr[1] - feeder.boundingRect[1]) < 0.5,
        `${sr[1]} vs ${feeder.boundingRect[1]}`);
    const ov = overlaps(graph);
    check("TB satellite: no overlaps", ov.length === 0, ov.join(", "));
    const a = snapshot(graph);
    await arrange(graph, layout);
    const m = moved(a, snapshot(graph));
    check("TB satellite: second run moves nothing", m.length === 0, m.join(", "));
    setSettingsSource(() => ({}));
}

// Smart: every step starts at the same edge, so the flow is one straight line.
{
    console.log("Smart (dagre) straight line");
    for (const dir of ["LR", "TB", "TB right"]) {
        setSettingsSource(() => ({ rankdir: dir.slice(0, 2), tbAlign: dir.endsWith("right") ? "right" : "left" }));
        const graph = new MockGraph();
        const sizes = [[200, 100], [600, 900], [300, 150], [800, 500]];
        const nodes = sizes.map(([w, h], i) => graph.add(new MockNode(i + 1, "N", i * 1000, (i % 2) * 700, w, h, 1, 1)));
        for (let i = 1; i < nodes.length; i++) graph.connect(nodes[i - 1], 0, nodes[i], 0);
        nodes.forEach((n, i) => graph.add(new MockGroup(i + 1, "G" + i, ...frameAround([n], 30, 34))));
        for (const g of graph._groups) g.recomputeInsideNodes();
        await arrange(graph, arrangeDagreGroups);
        const k = dir === "LR" ? 1 : 0;
        const right = dir.endsWith("right");
        const edges = graph._groups.map((g) => Math.round(g.pos[k] + (right ? g.size[0] : 0)));
        check(`${dir}: groups of a chain share one edge`, new Set(edges).size === 1, edges.join(", "));
        const along = graph._groups.map((g) => g.pos[1 - k]);
        check(`${dir}: chain runs in order`, along.every((p, i) => i === 0 || p > along[i - 1]), along.join(", "));
    }
    setSettingsSource(() => ({}));
}

// Smart: a chain of nodes of different sizes shares its top (LR) / left (TB)
// edge, with and without groups, and a branch below never overlaps.
{
    console.log("Smart (dagre) node alignment");
    for (const dir of ["LR", "TB", "TB right"]) {
        for (const grouped of [false, true]) {
            setSettingsSource(() => ({ rankdir: dir.slice(0, 2), tbAlign: dir.endsWith("right") ? "right" : "left" }));
            const graph = new MockGraph();
            const sizes = [[200, 100], [300, 600], [250, 150], [400, 350]];
            const chain = sizes.map(([w, h], i) => graph.add(new MockNode(i + 1, "N", i * 500, (i % 2) * 300, w, h, 1, 2)));
            for (let i = 1; i < chain.length; i++) graph.connect(chain[i - 1], 0, chain[i], 0);
            const side = graph.add(new MockNode(9, "N", 0, 2000, 500, 200, 1, 0));
            graph.connect(chain[1], 1, side, 0);
            if (grouped) {
                graph.add(new MockGroup(1, "G", ...frameAround([...chain, side], 30, 34)));
                for (const g of graph._groups) g.recomputeInsideNodes();
            }
            await arrange(graph, grouped ? arrangeDagreGroups : arrangeDagre);
            const k = dir === "LR" ? 1 : 0;
            const right = dir.endsWith("right");
            const edges = chain.map((n) => Math.round(n.boundingRect[k] + (right ? n.boundingRect[2] : 0)));
            const label = `${dir}${grouped ? " in a group" : ""}`;
            check(`${label}: chain shares one edge`, new Set(edges).size === 1, edges.join(", "));
            const ov = overlaps(graph);
            check(`${label}: no overlaps`, ov.length === 0, ov.join(", "));
            const a = snapshot(graph);
            await arrange(graph, grouped ? arrangeDagreGroups : arrangeDagre);
            const m = moved(a, snapshot(graph));
            check(`${label}: second run moves nothing`, m.length === 0, m.join(", "));
        }
    }
    setSettingsSource(() => ({}));
}

// Smart: a very tall node doesn't leave half its height empty above the
// lines next to it (dagre spaces centres; tops are packed afterwards).
{
    console.log("Smart (dagre) tall node packing");
    for (const dir of ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        const graph = new MockGraph();
        const big = dir === "LR" ? [300, 1200] : [1200, 100];
        const a = graph.add(new MockNode(1, "N", 0, 0, 150, 40, 1, 1));
        const t = graph.add(new MockNode(2, "N", 500, 0, ...big, 1, 1));
        const b = graph.add(new MockNode(3, "N", 0, 500, 150, 40, 1, 1));
        const c = graph.add(new MockNode(4, "N", 500, 2000, 150, 40, 1, 1));
        graph.connect(a, 0, t, 0);
        graph.connect(b, 0, c, 0);
        graph.connect(a, 0, c, 0);
        await arrange(graph, arrangeDagre);
        const k = dir === "LR" ? 1 : 0;
        const [first, second] = [a, b].sort((p, q) => p.boundingRect[k] - q.boundingRect[k]);
        const gap = second.boundingRect[k] - (first.boundingRect[k] + first.boundingRect[k + 2]);
        check(`${dir}: no big gap next to a tall node`, gap <= 50 + 1, `gap ${gap}`);
        const ov = overlaps(graph);
        check(`${dir}: no overlaps`, ov.length === 0, ov.join(", "));
    }
    setSettingsSource(() => ({}));
}

// Smart TB "mixed": inside a group, a chain fed from outside the group shares
// its left edge, a chain fed only from inside shares its right edge.
{
    console.log("Smart (dagre) TB mixed alignment");
    setSettingsSource(() => ({ rankdir: "TB", tbAlign: "mixed" }));
    const graph = new MockGraph();
    const n = (id, w, h, x, y) => graph.add(new MockNode(id, "N", x, y, w, h, 1, 1));
    const outside = n(1, 200, 100, 0, -1500);
    const fed = [n(2, 200, 100, 0, 0), n(3, 400, 300, 0, 300), n(4, 250, 150, 0, 800)];
    const inner = [n(5, 350, 100, 900, 0), n(6, 150, 300, 900, 300), n(7, 300, 120, 900, 800)];
    graph.connect(outside, 0, fed[0], 0);
    for (const chain of [fed, inner]) for (let i = 1; i < chain.length; i++) graph.connect(chain[i - 1], 0, chain[i], 0);
    graph.add(new MockGroup(1, "G", ...frameAround([...fed, ...inner], 30, 34)));
    for (const g of graph._groups) g.recomputeInsideNodes();
    await arrange(graph, arrangeDagreGroups);
    const R = (x) => Math.round(x.boundingRect[0] + x.boundingRect[2]);
    const rights = inner.map(R);
    check("chain fed from inside shares its right edge", new Set(rights).size === 1, rights.join(", "));
    // Fed chain: only its first node has the outside input. It takes the
    // left edge of the chain's band; the rest (like a Set at the end) the right.
    const band = [Math.min(...fed.map((x) => x.boundingRect[0])), Math.max(...fed.map(R))];
    check("node fed from outside on the chain's left edge", Math.round(fed[0].boundingRect[0]) === Math.round(band[0]),
        `${fed[0].boundingRect[0]} vs ${band[0]}`);
    const fedRights = fed.slice(1).map(R);
    check("rest of that chain on its right edge", fedRights.every((r) => r === Math.round(band[1])), `${fedRights} vs ${band[1]}`);
    const ov = overlaps(graph);
    check("no overlaps", ov.length === 0, ov.join(", "));
    const a = snapshot(graph);
    await arrange(graph, arrangeDagreGroups);
    const m = moved(a, snapshot(graph));
    check("second run moves nothing", m.length === 0, m.join(", "));
    setSettingsSource(() => ({}));
}

// Advanced: groups in the same step line up at the start of the step.
{
    console.log("Advanced (ELK) step alignment");
    for (const dir of ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        const graph = new MockGraph();
        const src = graph.add(new MockNode(1, "N", 0, 0, 200, 100, 0, 2));
        const wide = graph.add(new MockNode(2, "N", 500, 0, 900, 600, 1, 0));
        const thin = graph.add(new MockNode(3, "N", 500, 1000, 150, 80, 1, 0));
        graph.connect(src, 0, wide, 0);
        graph.connect(src, 1, thin, 0);
        for (const [i, n] of [[1, src], [2, wide], [3, thin]]) graph.add(new MockGroup(i, "G" + i, ...frameAround([n], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        await arrange(graph, arrangeELK);
        const [, W, T] = graph._groups;
        const k = dir === "LR" ? 0 : 1;
        check(`${dir}: groups sharing a step start at the same edge`, Math.abs(W.pos[k] - T.pos[k]) < 0.5, `${W.pos[k]} vs ${T.pos[k]}`);
    }
    setSettingsSource(() => ({}));
}

// Smart / Advanced: a loose node with no drawn input sits at the end of its
// step (next to what it feeds), not at the start of a long group.
for (const [name, layout] of [["Smart (dagre)", arrangeDagreGroups], ["Advanced (ELK)", arrangeELK]]) {
    console.log(name + " loose sources at the step end");
    for (const dir of ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        // A -> W (long along the flow) -> C; loose L (no inputs) -> C.
        const graph = new MockGraph();
        const a = graph.add(new MockNode(1, "N", 0, 0, 200, 100, 0, 1));
        const w = graph.add(new MockNode(2, "N", 500, 0, 900, 900, 1, 1));
        const c = graph.add(new MockNode(3, "N", 2000, 0, 200, 100, 2, 0));
        const l = graph.add(new MockNode(4, "N", 0, 2000, 150, 60, 0, 1));
        graph.connect(a, 0, w, 0);
        graph.connect(w, 0, c, 0);
        graph.connect(l, 0, c, 1);
        for (const [i, n] of [[1, a], [2, w], [3, c]]) graph.add(new MockGroup(i, "G" + i, ...frameAround([n], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        await arrange(graph, layout);
        const C = graph._groups[2];
        const k = dir === "LR" ? 0 : 1;
        const lr = l.boundingRect;
        // Right before what it feeds: at the end of the long group's step, or
        // (a wrapped row) at the start of the row that holds what it feeds.
        const gap = C.pos[k] - (lr[k] + lr[k + 2]);
        check(`${dir}: loose source ends right before what it feeds`, gap >= 0 && gap <= 200, `gap ${gap}`);
        const ov = overlaps(graph);
        check(`${dir}: no overlaps`, ov.length === 0, ov.join(", "));
        const s = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(s, snapshot(graph));
        check(`${dir}: second run moves nothing`, m.length === 0, m.join(", "));
    }
    setSettingsSource(() => ({}));
}

// Smart: loose sources also line up across the flow with what they feed
// (in TB they sat beside the big group of their step, far from it).
for (const [name, layout] of [["Smart (dagre)", arrangeDagreGroups], ["Advanced (ELK)", arrangeELK]]) {
    console.log(name + " loose sources across the flow");
    for (const dir of ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        // A -> W (big) -> C1 (group) ; W -> C2 (loose) ; L1, L2 (loose, no inputs) -> C2.
        const graph = new MockGraph();
        const a = graph.add(new MockNode(1, "N", 0, 0, 200, 100, 0, 1));
        const w = graph.add(new MockNode(2, "N", 500, 0, 900, 900, 1, 2));
        const c1 = graph.add(new MockNode(3, "N", 2000, 0, 700, 700, 1, 0));
        const c2 = graph.add(new MockNode(4, "N", 2000, 900, 200, 100, 3, 0));
        const l1 = graph.add(new MockNode(5, "N", 0, 2000, 150, 0, 0, 1));
        const l2 = graph.add(new MockNode(6, "N", 0, 2100, 150, 0, 0, 1));
        graph.connect(a, 0, w, 0);
        graph.connect(w, 0, c1, 0);
        graph.connect(w, 1, c2, 0);
        graph.connect(l1, 0, c2, 1);
        graph.connect(l2, 0, c2, 2);
        for (const [i, n] of [[1, a], [2, w], [3, c1]]) graph.add(new MockGroup(i, "G" + i, ...frameAround([n], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        await arrange(graph, layout);
        const k = dir === "LR" ? 1 : 0; // across the flow
        const c2r = c2.boundingRect;
        const near = [l1, l2].every((l) => {
            const r = l.boundingRect;
            return r[k] < c2r[k] + c2r[k + 2] + 100 && r[k] + r[k + 2] > c2r[k] - 100;
        });
        check(`${dir}: sources line up with the node they feed`, near,
            `C2 ${c2r.map(Math.round)}, L1 ${l1.boundingRect.map(Math.round)}, L2 ${l2.boundingRect.map(Math.round)}`);
        const ov = overlaps(graph);
        check(`${dir}: no overlaps`, ov.length === 0, ov.join(", "));
        const s = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(s, snapshot(graph));
        check(`${dir}: second run moves nothing`, m.length === 0, m.join(", "));
    }
    setSettingsSource(() => ({}));
}

// Advanced: a layer of only loose sources never ends a wrapped row -- it goes
// to the start of the next row, next to the layer it feeds.
{
    console.log("Advanced (ELK) wrap keeps sources with their consumers");
    for (const horizontal of [true, false]) {
        // mixed: the sources share their step with a regular block.
        for (const mixed of [false, true]) {
            const label = `${horizontal ? "LR" : "TB"}${mixed ? " (step shared with a regular block)" : ""}`;
            const big = (id) => ({ id, w: 1000, h: 1000 });
            let wrapped = 0, bad = 0;
            // Put the source step at every position; some of them land on a row break.
            for (let at = 1; at < 8; at++) {
                const layers = Array.from({ length: 8 }, (_, i) => [big("b" + i)]);
                const step = [{ id: "s", w: 120, h: 30, atEnd: true }, { id: "s2", w: 100, h: 30, atEnd: true }];
                if (mixed) step.unshift({ id: "r", w: 300, h: 300 });
                layers.splice(at, 0, step);
                const r = placeWrappedLayers(layers, { horizontal, layerGap: 100, itemGap: 50, rowGap: 100, aspect: 16 / 9 });
                if (r.rows > 1) wrapped++;
                const row = (p) => (horizontal ? p.y : p.x);
                const along = (p) => (horizontal ? p.x : p.y);
                const next = r.pos.get("b" + at);
                for (const id of ["s", "s2"]) {
                    const s = r.pos.get(id);
                    // Same row as what it feeds = its row starts at or before, and it comes first.
                    if (row(s) < row(next) || along(s) > along(next)) {
                        bad++;
                        check(`${label}: source at ${at} in the row of what it feeds`, false, `${id} ${JSON.stringify(s)}, next ${JSON.stringify(next)}`);
                    }
                }
                // No two blocks overlap.
                const all = layers.flat().map((b) => ({ ...b, ...r.pos.get(b.id) }));
                for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
                    const a = all[i], b = all[j];
                    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                        bad++;
                        check(`${label}: source at ${at}: ${a.id} / ${b.id} don't overlap`, false);
                    }
                }
            }
            check(`${label}: sources stay with what they feed, no overlaps`, bad === 0 && wrapped > 0, `wrapped ${wrapped}`);
        }
    }
}

// Advanced: the mirror case -- loose sinks fed from the end of a row don't
// start the next row; they stay at the end of the row that feeds them.
{
    console.log("Advanced (ELK) wrap keeps sinks with what feeds them");
    for (const horizontal of [true, false]) {
        const label = horizontal ? "LR" : "TB";
        const big = (id) => ({ id, w: 1000, h: 1000 });
        let wrapped = 0, bad = 0;
        for (let at = 1; at < 8; at++) {
            const layers = Array.from({ length: 8 }, (_, i) => [big("b" + i)]);
            // Sink fed by b(at-1), sharing its step with a regular block.
            layers.splice(at, 0, [{ id: "r", w: 1000, h: 1000 }, { id: "k", w: 120, h: 30, sink: true, fedBy: [{ id: "b" + (at - 1), offset: 0 }] }]);
            const r = placeWrappedLayers(layers, { horizontal, layerGap: 100, itemGap: 50, rowGap: 100, aspect: 16 / 9 });
            if (r.rows > 1) wrapped++;
            const row = (p) => (horizontal ? p.y : p.x);
            const along = (p) => (horizontal ? p.x : p.y);
            const k = r.pos.get("k"), feeder = r.pos.get("b" + (at - 1));
            // Same row = within the feeder's row band (rows up to 1080 deep), later along it.
            if (row(k) < row(feeder) || row(k) >= row(feeder) + 1080 || along(k) < along(feeder)) {
                bad++;
                check(`${label}: sink at ${at} in the row of what feeds it`, false, `k ${JSON.stringify(k)}, feeder ${JSON.stringify(feeder)}`);
            }
            const all = layers.flat().map((b) => ({ ...b, ...r.pos.get(b.id) }));
            for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
                const a = all[i], b = all[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                    bad++;
                    check(`${label}: sink at ${at}: ${a.id} / ${b.id} don't overlap`, false);
                }
            }
        }
        check(`${label}: sinks stay with what feeds them, no overlaps`, bad === 0 && wrapped > 0, `wrapped ${wrapped}`);
    }
}

// Advanced: a chain end (nothing after it) moves back into free space instead
// of waiting behind the longest block of the previous step.
{
    console.log("Advanced (ELK) chain ends move into free space");
    for (const horizontal of [true, false]) {
        // [length along the flow, size across]
        const blk = (id, m, c, extra = {}) => ({ id, ...(horizontal ? { w: m, h: c } : { w: c, h: m }), ...extra });
        const layers = [
            [blk("T", 1000, 200), blk("S", 100, 200)],       // tall T, short S
            [blk("X", 200, 200)],
            [blk("F", 100, 200), blk("E", 100, 100, { chainEnd: true, preds: ["S"] })],
        ];
        const r = placeWrappedLayers(layers, { horizontal, layerGap: 100, itemGap: 50, rowGap: 100, aspect: horizontal ? 100 : 0.01 });
        const along = (id) => (horizontal ? r.pos.get(id).x : r.pos.get(id).y);
        const label = horizontal ? "LR" : "TB";
        check(`${label}: chain end starts right after what feeds it`, along("E") === 200, `E at ${along("E")}`);
        check(`${label}: other blocks keep their step`, along("F") === 1400, `F at ${along("F")}`);
        const all = layers.flat().map((b) => ({ ...b, ...r.pos.get(b.id) }));
        const ov = [];
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
            const a = all[i], b = all[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push(a.id + "/" + b.id);
        }
        check(`${label}: no overlaps`, ov.length === 0, ov.join(", "));
    }
}

// Advanced end to end: a loose tail of several nodes after a short group moves
// back next to it, instead of waiting behind a tall group in the same step.
for (const [name, layout] of [["Smart (dagre)", arrangeDagreGroups], ["Advanced (ELK)", arrangeELK]]) {
    console.log(name + " loose tail moves into free space");
    for (const dir of ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        const graph = new MockGraph();
        const src = graph.add(new MockNode(1, "N", 0, 0, 200, 100, 0, 2));
        const tall = graph.add(new MockNode(2, "N", 500, 0, 2000, 2000, 1, 0));
        const short = graph.add(new MockNode(3, "N", 500, 3000, 200, 100, 1, 1));
        const t = [4, 5, 6].map((id, i) => graph.add(new MockNode(id, "N", 4000 + i * 300, 4000, 200, 100, 1, 1)));
        graph.connect(src, 0, tall, 0);
        graph.connect(src, 1, short, 0);
        graph.connect(short, 0, t[0], 0);
        graph.connect(t[0], 0, t[1], 0);
        graph.connect(t[1], 0, t[2], 0);
        // Short group listed first: it comes first in its step, the tail level with it.
        for (const [i, n] of [[1, src], [2, short], [3, tall]]) graph.add(new MockGroup(i, "G" + i, ...frameAround([n], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        await arrange(graph, layout);
        const k = dir === "LR" ? 0 : 1;
        const T = graph._groups[2];
        const tallEnd = T.pos[k] + T.size[k];
        check(`${dir}: tail starts before the tall group ends`, t[0].boundingRect[k] < tallEnd,
            `tail ${t[0].boundingRect[k]}, tall group ends ${tallEnd}`);
        check(`${dir}: tail keeps its order`, t.every((n, i) => i === 0 || n.boundingRect[k] > t[i - 1].boundingRect[k]));
        const ov = overlaps(graph);
        check(`${dir}: no overlaps`, ov.length === 0, ov.join(", "));
        const s = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(s, snapshot(graph));
        check(`${dir}: second run moves nothing`, m.length === 0, m.join(", "));
    }
    setSettingsSource(() => ({}));
}

// Folding long chains inside a group.
{
    console.log("Chain folding");
    {
        // Thicknesses 100, 300, 300, 100, 100 with room for two per line:
        // the 300s pair up, so do the 100s.
        const items = [100, 300, 300, 100, 100].map((t) => ({ a: 100, t }));
        const lines = breakLines(items, 250, 50, 80);
        check("breakLines: similar neighbours share a line", JSON.stringify(lines) === JSON.stringify([[0], [1, 2], [3, 4]]),
            JSON.stringify(lines));
        const tight = breakLines(items, 100, 50, 80);
        check("breakLines: nothing fits together -> one item per line", tight.length === 5, JSON.stringify(tight));
        const n = (id) => new MockNode(id, "N", 0, 0);
        const ns = [1, 2, 3, 4, 5].map(n);
        const l = (a, b) => ({ origin_id: ns[a].id, target_id: ns[b].id });
        const ids = (cs) => JSON.stringify(cs.map((c) => c.map((x) => x.id)));
        check("findChains: a path in flow order", ids(findChains(ns.slice(0, 4), [l(2, 3), l(0, 1), l(1, 2), l(1, 2)])) === '[["1","2","3","4"]]');
        check("findChains: a branch is not a chain", findChains(ns, [l(0, 1), l(1, 2), l(2, 3), l(1, 4)]).length === 0);
        check("findChains: a loop is not a chain", findChains(ns.slice(0, 3), [l(0, 1), l(1, 2), l(2, 0)]).length === 0);
        check("findChains: two nodes are too short", findChains(ns.slice(0, 2), [l(0, 1)]).length === 0);
    }

    /** LoRA-loader style group: Get -> 7 tall loaders -> Set, feeding a second group. */
    const buildLoraGraph = () => {
        const graph = new MockGraph();
        const heights = [1462, 1030, 454, 790, 526, 406, 838];
        const chain = [graph.add(new MockNode(1, "Get", 0, 0, 230, 90, 0, 1))];
        heights.forEach((h, i) => chain.push(graph.add(new MockNode(i + 2, "Loader", 300 + i * 700, 0, 560, h, 1, 1))));
        chain.push(graph.add(new MockNode(20, "Set", 6000, 0, 230, 100, 1, 1)));
        for (let i = 1; i < chain.length; i++) graph.connect(chain[i - 1], 0, chain[i], 0);
        const after = graph.add(new MockNode(30, "Sampler", 0, 3000, 300, 200, 1, 0));
        graph.connect(chain[chain.length - 1], 0, after, 0);
        graph.add(new MockGroup(1, "LORAS", ...frameAround(chain, 30, 34)));
        graph.add(new MockGroup(2, "Gen", ...frameAround([after], 30, 34)));
        for (const g of graph._groups) g.recomputeInsideNodes();
        return { graph, chain, loras: graph._groups[0] };
    };
    /** Pairs of nodes in `ns` whose boxes overlap. */
    const nodeOverlaps = (ns) => {
        const bad = [];
        for (let i = 0; i < ns.length; i++) {
            for (let j = i + 1; j < ns.length; j++) {
                const a = ns[i].boundingRect, b = ns[j].boundingRect;
                if (a[0] < b[0] + b[2] - 0.5 && b[0] < a[0] + a[2] - 0.5 && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5) {
                    bad.push(`#${ns[i].id}/#${ns[j].id}`);
                }
            }
        }
        return bad;
    };
    const cases = [
        ["Quick LR", (g) => arrangeFloatRightGroups(g), "LR"],
        ["Smart LR", (g) => arrangeDagreGroups(g, { rankdir: "LR" }), "LR"],
        ["Smart TB", (g) => arrangeDagreGroups(g, { rankdir: "TB" }), "TB"],
        ["Advanced LR", (g) => arrangeELK(g, { rankdir: "LR" }), "LR"],
        ["Advanced TB", (g) => arrangeELK(g, { rankdir: "TB" }), "TB"],
    ];
    for (const [name, layout, dir] of cases) {
        const { graph, chain, loras } = buildLoraGraph();
        await arrange(graph, layout);
        const [, , w, h] = loras._bounding;
        if (dir === "LR") {
            // Tallest node 1462 + title + padding 2x30 + group title 34.
            check(`${name}: stacking keeps the group as tall as its tallest node`, h <= 1462 + 30 + 60 + 34 + 1, `height ${h}`);
            const cols = new Set(chain.map((n) => Math.round(n.pos[0]))).size;
            check(`${name}: short neighbours share columns`, cols < chain.length, `${cols} columns`);
        } else {
            check(`${name}: tall chain folds to at most 1:${FOLD_RATIO}`, h / w <= FOLD_RATIO, `${w}x${h}`);
            const bad = flowErrors(chain.map((n) => ["#" + n.id, n]), { wrap: true });
            check(`${name}: folded chain reads in rows, left to right`, bad.length === 0, bad.join(", "));
        }
        const ov = nodeOverlaps(chain);
        check(`${name}: chain nodes don't overlap`, ov.length === 0, ov.join(", "));
        check(`${name}: chain stays in its group`, chain.every((n) => centreIn(n, loras)));
        const gov = overlaps(graph);
        check(`${name}: no overlapping groups`, gov.length === 0, gov.join(", "));
        const s = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(s, snapshot(graph));
        check(`${name}: second run moves nothing`, m.length === 0, m.join(", "));
    }
}

// collectHiddenLinks on its own.
{
    console.log("collectHiddenLinks");
    const { graph } = buildSetGetGraph();
    const broken = graph.add(new MockNode(20, "GetNode", 0, 0, 150, 60, 0, 1));
    broken.isVirtualNode = true;
    broken.getInputLink = () => { throw new Error("No SetNode found"); };
    const plainVirtual = graph.add(new MockNode(21, "Note", 0, 0, 150, 60, 0, 0));
    plainVirtual.isVirtualNode = true;
    let links = null, threw = false;
    try { links = collectHiddenLinks(graph); } catch { threw = true; }
    check("never throws on a broken virtual hook", !threw);
    const pairs = (links || []).map((l) => `${l.origin_id}>${l.target_id}`).sort();
    check("Set -> Get edges only", JSON.stringify(pairs) === JSON.stringify(["2>3", "5>6"]), JSON.stringify(pairs));
    const ue = buildUseEverywhereGraph();
    const uePairs = collectHiddenLinks(ue.graph).map((l) => `${l.origin_id}>${l.target_id}`);
    check("Use Everywhere: broadcaster -> receiver", JSON.stringify(uePairs) === JSON.stringify(["2>3"]), JSON.stringify(uePairs));
}

// ── Nested groups ──────────────────────────────────────────────────────────

/** Rects (title-inclusive) of a list of nodes / groups that overlap each other. */
function rectOverlaps(items) {
    const bad = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const a = rectOf(items[i][1]), b = rectOf(items[j][1]);
            if (a[0] < b[0] + b[2] - 0.5 && b[0] < a[0] + a[2] - 0.5 && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5) {
                bad.push(`${items[i][0]}/${items[j][0]}`);
            }
        }
    }
    return bad;
}

/** Frame around nodes and groups (groups via their bounds). */
const frameAroundItems = (items, pad, titlePad) =>
    frameAround(items.map((it) => (it instanceof MockGroup ? { boundingRect: it._bounding } : it)), pad, titlePad);

/**
 * Three levels: Outer holds a -> [Inner] -> b and an empty nested group;
 * Inner holds c1 -> c2 -> c3 and Deep (d1 -> d2, fed by c2). An ungrouped
 * source feeds a. Scattered so a flattening layout would mix them.
 */
function buildNestedGraph() {
    const graph = new MockGraph();
    const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
    const src = n(1, -3000, 0);
    const a = n(2, 0, 0), b = n(3, 3600, 0);
    const c = [n(4, 1500, 1500), n(5, 1900, 1400), n(6, 1500, 1800)];
    const d = [n(7, 2000, 2200), n(8, 2300, 2400)];
    graph.connect(src, 0, a, 0);
    graph.connect(a, 0, c[0], 0);
    graph.connect(c[0], 0, c[1], 0);
    graph.connect(c[1], 0, c[2], 0);
    graph.connect(c[2], 0, b, 0);
    graph.connect(c[1], 0, d[0], 0);
    graph.connect(d[0], 0, d[1], 0);
    const Deep = new MockGroup(3, "Deep", ...frameAround(d, 20, 34));
    const Inner = new MockGroup(2, "Inner", ...frameAroundItems([...c, Deep], 20, 34));
    const Empty = new MockGroup(4, "EmptyInner", 400, 3000, 300, 200);
    const Outer = new MockGroup(1, "Outer", ...frameAroundItems([a, b, Inner, Empty], 30, 34));
    // Listed outermost last on purpose: nesting must not depend on list order.
    for (const g of [Deep, Inner, Empty, Outer]) graph.add(g);
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, src, a, b, c, d, Outer, Inner, Deep, Empty };
}

{
    console.log("Nested groups");
    const { graph, Outer, Inner, Deep, Empty } = buildNestedGraph();
    const mid = (g) => [g.pos[0] + 5, g.pos[1] + 40];
    check("groupAtPoint: innermost group", groupAtPoint(graph, ...mid(Deep)) === Deep);
    check("groupAtPoint: inside Inner, outside Deep", groupAtPoint(graph, Inner.pos[0] + 2, Inner.pos[1] + 2) === Inner);
    check("groupAtPoint: outside every group", groupAtPoint(graph, -5000, -5000) === null);
    check("groupAtPoint: outer area", groupAtPoint(graph, Outer.pos[0] + 2, Outer.pos[1] + 2) === Outer);
}

for (const [name, layout] of LAYOUTS) {
    for (const dir of name.startsWith("Quick") ? ["LR"] : ["LR", "TB"]) {
        setSettingsSource(() => ({ rankdir: dir }));
        console.log(`${name} ${dir} nested groups`);
        const { graph, a, b, c, d, Outer, Inner, Deep, Empty } = buildNestedGraph();
        await arrange(graph, layout);
        check("nested groups stay inside their parents",
            groupInside(Inner, Outer) && groupInside(Deep, Inner) && groupInside(Empty, Outer));
        check("empty nested group keeps its size", Empty.size[0] === 300 && Empty.size[1] === 200, JSON.stringify(Empty.size));
        check("nodes stay in their innermost group only",
            [a, b].every((n) => centreIn(n, Outer) && !centreIn(n, Inner) && !centreIn(n, Empty))
            && c.every((n) => centreIn(n, Inner) && !centreIn(n, Deep)) && d.every((n) => centreIn(n, Deep)));
        const levels = {
            Outer: [["a", a], ["b", b], ["Inner", Inner], ["Empty", Empty]],
            Inner: [...c.map((n) => ["c" + n.id, n]), ["Deep", Deep]],
            Deep: d.map((n) => ["d" + n.id, n]),
        };
        for (const [lvl, items] of Object.entries(levels)) {
            const ov = rectOverlaps(items);
            check(`no overlaps inside ${lvl}`, ov.length === 0, ov.join(", "));
        }
        const k = dir === "LR" ? 0 : 1;
        const ra = rectOf(a), ri = rectOf(Inner), rb = rectOf(b);
        check("nested group sits in the flow: a, Inner, b",
            ra[k] + ra[k + 2] <= ri[k] + 0.5 && ri[k] + ri[k + 2] <= rb[k] + 0.5, `a ${ra}, Inner ${ri}, b ${rb}`);
        const s = snapshot(graph);
        await arrange(graph, layout);
        const m = moved(s, snapshot(graph));
        check("second run moves nothing", m.length === 0, m.join(", "));
    }
}
setSettingsSource(() => ({}));

// ── Arrange one group ──────────────────────────────────────────────────────

{
    console.log("pushAlong");
    const unit = (x, y, w, h) => ({ rect: [x, y, w, h], move(dx, dy) { this.moved = [dx, dy]; } });
    const A = unit(150, 0, 100, 50), B = unit(260, 40, 100, 100), C = unit(150, 200, 100, 100), D = unit(400, 120, 100, 50);
    pushAlong([D, C, B, A], { orig: [0, 0, 100, 100], cur: [0, 0, 300, 100] }, 0, 50);
    check("in the way: pushed to the frame end + the old gap (≤ 50)", A.rect[0] === 350, A.rect.join(","));
    check("staggered: pushed by what was pushed, keeping its smaller gap", B.rect[0] === 460, B.rect.join(","));
    check("cascade continues past the frame's band", D.rect[0] === 600, D.rect.join(","));
    check("not in the way: stays", C.rect[0] === 150 && !C.moved, C.rect.join(","));
    const E = unit(1000, 0, 100, 100);
    pushAlong([E], { orig: [0, 0, 100, 100], cur: [0, 0, 300, 100] }, 0, 50);
    check("enough free space: nothing moves", !E.moved);
}

/**
 * Group T (frame 400x300 at 0,0) holding a chain of 4 nodes stacked on each
 * other, everything pinned. Around it: R right of T (in its band), R2 right
 * of R (close), F above-right, L left, Bt below. Subgraph IO.
 */
function buildSingleGroupGraph({ rx = 600 } = {}) {
    const graph = new MockGraph({ subgraph: true });
    const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
    const t = [0, 1, 2, 3].map((i) => n(i + 1, 40 + i * 10, 80 + i * 10));
    for (let i = 1; i < t.length; i++) graph.connect(t[i - 1], 0, t[i], 0);
    const T = graph.add(new MockGroup(1, "T", 0, 0, 400, 300));
    const g = (id, title, node) => graph.add(new MockGroup(id, title, ...frameAround([node], 30, 34)));
    const r = n(11, rx, 100);
    const r2 = n(12, rx + 300, 150);
    const f = n(13, 600, -800);
    const l = n(14, -700, 100);
    const bt = n(15, 50, 700);
    const groups = { T, R: g(2, "R", r), R2: g(3, "R2", r2), F: g(4, "F", f), L: g(5, "L", l), Bt: g(6, "Bt", bt) };
    for (const gr of graph._groups) gr.recomputeInsideNodes();
    for (const item of [...graph._nodes, ...graph._groups]) item.pin(true);
    return { graph, t, groups };
}

{
    const cases = [
        ["Quick", "quick", "LR"], ["Smart LR", "smart", "LR"], ["Smart TB", "smart", "TB"],
        ["Advanced LR", "advanced", "LR"], ["Advanced TB", "advanced", "TB"],
    ];
    for (const [name, kind, dir] of cases) {
        console.log(`Arrange (Group) ${name}`);
        const { graph, t, groups } = buildSingleGroupGraph();
        const { T, R, R2, F, L, Bt } = groups;
        const before = snapshot(graph);
        await arrangeGroup(graph, T, kind, { rankdir: dir });
        const after = snapshot(graph);
        check("group keeps its top-left corner", T.pos[0] === 0 && T.pos[1] === 0, T.pos.join(","));
        check("group members stay inside", t.every((n) => centreIn(n, T)));
        check("group members are unpinned", t.every((n) => !n.flags.pinned));
        check("pushed and other items keep their pin", [R, R2, F, L, Bt, ...graph._nodes.filter((n) => !t.includes(n))].every((x) => x.flags.pinned));
        const ov = overlaps(graph);
        check("no overlaps", ov.length === 0, ov.join(", "));
        const same = (key) => !moved({ [key]: before[key] }, { [key]: after[key] }).length;
        check("items not in the way stay put", same("group F") && same("group L") && same("input") && same("node 13") && same("node 14"),
            moved(before, after).join(", "));
        if (dir === "LR") {
            check("wider: the group to its right moves right, same height",
                R.pos[0] > before["group R"][0] && R.pos[1] === before["group R"][1], R.pos.join(","));
            check("the one behind it is pushed along", R2.pos[0] > before["group R2"][0]);
            check("gap kept between the pushed groups", R2.pos[0] - (R.pos[0] + R.size[0]) >= 40 - 0.5,
                `${R2.pos[0] - (R.pos[0] + R.size[0])}`);
        } else {
            check("taller: the group below moves down, same x",
                Bt.pos[1] > before["group Bt"][1] && Bt.pos[0] === before["group Bt"][0], Bt.pos.join(","));
            check("narrower: nothing moves sideways", same("group R") && same("group R2"));
        }
        const s = snapshot(graph);
        await arrangeGroup(graph, T, kind, { rankdir: dir });
        const m = moved(s, snapshot(graph));
        check("second run moves nothing", m.length === 0, m.join(", "));
    }

    console.log("Arrange (Group) free space");
    {
        const { graph, groups } = buildSingleGroupGraph({ rx: 2500 });
        const before = snapshot(graph);
        await arrangeGroup(graph, groups.T, "quick");
        const m = moved(before, snapshot(graph)).filter((k) => !/^node [1-4]$|^group T$/.test(k));
        check("room made beforehand: nothing else moves", m.length === 0, m.join(", "));
    }
}

/**
 * Outer holds Inner (3 nodes stacked, 400x300 at 0,0) and a node s right of
 * it; top-level group X right of Outer.
 */
function buildNestedTargetGraph() {
    const graph = new MockGraph();
    const n = (id, x, y) => graph.add(new MockNode(id, "N", x, y, 200, 100, 1, 1));
    const inner = [0, 1, 2].map((i) => n(i + 1, 40 + i * 10, 80 + i * 10));
    for (let i = 1; i < inner.length; i++) graph.connect(inner[i - 1], 0, inner[i], 0);
    const s = n(21, 500, 100);
    const x = n(31, 950, 100);
    const Inner = new MockGroup(2, "Inner", 0, 0, 400, 300);
    const Outer = new MockGroup(1, "Outer", -50, -60, 900, 420);
    const X = new MockGroup(3, "X", ...frameAround([x], 30, 34));
    for (const g of [Inner, Outer, X]) graph.add(g);
    for (const g of graph._groups) g.recomputeInsideNodes();
    return { graph, inner, s, x, Inner, Outer, X };
}

{
    console.log("Arrange (Group) nested target");
    const { graph, inner, s, Inner, Outer, X } = buildNestedTargetGraph();
    const xBefore = X.pos[0], outerW = Outer.size[0];
    await arrangeGroup(graph, Inner, "quick");
    check("inner group keeps its corner", Inner.pos[0] === 0 && Inner.pos[1] === 0, Inner.pos.join(","));
    check("outer group keeps its corner and grows", Outer.pos[0] === -50 && Outer.pos[1] === -60 && Outer.size[0] > outerW,
        `${Outer.pos} ${Outer.size}`);
    check("inner group stays inside the outer one", groupInside(Inner, Outer));
    check("sibling pushed but stays in the outer group, out of the inner one", centreIn(s, Outer) && !centreIn(s, Inner));
    check("inner members stay inside", inner.every((n) => centreIn(n, Inner)));
    const ovIn = rectOverlaps([["Inner", Inner], ["s", s]]);
    check("no overlaps inside the outer group", ovIn.length === 0, ovIn.join(", "));
    const ov = rectOverlaps([["Outer", Outer], ["X", X]]);
    check("no overlaps at the top", ov.length === 0, ov.join(", "));
    check("group beside the outer group is pushed", X.pos[0] > xBefore);
    const snap = snapshot(graph);
    await arrangeGroup(graph, Inner, "quick");
    const m = moved(snap, snapshot(graph));
    check("second run moves nothing", m.length === 0, m.join(", "));
}

{
    console.log("Arrange (Group) with a nested group");
    for (const kind of ["quick", "smart", "advanced"]) {
        const { graph, inner, s, Inner, Outer } = buildNestedTargetGraph();
        graph.connect(s, 0, inner[0], 0);
        // Arrange Inner first so it has a real layout, then remember it.
        await arrangeGroup(graph, Inner, kind);
        const rel = inner.map((n) => [n.pos[0] - Inner.pos[0], n.pos[1] - Inner.pos[1]]);
        const size = [...Inner.size];
        await arrangeGroup(graph, Outer, kind);
        check(`${kind}: nested group keeps its contents and size`,
            inner.every((n, i) => n.pos[0] - Inner.pos[0] === rel[i][0] && n.pos[1] - Inner.pos[1] === rel[i][1])
            && Inner.size[0] === size[0] && Inner.size[1] === size[1]);
        check(`${kind}: nested group stays inside`, groupInside(Inner, Outer));
        const rs = rectOf(s), ri = rectOf(Inner);
        check(`${kind}: feeder before the nested group`, rs[0] + rs[2] <= ri[0] + 0.5, `s ${rs}, Inner ${ri}`);
        const snap = snapshot(graph);
        await arrangeGroup(graph, Outer, kind);
        const m = moved(snap, snapshot(graph));
        check(`${kind}: second run moves nothing`, m.length === 0, m.join(", "));
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
