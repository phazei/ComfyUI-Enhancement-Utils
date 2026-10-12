// Tests for js/flowGraph.js using mock LGraph / LGraphNode / LLink objects.
// Run: node tests/flowGraph.test.mjs
import assert from "node:assert/strict";

// ── Mocks ────────────────────────────────────────────────────────────────

// Shared mocks; importing the loader also sets globalThis.LGraphNode = MockNode.
import { MockGraph, mk, mkContainer } from "./workflowLoader.mjs";

const MODULE = new URL("../js/flowGraph.js", import.meta.url);

const { buildFlowModel, computeFlowSignature, nodeKey, linkKey } = await import(MODULE.href);

// ── Test runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const origWarn = console.warn;
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(" "));

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
    }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);

// ── Tests ────────────────────────────────────────────────────────────────

test("simple chain depths", () => {
    const g = new MockGraph("rootuuid");
    const a = g.add(mk(1, { outputs: ["IMAGE"] }));
    const b = g.add(mk(2, { inputs: ["IMAGE"], outputs: ["IMAGE"] }));
    const c = g.add(mk(3, { inputs: ["IMAGE"], output: true }));
    const l1 = g.connect(a, 0, b, 0);
    const l2 = g.connect(b, 0, c, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.size, 3);
    assert.deepEqual([...m.nodes.values()].map((n) => n.depth), [0, 1, 2]);
    assert.equal(m.maxDepth, 2);
    assert.equal(m.noOutputs, false);
    assert.equal(m.edges.length, 2);
    const li = m.getLinkInfo(g, l2.id);
    near(li.t0, 1);
    near(li.t1, 2);
    assert.equal(li.active, true);
    assert.equal(m.getNodeInfo(g, c).kind, "real");
    assert.deepEqual(m.getNodeInfo(g, b).execIds, ["2"]);
    assert.equal(nodeKey(g, a), "root|N1");
    assert.equal(linkKey(g, l1.id), "root|L1");
});

test("fan-out / fan-in longest path", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"], outputs: ["X"] }));
    const d = g.add(mk(3, { inputs: ["X", "X"], output: true }));
    g.connect(a, 0, b, 0);
    g.connect(b, 0, d, 0);
    const ad = g.connect(a, 0, d, 1);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").depth, 2);
    const li = m.getLinkInfo(g, ad.id);
    near(li.t0, 0);
    near(li.t1, 2);
});

test("dead branch inactive", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"], output: true }));
    const x = g.add(mk(3, { inputs: ["X"], outputs: ["X"] }));
    const y = g.add(mk(4, { inputs: ["X"] }));
    g.connect(a, 0, b, 0);
    const ax = g.connect(a, 0, x, 0);
    g.connect(x, 0, y, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("1").active, true);
    assert.equal(m.nodes.get("3").active, false);
    assert.equal(m.getNodeInfo(g, x).active, false);
    assert.equal(m.getNodeInfo(g, x).kind, "real");
    assert.equal(m.getLinkInfo(g, ax.id).active, false);
    // maxDepth only over active nodes (Y at depth 2 is dead) -> 1, and Y is clamped
    assert.equal(m.maxDepth, 1);
    assert.equal(m.nodes.get("4").depth, 1);
});

test("no outputs -> noOutputs, all active", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"] }));
    g.connect(a, 0, b, 0);
    const m = buildFlowModel(g);
    assert.equal(m.noOutputs, true);
    assert.ok([...m.nodes.values()].every((n) => n.active && !n.conditional));
});

test("muted node cuts chain", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const mu = g.add(mk(2, { inputs: ["X"], outputs: ["X"], mode: 2 }));
    const c = g.add(mk(3, { inputs: ["X"], output: true }));
    const l1 = g.connect(a, 0, mu, 0);
    const l2 = g.connect(mu, 0, c, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 0);
    assert.equal(m.nodes.has("2"), false);
    const info = m.getNodeInfo(g, mu);
    assert.equal(info.kind, "muted");
    assert.equal(info.active, false);
    assert.ok(Number.isNaN(info.depth));
    assert.equal(m.getLinkInfo(g, l1.id), null);
    assert.equal(m.getLinkInfo(g, l2.id), null);
    assert.equal(m.nodes.get("1").active, false);
    assert.equal(m.nodes.get("3").depth, 0);
});

test("bypassed node passes through with type matching, is a hop", () => {
    const g = new MockGraph("r");
    const a1 = g.add(mk(1, { outputs: ["LATENT"] }));
    const a2 = g.add(mk(2, { outputs: ["IMAGE"] }));
    const bp = g.add(mk(3, { inputs: ["LATENT", "IMAGE"], outputs: ["IMAGE"], mode: 4 }));
    const c = g.add(mk(4, { inputs: ["IMAGE"], output: true }));
    g.connect(a1, 0, bp, 0);
    const l2 = g.connect(a2, 0, bp, 1);
    const l3 = g.connect(bp, 0, c, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 1);
    const e = m.edges[0];
    assert.equal(e.from, "2");
    assert.equal(e.to, "4");
    assert.deepEqual(e.segments.map((s) => s.type), ["link", "hop", "link"]);
    const info = m.getNodeInfo(g, bp);
    assert.equal(info.kind, "bypassed");
    near(info.depth, 0.5);
    assert.equal(info.active, true);
    near(m.getLinkInfo(g, l2.id).t1, 0.5);
    near(m.getLinkInfo(g, l3.id).t0, 0.5);
    assert.equal(m.nodes.get("1").active, false);
});

