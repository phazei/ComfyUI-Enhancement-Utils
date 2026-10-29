/**
 * Graph Arrange -- group handling shared by the group-aware layouts.
 *
 * Phase 1 lays out each group's contents in group-relative coordinates
 * (`layoutGroupTree`; nested groups are rigid blocks, laid out first),
 * storing each node's and nested group's offset in `_groupOffsetX/Y`; other
 * code reads those offsets (satellites, source alignment) until `placeGroup`
 * moves the group and deletes them. Also: group resolution and nesting,
 * top-level block edges and satellites.
 */

import { TITLE_HEIGHT, sizeOf, partitionNodes, layoutDisconnectedNodes, getGraphBottom, getNodesBounds, isGroupInside, groupTitleHeight } from "./graphArrangeShared.js";
import { rankBlocks, collectBridgeLinks } from "./graphArrangeFlow.js";

// ═══════════════════════════════════════════════════════════════════════════
// Group Resolution (shared by all group-aware layouts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve group membership and nesting for all nodes in the graph.
 *
 * Handles:
 * - Refreshing group node membership via recomputeInsideNodes().
 * - The nesting tree: each group's parent is the innermost group wholly
 *   containing it (`isGroupInside`); groups with none are top-level.
 * - Mapping each node to its top-level group (`nodeToGroup`, all nodes of a
 *   top-level group incl. nested ones in `groupNodesMap`) and to its
 *   innermost group (`directMembers`).
 * - Identifying ungrouped nodes.
 *
 * @param {Object} graph - The LiteGraph graph instance.
 * @returns {{ topLevelGroups: Array<Object>, groupNodesMap: Map<Object, Array<Object>>,
 *   nodeToGroup: Map<*, Object>, ungroupedNodes: Array<Object>, parentOf: Map<Object, Object|null>,
 *   childGroups: Map<Object, Array<Object>>, directMembers: Map<Object, Array<Object>>,
 *   allMembers: Map<Object, Array<Object>> }} `childGroups` = directly nested
 *   groups; `directMembers` = nodes whose innermost group it is; `allMembers` =
 *   every node inside it, nested groups included. All three for every group.
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

    // Nesting: every group containing a group; the innermost one (the one
    // inside the most others) is its parent.
    const containers = new Map(groups.map((g) => [g, groups.filter((o) => isGroupInside(g, o, groups))]));
    const depth = (g) => containers.get(g).length;
    const parentOf = new Map();
    for (const g of groups) {
        let parent = null;
        for (const c of containers.get(g)) if (!parent || depth(c) > depth(parent)) parent = c;
        parentOf.set(g, parent);
    }
    const childGroups = new Map(groups.map((g) => [g, []]));
    for (const g of groups) if (parentOf.get(g)) childGroups.get(parentOf.get(g)).push(g);
    const rootOf = (g) => { while (parentOf.get(g)) g = parentOf.get(g); return g; };

    const topLevelGroups = groups.filter((g) => !parentOf.get(g));

    // Map each node to its outermost group.
    const nodeToGroup = new Map();
    const groupNodesMap = new Map();

    const gatherNodes = (grp, targetGroup, nodesInGroup) => {
        for (const node of groupMembers(grp)) {
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
        for (const nested of groups) {
            if (nested !== group && rootOf(nested) === group) gatherNodes(nested, group, nodesInGroup);
        }

        groupNodesMap.set(group, nodesInGroup);
    }

    // Innermost group of each grouped node (within its top-level group).
    const innerOf = new Map();
    for (const g of groups) {
        for (const node of groupMembers(g)) {
            if (nodeToGroup.get(node.id) !== rootOf(g)) continue;
            const cur = innerOf.get(node.id);
            if (!cur || depth(g) > depth(cur)) innerOf.set(node.id, g);
        }
    }
    const directMembers = new Map(groups.map((g) => [g, []]));
    const allMembers = new Map(groups.map((g) => [g, []]));
    for (const nodes of groupNodesMap.values()) {
        for (const node of nodes) {
            const inner = innerOf.get(node.id);
            if (!inner) continue;
            directMembers.get(inner).push(node);
            for (let g = inner; g; g = parentOf.get(g)) allMembers.get(g).push(node);
        }
    }

    const ungroupedNodes = allNodes.filter((n) => !nodeToGroup.has(n.id));

    return { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes, parentOf, childGroups, directMembers, allMembers };
}

