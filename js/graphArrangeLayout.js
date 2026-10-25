/**
 * Graph Arrange layouts -- pure layout code for `graphArrange.js`.
 *
 * No `app` import and no DOM: works on any LiteGraph-like graph passed in,
 * so it can be unit-tested under plain Node (`tests/graphArrange.test.mjs`).
 * Uses `window.dagre` / `window.ELK` (vendored in `js/lib/`) and
 * `LiteGraph` constants when present. Settings come from the provider set
 * with `setSettingsSource` (defaults otherwise).
 *
 * Layouts:
 * 1. Quick (column aligned)  -- `arrangeFloatRightGroups`: right-aligned columns with barycenter sorting.
 * 2. Smart (dagre)           -- `arrangeDagreGroups`: per-group + inter-group dagre layout.
 * 3. Advanced (ELK)          -- `arrangeELK`: port-aware layered layout, groups as ELK parents.
 * Menu callbacks wrap them in `withPreservedCenter`.
 */

export const DEFAULTS = {
    rankdir: "LR",
    nodesep: 50,
    ranksep: 80,
    groupPadding: 30,
};

const MARGIN = 50;
const TITLE_HEIGHT = () => globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;

/** @type {function(): Object} Returns the current settings (partial is fine). */
let settingsSource = () => DEFAULTS;

/**
 * Set where the layouts read their settings from.
 *
 * @param {function(): Object} fn - Returns { rankdir, nodesep, ranksep, groupPadding } (missing keys use DEFAULTS).
 * @returns {void}
 */
export function setSettingsSource(fn) {
    if (typeof fn === "function") settingsSource = fn;
}

/**
 * Current settings, falling back to defaults.
 *
 * @returns {{ rankdir: string, nodesep: number, ranksep: number, groupPadding: number }}
 */