test("bypassed node with no flow through -> bypassed, inactive", () => {
    const g = new MockGraph("r");
    const bp = g.add(mk(3, { inputs: ["IMAGE"], outputs: ["IMAGE"], mode: 4 }));
    const m = buildFlowModel(g);
    assert.equal(m.getNodeInfo(g, bp).kind, "bypassed");
    assert.equal(m.getNodeInfo(g, bp).active, false);
});

test("virtual reroute (default getInputLink)", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const r = g.add(mk(2, { inputs: ["*"], outputs: ["*"], virtual: true }));
    const c = g.add(mk(3, { inputs: ["X"], output: true }));
    g.connect(a, 0, r, 0);
    g.connect(r, 0, c, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0].from, "1");
    assert.deepEqual(m.edges[0].segments.map((s) => s.type), ["link", "hop", "link"]);
    const info = m.getNodeInfo(g, r);
    assert.equal(info.kind, "virtual");
    near(info.depth, 0.5);
    assert.equal(m.getVirtualSegments(g).length, 0);
    assert.equal(m.nodes.get("3").depth, 1);
});

test("Note-like virtual node with nothing through it -> null", () => {
    const g = new MockGraph("r");
    const note = g.add(mk(9, { virtual: true }));
    const m = buildFlowModel(g);
    assert.equal(m.getNodeInfo(g, note), null);
});

/** Build a Set/Get pair in graph g; returns { setter, getter }. */
function makeSetGet(g, setterId, getterId, name) {
    const setter = g.add(mk(setterId, { inputs: ["*"], outputs: ["*"], virtual: true, widgets: [name] }));
    const getter = g.add(mk(getterId, { outputs: ["*"], virtual: true, widgets: [name] }));
    getter.getInputLink = function (slot) {
        const s = this.graph._nodes.find((n) => n.widgets?.[0]?.value === this.widgets[0].value && n !== this);
        if (!s) throw new Error("no setter (easy-use style)");
        const id = s.inputs[slot]?.link;
        return id == null ? null : this.graph.getLink(id);
    };
    return { setter, getter };
}

test("Set/Get virtual jump produces ghost segment", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const { setter, getter } = makeSetGet(g, 2, 3, "foo");
    const c = g.add(mk(4, { inputs: ["X"], output: true }));
    const l1 = g.connect(a, 0, setter, 0);
    const l2 = g.connect(getter, 0, c, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 1);
    const e = m.edges[0];
    assert.equal(e.from, "1");
    assert.deepEqual(e.segments.map((s) => s.type), ["link", "hop", "virtual", "hop", "link"]);
    const vs = m.getVirtualSegments(g);
    assert.equal(vs.length, 1);
    assert.equal(vs[0].fromNode, setter);
    assert.equal(vs[0].toNode, getter);
    assert.equal(vs[0].toSlot, 0);
    near(vs[0].t0, 1 / 3);
    near(vs[0].t1, 2 / 3);
    near(m.getLinkInfo(g, l1.id).t1, 1 / 3);
    near(m.getLinkInfo(g, l2.id).t0, 2 / 3);
    near(m.getNodeInfo(g, setter).depth, 1 / 3);
    near(m.getNodeInfo(g, getter).depth, 2 / 3);
    assert.equal(m.getNodeInfo(g, getter).kind, "virtual");
});

test("getter without setter (throws) is memoised, no edge", () => {
    const g = new MockGraph("r");
    const getter = g.add(mk(3, { outputs: ["*"], virtual: true, widgets: ["missing"] }));
    let calls = 0;
    getter.getInputLink = () => {
        calls++;
        throw new Error("No setter");
    };
    getter.resolveVirtualOutput = () => {
        throw new Error("boom");
    };
    const c1 = g.add(mk(4, { inputs: ["X"], output: true }));
    const c2 = g.add(mk(5, { inputs: ["X"], output: true }));
    g.connect(getter, 0, c1, 0);
    g.connect(getter, 0, c2, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 0);
    buildFlowModel(g);
    assert.equal(calls, 1, "hook called once while signature unchanged");
    getter.widgets[0].value = "other";
    buildFlowModel(g);
    assert.equal(calls, 2, "hook called again after widget change");
});

