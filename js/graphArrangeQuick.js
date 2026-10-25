/**
 * Graph Arrange -- Quick layout: right-aligned columns with barycenter sorting.
 */

import { MARGIN, TITLE_HEIGHT, getSettings, sizeOf, partitionNodes, layoutDisconnectedNodes, getGraphBottom, positionSubgraphIO } from "./graphArrangeShared.js";
import { collectHiddenLinks, collectBridgeLinks, computeFlowOrder, chainRanks, rankBlocks } from "./graphArrangeFlow.js";
import { resolveGroups, layoutGroupContents, getLayoutBottom, placeGroup, buildTopLevelEdges, findSatellites } from "./graphArrangeGroups.js";

// ═══════════════════════════════════════════════════════════════════════════
// Float Right Algorithm
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Core float-right layout on a set of nodes using a specific graph's links.
 * Positions nodes in right-aligned columns with barycenter sorting.
 *
 * Columns come from `rankBlocks` over the nodes (longest path, feeders pulled
 * next to their nearest consumer) using drawn and hidden links; the start
 * order within a column is the graph's execution order.
 *
 * @param {Array} nodes - Connected nodes to layout.
 * @param {Object} graph - Graph instance (for links and computeExecutionOrder).
 * @param {Set} [nodeIdFilter] - Only consider nodes in this set.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - Hidden links (`collectHiddenLinks`).
 * @param {Map<string, {from: number, to: number}>} [flow] - `computeFlowOrder`, orders separate chains.
 */
function floatRightLayout(nodes, graph, nodeIdFilter = null, hidden = [], flow = null) {
    const filter = nodeIdFilter || new Set(nodes.map((n) => n.id));

    const execOrder = graph.computeExecutionOrder(false, true) || [];
    const ordered = execOrder.filter((n) => filter.has(n.id));
    // Nodes the execution order left out (loops) go last, in list order.
    const inOrder = new Set(ordered);
    for (const node of nodes) if (filter.has(node.id) && !inOrder.has(node)) ordered.push(node);
    if (ordered.length === 0) return;

    const edges = [];
    const addEdge = (link) => {
        if (link && filter.has(link.origin_id) && filter.has(link.target_id)) {
            edges.push({ srcTopId: String(link.origin_id), tgtTopId: String(link.target_id) });
        }
    };
    for (const link of Object.values(graph.links || {})) addEdge(link);
    for (const link of hidden) addEdge(link);
    const { level } = rankBlocks(ordered.map((n) => String(n.id)), edges);

    // Bucket into columns.
    const columns = [];
    for (const node of ordered) {
        const col = level.get(String(node.id)) ?? 0;
        if (!columns[col]) columns[col] = [];
        columns[col].push(node);
    }
    // Start order inside a column: separate chains by their place in the
    // whole graph (`chainRanks`), execution order within a chain (stable
    // sort); barycenter sweeps refine it below.
    if (flow) {
        const rank = chainRanks(ordered, flow, graph, hidden);
        for (const column of columns) column?.sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
    }

    const titleH = TITLE_HEIGHT();

    // First pass: position in columns.
    let xOffset = MARGIN;
    for (const column of columns) {
        if (!column) continue;
        let maxW = 100, yOff = MARGIN + titleH;
        for (const node of column) {
            node.pos = [xOffset, yOff];
            maxW = Math.max(maxW, sizeOf(node)[0]);
            yOff += sizeOf(node)[1] + MARGIN + titleH;
        }
        for (const node of column) node.pos = [node.pos[0] + maxW - sizeOf(node)[0], node.pos[1]];
        xOffset += maxW + MARGIN;
    }

    // Barycenter sorting (2 sweeps forward/backward).
    for (let sweep = 0; sweep < 2; sweep++) {
        const order = sweep % 2 === 0 ? columns.keys() : [...columns.keys()].reverse();
        for (const colIdx of order) {
            const column = columns[colIdx];
            if (!column || column.length <= 1) continue;

            for (const node of column) {
                const ys = [];
                for (const inp of node.inputs || []) {
                    if (inp.link == null) continue;
                    const li = graph.links[inp.link];
                    // Only nodes being laid out here: anything else still sits
                    // where it was, which made re-runs reorder the column.
                    if (li) { const nb = graph.getNodeById(li.origin_id); if (nb && filter.has(nb.id)) ys.push(nb.pos[1]); }
                }
                for (const out of node.outputs || []) {
                    for (const lid of out.links || []) {
                        const li = graph.links[lid];
                        if (li) { const nb = graph.getNodeById(li.target_id); if (nb && filter.has(nb.id)) ys.push(nb.pos[1]); }
                    }
                }
                node._barycenter = ys.length > 0
                    ? ys.reduce((a, b) => a + b, 0) / ys.length : node.pos[1];
            }
            column.sort((a, b) => a._barycenter - b._barycenter);
        }
    }

    // Final positioning after reorder.
    xOffset = MARGIN;
    for (const column of columns) {
        if (!column) continue;
        let maxW = 100;
        for (const node of column) maxW = Math.max(maxW, sizeOf(node)[0]);
        let yOff = MARGIN + titleH;
        for (const node of column) {
            node.pos = [xOffset + maxW - sizeOf(node)[0], yOff];
            yOff += sizeOf(node)[1] + MARGIN + titleH;
        }
        xOffset += maxW + MARGIN;
    }

    // Cleanup.
    for (const node of ordered) delete node._barycenter;
}

