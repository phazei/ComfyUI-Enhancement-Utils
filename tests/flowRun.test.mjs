// Tests for js/flowRun.js (last-run view + replay timeline) on mock graphs.
// Run: node tests/flowRun.test.mjs
import assert from "node:assert/strict";

import { MockGraph, mk } from "./workflowLoader.mjs";

const { buildFlowModel, linkKey } = await import(new URL("../js/flowGraph.js", import.meta.url).href);
const {
    normalizeRun, createLiveRun, applyNodeState, computeRunView, nodeChangedSinceRun, nodeChangeReason, nodeChangeReasons, describeValueChange, isPromptLink,
    buildReplayTimeline, replayEventAt, replayStatusAt, aggregateStatus, replaySteps, replayStepAt, replayStepTarget, replayBrackets,
} = await import(new URL("../js/flowRun.js", import.meta.url).href);

// ── Test runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

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

// ── Fixture ──────────────────────────────────────────────────────────────

/**
 * Loader(1) -> Proc(2) -> Save(3); Loader(1) -> Save2(4) (an output the run
 * never reached). Loader has a "ckpt" widget, Proc a seed with a control widget.
 */
function fixture() {
    const g = new MockGraph("root");
    const loader = g.add(mk(1, { type: "Loader", outputs: ["X"] }));
    loader.widgets = [{ name: "ckpt", value: "a.safetensors" }];
    const proc = g.add(mk(2, { type: "Proc", inputs: ["X"], outputs: ["X"] }));
    proc.widgets = [{ name: "seed", value: 5, linkedWidgets: [{ name: "control_after_generate", value: "randomize" }] }];
    const save = g.add(mk(3, { type: "Save", inputs: ["X"], output: true }));
    const save2 = g.add(mk(4, { type: "Save2", inputs: ["X"], output: true }));
    const l1 = g.connect(loader, 0, proc, 0);
    const l2 = g.connect(proc, 0, save, 0);
    const l3 = g.connect(loader, 0, save2, 0);
    return { g, loader, proc, save, save2, l1, l2, l3 };
}

/** Backend JSON for a successful run of the fixture. */
function rawRun(overrides = {}) {
    return {
        prompt_id: "p1",
        workflow_id: "wf",
        status: "success",
        error_node: null,
        total: 3,
        nodes: {
            1: { state: "cached", display: "1", start: 0.01, end: 0.01, order: 0, time: 0 },
            2: { state: "ran", display: "2", start: 0.02, end: 2.02, order: 1, time: 2 },
            3: { state: "ran", display: "3", start: 2.03, end: 2.53, order: 2, time: 0.5 },
        },
        prompt: {
            1: { class_type: "Loader", inputs: { ckpt: "a.safetensors" } },
            2: { class_type: "Proc", inputs: { in0: ["1", 0], seed: 4 } },
            3: { class_type: "Save", inputs: { in0: ["2", 0] } },
            4: { class_type: "Save2", inputs: { in0: ["1", 0] } },
        },
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────

test("normalizeRun: none -> null, records and prompt parsed", () => {
    assert.equal(normalizeRun({ status: "none" }), null);
    assert.equal(normalizeRun(null), null);
    const run = normalizeRun(rawRun());
    assert.equal(run.promptId, "p1");
    assert.equal(run.workflowId, "wf");
    assert.equal(run.nodes.get("2").state, "ran");
    assert.equal(run.nodes.get("2").time, 2);
    assert.equal(run.prompt.get("4").class_type, "Save2");
});

test("run view: cached / ran / skipped", () => {
    const { g } = fixture();
    const view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.foreign, false);
    assert.equal(view.finished, true);
    assert.deepEqual(Object.fromEntries(view.statuses), { 1: "cached", 2: "ran", 3: "ran", 4: "skipped" });
    assert.deepEqual(view.counts, { cached: 1, ran: 2, skipped: 1 });
});

test("run view: seed with a control widget is not a change", () => {
    const { g } = fixture();
    const view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("2"), "ran"); // seed 5 vs queued 4 ignored
});

