/**
 * Graph Arrange -- Advanced layout (ELK): compact, wrapped toward 16:9.
 *
 * ELK inside each group, then groups and ungrouped nodes as blocks ranked by
 * `rankBlocks`, ordered and wrapped into rows by `graphArrangeWrap.js`.
 */

import { TITLE_HEIGHT, getSettings, sizeOf, hasNoDrawnInput, partitionNodes, layoutDisconnectedNodes, getGraphBottom, positionSubgraphIO } from "./graphArrangeShared.js";
import { collectHiddenLinks, computeFlowOrder, sortChainsByFlow, rankBlocks } from "./graphArrangeFlow.js";
import { resolveGroups, layoutGroupTree, getLayoutBottom, placeGroup, buildTopLevelEdges, findSatellites } from "./graphArrangeGroups.js";
import { orderLayers, placeWrappedLayers } from "./graphArrangeWrap.js";
import { foldChains } from "./graphArrangeFold.js";

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
    const [w, h] = sizeOf(node);
    // A collapsed node draws every link at its title bar.
    const slotY = (i) => (h === 0 ? titleH / 2 : titleH + i * slotH + slotH / 2);

    for (let i = 0; i < (node.inputs || []).length; i++) {
        ports.push({
            id: nodeId + "_in_" + i,
            layoutOptions: { "elk.port.side": "WEST" },
            x: 0, y: slotY(i), width: 1, height: 1,
        });
    }
    for (let i = 0; i < (node.outputs || []).length; i++) {
        ports.push({
            id: nodeId + "_out_" + i,
            layoutOptions: { "elk.port.side": "EAST" },
            x: w, y: slotY(i), width: 1, height: 1,
        });
    }
    return ports;
}

/** Target width / height of the Advanced layout's block area. */
const TARGET_ASPECT = 16 / 9;

/**
 * Lay out a set of nodes with ELK's layered algorithm, placing them from the
 * origin. Left-to-right: every slot is an ELK port at its real position
 * (inputs west, outputs east) and hidden links attach to extra title-bar
 * ports. Top-to-bottom: no ports -- LiteGraph slots sit on the sides, and
 * fixing them there while layers run downwards turns every chain into a
 * diagonal staircase -- so edges join the nodes directly.
 *
 * @param {Array<Object>} nodes - Nodes to lay out.
 * @param {Object} graph - Graph (for its links).
 * @param {Array<{origin_id: *, target_id: *}>} hidden - Hidden links (`collectHiddenLinks`).
 * @param {Object} settings - Layout settings.
 * @returns {Promise<boolean>} False when ELK failed (nodes left where they were).
 */
async function runElkLayout(nodes, graph, hidden, settings) {
    if (nodes.length === 0) return true;
    const titleH = TITLE_HEIGHT();
    const horizontal = settings.rankdir !== "TB";
    const ids = new Set(nodes.map((n) => n.id));
    const elkId = (id) => "n_" + id;

    const links = Object.values(graph.links || {}).filter((l) => l && ids.has(l.origin_id) && ids.has(l.target_id));
    const hid = hidden.filter((l) => ids.has(l.origin_id) && ids.has(l.target_id));
    const hiddenSources = new Set(hid.map((l) => l.origin_id));
    const hiddenTargets = new Set(hid.map((l) => l.target_id));
    // Nested-group blocks have no ports: edges attach to the block itself.
    const blocks = new Set(nodes.filter((n) => n.isGroupBlock).map((n) => String(n.id)));
    const end = (id, port) => (horizontal && !blocks.has(String(id)) ? elkId(id) + port : elkId(id));

    const children = nodes.map((node) => {
        const id = elkId(node.id);
        const child = { id, width: sizeOf(node)[0], height: sizeOf(node)[1] + titleH };
        if (horizontal && !node.isGroupBlock) {
            const ports = computeElkPorts(node, id);
            if (hiddenTargets.has(node.id)) {
                ports.push({ id: id + "_hin", layoutOptions: { "elk.port.side": "WEST" }, x: 0, y: titleH / 2, width: 1, height: 1 });
            }
            if (hiddenSources.has(node.id)) {
                ports.push({ id: id + "_hout", layoutOptions: { "elk.port.side": "EAST" }, x: sizeOf(node)[0], y: titleH / 2, width: 1, height: 1 });
            }
            child.ports = ports;
            child.layoutOptions = { "elk.portConstraints": "FIXED_POS" };
        }
        return child;
    });

    const edges = [];
    links.forEach((l, i) => {
        edges.push({ id: "e" + i, sources: [end(l.origin_id, "_out_" + (l.origin_slot ?? 0))], targets: [end(l.target_id, "_in_" + (l.target_slot ?? 0))] });
    });
    hid.forEach((l, i) => {
        edges.push({ id: "h" + i, sources: [end(l.origin_id, "_hout")], targets: [end(l.target_id, "_hin")] });
    });

    let result;
    try {
        result = await new window.ELK().layout({
            id: "root",
            layoutOptions: {
                "elk.algorithm": "layered",
                "elk.direction": RANKDIR_TO_ELK[settings.rankdir] || "RIGHT",
                "elk.spacing.nodeNode": String(settings.nodesep),
                "elk.layered.spacing.nodeNodeBetweenLayers": String(settings.ranksep),
                "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
                // Unlinked chains are separate components: pack them in the
                // order given (`sortChainsByFlow`). Node order inside a chain
                // is left to crossing minimisation.
                "elk.layered.considerModelOrder.components": "MODEL_ORDER",
            },
            children,
            edges,
        });
    } catch (e) {
        console.error("[EnhancementUtils] ELK layout failed:", e);
        return false;
    }

    const placed = new Map((result.children || []).map((c) => [c.id, c]));
    for (const node of nodes) {
        const c = placed.get(elkId(node.id));
        if (c) node.pos = [c.x || 0, (c.y || 0) + titleH];
    }
    return true;
}