test("resolveVirtualOutput to a node in an ancestor graph", () => {
    const root = new MockGraph("r");
    const a = root.add(mk(1, { outputs: ["X"] }));
    const sub = new MockGraph("sub-uuid", true);
    const getter = sub.add(mk(7, { outputs: ["*"], virtual: true, widgets: ["foo"] }));
    getter.resolveVirtualOutput = () => ({ node: a, slot: 0 });
    getter.getInputLink = () => {
        throw new Error("should not be called");
    };
    const p = sub.add(mk(8, { inputs: ["X"], output: true }));
    const gl = sub.connect(getter, 0, p, 0);
    const cont = root.add(mkContainer(5, sub, [], []));
    const m = buildFlowModel(root);
    assert.ok(m.nodes.has("5:8"));
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0].from, "1");
    assert.equal(m.edges[0].to, "5:8");
    assert.deepEqual(m.edges[0].segments.map((s) => s.type), ["hop", "link"]);
    assert.equal(m.getVirtualSegments(sub).length, 0);
    assert.equal(m.getVirtualSegments(root).length, 0);
    assert.equal(m.getNodeInfo(sub, getter).kind, "virtual");
    near(m.getLinkInfo(sub, gl.id).t0, 0);
    assert.equal(nodeKey(sub, p), "sub-uuid|N8");
    assert.equal(m.getNodeInfo(root, cont).kind, "container");
});

test("resolveVirtualOutput same graph -> ghost from real source", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const getter = g.add(mk(2, { outputs: ["*"], virtual: true }));
    getter.resolveVirtualOutput = () => ({ node: a, slot: 0 });
    const c = g.add(mk(3, { inputs: ["X"], output: true }));
    g.connect(getter, 0, c, 0);
    const m = buildFlowModel(g);
    const vs = m.getVirtualSegments(g);
    assert.equal(vs.length, 1);
    assert.equal(vs[0].fromNode, a);
    assert.equal(vs[0].toNode, getter);
});

/** root: A -> [container 5: -10 -> I1 -> I2 -> -20] -> O */
function makeSubgraphWorkflow() {
    const root = new MockGraph("root-uuid");
    root.isRootGraph = true;
    const sub = new MockGraph("sub-1", true);
    sub.isRootGraph = false;
    const a = root.add(mk(1, { outputs: ["X"] }));
    const i1 = sub.add(mk(1, { inputs: ["X"], outputs: ["X"] }));
    const i2 = sub.add(mk(2, { inputs: ["X"], outputs: ["X"] }));
    const sIn = sub.connect("-10", 0, i1, 0);
    const sMid = sub.connect(i1, 0, i2, 0);
    const sOut = sub.connect(i2, 0, "-20", 0);
    const cont = root.add(mkContainer(5, sub, ["X"], ["X"]));
    const o = root.add(mk(6, { inputs: ["X"], output: true }));
    const rIn = root.connect(a, 0, cont, 0);
    const rOut = root.connect(cont, 0, o, 0);
    return { root, sub, a, i1, i2, cont, o, sIn, sMid, sOut, rIn, rOut };
}

test("subgraph container", () => {
    const w = makeSubgraphWorkflow();
    const m = buildFlowModel(w.root);
    assert.deepEqual([...m.nodes.keys()].sort(), ["1", "5:1", "5:2", "6"]);
    assert.equal(m.nodes.get("5:1").depth, 1);
    assert.equal(m.nodes.get("5:2").depth, 2);
    assert.equal(m.nodes.get("6").depth, 3);
    const ci = m.getNodeInfo(w.root, w.cont);
    assert.equal(ci.kind, "container");
    assert.equal(ci.depth, 1);
    assert.equal(ci.depthEnd, 2);
    assert.equal(ci.active, true);
    assert.deepEqual(ci.execIds.sort(), ["5:1", "5:2"]);
    const ii = m.getNodeInfo(w.sub, w.i1);
    assert.deepEqual(ii.execIds, ["5:1"]);
    // edge A -> 5:1 crosses root link + -10 link
    const eIn = m.edges.find((e) => e.to === "5:1");
    assert.equal(eIn.from, "1");
    assert.deepEqual(eIn.segments.map((s) => [s.type, s.graph === w.root ? "root" : "sub"]), [
        ["link", "root"],
        ["link", "sub"],
    ]);
    near(m.getLinkInfo(w.root, w.rIn.id).t1, 0.5);
    near(m.getLinkInfo(w.sub, w.sIn.id).t0, 0.5);
    near(m.getLinkInfo(w.sub, w.sIn.id).t1, 1);
    const eOut = m.edges.find((e) => e.to === "6");
    assert.equal(eOut.from, "5:2");
    assert.ok(m.getLinkInfo(w.sub, w.sOut.id));
    near(m.getLinkInfo(w.sub, w.sOut.id).t0, 2);
    near(m.getLinkInfo(w.root, w.rOut.id).t1, 3);
    assert.equal(m.getLinkInfo(w.sub, w.sMid.id).active, true);
    // the sub link and root link with the same id are distinct
    assert.notEqual(linkKey(w.sub, 1), linkKey(w.root, 1));
});