test("run view: widget, link, class and new-node changes", () => {
    const { g, loader, proc, save2 } = fixture();
    loader.widgets[0].value = "b.safetensors";
    let view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("1"), "changed");
    assert.equal(view.statuses.get("2"), "ran");

    loader.widgets[0].value = "a.safetensors";
    g.connect(proc, 0, save2, 0); // re-wired: Save2 now fed by Proc
    view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("4"), "changed");

    const extra = g.add(mk(9, { type: "New", inputs: ["X"], output: true }));
    g.connect(proc, 0, extra, 0);
    view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("9"), "changed");

    const raw = rawRun();
    raw.prompt[3].class_type = "Other";
    view = computeRunView(normalizeRun(raw), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("3"), "changed");
});

test("nodeChangedSinceRun: disconnected input, primitive value where model sees a link", () => {
    const { g } = fixture();
    const m = buildFlowModel(g);
    const save = m.nodes.get("3");
    assert.equal(nodeChangedSinceRun(save, { class_type: "Save", inputs: { in0: ["2", 0] } }), false);
    assert.equal(nodeChangedSinceRun(save, { class_type: "Save", inputs: { in0: ["1", 0] } }), true);
    assert.equal(nodeChangedSinceRun(save, { class_type: "Save", inputs: {} }), true);
    assert.equal(nodeChangedSinceRun(save, { class_type: "Save", inputs: { in0: 7 } }), false);
    assert.equal(nodeChangedSinceRun(save, undefined), true);
});

test("change reasons; own serializeValue and dynamic prompts ignored", () => {
    const { g, loader } = fixture();
    const m = buildFlowModel(g);
    const fnode = m.nodes.get("1");
    assert.equal(nodeChangeReason(fnode, { class_type: "Loader", inputs: { ckpt: "a.safetensors" } }), null);
    loader.widgets[0].value = "b.safetensors";
    assert.equal(nodeChangeReason(fnode, { class_type: "Loader", inputs: { ckpt: "a.safetensors" } }),
        'ckpt "a.safetensors" → "b.safetensors"');
    loader.widgets[0].serializeValue = () => "rewritten";
    assert.equal(nodeChangeReason(fnode, { class_type: "Loader", inputs: { ckpt: "a.safetensors" } }), null);
    delete loader.widgets[0].serializeValue;
    loader.widgets[0].value = "a {cat|dog}";
    loader.widgets[0].dynamicPrompts = true;
    assert.equal(nodeChangeReason(fnode, { class_type: "Loader", inputs: { ckpt: "a dog" } }), null);
    assert.equal(nodeChangeReason(fnode, undefined), "new node (not in the run)");
    assert.match(nodeChangeReason(fnode, { class_type: "Other", inputs: {} }), /node type changed/);
    const view = computeRunView(normalizeRun(rawRun()), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.details.get("2").time, 2);
});

test("all reasons listed; list-valued widget is not a link", () => {
    const { g, proc } = fixture();
    proc.widgets.push({ name: "cfg", value: 8 }, { name: "boxes", value: [[1, 2], [3, 4]] });
    proc.inputs.push({ name: "boxes", type: "BOUNDING_BOXES", link: null });
    const m = buildFlowModel(g);
    const entry = { class_type: "Proc", inputs: { in0: ["1", 0], seed: 5, cfg: 7, boxes: [[1, 2], [3, 4]] } };
    proc.widgets[0].linkedWidgets = undefined;
    proc.widgets[0].value = 9;
    const reasons = nodeChangeReasons(m.nodes.get("2"), entry);
    assert.deepEqual(reasons, ["seed 5 → 9", "cfg 7 → 8"]);
    // A 2-element box list [[..],[..]] is not a link: no "disconnected".
    entry.inputs.boxes = { __value__: [[0, 0], [9, 9]] }; // as graphToPrompt wraps arrays
    entry.inputs.seed = 9;
    entry.inputs.cfg = 8;
    assert.deepEqual(nodeChangeReasons(m.nodes.get("2"), entry), ["boxes[0][0]: 0 → 1", "boxes[0][1]: 0 → 2", "boxes[1][0]: 9 → 3 (+1 more)"]);
    assert.equal(isPromptLink([[1, 2], [3, 4]]), false);
    assert.equal(isPromptLink(["5", 0]), true);
});