/**
 * Advanced's layout of one group's connected items (see `layoutGroupTree`).
 *
 * @param {Object} settings - Layout settings (`getSettings`).
 * @returns {import("./graphArrangeGroups.js").GroupEngine} Resolves false when ELK failed.
 */
export function elkGroupEngine(settings) {
    return async (items, view) => {
        if (!(await runElkLayout(sortChainsByFlow(items, view.flow, view.graph, view.hidden), view.graph, view.hidden, settings))) return false;
        foldChains(items, [...Object.values(view.graph.links || {}), ...view.hidden],
            { horizontal: settings.rankdir !== "TB", along: settings.ranksep, across: settings.nodesep });
        return true;
    };
}

/**
 * Arrange nodes using ELK's layered (Sugiyama) algorithm.
 *
 * Without groups: one port-aware ELK layout of all connected nodes.
 * With groups (two passes):
 * 1. Each group's connected members are laid out by ELK on their own
 *    (unconnected members in a grid below them inside the group); nested
 *    groups first, then as port-less blocks in their parent.
 * 2. Groups and ungrouped connected nodes are blocks; drawn and hidden links
 *    between them give layers (`rankBlocks`) and the order inside a layer
 *    (`orderLayers`). The layers are wrapped into rows (like text) aiming at a
 *    16:9 overall shape (`placeWrappedLayers`).
 * 3. Blocks with no link to any other block (standalone groups) go in a grid
 *    below, then ungrouped unconnected nodes below everything.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {{ rankdir?: string }} [options] - `rankdir` "LR" / "TB" overrides the setting.
 * @returns {Promise<void>}
 */