test("subgraph pass-through (-10 directly to -20)", () => {
    const root = new MockGraph("r");
    const sub = new MockGraph("pt", true);
    const a = root.add(mk(1, { outputs: ["X"] }));
    const pt = sub.connect("-10", 0, "-20", 0);
    const cont = root.add(mkContainer(2, sub, ["X"], ["X"]));
    const o = root.add(mk(3, { inputs: ["X"], output: true }));
    root.connect(a, 0, cont, 0);
    root.connect(cont, 0, o, 0);
    const m = buildFlowModel(root);
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0].from, "1");
    assert.equal(m.edges[0].segments.length, 3);
    assert.ok(m.getLinkInfo(sub, pt.id));
    const ci = m.getNodeInfo(root, cont);
    assert.equal(ci.kind, "container");
    assert.equal(ci.active, false);
});

test("nested subgraph", () => {
    const root = new MockGraph("r");
    const s1 = new MockGraph("s1", true);
    const s2 = new MockGraph("s2", true);
    const a = root.add(mk(1, { outputs: ["X"] }));
    const x = s2.add(mk(3, { inputs: ["X"], output: true }));
    const l2 = s2.connect("-10", 0, x, 0);
    const c2 = s1.add(mkContainer(2, s2, ["X"], []));
    const l1 = s1.connect("-10", 0, c2, 0);
    const c1 = root.add(mkContainer(7, s1, ["X"], []));
    const l0 = root.connect(a, 0, c1, 0);
    const m = buildFlowModel(root);
    assert.ok(m.nodes.has("7:2:3"));
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0].from, "1");
    assert.equal(m.edges[0].segments.length, 3);
    near(m.getLinkInfo(s1, l1.id).t0, 1 / 3);
    near(m.getLinkInfo(s2, l2.id).t1, 1);
    assert.ok(m.getLinkInfo(root, l0.id));
    assert.equal(m.getNodeInfo(root, c1).kind, "container");
    assert.equal(m.getNodeInfo(s1, c2).kind, "container");
    assert.deepEqual(m.getNodeInfo(root, c1).execIds, ["7:2:3"]);
    const t = m.traceSelection(root, [c1]);
    assert.ok(t.nodeKeys.has(nodeKey(root, a)));
    assert.ok(t.linkKeys.has(linkKey(s2, l2.id)));
    assert.ok(t.nodeKeys.has(nodeKey(s1, c2)));
});

test("muted container is not entered", () => {
    const w = makeSubgraphWorkflow();
    w.cont.mode = 2;
    const m = buildFlowModel(w.root);
    assert.equal(m.nodes.has("5:1"), false);
    assert.equal(m.getNodeInfo(w.root, w.cont).kind, "muted");
});

test("lazy input marks edge lazy and node conditional", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["IMAGE"] }));
    const b = g.add(mk(2, { outputs: ["IMAGE"] }));
    const sw = g.add(
        mk(3, {
            inputs: [
                { name: "on_true", type: "IMAGE" },
                { name: "on_false", type: "IMAGE" },
            ],
            output: true,
            nodeInput: { required: { on_true: ["IMAGE", { lazy: true }] }, optional: { on_false: ["IMAGE", {}] } },
        })
    );
    const la = g.connect(a, 0, sw, 0);
    const lb = g.connect(b, 0, sw, 1);
    const m = buildFlowModel(g);
    const ea = m.edges.find((e) => e.from === "1");
    const eb = m.edges.find((e) => e.from === "2");
    assert.equal(ea.lazy, true);
    assert.equal(eb.lazy, false);
    assert.equal(m.nodes.get("1").conditional, true);
    assert.equal(m.nodes.get("1").active, true);
    assert.equal(m.nodes.get("2").conditional, false);
    assert.equal(m.getNodeInfo(g, a).conditional, true);
    assert.equal(m.getLinkInfo(g, la.id).lazy, true);
    assert.equal(m.getLinkInfo(g, lb.id).lazy, false);
});

test("lazy on optional input", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["IMAGE"] }));
    const sw = g.add(
        mk(3, {
            inputs: [{ name: "opt", type: "IMAGE" }],
            output: true,
            nodeInput: { required: {}, optional: { opt: ["IMAGE", { lazy: true }] } },
        })
    );
    g.connect(a, 0, sw, 0);
    const m = buildFlowModel(g);
    assert.equal(m.edges[0].lazy, true);
});