test("describeValueChange: excerpts around each differing spot", () => {
    const before = "A very long prompt about a cat sitting on a red mat in the warm afternoon sun, highly detailed, sharp focus";
    const after = "A very long prompt about a dog sitting on a red mat in the warm afternoon sun, highly detailed, soft focus";
    const lines = describeValueChange("text", before, after);
    assert.equal(lines.length, 2, lines.join(" | "));
    assert.match(lines[0], /«cat» → «dog»/);
    assert.match(lines[1], /«sharp» → «soft» focus/);
    // JSON text: changed paths, not the middle of the string.
    const ja = JSON.stringify({ a: 1, list: [{ x: 1, y: 2 }, { x: 3, y: 4 }], name: "something long enough to clip" });
    const jb = JSON.stringify({ a: 1, list: [{ x: 1, y: 2 }, { x: 3, y: 5 }], name: "something long enough to clip" });
    assert.deepEqual(describeValueChange("json", ja, jb), ["json.list[1].y: 4 → 5"]);
    // Short values whole.
    assert.deepEqual(describeValueChange("steps", 20, 33), ["steps 20 → 33"]);
});

test("run view: another workflow (by id, and by node match without id)", () => {
    const { g } = fixture();
    const m = buildFlowModel(g);
    assert.equal(computeRunView(normalizeRun(rawRun()), m, { workflowId: "other" }).foreign, true);
    const raw = rawRun({ workflow_id: "" });
    assert.equal(computeRunView(normalizeRun(raw), m, { workflowId: "x" }).foreign, false);
    raw.prompt = { 1: { class_type: "A" }, 2: { class_type: "B" }, 3: { class_type: "C" }, 4: { class_type: "D" } };
    assert.equal(computeRunView(normalizeRun(raw), m, { workflowId: "x" }).foreign, true);
});

test("run view: error run -> not_reached; running records become not_reached", () => {
    const { g } = fixture();
    const raw = rawRun({ status: "error" });
    raw.nodes[3] = { state: "running", display: "3", start: 2.03, end: null, order: null };
    const view = computeRunView(normalizeRun(raw), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("3"), "not_reached");
    assert.equal(view.statuses.get("4"), "not_reached");
});

test("live run: pending until reached, running, ignores other prompts", () => {
    const { g } = fixture();
    const m = buildFlowModel(g);
    const run = createLiveRun("p9");
    assert.equal(applyNodeState(run, { prompt_id: "other", node: "1", state: "ran" }), false);
    assert.equal(applyNodeState(run, { prompt_id: "p9", node: "1", state: "cached", start: 0, end: 0 }), true);
    applyNodeState(run, { prompt_id: "p9", node: "2", state: "running", start: 0.1 });
    const view = computeRunView(run, m, {});
    assert.equal(view.finished, false);
    assert.deepEqual(Object.fromEntries(view.statuses), { 1: "cached", 2: "running", 3: "pending", 4: "pending" });
});

test("node expansion: records map to their display node; error wins", () => {
    const { g } = fixture();
    const raw = rawRun();
    raw.nodes["2.0.0.1"] = { state: "error", display: "2", start: 1, end: 1.5, order: 5 };
    const view = computeRunView(normalizeRun(raw), buildFlowModel(g), { workflowId: "wf" });
    assert.equal(view.statuses.get("2"), "error");
    assert.equal(aggregateStatus(["skipped", "cached", "ran"]), "ran");
    assert.equal(aggregateStatus([null, "pending"]), "pending");
});

