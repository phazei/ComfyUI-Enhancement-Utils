/**
 * Tests for js/graphArrangeLayout.js (Quick / Smart (dagre) / Advanced (ELK)).
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
    withPreservedCenter, arrangeFloatRightGroups, arrangeDagreGroups, arrangeELK, setSettingsSource,
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

// ── Helpers ────────────────────────────────────────────────────────────────

const LAYOUTS = [
    ["Quick", (g) => arrangeFloatRightGroups(g)],
    ["Smart (dagre)", (g) => arrangeDagreGroups(g)],
    ["Advanced (ELK)", (g) => arrangeELK(g)],
];

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

for (const [name, layout] of LAYOUTS) {
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
