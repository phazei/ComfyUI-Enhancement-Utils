# Tests

Plain Node (no npm dependencies, no browser) tests for the pure JS modules.

```sh
node tests/flowGraph.test.mjs           # flow model, hand-built mock graphs
node tests/flowGraph.fixture.test.mjs   # flow model, real workflow fixture
node tests/graphArrange.test.mjs        # Arrange layouts (Quick / dagre / ELK)
```

Each script exits non-zero on failure.

## Files

- `workflowLoader.mjs` -- shared mock `LGraph` / `LGraphNode` classes (`MockGraph`, `MockNode`, `mk`, `mkContainer`; sets `globalThis.LGraphNode`) and `loadWorkflow(workflow, nodeDefs)`, which builds mock graphs from a serialized workflow (UI format 0.4, root + `definitions.subgraphs`). Node types without a definition are frontend-only and emulated: `Reroute` (virtual pass-through), KJNodes `SetNode` / `GetNode` (same-graph `getInputLink` + ancestor-graph `resolveVirtualOutput`), anything else (Note, PrimitiveNode, rgthree Bookmark...) is virtual and resolves nothing.
- `fixtures/h3_sampling_switches.json` -- a large real workflow: nested subgraphs, cross-graph Set/Get, bypassed / muted nodes and several lazy switches (LazySwitchKJ, Switch, ImpactSwitch, PromptStash, ExecutionGate).
- `fixtures/arrange_complicated.json` -- a large real workflow for checking Graph Arrange by hand (load it and run each layout): 138 nodes, 8 groups, 9 subgraphs, 59 collapsed Set/Get nodes whose 34 links all cross groups, groups feeding each other, and ungrouped nodes that loop back into one group (satellites). Not used by an automated test.
- `fixtures/h3_node_defs.json` -- node definitions for every type in that workflow, reduced to what the model reads (`output_node`, required / optional input names, `lazy` flag).
- `graphArrange.test.mjs` -- runs the three layouts in `js/graphArrangeLayout.js` with the vendored dagre / elkjs (`js/lib/`, loaded as globals) on mock graphs, groups and subgraph IO nodes (the mocks mirror LiteGraph's group min size, centre-point membership and `computeExecutionOrder` levels). Checks subgraph IO placement, unpinning, members staying in their groups (incl. unconnected ones and a nested group), empty groups keeping their size, left-to-right flow (incl. groups fed through ungrouped nodes: Settings -> Width -> /32 -> Models -> Sampler -> Output), groups feeding each other, groups joined only by Set/Get (mock KJ-style `getInputLink`) or Use Everywhere (`extra.ue_links`) ordered by those hidden links, `collectHiddenLinks` on its own (broken hooks ignored), and that a second arrange moves nothing. Flow order allows Advanced to wrap into rows (every row must still run with the flow); Advanced-only checks: a 12-group chain wraps to roughly 16:9 in LR and TB without overlaps, a standalone group lands below, and a TB chain inside a group is a straight column; groups sharing a step line up at its start. All layouts: a chain cut by a node outside its group (g -> c -> e -> [outside] -> st -> ap) stays in order inside the group via `collectBridgeLinks`, but not when the outside node is in another group; separate chains in a group follow the whole graph's flow (`computeFlowOrder`: a chain fed from earlier in the graph first, then the longer chain first, against node-list order); a satellite node (fed by a group and feeding it back) lands right of its group without overlaps (also in TB, level with the node feeding it), Smart puts a chain of differently sized groups on one edge (LR and TB) and likewise a chain of nodes, with and without groups, without overlapping a branch, two groups feeding each other are ordered by link count (3 links one way beat 1 back), and a collapsed node is laid out at its collapsed width.
- `flowGraph.fixture.test.mjs` -- expected values (real / active counts, switches, conditional nodes and their gates, certain spot checks) were taken from the live frontend running the same workflow.

## Regenerating node definitions

With ComfyUI running (only `GET /object_info` is requested):

```sh
node tests/captureNodeDefs.mjs tests/fixtures/h3_sampling_switches.json tests/fixtures/h3_node_defs.json [http://127.0.0.1:8188]
```

Types missing from `/object_info` are listed and left out (they are treated as frontend-only virtual nodes). A changed definition (e.g. a node pack adding or removing `lazy`) can legitimately change the expected values; re-check them against the live frontend.
