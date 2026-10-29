/**
 * Graph Arrange -- Smart layout (dagre): one straight start-to-finish line.
 *
 * Dagre inside each group, then dagre over groups and ungrouped nodes as
 * blocks; steps and lines share one edge (`alignDagreLines`).
 */

import { MARGIN, TITLE_HEIGHT, getSettings, sizeOf, hasNoDrawnInput, partitionNodes, layoutDisconnectedNodes, getGraphBottom, positionSubgraphIO } from "./graphArrangeShared.js";
import { collectHiddenLinks, computeFlowOrder, sortChainsByFlow } from "./graphArrangeFlow.js";
import { resolveGroups, layoutGroupTree, getLayoutBottom, placeGroup, buildTopLevelEdges, findSatellites } from "./graphArrangeGroups.js";
import { foldChains } from "./graphArrangeFold.js";

// ═══════════════════════════════════════════════════════════════════════════
// Dagre Algorithms
// ═══════════════════════════════════════════════════════════════════════════

/** Dagre edge weight of a drawn link; hidden links weigh 1, so drawn links pull harder. */
const DRAWN_EDGE_WEIGHT = 2;

/** Dagre centres closer than this (graph units) count as one line. */
const LINE_TOLERANCE = 2;

/**
 * Turn dagre's centre alignment into top alignment (LR) / left alignment (TB).
 *
 * Dagre places nodes by their centres and lines up linked nodes on a shared
 * centre line, so a chain of nodes with different heights zigzags along its
 * tops. Here every line (nodes whose dagre centres agree across the flow)
 * gets one top edge, and lines are processed in dagre's order, each packed
 * up as far as the nodes already placed in its steps allow (dagre's spacing
 * is for centred nodes, so a tall node otherwise left half its height empty
 * above the lines beside it). Dagre's steps and its order inside each step
 * are kept, and chains stay straight.
 *
 * @param {Array<{x: number, y: number, w: number, h: number}>} placed - Dagre
 *   centres and box sizes (h includes the title); receives `left` / `top`.
 * @param {boolean} horizontal - Flow runs left to right.
 * @param {number} gap - Minimum space between nodes of one step.
 * @param {string} [tbAlign] - TB only: "left" (default); "right" shares right
 *   edges instead (the same pass on the mirrored axis, so lines get pushed
 *   left); "mixed" = per node: a node with `external` set (fed from outside
 *   the nodes laid out, i.e. from outside the group) takes the line's left
 *   edge, the others its right edge.
 * @returns {void}
 */
function alignDagreLines(placed, horizontal, gap, tbAlign = "left") {
    const flip = !horizontal && tbAlign === "right";
    const mixed = !horizontal && tbAlign === "mixed";
    // u = along the flow (identifies the step), v = across it.
    const items = placed.map((p) => ({
        p,
        step: Math.round(horizontal ? p.x : p.y),
        v: horizontal ? p.y : (flip ? -p.x : p.x),
        half: (horizontal ? p.h : p.w) / 2,
    }));
    items.sort((a, b) => a.v - b.v || a.step - b.step);

    // Lines: runs of nearly equal centres, at most one node per step.
    const lines = [];
    for (const it of items) {
        const line = lines[lines.length - 1];
        if (line && it.v - line.v <= LINE_TOLERANCE && !line.members.some((m) => m.step === it.step)) {
            line.members.push(it);
        } else {
            lines.push({ v: it.v, members: [it] });
        }
    }

    const stepEnd = new Map(); // step -> far edge of the last node placed in it
    const top0 = Math.min(...items.map((it) => it.v - it.half));
    for (const { members } of lines) {
        // Start of each member across the flow: one shared start edge, or
        // (mixed) per node: start edge if fed from outside, else end edge --
        // both within the band of the line's widest member.
        const end = Math.max(...members.map((m) => m.v + m.half));
        const common = Math.min(...members.map((m) => m.v - m.half));
        const startOf = (m) => (mixed && !m.p.external ? end - 2 * m.half : common);
        // Pack the whole line up (left in TB) as far as the nodes already
        // placed in its steps allow; with none, to the top of the layout.
        // Dagre spaced its centres for centred nodes, so a tall node left
        // half its height as empty space above it; packing reclaims that.
        let shift = top0 - common;
        for (const m of members) {
            if (stepEnd.has(m.step)) shift = Math.max(shift, stepEnd.get(m.step) + gap - startOf(m));
        }
        for (const m of members) {
            const start = startOf(m) + shift;
            stepEnd.set(m.step, start + 2 * m.half);
            const along = (horizontal ? m.p.x - m.p.w / 2 : m.p.y - m.p.h / 2);
            const across = flip ? -(start + 2 * m.half) : start;
            [m.p.left, m.p.top] = horizontal ? [along, across] : [across, along];
        }
    }
}