test("segment timing interpolation + shared segment min rule", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const r = g.add(mk(2, { inputs: ["*"], outputs: ["*"], virtual: true }));
    const b = g.add(mk(3, { inputs: ["X"], output: true }));
    const c1 = g.add(mk(4, { outputs: ["X"] }));
    const c2 = g.add(mk(5, { inputs: ["X"], outputs: ["X"] }));
    const c3 = g.add(mk(6, { inputs: ["X"], outputs: ["X"] }));
    const d = g.add(mk(7, { inputs: ["X", "X"], output: true }));
    const shared = g.connect(a, 0, r, 0);
    const rb = g.connect(r, 0, b, 0);
    const rd = g.connect(r, 0, d, 0);
    g.connect(c1, 0, c2, 0);
    g.connect(c2, 0, c3, 0);
    g.connect(c3, 0, d, 1);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("7").depth, 3);
    const s = m.getLinkInfo(g, shared.id);
    near(s.t0, 0);
    near(s.t1, 0.5, "shared link t1 = min(0.5, 1.5)");
    near(m.getLinkInfo(g, rb.id).t0, 0.5);
    near(m.getLinkInfo(g, rd.id).t0, 1.5);
    near(m.getLinkInfo(g, rd.id).t1, 3);
    near(m.getNodeInfo(g, r).depth, 0.5, "hop takes earliest time");
});

test("traceSelection upstream/downstream", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"], outputs: ["X"] }));
    const c = g.add(mk(3, { inputs: ["X", "X"], output: true }));
    const x = g.add(mk(4, { outputs: ["X"] }));
    const r = g.add(mk(5, { inputs: ["*"], outputs: ["*"], virtual: true }));
    const ab = g.connect(a, 0, b, 0);
    const br = g.connect(b, 0, r, 0);
    const rc = g.connect(r, 0, c, 0);
    const xc = g.connect(x, 0, c, 1);
    const m = buildFlowModel(g);
    const t = m.traceSelection(g, [b]);
    for (const n of [a, b, c, r]) assert.ok(t.nodeKeys.has(nodeKey(g, n)), `node ${n.id}`);
    assert.ok(!t.nodeKeys.has(nodeKey(g, x)));
    for (const l of [ab, br, rc]) assert.ok(t.linkKeys.has(linkKey(g, l.id)), `link ${l.id}`);
    assert.ok(!t.linkKeys.has(linkKey(g, xc.id)));
    // selecting X: downstream C, upstream nothing else; A not included
    const tx = m.traceSelection(g, [x]);
    assert.ok(tx.nodeKeys.has(nodeKey(g, c)));
    assert.ok(!tx.nodeKeys.has(nodeKey(g, a)));
    assert.ok(!tx.linkKeys.has(linkKey(g, ab.id)));
    // selecting the reroute hop: its edge B -> C plus closure
    const tr = m.traceSelection(g, [r]);
    assert.ok(tr.linkKeys.has(linkKey(g, br.id)) && tr.linkKeys.has(linkKey(g, rc.id)));
    assert.ok(tr.nodeKeys.has(nodeKey(g, a)));
    assert.ok(!tr.nodeKeys.has(nodeKey(g, x)));
    // garbage input does not throw
    assert.equal(m.traceSelection(g, null).nodeKeys.size, 0);
});

test("traceSelection Set/Get virtual keys", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const { setter, getter } = makeSetGet(g, 2, 3, "foo");
    const c = g.add(mk(4, { inputs: ["X"], output: true }));
    g.connect(a, 0, setter, 0);
    g.connect(getter, 0, c, 0);
    const m = buildFlowModel(g);
    const t = m.traceSelection(g, [c]);
    assert.equal(t.virtualKeys.size, 1);
    assert.ok(t.virtualKeys.has(m.getVirtualSegments(g)[0].key));
    assert.ok(t.nodeKeys.has(nodeKey(g, setter)) && t.nodeKeys.has(nodeKey(g, getter)));
});

test("sourcePlacement late", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"], outputs: ["X"] }));
    const c = g.add(mk(3, { inputs: ["X"], outputs: ["X"] }));
    const d = g.add(mk(4, { inputs: ["X", "X"], output: true }));
    const s = g.add(mk(5, { outputs: ["X"] }));
    g.connect(a, 0, b, 0);
    g.connect(b, 0, c, 0);
    g.connect(c, 0, d, 0);
    g.connect(s, 0, d, 1);
    assert.equal(buildFlowModel(g).nodes.get("5").depth, 0);
    const m = buildFlowModel(g, { sourcePlacement: "late" });
    assert.equal(m.nodes.get("5").depth, 2);
    assert.equal(m.nodes.get("1").depth, 0);
});

test("throwing hooks / malformed nodes don't break the build", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { outputs: ["X"] }));
    const v = g.add(mk(2, { inputs: ["*"], outputs: ["*"], virtual: true }));
    v.resolveVirtualOutput = () => {
        throw new Error("hook boom");
    };
    v.getInputLink = () => {
        throw new Error("hook boom 2");
    };
    const c = g.add(mk(3, { inputs: ["X"], output: true }));
    g.connect(a, 0, v, 0);
    g.connect(v, 0, c, 0);
    const bad = mk(4, {});
    Object.defineProperty(bad, "inputs", {
        get() {
            throw new Error("bad inputs");
        },
    });
    g.add(bad);
    const ok = g.add(mk(5, { inputs: ["X"], output: true }));
    g.connect(a, 0, ok, 0);
    // dangling link id and a link to a missing origin
    const dang = g.add(mk(6, { inputs: ["X", "X"], output: true }));
    dang.inputs[0].link = 12345;
    g.links.set(500, { id: 500, origin_id: "77", origin_slot: 0, target_id: "6", target_slot: 1 });
    dang.inputs[1].link = 500;
    const m = buildFlowModel(g);
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0].to, "5");
    assert.equal(buildFlowModel(null).nodes.size, 0);
    assert.equal(buildFlowModel({}).nodes.size, 0);
    assert.equal(m.getNodeInfo(null, null), null);
    assert.equal(m.getLinkInfo(undefined, 3), null);
    assert.deepEqual(m.getVirtualSegments(undefined), []);
    assert.equal(typeof computeFlowSignature(null), "string");
});