function getSettings() {
    let s = null;
    try {
        s = settingsSource();
    } catch {
        s = null;
    }
    return { ...DEFAULTS, ...(s || {}) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Partition nodes into connected (has any links) and disconnected (zero links).
 */
export function partitionNodes(nodes) {
    const connected = [];
    const disconnected = [];
    for (const node of nodes) {
        const hasIn = (node.inputs || []).some((inp) => inp.link != null);
        const hasOut = (node.outputs || []).some((out) => out.links?.length > 0);
        (hasIn || hasOut ? connected : disconnected).push(node);
    }
    return { connected, disconnected };
}

/**
 * Layout disconnected nodes in a compact grid below the main graph.
 */
function layoutDisconnectedNodes(nodes, startY, startX = MARGIN) {
    if (nodes.length === 0) return;
    nodes.sort((a, b) => {
        const t = (a.type || "").localeCompare(b.type || "");
        return t !== 0 ? t : (a.getTitle() || "").localeCompare(b.getTitle() || "");
    });

    const titleH = TITLE_HEIGHT();
    let x = startX, y = startY + MARGIN * 2, rowH = 0, col = 0;

    for (const node of nodes) {
        if (col >= 5) { x = startX; y += rowH + MARGIN + titleH; rowH = 0; col = 0; }
        node.pos = [x, y];
        x += node.size[0] + MARGIN;
        rowH = Math.max(rowH, node.size[1] + titleH);
        col++;
    }
}

/** Get the bottom Y extent of positioned nodes. */
function getGraphBottom(nodes) {
    let maxY = 0;
    const titleH = TITLE_HEIGHT();
    for (const node of nodes) {
        maxY = Math.max(maxY, node.pos[1] + node.size[1] + titleH);
    }
    return maxY;
}

/**
 * Position subgraph IO nodes to the left and right of all arranged nodes.
 * No-op if the graph is not a subgraph (i.e., no inputNode/outputNode).
 *
 * Subgraph IO nodes are special Positionable items that represent the parent
 * node's input/output slots. They are NOT in graph._nodes -- they live as
 * graph.inputNode (id=-10) and graph.outputNode (id=-20).
 */
export function positionSubgraphIO(graph) {
    if (!graph.inputNode || !graph.outputNode) return;

    const nodes = graph._nodes || [];
    if (nodes.length === 0) return;

    const bounds = getNodesBounds(nodes);
    const centerY = (bounds.minY + bounds.maxY) / 2;

    const inputIO = graph.inputNode;
    const outputIO = graph.outputNode;
    const inputW = inputIO.size?.[0] || 100;
    const inputH = inputIO.size?.[1] || 100;
    const outputH = outputIO.size?.[1] || 100;

    const IO_GAP = 500;

    // Position input IO to the left of all nodes.
    inputIO.pos = [bounds.minX - IO_GAP - inputW, centerY - inputH / 2];

    // Position output IO to the right of all nodes.
    outputIO.pos = [bounds.maxX + IO_GAP, centerY - outputH / 2];

    // Re-layout internal slots after repositioning.
    if (typeof inputIO.arrange === "function") inputIO.arrange();
    if (typeof outputIO.arrange === "function") outputIO.arrange();
}

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
        sumX += node.pos[0] + node.size[0] / 2;
        sumY += node.pos[1] - titleH / 2 + node.size[1] / 2;
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

/** Get the bounding box of positioned nodes. */
function getNodesBounds(nodes) {
    const titleH = TITLE_HEIGHT();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
        minX = Math.min(minX, node.pos[0]);
        minY = Math.min(minY, node.pos[1] - titleH);
        maxX = Math.max(maxX, node.pos[0] + node.size[0]);
        maxY = Math.max(maxY, node.pos[1] + node.size[1]);
    }
    return { minX, minY, maxX, maxY };
}

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
 * Whether group `inner` lies wholly inside group `outer`. Two groups with
 * identical bounds would contain each other; the earlier one in the graph's
 * group list counts as the outer one so neither disappears.
 *
 * @param {Object} inner - Candidate nested group.
 * @param {Object} outer - Candidate containing group.
 * @param {Array<Object>} groups - The graph's groups (tie-break order).
 * @returns {boolean} True when `inner` is nested in `outer`.
 */
function isGroupInside(inner, outer, groups) {
    if (inner === outer) return false;
    const contains = (a, b) =>
        b[0] >= a[0] && b[1] >= a[1] && b[0] + b[2] <= a[0] + a[2] && b[1] + b[3] <= a[1] + a[3];
    const bi = inner._bounding || [inner.pos[0], inner.pos[1], inner.size[0], inner.size[1]];
    const bo = outer._bounding || [outer.pos[0], outer.pos[1], outer.size[0], outer.size[1]];
    if (!contains(bo, bi)) return false;
    if (contains(bi, bo)) return groups.indexOf(outer) < groups.indexOf(inner);
    return true;
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
function layoutGroupContents(group, nodes, padding, layoutConnected) {
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
function getLayoutBottom(nodes, groups) {
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
function placeGroup(group, nodes, x, y, size) {
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
 * Compute group title area height.
 * @param {Object} group - LiteGraph group.
 * @returns {number} Height in pixels reserved for the group title.
 */
function groupTitleHeight(group) {
    return (group.font_size || 24) + 10;
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
 * Build top-level edges between groups/ungrouped nodes for inter-group layout.
 * Returns an array of { srcTopId, tgtTopId } pairs (deduplicated).
 */
function buildTopLevelEdges(graph, nodeToGroup, ungroupedConnected) {
    const edges = [];
    const seen = new Set();
    const ungroupedSet = new Set(ungroupedConnected.map((n) => n.id));

    for (const link of Object.values(graph.links || {})) {
        if (!link) continue;
        const srcGroup = nodeToGroup.get(link.origin_id);
        const tgtGroup = nodeToGroup.get(link.target_id);

        const srcTopId = srcGroup ? "group_" + srcGroup.id
            : ungroupedSet.has(link.origin_id) ? "node_" + link.origin_id : null;
        const tgtTopId = tgtGroup ? "group_" + tgtGroup.id
            : ungroupedSet.has(link.target_id) ? "node_" + link.target_id : null;

        if (!srcTopId || !tgtTopId || srcTopId === tgtTopId) continue;

        const key = srcTopId + "->" + tgtTopId;
        if (!seen.has(key)) {
            seen.add(key);
            edges.push({ srcTopId, tgtTopId });
        }
    }
    return edges;
}

// ═══════════════════════════════════════════════════════════════════════════
// Float Right Algorithm
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Core float-right layout on a set of nodes using a specific graph's links.
 * Positions nodes in right-aligned columns with barycenter sorting.
 *
 * @param {Array} nodes - Connected nodes to layout.
 * @param {Object} graph - Graph instance (for links and computeExecutionOrder).
 * @param {Set} [nodeIdFilter] - Only consider nodes in this set.
 */
function floatRightLayout(nodes, graph, nodeIdFilter = null) {
    const filter = nodeIdFilter || new Set(nodes.map((n) => n.id));

    const execOrder = graph.computeExecutionOrder(false, true);
    if (!execOrder || execOrder.length === 0) return;

    const ordered = execOrder.filter((n) => filter.has(n.id));

    // Reassign levels by pulling nodes toward their consumers.
    for (let i = ordered.length - 1; i >= 0; i--) {
        const node = ordered[i];
        let minConsumerLevel = null;

        for (const output of node.outputs || []) {
            if (!output.links) continue;
            for (const linkId of output.links) {
                const linkInfo = graph.links[linkId];
                if (!linkInfo) continue;
                const consumer = graph.getNodeById(linkInfo.target_id);
                if (!consumer || !filter.has(consumer.id)) continue;
                const cl = (consumer._level || 1) - 1;
                if (minConsumerLevel === null || cl < minConsumerLevel) minConsumerLevel = cl;
            }
        }
        if (minConsumerLevel !== null) node._level = minConsumerLevel;
    }

    // Bucket into columns.
    const columns = [];
    for (const node of ordered) {
        const col = node._level || 1;
        if (!columns[col]) columns[col] = [];
        columns[col].push(node);
    }

    const titleH = TITLE_HEIGHT();

    // First pass: position in columns.
    let xOffset = MARGIN;
    for (const column of columns) {
        if (!column) continue;
        let maxW = 100, yOff = MARGIN + titleH;
        for (const node of column) {
            node.pos = [xOffset, yOff];
            maxW = Math.max(maxW, node.size[0]);
            yOff += node.size[1] + MARGIN + titleH;
        }
        for (const node of column) node.pos = [node.pos[0] + maxW - node.size[0], node.pos[1]];
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
                    if (li) { const nb = graph.getNodeById(li.origin_id); if (nb) ys.push(nb.pos[1]); }
                }
                for (const out of node.outputs || []) {
                    for (const lid of out.links || []) {
                        const li = graph.links[lid];
                        if (li) { const nb = graph.getNodeById(li.target_id); if (nb) ys.push(nb.pos[1]); }
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
        for (const node of column) maxW = Math.max(maxW, node.size[0]);
        let yOff = MARGIN + titleH;
        for (const node of column) {
            node.pos = [xOffset + maxW - node.size[0], yOff];
            yOff += node.size[1] + MARGIN + titleH;
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
        floatRightLayout(connected, graph);
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

    // ── Phase 1: Layout within each group ──────────────────────────

    const groupSizes = new Map();

    for (const group of topLevelGroups) {
        const nodes = groupNodesMap.get(group) || [];
        groupSizes.set(group, layoutGroupContents(group, nodes, padding,
            (gc) => floatRightLayout(gc, graph, new Set(gc.map((n) => n.id)))));
    }

    // ── Phase 2: Position groups as columns ────────────────────────

    // Assign each group a level based on the minimum _level of its nodes from
    // a full-graph execution order, then layout groups as "mega-nodes" in
    // right-aligned columns.
    const execOrder = graph.computeExecutionOrder(false, true);
    const groupLevels = new Map();

    if (execOrder) {
        for (const node of execOrder) {
            const grp = nodeToGroup.get(node.id);
            if (!grp) continue;
            const level = node._level || 1;
            const cur = groupLevels.get(grp);
            if (cur == null || level < cur) groupLevels.set(grp, level);
        }
    }

    // Also compute levels for ungrouped connected nodes.
    const ungroupedLevels = new Map();
    if (execOrder) {
        for (const node of execOrder) {
            if (!nodeToGroup.has(node.id) && ungroupedConnected.includes(node)) {
                ungroupedLevels.set(node.id, node._level || 1);
            }
        }
    }

    // Build columns of groups + ungrouped nodes.
    const topColumns = [];

    // Add groups.
    for (const group of topLevelGroups) {
        const col = groupLevels.get(group) || 1;
        if (!topColumns[col]) topColumns[col] = [];
        topColumns[col].push({
            type: "group", group,
            width: groupSizes.get(group).width,
            height: groupSizes.get(group).height,
        });
    }

    // Add ungrouped nodes.
    for (const node of ungroupedConnected) {
        const col = ungroupedLevels.get(node.id) || 1;
        if (!topColumns[col]) topColumns[col] = [];
        topColumns[col].push({
            type: "node", node,
            width: node.size[0],
            height: node.size[1] + titleH,
        });
    }

    // Position in right-aligned columns.
    let xOffset = MARGIN;
    for (const column of topColumns) {
        if (!column) continue;
        let maxW = 100;
        for (const item of column) maxW = Math.max(maxW, item.width);

        let yOff = MARGIN;
        for (const item of column) {
            const x = xOffset + maxW - item.width; // Right-align.
            if (item.type === "group") {
                placeGroup(item.group, groupNodesMap.get(item.group) || [], x, yOff, item);
            } else {
                item.node.pos = [x, yOff + titleH];
            }
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

// ═══════════════════════════════════════════════════════════════════════════
// Dagre Algorithms
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run dagre layout on a set of nodes and their internal edges.
 * @returns {{ width: number, height: number }} Bounding size of the layout.
 */
function runDagreLayout(nodes, graphLinks, settings, offsetX = 0, offsetY = 0) {
    const dagre = window.dagre;
    if (!dagre || nodes.length === 0) return { width: 0, height: 0 };

    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: settings.rankdir, nodesep: settings.nodesep,
        ranksep: settings.ranksep, marginx: 10, marginy: 10,
    });
    g.setDefaultEdgeLabel(() => ({}));

    const titleH = TITLE_HEIGHT();
    const nodeIds = new Set();

    for (const node of nodes) {
        const id = String(node.id);
        nodeIds.add(id);
        g.setNode(id, { width: node.size[0], height: node.size[1] + titleH });
    }

    for (const link of Object.values(graphLinks || {})) {
        if (!link) continue;
        const src = String(link.origin_id), tgt = String(link.target_id);
        if (nodeIds.has(src) && nodeIds.has(tgt)) g.setEdge(src, tgt);
    }

    try { dagre.layout(g); } catch (e) {
        console.error("[EnhancementUtils] Dagre layout failed:", e);
        return { width: 0, height: 0 };
    }

    for (const node of nodes) {
        const dn = g.node(String(node.id));
        if (!dn) continue;
        node.pos = [dn.x - node.size[0] / 2 + offsetX, dn.y - (node.size[1] + titleH) / 2 + titleH + offsetY];
    }

    const info = g.graph();
    return { width: info.width || 0, height: info.height || 0 };
}

/** Arrange all nodes using dagre (ignores groups). */
export function arrangeDagre(graph) {
    if (!window.dagre) { console.error("[EnhancementUtils] dagre not loaded."); return; }
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const settings = getSettings();
    const { connected, disconnected } = partitionNodes(allNodes);

    if (connected.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
    } else {
        runDagreLayout(connected, graph.links, settings);
        layoutDisconnectedNodes(disconnected, getGraphBottom(connected));
    }
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

/**
 * Arrange nodes using dagre respecting group boundaries.
 *
 * Phase 1: Dagre layout within each group.
 * Phase 2: Dagre layout of groups as mega-nodes + ungrouped nodes.
 * Phase 3: Disconnected nodes below.
 */
export function arrangeDagreGroups(graph) {
    if (!window.dagre) { console.error("[EnhancementUtils] dagre not loaded."); return; }
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;
    if ((graph._groups || []).length === 0) { arrangeDagre(graph); return; }

    const settings = getSettings();
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;

    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolveGroups(graph);
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);

    // ── Phase 1: Layout within each group ──────────────────────────

    const groupSizes = new Map();

    for (const group of topLevelGroups) {
        const nodes = groupNodesMap.get(group) || [];
        groupSizes.set(group, layoutGroupContents(group, nodes, padding,
            (gc) => runDagreLayout(gc, graph.links, settings)));
    }

    // ── Phase 2: Top-level dagre layout ────────────────────────────

    const dagre = window.dagre;
    const topG = new dagre.graphlib.Graph();
    topG.setGraph({
        rankdir: settings.rankdir, nodesep: settings.nodesep,
        ranksep: settings.ranksep, marginx: MARGIN, marginy: MARGIN,
    });
    topG.setDefaultEdgeLabel(() => ({}));

    for (const group of topLevelGroups) {
        const s = groupSizes.get(group);
        topG.setNode("group_" + group.id, { width: s.width, height: s.height });
    }
    for (const node of ungroupedConnected) {
        topG.setNode("node_" + node.id, { width: node.size[0], height: node.size[1] + titleH });
    }

    for (const { srcTopId, tgtTopId } of buildTopLevelEdges(graph, nodeToGroup, ungroupedConnected)) {
        topG.setEdge(srcTopId, tgtTopId);
    }

    try { dagre.layout(topG); } catch (e) {
        console.error("[EnhancementUtils] Dagre top-level layout failed:", e);
        return;
    }

    // ── Phase 3: Apply positions ───────────────────────────────────

    for (const group of topLevelGroups) {
        const dn = topG.node("group_" + group.id);
        if (!dn) continue;
        const s = groupSizes.get(group);
        placeGroup(group, groupNodesMap.get(group) || [], dn.x - s.width / 2, dn.y - s.height / 2, s);
    }

    for (const node of ungroupedConnected) {
        const dn = topG.node("node_" + node.id);
        if (!dn) continue;
        node.pos = [dn.x - node.size[0] / 2, dn.y - (node.size[1] + titleH) / 2 + titleH];
    }

    const allPositioned = [
        ...ungroupedConnected,
        ...topLevelGroups.flatMap((g) => groupNodesMap.get(g) || []),
    ];
    layoutDisconnectedNodes(disconnected, getLayoutBottom(allPositioned, topLevelGroups));
    positionSubgraphIO(graph);

    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// ELK (Eclipse Layout Kernel) -- Layered Algorithm with Port Awareness
// ═══════════════════════════════════════════════════════════════════════════

/** Map our rankdir setting to ELK's elk.direction values. */
const RANKDIR_TO_ELK = { LR: "RIGHT", TB: "DOWN", RL: "LEFT", BT: "UP" };

/**
 * Compute ELK port objects for a LiteGraph node's input/output slots.
 * Ports are positioned to match LiteGraph's rendering (inputs on WEST,
 * outputs on EAST, evenly spaced vertically).
 */
function computeElkPorts(node, nodeId) {
    const ports = [];
    const titleH = TITLE_HEIGHT();
    const slotH = globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;

    for (let i = 0; i < (node.inputs || []).length; i++) {
        ports.push({
            id: nodeId + "_in_" + i,
            layoutOptions: { "elk.port.side": "WEST" },
            x: 0, y: titleH + i * slotH + slotH / 2, width: 1, height: 1,
        });
    }
    for (let i = 0; i < (node.outputs || []).length; i++) {
        ports.push({
            id: nodeId + "_out_" + i,
            layoutOptions: { "elk.port.side": "EAST" },
            x: node.size[0], y: titleH + i * slotH + slotH / 2, width: 1, height: 1,
        });
    }
    return ports;
}

/**
 * Arrange nodes using ELK's layered (Sugiyama) algorithm.
 *
 * Features:
 * - Port-aware: models each input/output slot as an ELK port with FIXED_POS.
 * - Native hierarchy: groups become parent nodes with children (auto-detected).
 * - Crossing minimization via layer sweep.
 * - Async: won't freeze the UI on large graphs.
 * - Disconnected nodes laid out in a grid below.
 */
export async function arrangeELK(graph) {
    if (!window.ELK) { console.error("[EnhancementUtils] ELK not loaded."); return; }

    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const settings = getSettings();
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;
    const elkDir = RANKDIR_TO_ELK[settings.rankdir] || "RIGHT";

    // ── Group detection ────────────────────────────────────────────

    const groups = graph._groups || [];
    const useGroups = groups.length > 0;

    let topLevelGroups = [], groupNodesMap = new Map(), nodeToGroup = new Map();
    if (useGroups) {
        const resolved = resolveGroups(graph);
        topLevelGroups = resolved.topLevelGroups;
        groupNodesMap = resolved.groupNodesMap;
        nodeToGroup = resolved.nodeToGroup;
    }

    // Grouped nodes stay in their group whether connected or not; only
    // ungrouped unconnected nodes go to the grid below.
    const { connected, disconnected } = partitionNodes(allNodes);
    const ungroupedDisconnected = disconnected.filter((n) => !nodeToGroup.has(n.id));
    if (connected.length === 0 && topLevelGroups.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
        graph.setDirtyCanvas(true, true);
        return;
    }

    // ── Shared layout options for layered algorithm ────────────────

    const layeredOptions = {
        "elk.algorithm": "layered",
        "elk.direction": elkDir,
        "elk.spacing.nodeNode": String(settings.nodesep),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(settings.ranksep),
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.portConstraints": "FIXED_POS",
    };

    // ── Build ELK graph ────────────────────────────────────────────

    const elkGraph = {
        id: "root",
        layoutOptions: { ...layeredOptions },
        children: [],
        edges: [],
    };

    const nodeIdToElk = new Map();
    const connectedIds = new Set(connected.map((n) => n.id));

    const buildElkNode = (node) => {
        const elkId = "n_" + node.id;
        nodeIdToElk.set(node.id, elkId);
        return {
            id: elkId,
            width: node.size[0],
            height: node.size[1] + titleH,
            ports: computeElkPorts(node, elkId),
            layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        };
    };

    const buildElkEdge = (link, idPrefix, idx) => {
        const srcElk = nodeIdToElk.get(link.origin_id);
        const tgtElk = nodeIdToElk.get(link.target_id);
        if (!srcElk || !tgtElk) return null;
        return {
            id: idPrefix + idx,
            sources: [srcElk + "_out_" + (link.origin_slot ?? 0)],
            targets: [tgtElk + "_in_" + (link.target_slot ?? 0)],
        };
    };

    /** Grid blocks of unconnected group members: elk id -> nodes with block-relative offsets. */
    const blocks = new Map();

    // Build hierarchy.
    if (useGroups && topLevelGroups.length > 0) {
        const groupedNodeIds = new Set();
        const allLinks = Object.values(graph.links || {});

        for (const group of topLevelGroups) {
            const members = groupNodesMap.get(group) || [];
            const nodes = members.filter((n) => connectedIds.has(n.id));
            const loose = members.filter((n) => !connectedIds.has(n.id));

            // Empty group: a plain box of its current size.
            if (members.length === 0) {
                elkGraph.children.push({ id: "g_" + group.id, width: group.size[0], height: group.size[1] });
                continue;
            }

            const gTitleH = groupTitleHeight(group);
            const groupElk = {
                id: "g_" + group.id,
                layoutOptions: {
                    ...layeredOptions,
                    "elk.padding": `[top=${padding + gTitleH},left=${padding},bottom=${padding},right=${padding}]`,
                },
                children: [],
                edges: [],
            };

            const groupNodeIds = new Set();
            for (const node of nodes) {
                groupElk.children.push(buildElkNode(node));
                groupedNodeIds.add(node.id);
                groupNodeIds.add(node.id);
            }

            // Unconnected members: laid out as a grid first and passed to ELK
            // as one box, so they stay inside the group.
            if (loose.length > 0) {
                layoutDisconnectedNodes(loose, 0, 0);
                const b = getNodesBounds(loose);
                const blockId = "b_" + group.id;
                blocks.set(blockId, loose.map((node) => ({ node, dx: node.pos[0] - b.minX, dy: node.pos[1] - b.minY })));
                groupElk.children.push({ id: blockId, width: b.maxX - b.minX, height: b.maxY - b.minY });
            }

            // Intra-group edges.
            let ei = 0;
            for (const link of allLinks) {
                if (!link) continue;
                if (groupNodeIds.has(link.origin_id) && groupNodeIds.has(link.target_id)) {
                    const edge = buildElkEdge(link, "ge_" + group.id + "_", ei++);
                    if (edge) groupElk.edges.push(edge);
                }
            }

            elkGraph.children.push(groupElk);
        }

        // Ungrouped connected nodes at root level.
        for (const node of connected) {
            if (!groupedNodeIds.has(node.id)) elkGraph.children.push(buildElkNode(node));
        }
    } else {
        for (const node of connected) elkGraph.children.push(buildElkNode(node));
    }

    // Root-level edges (cross-group + ungrouped).
    let rei = 0;
    for (const link of Object.values(graph.links || {})) {
        if (!link) continue;
        if (useGroups) {
            const sg = nodeToGroup.get(link.origin_id), tg = nodeToGroup.get(link.target_id);
            if (sg && tg && sg === tg) continue; // Already added as intra-group.
        }
        const edge = buildElkEdge(link, "re_", rei++);
        if (edge) elkGraph.edges.push(edge);
    }

    // ── Run ELK ────────────────────────────────────────────────────

    let result;
    try {
        const elk = new window.ELK();
        result = await elk.layout(elkGraph);
    } catch (e) {
        console.error("[EnhancementUtils] ELK layout failed:", e);
        return;
    }

    // ── Apply positions ────────────────────────────────────────────

    // Walk the result tree to compute absolute positions.
    const elkMap = new Map();
    const walk = (node, px = 0, py = 0) => {
        const ax = (node.x || 0) + px, ay = (node.y || 0) + py;
        elkMap.set(node.id, { ...node, absX: ax, absY: ay });
        for (const child of node.children || []) walk(child, ax, ay);
    };
    for (const child of result.children || []) walk(child);

    for (const node of connected) {
        const er = elkMap.get(nodeIdToElk.get(node.id));
        if (er) { node.pos = [er.absX, er.absY + titleH]; }
    }

    for (const [blockId, entries] of blocks) {
        const er = elkMap.get(blockId);
        if (!er) continue;
        for (const { node, dx, dy } of entries) node.pos = [er.absX + dx, er.absY + dy];
    }

    if (useGroups) {
        for (const group of topLevelGroups) {
            const er = elkMap.get("g_" + group.id);
            if (!er) continue;
            group.pos = [er.absX, er.absY];
            // Empty groups keep their size; others fit their content (same minimum as the other layouts).
            if ((groupNodesMap.get(group) || []).length > 0) {
                group.size = [Math.max(140, er.width || 140), Math.max(80, er.height || 80)];
            }
        }
    }

    const placedNodes = allNodes.filter((n) => connectedIds.has(n.id) || nodeToGroup.has(n.id));
    layoutDisconnectedNodes(ungroupedDisconnected, getLayoutBottom(placedNodes, topLevelGroups));
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}