/**
 * Run dagre layout on a set of nodes and their internal edges.
 *
 * @param {Array<Object>} nodes - Nodes to lay out.
 * @param {Object} graphLinks - The graph's links.
 * @param {Object} settings - Layout settings.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - Hidden links (`collectHiddenLinks`).
 * @returns {{ width: number, height: number }} Bounding size of the layout.
 */
function runDagreLayout(nodes, graphLinks, settings, hidden = []) {
    const dagre = window.dagre;
    if (!dagre || nodes.length === 0) return { width: 0, height: 0 };

    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: settings.rankdir, nodesep: settings.nodesep,
        ranksep: settings.ranksep, marginx: 10, marginy: 10,
        // One Brandes-Koepf alignment instead of the average of four: linked
        // nodes it lines up share exactly one centre, which alignDagreLines
        // needs to find the lines (the average leaves them a few px apart).
        align: "UL",
    });
    g.setDefaultEdgeLabel(() => ({}));

    const titleH = TITLE_HEIGHT();
    const nodeIds = new Set();
    // Prefixed keys: graphlib keeps nodes in a plain object, where integer-like
    // keys ("7353") iterate in numeric order, so dagre's start order would be
    // the node ids rather than the order `nodes` is given in (flow order).
    const key = (id) => "n" + id;

    for (const node of nodes) {
        const id = String(node.id);
        nodeIds.add(id);
        g.setNode(key(id), { width: sizeOf(node)[0], height: sizeOf(node)[1] + titleH });
    }

    for (const link of Object.values(graphLinks || {})) {
        if (!link) continue;
        const src = String(link.origin_id), tgt = String(link.target_id);
        if (nodeIds.has(src) && nodeIds.has(tgt)) g.setEdge(key(src), key(tgt), { weight: DRAWN_EDGE_WEIGHT });
    }
    for (const link of hidden) {
        const src = String(link.origin_id), tgt = String(link.target_id);
        if (nodeIds.has(src) && nodeIds.has(tgt) && !g.hasEdge(key(src), key(tgt))) g.setEdge(key(src), key(tgt), { weight: 1 });
    }

    try { dagre.layout(g); } catch (e) {
        console.error("[EnhancementUtils] Dagre layout failed:", e);
        return { width: 0, height: 0 };
    }

    // Nodes fed from outside this set (drawn or hidden link, e.g. a Get whose
    // Set is in another group) -- used by the "mixed" TB alignment.
    const external = new Set();
    for (const link of [...Object.values(graphLinks || {}), ...hidden]) {
        if (!link) continue;
        const src = String(link.origin_id), tgt = String(link.target_id);
        if (nodeIds.has(tgt) && !nodeIds.has(src)) external.add(tgt);
    }

    const placed = [];
    for (const node of nodes) {
        const dn = g.node(key(node.id));
        if (dn) {
            placed.push({ node, x: dn.x, y: dn.y, w: sizeOf(node)[0], h: sizeOf(node)[1] + titleH,
                external: external.has(String(node.id)) });
        }
    }
    alignDagreLines(placed, settings.rankdir !== "TB", settings.nodesep, settings.tbAlign);
    for (const p of placed) p.node.pos = [p.left, p.top + titleH];

    const info = g.graph();
    return { width: info.width || 0, height: info.height || 0 };
}

