/**
 * Fixture-driven tests for js/flowGraph.js: loads a large real workflow
 * (`fixtures/h3_sampling_switches.json`) with captured node definitions
 * (`fixtures/h3_node_defs.json`) into mock graphs and checks the model
 * against values observed in a live browser run of the real frontend.
 *
 * Run: node tests/flowGraph.fixture.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadWorkflow } from "./workflowLoader.mjs";

const MODULE = new URL("../js/flowGraph.js", import.meta.url);
const WORKFLOW = new URL("./fixtures/h3_sampling_switches.json", import.meta.url);
const NODE_DEFS = new URL("./fixtures/h3_node_defs.json", import.meta.url);

const { buildFlowModel } = await import(MODULE.href);

// ── Test Runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const origWarn = console.warn;
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(" "));

/**
 * Run one named test, recording pass / fail.
 *
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (throws on failure).
 * @returns {void}
 */
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

// ── Fixture ───────────────────────────────────────────────────────────────

const workflow = JSON.parse(readFileSync(WORKFLOW, "utf8"));
const nodeDefs = JSON.parse(readFileSync(NODE_DEFS, "utf8"));
const { root, subgraphs, virtualTypes } = loadWorkflow(workflow, nodeDefs);
const allGraphs = [root, ...subgraphs.values()];

buildFlowModel(root); // warm-up
const t0 = performance.now();
const model = buildFlowModel(root);
const buildMs = performance.now() - t0;
const flowNodes = [...model.nodes.values()];
console.log(
    `  h3: build ${buildMs.toFixed(2)} ms, ${model.nodes.size} real nodes, ${model.edges.length} edges, ` +
        `maxDepth ${model.maxDepth}; emulated virtual types: ${[...virtualTypes].sort().join(", ")}`
);

/**
 * Look up a flow node by exec id, failing the test when absent.
 *
 * @param {string} execId - Execution id.
 * @returns {Object} FlowNode.
 */
function flowNode(execId) {
    const n = model.nodes.get(execId);
    assert.ok(n, `no real node ${execId}`);
    return n;
}

// ── Expected Values (from the live frontend) ──────────────────────────────

const EXPECTED_SWITCHES = [
    "6815",
    "7058:790",
    "7058:791",
    "6771",
    "6732:6625",
    "6732:7002",
    "6732:7139",
    "6840:7161",
    "6840:7177",
];

/** Conditional exec id -> gate exec ids (getGateTrace(...).gates). */
const EXPECTED_GATES = {
    6725: ["6771"],
    6730: ["6771"],
    6727: ["6771"],
    6733: ["6771"],
    7009: ["6771"],
    6937: ["6771"],
    "6732:6620": ["6771"],
    "6732:6621": ["6732:6625"],
    "6732:6622": ["6732:6625"],
    "6732:6623": ["6732:6625"],
    "6732:6624": ["6732:6625"],
    "6732:6625": ["6771"],
    "6732:7002": ["6771"],
    "6732:6986": ["6771"],
    "6732:6987": ["6771"],
    "6732:6985:6964": ["6771"],
    "6732:6985:6965": ["6771"],
    "6732:6985:6966": ["6771"],
    "6732:6546": ["6771"],
    "6732:7140": ["6771"],
    "6732:7165": ["6771"],
    "6732:7166": ["6771"],
    "6732:7124": ["6732:7139"],
    "6732:7135": ["6732:7139"],
    "6840:126": ["6840:7161", "6840:7177"],
    "6840:6808": ["6840:7161"],
    "6840:129": ["6840:7161", "6840:7177"],
    "6840:123": ["6840:7177"],
    "6840:7060": ["6840:7161"],
    "6840:7157": ["6840:7161"],
    "6840:7161": ["6840:7177"],
    "6840:7186": ["6840:7177"],
};

/** Certain (active, not conditional) spot checks: exec id -> node type. */
const EXPECTED_CERTAIN = {
    "6840:124": "BasicScheduler",
    "6840:6879": "Any Switch (rgthree)",
    "6840:7177": "LazySwitchKJ",
    7071: "VHS_VideoCombine",
};

// ── Tests ─────────────────────────────────────────────────────────────────

test("loader: links are real, containers' bogus getInputLink unused", () => {
    for (const e of model.edges) {
        for (const seg of e.segments) {
            if (seg.type !== "link") continue;
            assert.ok(seg.graph.getLink(seg.linkId), `edge ${e.from} -> ${e.to} uses missing link ${seg.linkId}`);
        }
    }
});

test("loader: Set/Get resolved both same-graph (ghost) and cross-graph", () => {
    const ghosts = allGraphs.reduce((sum, g) => sum + model.getVirtualSegments(g).length, 0);
    assert.ok(ghosts > 0, "expected same-graph ghost segments");
    let crossGraph = 0;
    for (const g of allGraphs) {
        for (const n of g._nodes) {
            if (n.type === "GetNode" && n.resolveVirtualOutput(0)) crossGraph++;
        }
    }
    assert.ok(crossGraph > 0, "expected cross-graph getters");
});

test("h3: 107 real nodes, 88 active", () => {
    assert.equal(model.nodes.size, 107);
    assert.equal(flowNodes.filter((n) => n.active).length, 88);
    assert.equal(model.noOutputs, false);
});

test("h3: switch nodes", () => {
    const switches = flowNodes.filter((n) => n.isSwitch).map((n) => n.execId);
    assert.deepEqual(switches.sort(), [...EXPECTED_SWITCHES].sort());
});

test("h3: conditional nodes", () => {
    const conditional = flowNodes.filter((n) => n.conditional).map((n) => n.execId);
    assert.deepEqual(conditional.sort(), Object.keys(EXPECTED_GATES).sort());
});

test("h3: gate traces of conditional nodes", () => {
    for (const [execId, gates] of Object.entries(EXPECTED_GATES)) {
        const n = flowNode(execId);
        const trace = model.getGateTrace(n.graph, n.node);
        assert.ok(trace, `no gate trace for ${execId}`);
        assert.deepEqual(
            trace.gates.map((g) => g.execId),
            gates,
            `gates of ${execId} (${n.node.type})`
        );
    }
});

test("h3: certain spot checks", () => {
    for (const [execId, type] of Object.entries(EXPECTED_CERTAIN)) {
        const n = flowNode(execId);
        assert.equal(n.node.type, type, `type of ${execId}`);
        const info = model.getNodeInfo(n.graph, n.node);
        assert.equal(info.active, true, `${execId} active`);
        assert.equal(info.conditional, false, `${execId} not conditional`);
        assert.equal(info.certain, true, `${execId} certain`);
        assert.equal(model.getGateTrace(n.graph, n.node), null, `${execId} has no gates`);
    }
});

test("h3: rebuild is deterministic", () => {
    const again = buildFlowModel(root);
    const summary = (m) =>
        [...m.nodes.values()].map((n) => `${n.execId}:${n.depth}:${n.active}:${n.conditional}:${n.isSwitch}`).join();
    assert.equal(summary(again), summary(model));
    assert.equal(again.edges.length, model.edges.length);
});

console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
if (warnings.length) console.log(`warnings logged (once each):\n  ${warnings.join("\n  ")}`);
process.exit(failed ? 1 : 0);