test("cycle doesn't hang or throw", () => {
    const g = new MockGraph("r");
    const a = g.add(mk(1, { inputs: ["X"], outputs: ["X"] }));
    const b = g.add(mk(2, { inputs: ["X"], outputs: ["X"], output: true }));
    g.connect(a, 0, b, 0);
    g.connect(b, 0, a, 0);
    const r1 = g.add(mk(3, { inputs: ["*"], outputs: ["*"], virtual: true }));
    const r2 = g.add(mk(4, { inputs: ["*"], outputs: ["*"], virtual: true }));
    g.connect(r1, 0, r2, 0);
    g.connect(r2, 0, r1, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.size, 2);
});

test("computeFlowSignature changes on mode / virtual widget change", () => {
    const w = makeSubgraphWorkflow();
    const { setter, getter } = makeSetGet(w.sub, 10, 11, "foo");
    const s0 = computeFlowSignature(w.root);
    assert.equal(computeFlowSignature(w.root), s0);
    w.i1.mode = 4;
    const s1 = computeFlowSignature(w.root);
    assert.notEqual(s1, s0);
    w.i1.mode = 0;
    assert.equal(computeFlowSignature(w.root), s0);
    getter.widgets[0].value = "bar";
    const s2 = computeFlowSignature(w.root);
    assert.notEqual(s2, s0);
    w.sub._version++;
    assert.notEqual(computeFlowSignature(w.root), s2);
    void setter;
});

test("LiteGraph.isValidConnection global is used when present", () => {
    let called = 0;
    globalThis.LiteGraph = {
        isValidConnection: (a, b) => {
            called++;
            return a === b || a === "*" || b === "*";
        },
    };
    try {
        const g = new MockGraph("r");
        const a2 = g.add(mk(2, { outputs: ["IMAGE"] }));
        const bp = g.add(mk(3, { inputs: ["LATENT", "IMAGE"], outputs: ["IMAGE"], mode: 4 }));
        const c = g.add(mk(4, { inputs: ["IMAGE"], output: true }));
        g.connect(a2, 0, bp, 1);
        g.connect(bp, 0, c, 0);
        const m = buildFlowModel(g);
        assert.equal(m.edges[0].from, "2");
        assert.ok(called > 0);
    } finally {
        delete globalThis.LiteGraph;
    }
});

test("performance: 1500-node workflow", () => {
    const g = new MockGraph("r");
    const N = 1500;
    const ns = [];
    for (let i = 0; i < N; i++) {
        const n = g.add(
            mk(i + 1, {
                inputs: ["X", "X", "X"],
                outputs: ["X"],
                output: i % 100 === 99,
                virtual: false,
                mode: i % 37 === 5 ? 4 : 0,
            })
        );
        ns.push(n);
    }
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 1; i < N; i++) {
        for (let s = 0; s < 3; s++) {
            if (rnd() < 0.8) g.connect(ns[Math.floor(rnd() * i)], 0, ns[i], s);
        }
    }
    buildFlowModel(g); // warm-up
    const t0 = performance.now();
    const m = buildFlowModel(g);
    const dt = performance.now() - t0;
    const t1 = performance.now();
    const sig = computeFlowSignature(g);
    const dtSig = performance.now() - t1;
    console.log(
        `       build ${dt.toFixed(1)} ms, signature ${dtSig.toFixed(2)} ms, ${m.nodes.size} nodes, ${m.edges.length} edges, maxDepth ${m.maxDepth}`
    );
    assert.ok(dt < 50, `build took ${dt} ms`);
    assert.ok(sig.length > 0);
});