/**
 * Arrange all nodes using dagre (ignores groups).
 *
 * @param {Object} graph - Graph being arranged.
 * @param {{ rankdir?: string }} [options] - `rankdir` "LR" / "TB" overrides the setting.
 * @returns {void}
 */
export function arrangeDagre(graph, options) {
    if (!window.dagre) { console.error("[EnhancementUtils] dagre not loaded."); return; }
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;

    const settings = getSettings(options);
    const { connected, disconnected } = partitionNodes(allNodes);

    if (connected.length === 0) {
        layoutDisconnectedNodes(disconnected, 0);
    } else {
        const hidden = collectHiddenLinks(graph);
        runDagreLayout(sortChainsByFlow(connected, computeFlowOrder(graph, hidden), graph, hidden), graph.links, settings, hidden);
        layoutDisconnectedNodes(disconnected, getGraphBottom(connected));
    }
    positionSubgraphIO(graph);
    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas(true, true);
}

/**
 * Smart's layout of one group's connected items (see `layoutGroupTree`).
 *
 * @param {Object} settings - Layout settings (`getSettings`).
 * @returns {import("./graphArrangeGroups.js").GroupEngine}
 */
export function smartGroupEngine(settings) {
    return (items, view) => {
        runDagreLayout(sortChainsByFlow(items, view.flow, view.graph, view.hidden), view.graph.links, settings, view.hidden);
        foldChains(items, [...Object.values(view.graph.links || {}), ...view.hidden],
            { horizontal: settings.rankdir !== "TB", along: settings.ranksep, across: settings.nodesep });
    };
}

/**
 * Arrange nodes using dagre respecting group boundaries.
 *
 * Phase 1: Dagre layout within each group (nested groups first, then as
 *          blocks in their parent).
 * Phase 2: Dagre layout of groups as mega-nodes + ungrouped nodes.
 * Phase 3: Disconnected nodes below.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {{ rankdir?: string }} [options] - `rankdir` "LR" / "TB" overrides the setting.
 * @returns {Promise<void>}
 */
