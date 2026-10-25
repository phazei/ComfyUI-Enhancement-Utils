/**
 * Graph Arrange -- group handling shared by the group-aware layouts.
 *
 * Phase 1 lays out each group's members in group-relative coordinates
 * (`layoutGroupContents`), storing each node's offset in `_groupOffsetX/Y`;
 * other code reads those offsets (satellites, source alignment) until
 * `placeGroup` moves the group and deletes them. Also: group resolution,
 * top-level block edges and satellites.
 */

import { TITLE_HEIGHT, sizeOf, partitionNodes, layoutDisconnectedNodes, getGraphBottom, getNodesBounds, isGroupInside, groupTitleHeight } from "./graphArrangeShared.js";
import { rankBlocks } from "./graphArrangeFlow.js";

// ═══════════════════════════════════════════════════════════════════════════
// Group Resolution (shared by all group-aware layouts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve group membership for all nodes in the graph.
 *
 * Handles:
 * - Refreshing group node membership via recomputeInsideNodes().
 * - Flattening nested groups into their outermost parent.
 * - Mapping each node to its top-level group.
 * - Identifying ungrouped nodes.
 *
 * @param {Object} graph - The LiteGraph graph instance.
 * @returns {Object} { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes }
 */
export function resolveGroups(graph) {
    const allNodes = graph._nodes || [];
    const groups = graph._groups || [];

    // Refresh group membership.
    for (const group of groups) {
        if (typeof group.recomputeInsideNodes === "function") {
            group.recomputeInsideNodes();
        }
    }

    // Detect nested groups (g1 fully inside g2).
    const isNested = new Set();
    for (const g1 of groups) {
        for (const g2 of groups) {
            if (isGroupInside(g1, g2, groups)) isNested.add(g1);
        }
    }

    const topLevelGroups = groups.filter((g) => !isNested.has(g));

    // Map each node to its outermost group.
    const nodeToGroup = new Map();
    const groupNodesMap = new Map();

    const gatherNodes = (grp, targetGroup, nodesInGroup) => {
        const members = grp._nodes || (grp._children
            ? Array.from(grp._children).filter((c) => c.inputs !== undefined)
            : []);
        for (const node of members) {
            if (!nodeToGroup.has(node.id)) {
                nodeToGroup.set(node.id, targetGroup);
                nodesInGroup.push(node);
            }
        }
    };

    for (const group of topLevelGroups) {
        const nodesInGroup = [];
        gatherNodes(group, group, nodesInGroup);

        // Also gather from nested groups inside this one.
        for (const nested of isNested) {
            if (isGroupInside(nested, group, groups)) gatherNodes(nested, group, nodesInGroup);
        }

        groupNodesMap.set(group, nodesInGroup);
    }

    const ungroupedNodes = allNodes.filter((n) => !nodeToGroup.has(n.id));

    return { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes };
}

/**
 * Lay out one group's member nodes in group-relative coordinates (phase 1 of
 * the group-aware Quick and Smart layouts): connected members with
 * `layoutConnected`, unconnected members in a grid below them, then the whole
 * content shifted to start at (padding, padding + group title). Each node's
 * offset from the group origin is stored in `_groupOffsetX/Y`.
 * An empty group keeps its current size.
 *
 * @param {Object} group - The group.
 * @param {Array<Object>} nodes - Its member nodes.
 * @param {number} padding - Group padding setting.
 * @param {function(Array<Object>): void} layoutConnected - Lays out the connected members.
 * @returns {{ width: number, height: number }} Group size.
 */
export function layoutGroupContents(group, nodes, padding, layoutConnected) {
    if (nodes.length === 0) return { width: group.size[0], height: group.size[1] };
    const { connected, disconnected } = partitionNodes(nodes);
    if (connected.length > 0) {
        layoutConnected(connected);
        if (disconnected.length > 0) {
            layoutDisconnectedNodes(disconnected, getGraphBottom(connected), getNodesBounds(connected).minX);
        }
    } else {
        layoutDisconnectedNodes(disconnected, 0, 0);
    }
    const bounds = getNodesBounds(nodes);
    const shiftX = padding - bounds.minX;
    const shiftY = padding + groupTitleHeight(group) - bounds.minY;
    for (const node of nodes) {
        node.pos = [node.pos[0] + shiftX, node.pos[1] + shiftY];
        node._groupOffsetX = node.pos[0];
        node._groupOffsetY = node.pos[1];
    }
    return computeGroupSize(group, nodes, padding);
}

/**
 * Bottom edge of everything placed so far (nodes and group frames), used to
 * put the grid of unconnected ungrouped nodes below it.
 *
 * @param {Array<Object>} nodes - Placed nodes.
 * @param {Array<Object>} groups - Placed groups.
 * @returns {number} Bottom Y in graph units.
 */