test("output with a required input cut by a mute fails validation", () => {
    const g = new MockGraph("r");
    const req = { required: { in0: ["IMAGE"] } };
    const a = g.add(mk(1, { outputs: ["IMAGE"] }));
    const mu = g.add(mk(2, { inputs: ["IMAGE"], outputs: ["IMAGE"], mode: 2, nodeInput: req }));
    const p = g.add(mk(3, { inputs: ["IMAGE"], output: true, nodeInput: req }));
    const s = g.add(mk(4, { inputs: ["IMAGE"], output: true, nodeInput: req }));
    g.connect(a, 0, mu, 0);
    g.connect(mu, 0, p, 0);
    g.connect(a, 0, s, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").invalid, true);
    assert.equal(m.nodes.get("3").active, false);
    assert.equal(m.getNodeInfo(g, p).invalid, true);
    assert.equal(m.nodes.get("4").active, true);
    assert.equal(m.nodes.get("1").active, true);
});

test("invalid node upstream poisons every output that depends on it", () => {
    const g = new MockGraph("r");
    const req = { required: { in0: ["MODEL"], in1: ["IMAGE"] } };
    const a = g.add(mk(1, { outputs: ["IMAGE"] }));
    const mid = g.add(mk(2, { inputs: ["MODEL", "IMAGE"], outputs: ["IMAGE"], nodeInput: req }));
    const o = g.add(mk(3, { inputs: ["IMAGE"], output: true }));
    g.connect(a, 0, mid, 1);
    g.connect(mid, 0, o, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("2").invalid, true);
    assert.equal(m.nodes.get("3").active, false);
    assert.equal(m.nodes.get("1").active, false);
    assert.equal(m.noOutputs, false);
});

test("unlinked widget-backed or unknown inputs never invalidate", () => {
    const g = new MockGraph("r");
    const a = g.add(
        mk(1, {
            inputs: [{ name: "seed", type: "INT", widget: { name: "seed" } }, { name: "dyn.x", type: "IMAGE" }],
            output: true,
            nodeInput: { required: { seed: ["INT"] } },
        })
    );
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("1").invalid, false);
    assert.equal(m.getNodeInfo(g, a).active, true);
});

/** Two-way lazy switch class (on_false, on_true), like LazySwitchKJ. */
const SW = { required: { on_false: ["*", { lazy: true }], on_true: ["*", { lazy: true }] } };
const mkSwitch = (id) => mk(id, { inputs: [{ name: "on_false", type: "*" }, { name: "on_true", type: "*" }], outputs: ["*"], nodeInput: SW });

test("node feeding both branches of a switch is certain; single-branch feeders are conditional", () => {
    const g = new MockGraph("r");
    const sched = g.add(mk(1, { outputs: ["X"] }));               // feeds all samplers
    const guider = g.add(mk(2, { outputs: ["X"] }));              // feeds A and C only
    const a = g.add(mk(3, { inputs: ["X", "X"], outputs: ["X"] }));
    const b = g.add(mk(4, { inputs: ["X"], outputs: ["X"] }));
    const c = g.add(mk(5, { inputs: ["X", "X"], outputs: ["X"] }));
    const s1 = g.add(mkSwitch(6));
    const s2 = g.add(mkSwitch(7));
    const out = g.add(mk(8, { inputs: ["X"], output: true }));
    g.connect(sched, 0, a, 0);
    g.connect(guider, 0, a, 1);
    g.connect(sched, 0, b, 0);
    g.connect(sched, 0, c, 0);
    g.connect(guider, 0, c, 1);
    g.connect(a, 0, s1, 0);
    g.connect(b, 0, s1, 1);
    g.connect(s1, 0, s2, 0);
    g.connect(c, 0, s2, 1);
    g.connect(s2, 0, out, 0);
    const m = buildFlowModel(g);
    const n = (id) => m.nodes.get(id);
    assert.equal(n("1").conditional, false, "scheduler feeds every branch");
    assert.equal(m.getNodeInfo(g, sched).certain, true);
    assert.equal(n("2").conditional, true, "guider misses branch B");
    assert.equal(n("3").conditional, true);
    assert.equal(n("5").conditional, true);
    assert.equal(n("6").conditional, true, "inner switch is one branch of the outer");
    assert.equal(n("7").conditional, false);
    assert.equal(m.getNodeInfo(g, s2).isSwitch, true);
    assert.deepEqual([...m.getNodeInfo(g, s2).lazySlots].sort(), [0, 1]);
    assert.equal(m.getNodeInfo(g, a).isSwitch, false);

    // A gates at the inner switch; the inner switch gates at the outer one.
    assert.deepEqual(m.getGateTrace(g, a).gates.map((x) => x.execId), ["6"]);
    assert.deepEqual(m.getGateTrace(g, s1).gates.map((x) => x.execId), ["7"]);
    // Guider: gates at both switches? It feeds A (-> s1) and C (-> s2). Survives into s1? No (B lacks it).
    assert.deepEqual(m.getGateTrace(g, guider).gates.map((x) => x.execId), ["6", "7"]);
    assert.equal(m.getGateTrace(g, sched), null);
    assert.ok(m.getGateTrace(g, a).nodeKeys.has(nodeKey(g, s1)));
    assert.ok(m.getGateTrace(g, a).linkKeys.size >= 1);
});