test("replay timeline: real order, segments of reached sources, compression", () => {
    const { g, l1, l2 } = fixture();
    const m = buildFlowModel(g);
    const run = normalizeRun(rawRun());
    const tl = buildReplayTimeline(run, m, { maxDuration: 100 });
    assert.deepEqual(tl.events.map((e) => e.execId), ["1", "2", "3"]);
    const [e1, e2, e3] = tl.events;
    assert.equal(e1.status, "cached");
    assert.equal(e1.segs.length, 0);
    assert.equal(e1.t1, e1.t0); // no travel for cached
    assert.deepEqual(e2.segs.map((s) => [s.kind, s.key, s.f0, s.f1]), [["link", linkKey(g, l1.id), 0, 1]]);
    assert.deepEqual(e3.segs.map((s) => s.key), [linkKey(g, l2.id)]);
    assert.ok(e2.t2 - e2.t1 > e3.t2 - e3.t1, "longer real time -> longer work phase");
    assert.ok(Math.abs(tl.duration - e3.t2) < 1e-9);

    // Cached beat: [0, 0.5); every other node holds >= 0.5 s after a 0.25 s travel.
    assert.equal(tl.cachedCount, 1);
    assert.equal(e1.t2, 0.5);
    assert.equal(e2.t0, 0.5);
    for (const e of [e2, e3]) assert.ok(e.t2 - e.t1 >= 0.5 - 1e-9 && Math.abs(e.t1 - e.t0 - 0.25) < 1e-9);
    // Log scale: 2 s -> 0.8*log10(21) extra, 0.5 s -> 0.8*log10(6).
    assert.ok(Math.abs(e2.t2 - e2.t1 - (0.5 + 0.8 * Math.log10(21))) < 1e-9);
    // Compression shrinks only the extra; floors stay (0.5 beat + 2 * (0.25 + 0.5)).
    const short = buildReplayTimeline(run, m, { maxDuration: 1 });
    assert.ok(Math.abs(short.duration - 2) < 1e-9, `floors kept, got ${short.duration}`);
    const custom = buildReplayTimeline(run, m, { maxDuration: 1, minNodeMs: 200 });
    assert.ok(Math.abs(custom.duration - (0.2 + 2 * 0.45)) < 1e-9, `min per node setting, got ${custom.duration}`);
    // Trivial node: barely any extra.
    const quick = normalizeRun(rawRun());
    quick.nodes.get("3").time = 0.01;
    const q3 = buildReplayTimeline(quick, m, { maxDuration: 100 }).byId.get("3");
    assert.ok(q3.t2 - q3.t1 < 0.54);

    // Lookup helpers.
    assert.equal(replayEventAt(tl, -1), -1);
    assert.equal(replayEventAt(tl, e2.t0 + 1e-6), 1);
    assert.equal(replayEventAt(tl, tl.duration + 1), -1);
    const view = computeRunView(run, m, { workflowId: "wf" });
    assert.equal(replayStatusAt(tl, view.statuses, "3", 0), "pending");
    assert.equal(replayStatusAt(tl, view.statuses, "3", e3.t1), "running");
    assert.equal(replayStatusAt(tl, view.statuses, "3", tl.duration), "ran");
    assert.equal(replayStatusAt(tl, view.statuses, "4", 0), "skipped");
});