/**
 * Arrange all nodes using float-right (ignores groups).
 */
export function arrangeFloatRight(graph) {
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const { connected, disconnected } = partitionNodes(allNodes);
    if (connected.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
    } else {
        const hidden = collectHiddenLinks(graph);
        floatRightLayout(connected, graph, null, hidden, computeFlowOrder(graph, hidden));
        layoutDisconnectedNodes(disconnected, getGraphBottom(connected));
    }
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

/**
 * Arrange nodes using float-right respecting group boundaries.
 *
 * Phase 1: Float-right layout within each group.
 * Phase 2: Assign groups to columns based on inter-group edges, position groups.
 * Phase 3: Disconnected nodes in a grid below.
 */
export function arrangeFloatRightGroups(graph) {
    const allNodes = graph._nodes || [];
    const groups = graph._groups || [];
    if (allNodes.length === 0) return;

    if (groups.length === 0) {
        arrangeFloatRight(graph);
        return;
    }

    const settings = getSettings();
    const padding = settings.groupPadding;
    const titleH = TITLE_HEIGHT();

    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolveGroups(graph);
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);
    const hidden = collectHiddenLinks(graph);
    const flow = computeFlowOrder(graph, hidden);

    // ── Phase 1: Layout within each group ──────────────────────────

    const groupSizes = new Map();

    for (const group of topLevelGroups) {
        const nodes = groupNodesMap.get(group) || [];
        groupSizes.set(group, layoutGroupContents(group, nodes, padding,
            (gc) => floatRightLayout(gc, graph, new Set(gc.map((n) => n.id)),
                [...hidden, ...collectBridgeLinks(graph, nodes, hidden, nodeToGroup)], flow)));
    }

    // ── Phase 2: Position groups as columns ────────────────────────

    // Groups and ungrouped nodes are blocks; a drawn or hidden link between
    // two blocks is an edge (same as the dagre layout). Blocks get columns from those edges
    // (cycles broken), so a group is placed after everything that feeds it
    // from outside, not by its earliest member. Satellites ride along with
    // their group (its block includes them).
    const sats = findSatellites(graph, nodeToGroup, ungroupedConnected, hidden, MARGIN);
    const flowNodes = ungroupedConnected.filter((n) => !sats.ids.has(n.id));
    const items = [
        ...topLevelGroups.map((group) => ({
            id: "group_" + group.id, type: "group", group,
            ...sats.size(group, groupSizes.get(group)),
        })),
        ...flowNodes.map((node) => ({
            id: "node_" + node.id, type: "node", node,
            width: sizeOf(node)[0], height: sizeOf(node)[1] + titleH,
        })),
    ];
    const ranked = rankBlocks(items.map((it) => it.id), buildTopLevelEdges(graph, nodeToGroup, flowNodes, hidden));
    const topColumns = [];
    for (const item of items) {
        const col = ranked.level.get(item.id);
        (topColumns[col] ??= []).push(item);
    }

    // Position in right-aligned columns, column by column; within a column
    // blocks are ordered by the mean centre of the blocks feeding them
    // (barycenter), blocks without placed feeders keep their order at the end.
    const centreY = new Map();
    let xOffset = MARGIN;
    for (const column of topColumns) {
        if (!column) continue;
        const keyed = column.map((item, index) => {
            const ys = (ranked.preds.get(item.id) || []).filter((p) => centreY.has(p)).map((p) => centreY.get(p));
            return { item, index, bary: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity };
        });
        keyed.sort((a, b) => (a.bary - b.bary) || (a.index - b.index));

        let maxW = 100;
        for (const item of column) maxW = Math.max(maxW, item.width);

        let yOff = MARGIN;
        for (const { item } of keyed) {
            const x = xOffset + maxW - item.width; // Right-align.
            if (item.type === "group") {
                const s = groupSizes.get(item.group);
                placeGroup(item.group, groupNodesMap.get(item.group) || [], x, yOff, s);
                sats.place(item.group, x, yOff, s);
            } else {
                item.node.pos = [x, yOff + titleH];
            }
            centreY.set(item.id, yOff + item.height / 2);
            yOff += item.height + MARGIN;
        }
        xOffset += maxW + MARGIN;
    }

    // ── Phase 3: Disconnected nodes below ──────────────────────────

    const allPositioned = [
        ...ungroupedConnected,
        ...topLevelGroups.flatMap((g) => groupNodesMap.get(g) || []),
    ];
    layoutDisconnectedNodes(disconnected, getLayoutBottom(allPositioned, topLevelGroups));
    positionSubgraphIO(graph);

    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}