export function getLayoutBottom(nodes, groups) {
    let maxY = nodes.length > 0 ? getGraphBottom(nodes) : 0;
    for (const group of groups) maxY = Math.max(maxY, group.pos[1] + group.size[1]);
    return maxY;
}

/**
 * Move a group to `pos` with size `size` and place its members at their
 * stored `_groupOffsetX/Y` offsets.
 *
 * @param {Object} group - The group.
 * @param {Array<Object>} nodes - Its member nodes.
 * @param {number} x - New group x.
 * @param {number} y - New group y.
 * @param {{ width: number, height: number }} size - New group size.
 * @returns {void}
 */
export function placeGroup(group, nodes, x, y, size) {
    group.pos = [x, y];
    group.size = [size.width, size.height];
    for (const node of nodes) {
        if (node._groupOffsetX == null) continue;
        node.pos = [x + node._groupOffsetX, y + node._groupOffsetY];
        delete node._groupOffsetX;
        delete node._groupOffsetY;
    }
}

/**
 * Finalize group layout after internal nodes have been positioned:
 * stores node offsets relative to group origin and computes group size.
 *
 * @param {Object} group - The group.
 * @param {Array} nodes - All nodes in this group.
 * @param {number} padding - Group padding from settings.
 * @returns {{ width: number, height: number }} Computed group size.
 */
function computeGroupSize(group, nodes, padding) {
    if (nodes.length === 0) return { width: 140, height: 80 };
    const bounds = getNodesBounds(nodes);
    const gTitleH = groupTitleHeight(group);
    return {
        width: Math.max(140, (bounds.maxX - bounds.minX) + padding * 2),
        height: Math.max(80, (bounds.maxY - bounds.minY) + padding * 2 + gTitleH),
    };
}

/**
 * Build top-level edges between groups/ungrouped nodes for inter-group layout,
 * from the drawn links plus the hidden ones. Deduplicated per block pair; a
 * pair is `hidden` only when no drawn link connects it.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Map<*, Object>} nodeToGroup - Node id -> top-level group.
 * @param {Array<Object>} ungroupedConnected - Ungrouped nodes taking part in the layout.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - From `collectHiddenLinks`.
 * @returns {Array<{srcTopId: string, tgtTopId: string, hidden: boolean, weight: number}>}
 *   `weight` = number of links (drawn + hidden) behind the pair.
 */
export function buildTopLevelEdges(graph, nodeToGroup, ungroupedConnected, hidden = []) {
    const byKey = new Map();
    const ungroupedSet = new Set(ungroupedConnected.map((n) => n.id));
    const topId = (id) => {
        const group = nodeToGroup.get(id);
        if (group) return "group_" + group.id;
        return ungroupedSet.has(id) ? "node_" + id : null;
    };
    const add = (link, isHidden) => {
        if (!link) return;
        const srcTopId = topId(link.origin_id);
        const tgtTopId = topId(link.target_id);
        if (!srcTopId || !tgtTopId || srcTopId === tgtTopId) return;
        const key = srcTopId + "->" + tgtTopId;
        const existing = byKey.get(key);
        if (existing) {
            existing.hidden &&= isHidden;
            existing.weight++;
        } else {
            byKey.set(key, { srcTopId, tgtTopId, hidden: isHidden, weight: 1 });
        }
    };

    for (const link of Object.values(graph.links || {})) add(link, false);
    for (const link of hidden) add(link, true);
    return [...byKey.values()];
}

/**
 * Find satellites: clusters of ungrouped nodes (joined to each other by drawn
 * or hidden links) that take input from exactly one group and feed only that
 * same group -- e.g. a node outside a group that processes something from it
 * and hands it back. As separate blocks they form a loop with the group that
 * no order can untangle, so they ended up far away with long links both
 * ways. Instead they are left out of the block ordering and placed to the
 * right of their group (in TB too -- slots are on the sides of nodes, and
 * there's room beside a tall column), level with the group member feeding
 * them, laid out left to right among themselves. They are not moved into the
 * group. Call after the groups' contents are laid out (`_groupOffsetY` set).
 *
 * Usage: `size(group, s)` gives the block size of the group plus its
 * satellites (`s` = the group's own size); `place(group, x, y, s)` puts the
 * satellites next to a group placed at (x, y); `ids` holds every satellite
 * node id (exclude them from the ungrouped blocks).
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Map<*, Object>} nodeToGroup - Node id -> top-level group.
 * @param {Array<Object>} ungroupedConnected - Ungrouped nodes with links.
 * @param {Array<{origin_id: *, target_id: *}>} hidden - Hidden links.
 * @param {number} gap - Space between the group and its satellites, and between satellites.
 * @returns {{ ids: Set<*>, size: function(Object, {width: number, height: number}): {width: number, height: number},
 *   place: function(Object, number, number, {width: number, height: number}): void }}
 */
