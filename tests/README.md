# Tests

Plain Node (no npm dependencies, no browser) tests for `js/flowGraph.js`.

```sh
node tests/flowGraph.test.mjs           # unit tests on hand-built mock graphs
node tests/flowGraph.fixture.test.mjs   # real workflow fixture
```

Each script exits non-zero on failure.

## Files

- `workflowLoader.mjs` -- shared mock `LGraph` / `LGraphNode` classes (`MockGraph`, `MockNode`, `mk`, `mkContainer`; sets `globalThis.LGraphNode`) and `loadWorkflow(workflow, nodeDefs)`, which builds mock graphs from a serialized workflow (UI format 0.4, root + `definitions.subgraphs`). Node types without a definition are frontend-only and emulated: `Reroute` (virtual pass-through), KJNodes `SetNode` / `GetNode` (same-graph `getInputLink` + ancestor-graph `resolveVirtualOutput`), anything else (Note, PrimitiveNode, rgthree Bookmark...) is virtual and resolves nothing.
- `fixtures/h3_sampling_switches.json` -- a large real workflow: nested subgraphs, cross-graph Set/Get, bypassed / muted nodes and several lazy switches (LazySwitchKJ, Switch, ImpactSwitch, PromptStash, ExecutionGate).
- `fixtures/h3_node_defs.json` -- node definitions for every type in that workflow, reduced to what the model reads (`output_node`, required / optional input names, `lazy` flag).
- `flowGraph.fixture.test.mjs` -- expected values (real / active counts, switches, conditional nodes and their gates, certain spot checks) were taken from the live frontend running the same workflow.

## Regenerating node definitions

With ComfyUI running (only `GET /object_info` is requested):

```sh
node tests/captureNodeDefs.mjs tests/fixtures/h3_sampling_switches.json tests/fixtures/h3_node_defs.json [http://127.0.0.1:8188]
```

Types missing from `/object_info` are listed and left out (they are treated as frontend-only virtual nodes). A changed definition (e.g. a node pack adding or removing `lazy`) can legitimately change the expected values; re-check them against the live frontend.