/**
 * Nodes inside a group (its own `_nodes`, else the node children).
 *
 * @param {Object} group - LiteGraph group (membership already recomputed).
 * @returns {Array<Object>} Member nodes.
 */
function groupMembers(group) {
    return group._nodes || (group._children
        ? Array.from(group._children).filter((c) => c.inputs !== undefined)
        : []);
}

/**
 * Every group nested inside `group`, at any depth.
 *
 * @param {Object} group - The group.
 * @param {Map<Object, Array<Object>>} childGroups - From `resolveGroups`.
 * @returns {Array<Object>} Descendant groups (not `group` itself).
 */
export function descendantGroups(group, childGroups) {
    const out = [];
    const stack = [...(childGroups.get(group) || [])];
    while (stack.length) {
        const g = stack.pop();
        out.push(g);
        stack.push(...(childGroups.get(g) || []));
    }
    return out;
}

/**
 * Innermost group containing a point (graph coordinates): of the groups the
 * point lies in, the one no other of them sits inside.
 *
 * @param {Object} graph - Graph (its `_groups`).
 * @param {number} x - X in graph units.
 * @param {number} y - Y in graph units.
 * @returns {Object|null} The group, or null when the point is in none.
 */
export function groupAtPoint(graph, x, y) {
    const groups = graph?._groups || [];
    const hits = groups.filter((g) => {
        const [gx, gy, gw, gh] = g.boundingRect || g._bounding || [g.pos[0], g.pos[1], g.size[0], g.size[1]];
        return x >= gx && x <= gx + gw && y >= gy && y <= gy + gh;
    });
    return hits.find((g) => !hits.some((o) => isGroupInside(o, g, groups))) || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group Contents (phase 1 of every group-aware layout)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lays out the connected items of one group (nodes and nested-group blocks).
 * `view.graph` is the graph, or (with nested groups) a stand-in whose links
 * end at the blocks; `view.hidden` = hidden + bridge links in the same ids;
 * `view.flow` = `computeFlowOrder` incl. the blocks. Returns false to abort
 * the arrange (layout engine failed).
 *
 * @typedef {function(Array<Object>, {graph: Object, hidden: Array<Object>, flow: Map<string, Object>}):
 *   (void|boolean|Promise<void|boolean>)} GroupEngine
 */

/**
 * Stand-in node for a nested group in its parent's layout: a node without a
 * body of its own, as big as the group frame (`pos` / `size` in node terms --
 * title bar above `pos`). Slots are filled by `buildGroupView`, one per link
 * crossing the group's frame, so `partitionNodes` and barycenters work.
 *
 * @param {Object} group - The nested group.
 * @returns {Object} The block.
 */
function makeGroupBlock(group) {
    const titleH = TITLE_HEIGHT();
    return {
        id: "group:" + group.id,
        isGroupBlock: true,
        group,
        type: "",
        flags: {},
        pos: [group.pos[0], group.pos[1] + titleH],
        size: [group.size[0], Math.max(0, group.size[1] - titleH)],
        inputs: [],
        outputs: [],
        getTitle: () => group.title || "",
    };
}

/**
 * Links as seen from inside one group whose nested groups are blocks: every
 * end inside a block is moved to the block (links within one block are
 * dropped), hidden and bridge links likewise; the blocks get one slot per
 * link crossing their frame and a flow position spanning their members.
 * Without blocks it is the graph itself.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Object} group - Group being laid out.
 * @param {Array<Object>} items - Its direct member nodes and blocks.
 * @param {Object} resolved - From `resolveGroups`.
 * @param {{hidden: Array<Object>, flow: Map<string, Object>}} ctx - Hidden links and flow order of the graph.
 * @returns {{graph: Object, hidden: Array<Object>, flow: Map<string, Object>}} View for a `GroupEngine`.
 */
function buildGroupView(graph, group, items, resolved, ctx) {
    const extra = [...ctx.hidden, ...collectBridgeLinks(graph, resolved.allMembers.get(group) || [], ctx.hidden, resolved.nodeToGroup)];
    const blocks = items.filter((it) => it.isGroupBlock);
    if (blocks.length === 0) return { graph, hidden: extra, flow: ctx.flow };

    const blockOf = new Map();
    for (const b of blocks) for (const n of resolved.allMembers.get(b.group) || []) blockOf.set(String(n.id), b);
    const mapId = (id) => blockOf.get(String(id))?.id ?? id;

    const links = {};
    for (const l of Object.values(graph.links || {})) {
        if (!l) continue;
        const a = blockOf.get(String(l.origin_id)), b = blockOf.get(String(l.target_id));
        if (a && a === b) continue;
        const v = { id: l.id, origin_id: l.origin_id, origin_slot: l.origin_slot, target_id: l.target_id, target_slot: l.target_slot };
        if (a) { v.origin_id = a.id; v.origin_slot = a.outputs.length; a.outputs.push({ links: [l.id] }); }
        if (b) { v.target_id = b.id; v.target_slot = b.inputs.length; b.inputs.push({ link: l.id }); }
        links[l.id] = v;
    }

    const hidden = [];
    const seen = new Set();
    for (const l of extra) {
        const o = mapId(l.origin_id), t = mapId(l.target_id);
        const key = o + ">" + t;
        if (String(o) === String(t) || seen.has(key)) continue;
        seen.add(key);
        hidden.push({ origin_id: o, target_id: t });
    }

    const flow = new Map(ctx.flow);
    for (const b of blocks) {
        let from = Infinity, to = 0;
        for (const n of resolved.allMembers.get(b.group) || []) {
            const f = ctx.flow.get(String(n.id));
            if (f) { from = Math.min(from, f.from); to = Math.max(to, f.to); }
        }
        flow.set(b.id, { from: Number.isFinite(from) ? from : 0, to });
    }

    const byId = new Map(items.map((it) => [String(it.id), it]));
    const view = {
        links,
        getNodeById: (id) => byId.get(String(id)) ?? graph.getNodeById?.(id) ?? null,
        /** The graph's execution order with block members replaced by their block (first occurrence). */
        computeExecutionOrder: (...args) => {
            const out = [];
            const done = new Set();
            for (const n of graph.computeExecutionOrder?.(...args) || []) {
                const it = blockOf.get(String(n.id)) || n;
                if (!done.has(it)) { done.add(it); out.push(it); }
            }
            return out;
        },
    };
    return { graph: view, hidden, flow };
}

/**
 * Move every node and group inside `group`, and the group itself, by (dx, dy).
 *
 * @param {Object} group - The group.
 * @param {Object} resolved - From `resolveGroups`.
 * @param {number} dx - Shift in x.
 * @param {number} dy - Shift in y.
 * @returns {void}
 */
export function translateGroup(group, resolved, dx, dy) {
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
    for (const g of [group, ...descendantGroups(group, resolved.childGroups)]) g.pos = [g.pos[0] + dx, g.pos[1] + dy];
    for (const n of resolved.allMembers.get(group) || []) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
}

/**
 * Lay out one group's contents in group-relative coordinates (phase 1 of the
 * group-aware layouts): its own nodes plus each directly nested group as one
 * rigid block (`makeGroupBlock`). Connected items go to `engine`, unconnected
 * ones in a grid below them, then the whole content is shifted to start at
 * (padding, padding + group title) and every node and nested group inside
 * stores its offset from the group origin in `_groupOffsetX/Y` (`placeGroup`
 * applies them). An empty group keeps its current size.
 *
 * With `recurse` (full arrange) nested groups are laid out first, bottom-up,
 * so their blocks have their final size; without it (arranging one group)
 * they keep their current size and contents.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Object} group - The group.
 * @param {Object} resolved - From `resolveGroups`.
 * @param {{padding: number, hidden: Array<Object>, flow: Map<string, Object>}} ctx - Group padding,
 *   `collectHiddenLinks` and `computeFlowOrder` of the graph.
 * @param {GroupEngine} engine - Lays out the connected items.
 * @param {{recurse?: boolean}} [options] - Lay out nested groups too (default true).
 * @returns {Promise<{width: number, height: number, groups: Array<Object>}|null>} Group size and its
 *   nested groups (for `placeGroup`), or null when the engine failed.
 */
export async function layoutGroupTree(graph, group, resolved, ctx, engine, { recurse = true } = {}) {
    const children = resolved.childGroups.get(group) || [];
    const nested = descendantGroups(group, resolved.childGroups);
    if (recurse) {
        for (const child of children) {
            const s = await layoutGroupTree(graph, child, resolved, ctx, engine);
            if (!s) return null;
            placeGroup(child, resolved.allMembers.get(child) || [], 0, 0, s);
        }
    }
    const blocks = children.map(makeGroupBlock);
    const items = [...(resolved.directMembers.get(group) || []), ...blocks];
    if (items.length === 0) return { width: group.size[0], height: group.size[1], groups: nested };

    const view = buildGroupView(graph, group, items, resolved, ctx);
    const { connected, disconnected } = partitionNodes(items);
    if (connected.length > 0) {
        if ((await engine(connected, view)) === false) return null;
        if (disconnected.length > 0) {
            layoutDisconnectedNodes(disconnected, getGraphBottom(connected), getNodesBounds(connected).minX);
        }
    } else {
        layoutDisconnectedNodes(disconnected, 0, 0);
    }
    const bounds = getNodesBounds(items);
    const shiftX = ctx.padding - bounds.minX;
    const shiftY = ctx.padding + groupTitleHeight(group) - bounds.minY;
    const titleH = TITLE_HEIGHT();
    for (const it of items) {
        it.pos = [it.pos[0] + shiftX, it.pos[1] + shiftY];
        if (it.isGroupBlock) {
            translateGroup(it.group, resolved, it.pos[0] - it.group.pos[0], it.pos[1] - titleH - it.group.pos[1]);
        }
    }
    for (const it of [...(resolved.allMembers.get(group) || []), ...nested]) {
        it._groupOffsetX = it.pos[0];
        it._groupOffsetY = it.pos[1];
    }
    return { ...computeGroupSize(group, items, ctx.padding), groups: nested };
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
 * Move a group to `pos` with size `size` and place its members and nested
 * groups at their stored `_groupOffsetX/Y` offsets.
 *
 * @param {Object} group - The group.
 * @param {Array<Object>} nodes - Its member nodes (nested ones included).
 * @param {number} x - New group x.
 * @param {number} y - New group y.
 * @param {{ width: number, height: number, groups?: Array<Object> }} size - New group size
 *   and its nested groups (from `layoutGroupTree`).
 * @returns {void}
 */
export function placeGroup(group, nodes, x, y, size) {
    group.pos = [x, y];
    group.size = [size.width, size.height];
    for (const item of [...nodes, ...(size.groups || [])]) {
        if (item._groupOffsetX == null) continue;
        item.pos = [x + item._groupOffsetX, y + item._groupOffsetY];
        delete item._groupOffsetX;
        delete item._groupOffsetY;
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
