/**
 * Graph Arrange -- the wrapper every menu entry runs a layout through.
 *
 * `withPreservedCenter` unpins everything, runs the layout, shifts the
 * result back to the old centre and re-places the subgraph IO nodes. No
 * layout calls anything in here.
 */

import { TITLE_HEIGHT, sizeOf, positionSubgraphIO } from "./graphArrangeShared.js";

/**
 * Compute the centroid (center of mass) of a set of nodes.
 * Uses each node's visual center (accounting for title bar).
 * Returns {x: 0, y: 0} for empty arrays.
 */
function computeCentroid(nodes) {
    if (nodes.length === 0) return { x: 0, y: 0 };
    const titleH = TITLE_HEIGHT();
    let sumX = 0, sumY = 0;
    for (const node of nodes) {
        sumX += node.pos[0] + sizeOf(node)[0] / 2;
        sumY += node.pos[1] - titleH / 2 + sizeOf(node)[1] / 2;
    }
    return { x: sumX / nodes.length, y: sumY / nodes.length };
}

/**
 * Shift all nodes and groups in the graph so the centroid is at (0, 0).
 * Subgraph IO nodes are repositioned to flank the centered nodes.
 */
export function centerGraph(graph) {
    const nodes = graph._nodes || [];
    const groups = graph._groups || [];
    if (nodes.length === 0) return;

    const center = computeCentroid(nodes);
    const dx = -center.x;
    const dy = -center.y;

    for (const node of nodes) { node.pos = [node.pos[0] + dx, node.pos[1] + dy]; }
    for (const group of groups) { group.pos = [group.pos[0] + dx, group.pos[1] + dy]; }
    positionSubgraphIO(graph);

    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

/**
 * Unpin every node and group in the graph. Arrange treats pinned and unpinned
 * items alike and leaves them unpinned afterwards.
 *
 * @param {Object} graph - Graph being arranged.
 * @returns {void}
 */
function unpinAll(graph) {
    for (const item of [...(graph._nodes || []), ...(graph._groups || [])]) {
        if (!item?.flags?.pinned) continue;
        if (typeof item.pin === "function") item.pin(false);
        else delete item.flags.pinned;
    }
}

/**
 * Run an arrange: unpin everything, lay out, then shift everything back so
 * the node centroid stays where it was (the layouts build from the origin),
 * and place the subgraph IO nodes.
 *
 * If the graph was empty before layout, no shift is applied (layout starts at origin).
 *
 * @param {Object} graph - Graph being arranged (`app.canvas.graph`).
 * @param {function(): (void|Promise<void>)} layoutFn - The layout.
 * @returns {Promise<void>}
 */
export async function withPreservedCenter(graph, layoutFn) {
    unpinAll(graph);
    const nodesBefore = graph._nodes || [];
    const hadNodes = nodesBefore.length > 0;
    const oldCenter = hadNodes ? computeCentroid(nodesBefore) : { x: 0, y: 0 };

    // Run the layout (may be async for ELK).
    await layoutFn();

    // Every node and group has now been placed by the layout, so all of them
    // shift together.
    const nodesAfter = graph._nodes || [];
    // If there were no nodes before, skip shifting (layout places at origin).
    if (hadNodes && nodesAfter.length > 0) {
        const newCenter = computeCentroid(nodesAfter);
        const dx = oldCenter.x - newCenter.x;
        const dy = oldCenter.y - newCenter.y;

        // Skip if the shift is negligible.
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
            for (const node of nodesAfter) { node.pos = [node.pos[0] + dx, node.pos[1] + dy]; }
            for (const group of graph._groups || []) {
                group.pos = [group.pos[0] + dx, group.pos[1] + dy];
            }
        }
    }

    // Re-place the subgraph IO nodes from the final node bounds rather than
    // shifting them by the same delta: not every layout positions them, and
    // shifting an unplaced IO node by the (nonzero) recentring delta made it
    // drift further on every run.
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}
