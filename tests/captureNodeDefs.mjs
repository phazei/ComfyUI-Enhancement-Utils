/**
 * Capture the node definitions a workflow fixture needs from a running
 * ComfyUI server, reduced to the fields `js/flowGraph.js` reads.
 *
 * Usage:
 *   node tests/captureNodeDefs.mjs <workflow.json> <out.json> [serverUrl]
 *
 * `serverUrl` defaults to http://127.0.0.1:8188. Only GET /object_info is
 * requested (read-only). Every node type used in the workflow -- root graph
 * plus all subgraph definitions -- is looked up; subgraph container types
 * (whose type is a subgraph id) are skipped, and types the server does not
 * know (frontend-only nodes: Reroute, SetNode, GetNode, Note, rgthree virtual
 * nodes...) are simply absent from the output.
 *
 * Per type the output keeps `output_node` and `input.required` /
 * `input.optional`, each input spec reduced to `[typeOrNull, {lazy: true}]`
 * when lazy, else `[typeOrNull]` (combo lists become null).
 */

import { readFile, writeFile } from "node:fs/promises";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Collect every node type used in a serialized workflow (root + subgraphs),
 * excluding subgraph container types.
 *
 * @param {Object} workflow - Serialized workflow JSON.
 * @returns {Array<string>} Sorted unique node types.
 */
function collectTypes(workflow) {
    const subgraphs = workflow?.definitions?.subgraphs || [];
    const subgraphIds = new Set(subgraphs.map((s) => s.id));
    const types = new Set();
    for (const list of [workflow?.nodes || [], ...subgraphs.map((s) => s.nodes || [])]) {
        for (const node of list) {
            if (node?.type && !subgraphIds.has(node.type)) types.add(node.type);
        }
    }
    return [...types].sort();
}

/**
 * Reduce one input-spec section (`required` / `optional`) to what the model uses.
 *
 * @param {Object|undefined} section - Section from object_info.
 * @returns {Object} name -> `[typeOrNull]` or `[typeOrNull, {lazy: true}]`.
 */
function reduceSection(section) {
    const out = {};
    for (const [name, spec] of Object.entries(section || {})) {
        const type = Array.isArray(spec) && typeof spec[0] === "string" ? spec[0] : null;
        out[name] = Array.isArray(spec) && spec[1]?.lazy ? [type, { lazy: true }] : [type];
    }
    return out;
}

/**
 * Reduce a full object_info entry.
 *
 * @param {Object} info - object_info entry for one node type.
 * @returns {Object} `{ output_node, input: { required, optional } }`.
 */
function reduceDef(info) {
    return {
        output_node: info?.output_node === true,
        input: {
            required: reduceSection(info?.input?.required),
            optional: reduceSection(info?.input?.optional),
        },
    };
}

// ── Main ──────────────────────────────────────────────────────────────────

const [workflowPath, outPath, serverUrl = "http://127.0.0.1:8188"] = process.argv.slice(2);
if (!workflowPath || !outPath) {
    console.error("usage: node tests/captureNodeDefs.mjs <workflow.json> <out.json> [serverUrl]");
    process.exit(2);
}

const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
const types = collectTypes(workflow);
const response = await fetch(`${serverUrl.replace(/\/$/, "")}/object_info`);
if (!response.ok) {
    console.error(`GET /object_info failed: ${response.status} ${response.statusText}`);
    process.exit(1);
}
const objectInfo = await response.json();

const defs = {};
const missing = [];
for (const type of types) {
    if (objectInfo[type]) defs[type] = reduceDef(objectInfo[type]);
    else missing.push(type);
}
// One type per line: compact but still diffable.
const lines = Object.entries(defs).map(([type, def]) => `  ${JSON.stringify(type)}: ${JSON.stringify(def)}`);
await writeFile(outPath, `{\n${lines.join(",\n")}\n}\n`, "utf8");
console.log(`${Object.keys(defs).length} definitions written to ${outPath}`);
console.log(`not in object_info (frontend-only): ${missing.join(", ") || "none"}`);