export async function arrangeELK(graph, options) {
    if (!window.ELK) { console.error("[EnhancementUtils] ELK not loaded."); return; }

    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const settings = getSettings(options);
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;
    const hidden = collectHiddenLinks(graph);
    const flow = computeFlowOrder(graph, hidden);

    // ── No groups: one ELK layout ──────────────────────────────────

    if ((graph._groups || []).length === 0) {
        const { connected, disconnected } = partitionNodes(allNodes);
        if (connected.length > 0 && !(await runElkLayout(sortChainsByFlow(connected, flow, graph, hidden), graph, hidden, settings))) return;
        layoutDisconnectedNodes(disconnected, connected.length ? getGraphBottom(connected) : 0);
        positionSubgraphIO(graph);
        if (typeof graph.change === "function") graph.change();
        graph.setDirtyCanvas(true, true);
        return;
    }

    const resolved = resolveGroups(graph);
    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolved;
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);

    // ── Phase 1: ELK inside each group ─────────────────────────────

    const groupSizes = new Map();
    const engine = elkGroupEngine(settings);
    for (const group of topLevelGroups) {
        const s = await layoutGroupTree(graph, group, resolved, { padding, hidden, flow }, engine);
        if (!s) return;
        groupSizes.set(group, s);
    }

    // ── Phase 2: Blocks in wrapped rows ────────────────────────────

    const sats = findSatellites(graph, nodeToGroup, ungroupedConnected, hidden, settings.nodesep);
    const flowNodes = ungroupedConnected.filter((n) => !sats.ids.has(n.id));
    const blocks = new Map();
    for (const group of topLevelGroups) {
        const s = sats.size(group, groupSizes.get(group));
        blocks.set("group_" + group.id, { id: "group_" + group.id, group, w: s.width, h: s.height });
    }
    for (const node of flowNodes) {
        blocks.set("node_" + node.id, {
            id: "node_" + node.id, node, w: sizeOf(node)[0], h: sizeOf(node)[1] + titleH,
            atEnd: hasNoDrawnInput(node),
        });
    }
    // Loose sources: which blocks they feed through drawn links, and where the
    // fed node sits across the flow inside that block (group offset).
    const horizontalTop = settings.rankdir !== "TB";
    for (const node of flowNodes) {
        const b = blocks.get("node_" + node.id);
        if (!b.atEnd) continue;
        b.feeds = [];
        for (const out of node.outputs || []) {
            for (const lid of out.links || []) {
                const l = typeof graph.links?.get === "function" ? graph.links.get(lid) : graph.links?.[lid];
                const t = l && graph.getNodeById(l.target_id);
                if (!t) continue;
                const group = nodeToGroup.get(t.id);
                if (group && topLevelGroups.includes(group) && t._groupOffsetX != null) {
                    b.feeds.push({ id: "group_" + group.id, offset: horizontalTop ? t._groupOffsetY - titleH : t._groupOffsetX });
                } else if (!group) {
                    b.feeds.push({ id: "node_" + t.id, offset: 0 });
                }
            }
        }
    }
    // Loose sinks (drawn inputs, no drawn output, e.g. Set nodes): which blocks
    // feed them through drawn links, and where the feeding node sits across
    // the flow inside that block.
    const linkOf = (lid) => (typeof graph.links?.get === "function" ? graph.links.get(lid) : graph.links?.[lid]);
    for (const node of flowNodes) {
        const b = blocks.get("node_" + node.id);
        const drawnOut = (node.outputs || []).some((o) => o?.links?.length > 0);
        const ins = (node.inputs || []).filter((i) => i?.link != null);
        if (drawnOut || ins.length === 0) continue;
        b.sink = true;
        b.fedBy = [];
        for (const input of ins) {
            const l = linkOf(input.link);
            const s = l && graph.getNodeById(l.origin_id);
            if (!s) continue;
            const group = nodeToGroup.get(s.id);
            if (group && topLevelGroups.includes(group) && s._groupOffsetX != null) {
                b.fedBy.push({ id: "group_" + group.id, offset: horizontalTop ? s._groupOffsetY - titleH : s._groupOffsetX });
            } else if (!group) {
                b.fedBy.push({ id: "node_" + s.id, offset: 0 });
            } else {
                b.fedBy.push({ id: "?" }); // Fed from somewhere not placed as a block: never pulled back.
            }
        }
    }
    const edges = buildTopLevelEdges(graph, nodeToGroup, flowNodes, hidden);
    const linked = new Set(edges.flatMap((e) => [e.srcTopId, e.tgtTopId]));
    const flowIds = [...blocks.keys()].filter((id) => linked.has(id));
    const standalone = [...blocks.values()].filter((b) => !linked.has(b.id));

    /** Put a block's top-left corner at (x, y). */
    const placeBlock = (b, x, y) => {
        if (b.group) {
            const s = groupSizes.get(b.group);
            placeGroup(b.group, groupNodesMap.get(b.group) || [], x, y, s);
            sats.place(b.group, x, y, s);
        } else {
            b.node.pos = [x, y + titleH];
        }
    };

    let bottom = 0, right = 0;
    if (flowIds.length > 0) {
        const ranked = rankBlocks(flowIds, edges);
        const layers = [];
        for (const id of flowIds) (layers[ranked.level.get(id)] ??= []).push(id);
        const ordered = orderLayers(layers.filter(Boolean), ranked.preds);
        // Loose tails may move back into free space: an ungrouped node whose
        // forward consumers are all loose tails too (none = end of a chain).
        // Groups never move, so the steps of the groups stay aligned.
        const succs = new Map(flowIds.map((id) => [id, []]));
        for (const [id, ps] of ranked.preds) for (const p of ps) succs.get(p)?.push(id);
        const byLevel = [...flowIds].sort((a, b) => ranked.level.get(b) - ranked.level.get(a));
        const tail = new Set();
        for (const id of byLevel) {
            const b = blocks.get(id);
            b.preds = ranked.preds.get(id) || [];
            if (b.node && succs.get(id).every((s) => tail.has(s))) tail.add(id);
            b.chainEnd = tail.has(id);
        }
        const wrapped = placeWrappedLayers(ordered.map((l) => l.map((id) => blocks.get(id))), {
            horizontal: settings.rankdir !== "TB",
            layerGap: settings.ranksep,
            itemGap: settings.nodesep,
            rowGap: settings.ranksep,
            aspect: TARGET_ASPECT,
        });
        for (const [id, p] of wrapped.pos) placeBlock(blocks.get(id), p.x, p.y);
        bottom = wrapped.height;
        right = wrapped.width;
    }

    // ── Phase 3: Standalone blocks, then unconnected nodes, below ──

    if (standalone.length > 0) {
        const rowLimit = Math.max(right, ...standalone.map((b) => b.w));
        let x = 0, y = flowIds.length > 0 ? bottom + settings.ranksep * 2 : 0, rowH = 0;
        for (const b of standalone) {
            if (x > 0 && x + b.w > rowLimit) { x = 0; y += rowH + settings.nodesep; rowH = 0; }
            placeBlock(b, x, y);
            x += b.w + settings.nodesep;
            rowH = Math.max(rowH, b.h);
        }
    }

    const allPositioned = [
        ...ungroupedConnected,
        ...topLevelGroups.flatMap((g) => groupNodesMap.get(g) || []),
    ];
    layoutDisconnectedNodes(disconnected, getLayoutBottom(allPositioned, topLevelGroups), 0);
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}