test("single lazy input (gate) guarantees nothing upstream", () => {
    const g = new MockGraph("r");
    const src = g.add(mk(1, { outputs: ["X"] }));
    const gate = g.add(
        mk(2, { inputs: [{ name: "value", type: "*" }], outputs: ["X"], nodeInput: { required: { value: ["*", { lazy: true }] } } })
    );
    const out = g.add(mk(3, { inputs: ["X"], output: true }));
    g.connect(src, 0, gate, 0);
    g.connect(gate, 0, out, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("1").conditional, true);
    assert.equal(m.nodes.get("2").conditional, false);
    assert.equal(m.getNodeInfo(g, gate).isSwitch, true);
    assert.deepEqual(m.getGateTrace(g, src).gates.map((x) => x.execId), ["2"]);
});

test("conditional node also reached by a strong path elsewhere is certain", () => {
    const g = new MockGraph("r");
    const src = g.add(mk(1, { outputs: ["X"] }));
    const other = g.add(mk(2, { outputs: ["X"] }));
    const sw = g.add(mkSwitch(3));
    const o1 = g.add(mk(4, { inputs: ["X"], output: true }));
    const o2 = g.add(mk(5, { inputs: ["X"], output: true }));
    g.connect(src, 0, sw, 0);
    g.connect(other, 0, sw, 1);
    g.connect(sw, 0, o1, 0);
    g.connect(src, 0, o2, 0);
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("1").conditional, false);
    assert.equal(m.nodes.get("2").conditional, true);
});

// ── Implicit links (Use Everywhere `graph.extra.ue_links`) ─────────────────

/** Loader -> UE node -> (implicit) sampler -> output; the sampler's model input is unlinked. */
function makeUeGraph() {
    const g = new MockGraph("r");
    const req = { required: { model: ["MODEL"] } };
    const ld = g.add(mk(1, { outputs: ["MODEL"] }));
    const ue = g.add(mk(2, { inputs: ["MODEL"] }));
    const ks = g.add(mk(3, { inputs: [{ name: "model", type: "MODEL" }], outputs: ["LATENT"], nodeInput: req }));
    const out = g.add(mk(4, { inputs: ["LATENT"], output: true }));
    const feed = g.connect(ld, 0, ue, 0);
    g.connect(ks, 0, out, 0);
    g.extra = {
        ue_links: [{ downstream: "3", downstream_slot: 0, upstream: "1", upstream_slot: 0, controller: "2", type: "MODEL" }],
    };
    return { g, ld, ue, ks, out, feed };
}

test("UE implicit link resolves the input; UE node becomes a hop with a ghost", () => {
    const { g, ue, ks, feed } = makeUeGraph();
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").invalid, false, "sampler fed by UE is valid");
    assert.equal(m.nodes.get("4").active, true);
    assert.equal(m.nodes.get("1").active, true);
    assert.equal(m.nodes.has("2"), false, "UE node is not a real node");
    assert.equal(m.getNodeInfo(g, ue).kind, "virtual");
    assert.equal(m.getNodeInfo(g, ue).active, true);
    const e = m.edges.find((x) => x.to === "3");
    assert.equal(e.from, "1");
    assert.ok(m.getLinkInfo(g, feed.id).active, "loader -> UE link is on the path");
    const ghosts = m.getVirtualSegments(g);
    assert.equal(ghosts.length, 1);
    assert.equal(ghosts[0].fromNode, ue);
    assert.equal(ghosts[0].toNode, ks);
    assert.equal(ghosts[0].toInput, 0);
    assert.ok(m.traceSelection(g, [ue]).nodeKeys.has(nodeKey(g, ks)));
});

test("without ue_links the sampler is invalid (baseline)", () => {
    const { g } = makeUeGraph();
    g.extra = {};
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").invalid, true);
    assert.equal(m.nodes.get("4").active, false);
    assert.equal(m.nodes.has("2"), true, "plain node again");
});

test("muted UE node or a real link override the implicit link", () => {
    const { g, ue, ld, ks } = makeUeGraph();
    ue.mode = 2;
    let m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").invalid, true, "muted broadcaster sends nothing");
    ue.mode = 0;
    const direct = g.connect(ld, 0, ks, 0);
    m = buildFlowModel(g);
    assert.equal(m.getVirtualSegments(g).length, 0, "real link wins");
    assert.ok(m.getLinkInfo(g, direct.id).active);
});

test("implicitLinks option replaces the default readers; signature tracks ue_links", () => {
    const { g } = makeUeGraph();
    const m = buildFlowModel(g, { implicitLinks: [] });
    assert.equal(m.nodes.get("3").invalid, true);
    const s1 = computeFlowSignature(g);
    g.extra.ue_links = [];
    assert.notEqual(computeFlowSignature(g), s1);
});

test("malformed ue_links entries are ignored", () => {
    const { g } = makeUeGraph();
    g.extra.ue_links = [null, { downstream: "3" }, { downstream: "3", downstream_slot: "x", upstream: "1", upstream_slot: 0 }, 5];
    const m = buildFlowModel(g);
    assert.equal(m.nodes.get("3").invalid, true);
});

console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
if (warnings.length) console.log(`warnings logged (once each):\n  ${warnings.join("\n  ")}`);
process.exit(failed ? 1 : 0);
