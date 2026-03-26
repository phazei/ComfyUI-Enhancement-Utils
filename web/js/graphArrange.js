/**
 * Graph Arrange extension -- adds auto-layout options to the canvas right-click
 * context menu under an "Arrange" submenu:
 *
 * 1. Quick (column aligned)  -- Right-aligned columns with barycenter sorting.
 *                               Group-aware: respects groups when present.
 * 2. Smart (dagre)           -- Sugiyama layout via dagre.js.
 *                               Group-aware: per-group + inter-group layout.
 * 3. Advanced (ELK)          -- Port-aware Sugiyama via ELK with native hierarchy.
 *                               Auto-detects groups, models input/output slots as ports.
 *
 * Settings (configurable via ComfyUI Settings panel):
 * - Flow direction (LR or TB)       -- affects Dagre and ELK
 * - Node spacing                    -- affects Dagre and ELK
 * - Rank spacing                    -- affects Dagre and ELK
 * - Group padding                   -- affects all group-aware layouts
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts, significantly extended with
 * dagre/ELK integration, group awareness, and layout improvements.
 */

import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

const SETTING_RANKDIR       = "EnhUtils.Arrange.RankDir";
const SETTING_NODESEP       = "EnhUtils.Arrange.NodeSep";
const SETTING_RANKSEP       = "EnhUtils.Arrange.RankSep";
const SETTING_GROUP_PADDING = "EnhUtils.Arrange.GroupPadding";

const DEFAULTS = {
    rankdir: "LR",
    nodesep: 50,
    ranksep: 80,
    groupPadding: 30,
};

const MARGIN = 50;
const TITLE_HEIGHT = () => LiteGraph.NODE_TITLE_HEIGHT || 30;

/** Read current settings, falling back to defaults. */
function getSettings() {
    const get = (id, fallback) => {
        try {
            const val = app.ui.settings.getSettingValue(id);
            return val != null ? val : fallback;
        } catch {
            return fallback;
        }
    };
    return {
        rankdir:      get(SETTING_RANKDIR, DEFAULTS.rankdir),
        nodesep:      get(SETTING_NODESEP, DEFAULTS.nodesep),
        ranksep:      get(SETTING_RANKSEP, DEFAULTS.ranksep),
        groupPadding: get(SETTING_GROUP_PADDING, DEFAULTS.groupPadding),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Partition nodes into connected (has any links) and disconnected (zero links).
 */
function partitionNodes(nodes) {
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
        node.pos[0] = x;
        node.pos[1] = y;
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
 * - Skipping pinned groups (they keep their internal layout).
 *
 * @param {Object} graph - The LiteGraph graph instance.
 * @returns {Object} { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes }
 */
function resolveGroups(graph) {
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
            if (g1 === g2) continue;
            const b1 = g1._bounding || [g1.pos[0], g1.pos[1], g1.size[0], g1.size[1]];
            const b2 = g2._bounding || [g2.pos[0], g2.pos[1], g2.size[0], g2.size[1]];
            if (b1[0] >= b2[0] && b1[1] >= b2[1] &&
                b1[0] + b1[2] <= b2[0] + b2[2] &&
                b1[1] + b1[3] <= b2[1] + b2[3]) {
                isNested.add(g1);
            }
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
            const nb = nested._bounding || [nested.pos[0], nested.pos[1], nested.size[0], nested.size[1]];
            const gb = group._bounding || [group.pos[0], group.pos[1], group.size[0], group.size[1]];
            if (nb[0] >= gb[0] && nb[1] >= gb[1] &&
                nb[0] + nb[2] <= gb[0] + gb[2] &&
                nb[1] + nb[3] <= gb[1] + gb[3]) {
                gatherNodes(nested, group, nodesInGroup);
            }
        }

        groupNodesMap.set(group, nodesInGroup);
    }

    const ungroupedNodes = allNodes.filter((n) => !nodeToGroup.has(n.id));

    return { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes };
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
            node.pos[0] = xOffset; node.pos[1] = yOff;
            maxW = Math.max(maxW, node.size[0]);
            yOff += node.size[1] + MARGIN + titleH;
        }
        for (const node of column) node.pos[0] += maxW - node.size[0];
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
            node.pos[0] = xOffset + maxW - node.size[0];
            node.pos[1] = yOff;
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
function arrangeFloatRight(graph) {
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const { connected, disconnected } = partitionNodes(allNodes);
    if (connected.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
    } else {
        floatRightLayout(connected, graph);
        layoutDisconnectedNodes(disconnected, getGraphBottom(connected));
    }
    graph.setDirtyCanvas(true, true);
}

/**
 * Arrange nodes using float-right respecting group boundaries.
 *
 * Phase 1: Float-right layout within each group.
 * Phase 2: Assign groups to columns based on inter-group edges, position groups.
 * Phase 3: Disconnected nodes in a grid below.
 */
function arrangeFloatRightGroups(graph) {
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
        if (group.flags?.pinned || group.pinned) {
            groupSizes.set(group, { width: group.size[0], height: group.size[1] });
            continue;
        }

        const nodes = groupNodesMap.get(group) || [];
        if (nodes.length === 0) {
            groupSizes.set(group, { width: 140, height: 80 });
            continue;
        }

        const { connected: gc, disconnected: gd } = partitionNodes(nodes);
        const gTitleH = groupTitleHeight(group);

        if (gc.length > 0) {
            const gcIds = new Set(gc.map((n) => n.id));
            floatRightLayout(gc, graph, gcIds);

            // Shift to group-relative coords with padding.
            const bounds = getNodesBounds(gc);
            const shiftX = padding - bounds.minX;
            const shiftY = padding + gTitleH - bounds.minY;
            for (const node of gc) { node.pos[0] += shiftX; node.pos[1] += shiftY; }

            if (gd.length > 0) layoutDisconnectedNodes(gd, getGraphBottom(gc), padding);
        } else {
            layoutDisconnectedNodes(nodes, padding + gTitleH, padding);
        }

        const size = computeGroupSize(group, nodes, padding);
        groupSizes.set(group, size);

        // Store offsets relative to group origin.
        for (const node of nodes) {
            node._groupOffsetX = node.pos[0];
            node._groupOffsetY = node.pos[1];
        }
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
                const group = item.group;
                group.pos = [x, yOff];
                group.size = [item.width, item.height];

                // Reposition internal nodes.
                if (!(group.flags?.pinned || group.pinned)) {
                    for (const node of groupNodesMap.get(group) || []) {
                        if (node._groupOffsetX != null) {
                            node.pos[0] = x + node._groupOffsetX;
                            node.pos[1] = yOff + node._groupOffsetY;
                            delete node._groupOffsetX;
                            delete node._groupOffsetY;
                        }
                    }
                }
            } else {
                item.node.pos[0] = x;
                item.node.pos[1] = yOff + titleH;
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
    layoutDisconnectedNodes(disconnected, getGraphBottom(allPositioned));

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
        node.pos[0] = dn.x - node.size[0] / 2 + offsetX;
        node.pos[1] = dn.y - (node.size[1] + titleH) / 2 + titleH + offsetY;
    }

    const info = g.graph();
    return { width: info.width || 0, height: info.height || 0 };
}

