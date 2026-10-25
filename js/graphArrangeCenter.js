/**
 * Graph Arrange -- the wrapper every menu entry runs a layout through.
 *
 * `withPreservedCenter` unpins everything, runs the layout, fits nested
 * group frames to their members, shifts the result back to the old centre
 * and re-places the subgraph IO nodes. No layout calls anything in here.
 */

import { TITLE_HEIGHT, getSettings, sizeOf, positionSubgraphIO, getNodesBounds, isGroupInside, groupTitleHeight } from "./graphArrangeShared.js";

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
 * Record every nested group (a group wholly inside another) before a layout.
 * Layouts only place top-level groups and flatten nested ones into them, so
 * the nested frames are fixed up afterwards by `restoreNestedGroups`.
 *
 * @param {Object} graph - Graph being arranged.
 * @returns {Array<Object>} { group, outer, outerPos, members } per nested group.
 */
function captureNestedGroups(graph) {
    const groups = graph._groups || [];
    for (const group of groups) {
        if (typeof group.recomputeInsideNodes === "function") group.recomputeInsideNodes();
    }
    const nested = [];
    for (const group of groups) {
        // Outermost group containing this one (same rule as resolveGroups).
        let outer = null;
        for (const other of groups) {
            if (isGroupInside(group, other, groups) && (!outer || isGroupInside(outer, other, groups))) outer = other;
        }
        if (!outer) continue;
        nested.push({ group, outer, outerPos: [outer.pos[0], outer.pos[1]], members: [...(group._nodes || [])] });
    }
    return nested;
}

/**
 * Fit nested group frames to their (re-arranged) member nodes; an empty
 * nested group moves along with its outermost group.
 *
 * @param {Array<Object>} nested - From `captureNestedGroups`.
 * @param {number} padding - Group padding setting (nested frames use half).
 * @returns {void}
 */
function restoreNestedGroups(nested, padding) {
    const pad = padding / 2;
    for (const { group, outer, outerPos, members } of nested) {
        if (members.length > 0) {
            const b = getNodesBounds(members);
            const titleH = groupTitleHeight(group);
            group.pos = [b.minX - pad, b.minY - pad - titleH];
            group.size = [b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2 + titleH];
        } else {
            group.pos = [group.pos[0] + outer.pos[0] - outerPos[0], group.pos[1] + outer.pos[1] - outerPos[1]];
        }
    }
}

/**
 * Run an arrange: unpin everything, lay out, fix nested group frames, then
 * shift everything back so the node centroid stays where it was (the
 * layouts build from the origin), and place the subgraph IO nodes.
 *
 * If the graph was empty before layout, no shift is applied (layout starts at origin).
 *
 * @param {Object} graph - Graph being arranged (`app.canvas.graph`).
 * @param {function(): (void|Promise<void>)} layoutFn - The layout.
 * @returns {Promise<void>}
 */
export async function withPreservedCenter(graph, layoutFn) {
    unpinAll(graph);
    const nested = captureNestedGroups(graph);
    const nodesBefore = graph._nodes || [];
    const hadNodes = nodesBefore.length > 0;
    const oldCenter = hadNodes ? computeCentroid(nodesBefore) : { x: 0, y: 0 };

    // Run the layout (may be async for ELK).
    await layoutFn();
    restoreNestedGroups(nested, getSettings().groupPadding);

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