export function findSatellites(graph, nodeToGroup, ungroupedConnected, hidden, gap) {
    const titleH = TITLE_HEIGHT();
    const loose = new Map(ungroupedConnected.map((n) => [n.id, n]));
    const links = [...Object.values(graph.links || {}).filter(Boolean), ...hidden];

    // Clusters of ungrouped nodes.
    const parent = new Map([...loose.keys()].map((id) => [id, id]));
    const find = (id) => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
    for (const l of links) {
        if (loose.has(l.origin_id) && loose.has(l.target_id)) parent.set(find(l.origin_id), find(l.target_id));
    }
    const clusters = new Map();
    for (const id of loose.keys()) {
        const root = find(id);
        if (!clusters.has(root)) clusters.set(root, { nodes: [], from: new Set(), to: new Set(), other: false });
        clusters.get(root).nodes.push(loose.get(id));
    }
    for (const l of links) {
        const a = loose.has(l.origin_id), b = loose.has(l.target_id);
        if (a === b) continue;
        const c = clusters.get(find(a ? l.origin_id : l.target_id));
        const outside = a ? l.target_id : l.origin_id;
        const group = nodeToGroup.get(outside);
        if (!group) c.other = true;
        else (a ? c.to : c.from).add(group);
    }

    // Top of the group member feeding a cluster, relative to the group (the
    // group's contents are laid out already). Drawn links first, hidden ones
    // only when no drawn link feeds the cluster.
    const anchorOf = (memberIds) => {
        for (const set of [Object.values(graph.links || {}).filter(Boolean), hidden]) {
            let top = Infinity;
            for (const l of set) {
                if (!memberIds.has(l.target_id) || memberIds.has(l.origin_id)) continue;
                const src = graph.getNodeById?.(l.origin_id);
                if (src?._groupOffsetY != null) top = Math.min(top, src._groupOffsetY - titleH);
            }
            if (top < Infinity) return top;
        }
        return 0;
    };

    const byGroup = new Map();
    const ids = new Set();
    for (const c of clusters.values()) {
        if (c.other || c.from.size !== 1 || c.to.size !== 1) continue;
        const [group] = c.from;
        if (!c.to.has(group)) continue;
        // Lay the cluster out left to right (cluster-relative offsets): node
        // slots are on the sides, so even in TB a satellite reads best beside
        // the node feeding it.
        const memberIds = new Set(c.nodes.map((n) => n.id));
        const edges = links.filter((l) => memberIds.has(l.origin_id) && memberIds.has(l.target_id))
            .map((l) => ({ srcTopId: String(l.origin_id), tgtTopId: String(l.target_id) }));
        const { level } = rankBlocks(c.nodes.map((n) => String(n.id)), edges);
        const layers = [];
        for (const n of c.nodes) (layers[level.get(String(n.id))] ??= []).push(n);
        const items = [];
        let u = 0, height = 0;
        for (const layer of layers.filter(Boolean)) {
            let v = 0, widthMax = 0;
            for (const n of layer) {
                const [w, h] = sizeOf(n);
                items.push({ node: n, dx: u, dy: v });
                v += h + titleH + gap;
                widthMax = Math.max(widthMax, w);
            }
            height = Math.max(height, v - gap);
            u += widthMax + gap;
        }
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group).push({ items, width: u - gap, height, anchor: anchorOf(memberIds) });
        for (const n of c.nodes) ids.add(n.id);
    }
    // Each cluster level with its feeder; several on one group stack
    // downwards without overlapping, in feeder order.
    for (const [group, list] of byGroup) {
        list.sort((a, b) => a.anchor - b.anchor);
        const entry = { items: [], width: 0, height: 0 };
        let bottom = -Infinity;
        for (const c of list) {
            const top = Math.max(c.anchor, bottom + gap);
            for (const it of c.items) entry.items.push({ ...it, dy: it.dy + top });
            entry.width = Math.max(entry.width, c.width);
            bottom = top + c.height;
        }
        entry.height = bottom;
        byGroup.set(group, entry);
    }

    return {
        ids,
        size(group, s) {
            const sat = byGroup.get(group);
            if (!sat) return s;
            return { width: s.width + gap + sat.width, height: Math.max(s.height, sat.height) };
        },
        place(group, x, y, s) {
            const sat = byGroup.get(group);
            if (!sat) return;
            for (const { node, dx, dy } of sat.items) {
                node.pos = [x + s.width + gap + dx, y + dy + titleH];
            }
        },
    };
}