/** Arrange all nodes using dagre (ignores groups). */
function arrangeDagre(graph) {
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
    graph.setDirtyCanvas(true, true);
}

/**
 * Arrange nodes using dagre respecting group boundaries.
 *
 * Phase 1: Dagre layout within each group.
 * Phase 2: Dagre layout of groups as mega-nodes + ungrouped nodes.
 * Phase 3: Disconnected nodes below.
 */
function arrangeDagreGroups(graph) {
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
        if (group.flags?.pinned || group.pinned) {
            groupSizes.set(group, { width: group.size[0], height: group.size[1] });
            continue;
        }

        const nodes = groupNodesMap.get(group) || [];
        if (nodes.length === 0) { groupSizes.set(group, { width: 140, height: 80 }); continue; }

        const { connected: gc, disconnected: gd } = partitionNodes(nodes);
        const gTitleH = groupTitleHeight(group);

        if (gc.length > 0) {
            runDagreLayout(gc, graph.links, settings);
            const bounds = getNodesBounds(gc);
            const shiftX = padding - bounds.minX, shiftY = padding + gTitleH - bounds.minY;
            for (const node of gc) { node.pos[0] += shiftX; node.pos[1] += shiftY; }
            if (gd.length > 0) layoutDisconnectedNodes(gd, getGraphBottom(gc), padding);
        } else {
            layoutDisconnectedNodes(nodes, padding + gTitleH, padding);
        }

        groupSizes.set(group, computeGroupSize(group, nodes, padding));
        for (const node of nodes) {
            node._groupOffsetX = node.pos[0];
            node._groupOffsetY = node.pos[1];
        }
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
        const gx = dn.x - s.width / 2, gy = dn.y - s.height / 2;
        group.pos = [gx, gy];
        group.size = [s.width, s.height];

        if (!(group.flags?.pinned || group.pinned)) {
            for (const node of groupNodesMap.get(group) || []) {
                if (node._groupOffsetX != null) {
                    node.pos[0] = gx + node._groupOffsetX;
                    node.pos[1] = gy + node._groupOffsetY;
                    delete node._groupOffsetX;
                    delete node._groupOffsetY;
                }
            }
        }
    }

    for (const node of ungroupedConnected) {
        const dn = topG.node("node_" + node.id);
        if (!dn) continue;
        node.pos[0] = dn.x - node.size[0] / 2;
        node.pos[1] = dn.y - (node.size[1] + titleH) / 2 + titleH;
    }

    const allPositioned = [
        ...ungroupedConnected,
        ...topLevelGroups.flatMap((g) => groupNodesMap.get(g) || []),
    ];
    layoutDisconnectedNodes(disconnected, getGraphBottom(allPositioned));

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
    const slotH = LiteGraph.NODE_SLOT_HEIGHT || 20;

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
async function arrangeELK(graph) {
    if (!window.ELK) { console.error("[EnhancementUtils] ELK not loaded."); return; }

    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const settings = getSettings();
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;
    const elkDir = RANKDIR_TO_ELK[settings.rankdir] || "RIGHT";

    const { connected, disconnected } = partitionNodes(allNodes);
    if (connected.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
        graph.setDirtyCanvas(true, true);
        return;
    }

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

    // Build hierarchy.
    if (useGroups && topLevelGroups.length > 0) {
        const groupedNodeIds = new Set();
        const allLinks = Object.values(graph.links || {});

        for (const group of topLevelGroups) {
            if (group.flags?.pinned || group.pinned) continue;
            const nodes = (groupNodesMap.get(group) || []).filter((n) => connectedIds.has(n.id));
            if (nodes.length === 0) continue;

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
        if (er) { node.pos[0] = er.absX; node.pos[1] = er.absY + titleH; }
    }

    if (useGroups) {
        for (const group of topLevelGroups) {
            if (group.flags?.pinned || group.pinned) continue;
            const er = elkMap.get("g_" + group.id);
            if (!er) continue;
            group.pos = [er.absX, er.absY];
            group.size = [Math.max(140, er.width || 140), Math.max(80, er.height || 80)];
        }
    }

    layoutDisconnectedNodes(disconnected, getGraphBottom(connected));
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.GraphArrange",

    setup() {
        // ── Settings ───────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: SETTING_RANKDIR,
            name: "Graph Arrange - Flow direction",
            type: "combo",
            defaultValue: DEFAULTS.rankdir,
            options: ["LR", "TB"],
            tooltip: "LR = Left-to-Right, TB = Top-to-Bottom. Affects Dagre and ELK layouts.",
        });

        app.ui.settings.addSetting({
            id: SETTING_NODESEP,
            name: "Graph Arrange - Node spacing",
            type: "slider",
            defaultValue: DEFAULTS.nodesep,
            attrs: { min: 20, max: 150, step: 5 },
            tooltip: "Spacing between nodes within the same rank/column. Affects Dagre and ELK.",
        });

        app.ui.settings.addSetting({
            id: SETTING_RANKSEP,
            name: "Graph Arrange - Rank spacing",
            type: "slider",
            defaultValue: DEFAULTS.ranksep,
            attrs: { min: 30, max: 200, step: 5 },
            tooltip: "Spacing between ranks (columns/rows). Affects Dagre and ELK.",
        });

        app.ui.settings.addSetting({
            id: SETTING_GROUP_PADDING,
            name: "Graph Arrange - Group padding",
            type: "slider",
            defaultValue: DEFAULTS.groupPadding,
            attrs: { min: 10, max: 80, step: 5 },
            tooltip: "Padding inside groups around the arranged nodes.",
        });

        // ── Context Menu ───────────────────────────────────────────

        const origGetCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;

        LGraphCanvas.prototype.getCanvasMenuOptions = function () {
            const options = origGetCanvasMenuOptions.apply(this, arguments);

            options.push({
                content: "Arrange",
                has_submenu: true,
                submenu: {
                    options: [
                        {
                            content: "Quick (column aligned)",
                            callback: () => arrangeFloatRightGroups(app.graph),
                        },
                        {
                            content: "Smart (dagre)",
                            callback: () => arrangeDagreGroups(app.graph),
                        },
                        {
                            content: "Advanced (ELK)",
                            callback: () => arrangeELK(app.graph),
                        },
                    ],
                },
            });

            return options;
        };
    },
});