test("replay timeline: edge from a never-reached source gets no pulse", () => {
    const g = new MockGraph("root");
    const a = g.add(mk(1, { type: "A", outputs: ["X"] }));
    const b = g.add(mk(2, { type: "B", outputs: ["X"] }));
    const sw = g.add(mk(3, {
        type: "Switch", inputs: ["X", "X"], output: true,
        nodeInput: { required: { in0: ["X", { lazy: true }], in1: ["X", { lazy: true }] } },
    }));
    const la = g.connect(a, 0, sw, 0);
    g.connect(b, 0, sw, 1);
    const run = normalizeRun({
        status: "success", prompt_id: "p",
        nodes: {
            1: { state: "ran", start: 0, end: 1, order: 0, time: 1 },
            3: { state: "ran", start: 1, end: 1.1, order: 1, time: 0.1 },
        },
    });
    const tl = buildReplayTimeline(run, buildFlowModel(g));
    assert.deepEqual(tl.byId.get("3").segs.map((s) => s.key), [linkKey(g, la.id)]);
    assert.equal(tl.byId.has("2"), false);
});

test("replay steps: cached share one step; step at / stepping targets", () => {
    const ev = (execId, status, t0, t1, t2) => ({ execId, status, t0, t1, t2 });
    const timeline = {
        events: [ev("1", "cached", 0, 0, 0.5), ev("4", "cached", 0, 0, 0.5), ev("2", "ran", 0.5, 0.75, 1.25), ev("3", "error", 1.25, 1.5, 2)],
        duration: 2,
    };
    const steps = replaySteps(timeline);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps[0].events.map((e) => e.execId), ["1", "4"]);
    assert.equal(steps[2].status, "error");
    assert.equal(replayStepAt(steps, 0), 0);
    assert.equal(replayStepAt(steps, 0.6), 1);
    assert.equal(replayStepAt(steps, 2), -1);
    // forward: from step 0 onto the cached beat (just after 0), next hold start, then the end
    assert.equal(replayStepTarget(steps, 2, 0, 1), 0.002);
    assert.equal(replayStepTarget(steps, 2, 0.002, 1), 0.75);
    assert.equal(replayStepTarget(steps, 2, 0.75, 1), 1.5);
    assert.equal(replayStepTarget(steps, 2, 1.5, 1), 2);
    // backward: inside a hold -> its own start; at a start -> previous; first -> 0
    assert.equal(replayStepTarget(steps, 2, 1.9, -1), 1.5);
    assert.equal(replayStepTarget(steps, 2, 1.5, -1), 0.75);
    assert.equal(replayStepTarget(steps, 2, 0.75, -1), 0.002);
    assert.equal(replayStepTarget(steps, 2, 0.002, -1), 0);
    assert.equal(replayStepTarget(steps, 2, 0, -1), 0);
    assert.equal(replaySteps(null).length, 0);
});

test("replay brackets: consecutive steps per subgraph, per level, interleaving splits", () => {
    const ev = (execId, status, t0, t2) => ({ execId, status, t0, t1: t0, t2 });
    const steps = replaySteps({ events: [
        ev("1", "cached", 0, 1), ev("5:2", "cached", 0, 1),
        ev("5:3", "ran", 1, 2), ev("5:7:1", "ran", 2, 3), ev("5:7:2", "ran", 3, 4),
        ev("9", "ran", 4, 5), ev("5:4", "ran", 5, 6), ev("8:1", "ran", 6, 7),
    ] });
    const b = replayBrackets(steps).map((x) => `${x.level}:${x.execId}:${x.t0}-${x.t2}`);
    assert.deepEqual(b, ["1:5:1-4", "1:5:5-6", "1:8:6-7", "2:5:7:2-4"]);
    assert.equal(replayBrackets(steps, 1).length, 3);
    assert.deepEqual(replayBrackets(null), []);
});

test("malformed input never throws", () => {
    const { g } = fixture();
    const m = buildFlowModel(g);
    const run = normalizeRun({ status: "success", nodes: { 1: null, 2: "x", 3: { state: 5 } }, prompt: "nope" });
    assert.doesNotThrow(() => computeRunView(run, m, {}));
    assert.doesNotThrow(() => buildReplayTimeline(run, m));
    assert.equal(computeRunView(null, m).statuses.size, 0);
    assert.equal(buildReplayTimeline(run, null).events.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