export async function arrangeDagreGroups(graph, options) {
    if (!window.dagre) { console.error("[EnhancementUtils] dagre not loaded."); return; }
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;
    if ((graph._groups || []).length === 0) { arrangeDagre(graph, options); return; }

    const settings = getSettings(options);
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;

    const resolved = resolveGroups(graph);
    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolved;
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);
    const hidden = collectHiddenLinks(graph);

    // ── Phase 1: Layout within each group ──────────────────────────

    const groupSizes = new Map();

    const flow = computeFlowOrder(graph, hidden);
    const engine = smartGroupEngine(settings);
    for (const group of topLevelGroups) {
        groupSizes.set(group, await layoutGroupTree(graph, group, resolved, { padding, hidden, flow }, engine));
    }

    // ── Phase 2: Top-level dagre layout ────────────────────────────

    const dagre = window.dagre;
    const topG = new dagre.graphlib.Graph();
    topG.setGraph({
        rankdir: settings.rankdir, nodesep: settings.nodesep,
        ranksep: settings.ranksep, marginx: MARGIN, marginy: MARGIN,
        acyclicer: "greedy",
    });
    topG.setDefaultEdgeLabel(() => ({}));

    const sats = findSatellites(graph, nodeToGroup, ungroupedConnected, hidden, settings.nodesep);
    const flowNodes = ungroupedConnected.filter((n) => !sats.ids.has(n.id));
    const blockSizes = new Map(topLevelGroups.map((g) => [g, sats.size(g, groupSizes.get(g))]));

    for (const group of topLevelGroups) {
        const s = blockSizes.get(group);
        topG.setNode("group_" + group.id, { width: s.width, height: s.height });
    }
    for (const node of flowNodes) {
        topG.setNode("node_" + node.id, { width: sizeOf(node)[0], height: sizeOf(node)[1] + titleH });
    }

    // Weight = number of links (drawn ones count double). The greedy acyclicer
    // reverses the lightest edges of a loop, so a group feeding another
    // through many links stays first (dagre's default ignores weights).
    const topEdges = buildTopLevelEdges(graph, nodeToGroup, flowNodes, hidden);
    for (const { srcTopId, tgtTopId, hidden: isHidden, weight } of topEdges) {
        topG.setEdge(srcTopId, tgtTopId, { weight: weight * (isHidden ? 1 : DRAWN_EDGE_WEIGHT) });
    }

    try { dagre.layout(topG); } catch (e) {
        console.error("[EnhancementUtils] Dagre top-level layout failed:", e);
        return;
    }

    // ── Phase 3: Apply positions ───────────────────────────────────

    // Dagre centres every step across the flow, so blocks of different sizes
    // zigzag. Keep its steps and its order inside each step, but start every
    // step at the same edge (top in LR, left in TB) and at the start of the
    // step along the flow: the first block of each step sits on one straight
    // line from start to finish. Loose nodes with no drawn input go to the
    // end of the step instead (`hasNoDrawnInput`).
    const horizontal = settings.rankdir !== "TB";
    const blocks = [
        ...topLevelGroups.map((group) => {
            const b = blockSizes.get(group);
            return { id: "group_" + group.id, group, w: b.width, h: b.height };
        }),
        ...flowNodes.map((node) => ({
            id: "node_" + node.id, node, w: sizeOf(node)[0], h: sizeOf(node)[1] + titleH,
            atEnd: hasNoDrawnInput(node),
        })),
    ];
    const steps = new Map();
    for (const b of blocks) {
        const dn = topG.node(b.id);
        if (!dn) continue;
        const key = Math.round(horizontal ? dn.x : dn.y);
        if (!steps.has(key)) steps.set(key, []);
        steps.get(key).push({ ...b, order: horizontal ? dn.y : dn.x });
    }
    const main = (b) => (horizontal ? b.w : b.h);
    const cross = (b) => (horizontal ? b.h : b.w);
    const keys = [...steps.keys()].sort((a, b) => a - b);
    const split = keys.map((key) => {
        const step = steps.get(key).sort((a, b) => a.order - b.order);
        return { blocks: step.filter((b) => !b.atEnd), srcs: step.filter((b) => b.atEnd) };
    });

    // Across the flow: regular blocks stacked from the shared edge.
    // TB with tbAlign "right": every step ends at the same right edge instead.
    const crossOf = (st) => st.reduce((s, b) => s + cross(b) + settings.nodesep, -settings.nodesep);
    const alignEnd = !horizontal && settings.tbAlign === "right";
    const endEdge = MARGIN + Math.max(0, ...split.map((s) => crossOf(s.blocks)));
    const crossPos = new Map();
    for (const { blocks: st } of split) {
        let v = alignEnd ? endEdge - crossOf(st) : MARGIN;
        for (const b of st) { crossPos.set(b, v); v += cross(b) + settings.nodesep; }
    }

    // Loose sources line up across the flow with the first node they feed
    // (in a group: that member), packed so they don't overlap.
    const blockOfNode = new Map();
    for (const { blocks: st } of split) {
        for (const b of st) {
            if (b.node) blockOfNode.set(b.node.id, b);
            else for (const n of groupNodesMap.get(b.group) || []) blockOfNode.set(n.id, b);
        }
    }
    const wantedCross = (src) => {
        let best = Infinity;
        for (const out of src.node.outputs || []) {
            for (const lid of out.links || []) {
                const l = typeof graph.links?.get === "function" ? graph.links.get(lid) : graph.links?.[lid];
                const t = l && graph.getNodeById(l.target_id);
                const b = t && blockOfNode.get(t.id);
                if (!b || !crossPos.has(b)) continue;
                let c = crossPos.get(b);
                if (b.group && t._groupOffsetX != null) c += horizontal ? t._groupOffsetY - titleH : t._groupOffsetX;
                best = Math.min(best, c);
            }
        }
        return best;
    };

    // Loose tails: an ungrouped node whose forward consumers (later steps) are
    // all loose tails too -- a chain of loose nodes leading to no group. They
    // move back into free space instead of waiting behind the longest block
    // of the previous step; groups never move, so the straight line stays.
    const stepOf = new Map();
    split.forEach(({ blocks: st, srcs }, i) => { for (const b of [...st, ...srcs]) stepOf.set(b.id, i); });
    const succs = new Map(), preds = new Map();
    for (const { srcTopId: a, tgtTopId: b } of topEdges) {
        if (!stepOf.has(a) || !stepOf.has(b) || stepOf.get(b) <= stepOf.get(a)) continue;
        if (!succs.has(a)) succs.set(a, new Set());
        if (!preds.has(b)) preds.set(b, new Set());
        succs.get(a).add(b);
        preds.get(b).add(a);
    }
    const tail = new Set();
    for (let i = split.length - 1; i >= 0; i--) {
        for (const b of split[i].blocks) {
            if (b.node && [...(succs.get(b.id) || [])].every((s) => tail.has(s))) tail.add(b.id);
        }
    }
    /** Placed blocks: along-flow end `u1`, across [c0, c1]. */
    const placed = new Map();

    let u = MARGIN;
    for (const { blocks: st, srcs } of split) {
        const start = new Map();
        for (const b of st) {
            let s = u;
            if (tail.has(b.id)) {
                const c0 = crossPos.get(b), c1 = c0 + cross(b);
                s = MARGIN;
                for (const q of placed.values()) if (q.c0 < c1 && c0 < q.c1) s = Math.max(s, q.u1 + settings.ranksep);
                for (const id of preds.get(b.id) || []) {
                    const q = placed.get(id);
                    if (q) s = Math.max(s, q.u1 + settings.ranksep);
                }
                s = Math.min(s, u);
            }
            start.set(b, s);
        }
        const mainMax = Math.max(0, ...st.map((b) => start.get(b) + main(b) - u));
        // Sources: at the end of the step where that is free, else in a band
        // of their own right after it (before the step they feed).
        let band = [];
        if (srcs.length) {
            const fallback = st.length ? crossPos.get(st[st.length - 1]) + cross(st[st.length - 1]) + settings.nodesep : MARGIN;
            const want = srcs.map((b, i) => ({ b, i, c: wantedCross(b) })).map((s) => ({ ...s, c: Number.isFinite(s.c) ? s.c : fallback }));
            want.sort((p, q) => (p.c - q.c) || (p.i - q.i));
            let next = -Infinity;
            for (const s of want) {
                const c = Math.max(s.c, next);
                band.push({ b: s.b, c });
                next = c + cross(s.b) + settings.nodesep;
            }
        }
        const bandT = Math.max(0, ...band.map((s) => main(s.b)));
        const stepLen = Math.max(mainMax, bandT);
        // In the step, a source spans [end - its length, end] along the flow.
        const collides = band.some(({ b, c }) => st.some((r) => {
            const r0 = crossPos.get(r);
            return start.get(r) + main(r) > u + stepLen - main(b) && r0 < c + cross(b) && c < r0 + cross(r);
        }));
        const bandStart = collides ? u + mainMax + settings.nodesep : null;

        const put = (b, bu, v) => {
            const [x, y] = horizontal ? [bu, v] : [v, bu];
            if (b.group) {
                const s = groupSizes.get(b.group);
                placeGroup(b.group, groupNodesMap.get(b.group) || [], x, y, s);
                sats.place(b.group, x, y, s);
            } else {
                b.node.pos = [x, y + titleH];
            }
        };
        for (const b of st) {
            const s = start.get(b), c0 = crossPos.get(b);
            put(b, s, c0);
            placed.set(b.id, { u1: s + main(b), c0, c1: c0 + cross(b) });
        }
        for (const { b, c } of band) {
            // Ends where the step / band ends, next to what it feeds.
            const end = collides ? bandStart + bandT : u + stepLen;
            put(b, end - main(b), c);
            placed.set(b.id, { u1: end, c0: c, c1: c + cross(b) });
        }
        u = (collides ? bandStart + bandT : u + stepLen) + settings.ranksep;
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
