/**
 * Graph Arrange -- arranging one group in place ("Arrange (Group)").
 *
 * Only the group's own level is laid out, with the Quick / Smart / Advanced
 * per-group engine: its nodes plus its directly nested groups as rigid blocks
 * (their contents keep their arrangement). The group keeps its top-left
 * corner and resizes to fit; nothing is recentred.
 *
 * The rest of the graph then makes room (`makeRoom`): only what the grown
 * frame would run into moves -- sideways first, then down -- and whatever a
 * moved item runs into moves too, so free space is used before anything is
 * pushed and items not in the way stay put. A group always moves as a whole.
 * When the group sits inside another group whose frame its contents no
 * longer fit, that group grows (never shrinks) and the same happens one
 * level up. Space freed by shrinking is left as is.
 */

import { TITLE_HEIGHT, getSettings, sizeOf } from "./graphArrangeShared.js";
import { collectHiddenLinks, computeFlowOrder } from "./graphArrangeFlow.js";
import { resolveGroups, layoutGroupTree, placeGroup, translateGroup } from "./graphArrangeGroups.js";
import { quickGroupEngine } from "./graphArrangeQuick.js";
import { smartGroupEngine } from "./graphArrangeSmart.js";
import { elkGroupEngine } from "./graphArrangeAdvanced.js";

/** Tolerance for edge comparisons, in graph units. */
const EPS = 0.5;

/** Per-group engines by layout name, and the global each one needs. */
const ENGINES = {
    quick: { make: () => quickGroupEngine() },
    smart: { make: (s) => smartGroupEngine(s), lib: "dagre" },
    advanced: { make: (s) => elkGroupEngine(s), lib: "ELK" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Making Room
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Something that moves as one piece when room is made: a group (with
 * everything inside it), a node, or a subgraph IO node.
 *
 * @typedef {{rect: Array<number>, move: function(number, number): void}} RoomUnit
 */

/**
 * Title-inclusive rect [x, y, w, h] of a node.
 *
 * @param {Object} node - LGraphNode.
 * @returns {Array<number>} Rect.
 */
function nodeRect(node) {
    const titleH = TITLE_HEIGHT();
    const [w, h] = sizeOf(node);
    return [node.pos[0], node.pos[1] - titleH, w, h + titleH];
}

/**
 * Rect [x, y, w, h] of a group frame.
 *
 * @param {Object} group - LiteGraph group.
 * @returns {Array<number>} Rect.
 */
function groupRect(group) {
    return [group.pos[0], group.pos[1], group.size[0], group.size[1]];
}

/**
 * The items sharing a level with `exclude`: inside `container` its own nodes
 * and directly nested groups, at the top level the top-level groups,
 * ungrouped nodes and subgraph IO nodes.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Object} resolved - From `resolveGroups`.
 * @param {Object|null} container - Group whose contents to list, null = top level.
 * @param {Object} exclude - The group making room (not a unit itself).
 * @returns {Array<RoomUnit>} Units.
 */
function levelUnits(graph, resolved, container, exclude) {
    const units = [];
    const groups = container ? resolved.childGroups.get(container) || [] : resolved.topLevelGroups;
    for (const g of groups) {
        if (g === exclude) continue;
        units.push({ rect: groupRect(g), move: (dx, dy) => translateGroup(g, resolved, dx, dy) });
    }
    const nodes = container ? resolved.directMembers.get(container) || [] : resolved.ungroupedNodes;
    for (const n of nodes) {
        units.push({ rect: nodeRect(n), move: (dx, dy) => { n.pos = [n.pos[0] + dx, n.pos[1] + dy]; } });
    }
    if (!container) {
        for (const io of [graph.inputNode, graph.outputNode]) {
            if (!io?.pos || !io.size) continue;
            units.push({
                rect: [io.pos[0], io.pos[1], io.size[0], io.size[1]],
                move: (dx, dy) => {
                    io.pos = [io.pos[0] + dx, io.pos[1] + dy];
                    if (typeof io.arrange === "function") io.arrange();
                },
            });
        }
    }
    return units;
}

/**
 * Push units along one axis (0 = right, 1 = down) out of the way of a frame
 * that changed from `orig` to `cur`. Units are visited in order along the
 * axis; one moves when a frame or already moved unit that was before it
 * (wholly, along the axis) and overlaps it across the axis now reaches into
 * it, and then pushes on in turn. The space kept is the smaller of `gap` and
 * the space there was, so free space is used up before anything moves.
 * Items that already overlapped are left alone.
 *
 * @param {Array<RoomUnit>} units - Units of the level (rects updated in place).
 * @param {{orig: Array<number>, cur: Array<number>}} frame - The changed frame.
 * @param {number} axis - 0 = push right, 1 = push down.
 * @param {number} gap - Preferred space between items.
 * @returns {void}
 */
export function pushAlong(units, frame, axis, gap) {
    const a = axis, b = 1 - axis;
    const movers = [frame];
    const sorted = [...units].sort((p, q) => p.rect[a] - q.rect[a]);
    for (const u of sorted) {
        const r = u.rect;
        let need = r[a];
        for (const m of movers) {
            if (!(m.cur[b] < r[b] + r[b + 2] - EPS && r[b] < m.cur[b] + m.cur[b + 2] - EPS)) continue;
            const end = m.orig[a] + m.orig[a + 2];
            if (end > r[a] + EPS) continue;
            need = Math.max(need, m.cur[a] + m.cur[a + 2] + Math.min(gap, r[a] - end));
        }
        if (need <= r[a] + EPS) continue;
        const orig = [...r];
        const d = need - r[a];
        u.move(a === 0 ? d : 0, a === 1 ? d : 0);
        r[a] += d;
        movers.push({ orig, cur: [...r] });
    }
}

/**
 * Make room for a group whose frame changed from `oldRect` (same top-left):
 * push its neighbours right, then down (`pushAlong`); if it is nested and its
 * parent's contents no longer fit the parent's frame, grow the parent (right
 * and down only) and repeat one level up.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Object} resolved - From `resolveGroups` (taken before the change).
 * @param {Object} group - The changed group.
 * @param {Array<number>} oldRect - Its frame before, [x, y, w, h].
 * @param {{gap: number, padding: number}} opts - Space kept between items;
 *   padding of a parent frame around its contents.
 * @returns {void}
 */
export function makeRoom(graph, resolved, group, oldRect, { gap, padding }) {
    let changed = group, before = oldRect;
    for (;;) {
        const after = groupRect(changed);
        const container = resolved.parentOf.get(changed) || null;
        const units = levelUnits(graph, resolved, container, changed);
        pushAlong(units, { orig: before, cur: after }, 0, gap);
        pushAlong(units, { orig: before, cur: after }, 1, gap);
        if (!container) return;

        const c = groupRect(container);
        let right = c[0] + c[2], bottom = c[1] + c[3];
        for (const r of [after, ...units.map((u) => u.rect)]) {
            right = Math.max(right, r[0] + r[2] + padding);
            bottom = Math.max(bottom, r[1] + r[3] + padding);
        }
        if (right <= c[0] + c[2] + EPS && bottom <= c[1] + c[3] + EPS) return;
        container.size = [right - c[0], bottom - c[1]];
        changed = container;
        before = c;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Arrange One Group
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arrange one group in place with the given layout, then make room for it
 * (see the module comment). Unpins only what gets arranged: the group's own
 * nodes and its directly nested groups; pushed items keep their pin.
 *
 * @param {Object} graph - Graph holding the group (`app.canvas.graph`).
 * @param {Object} group - The group to arrange.
 * @param {"quick"|"smart"|"advanced"} layout - Which layout's per-group engine to use.
 * @param {{ rankdir?: string }} [options] - `rankdir` "LR" / "TB" overrides the setting (Quick is LR only).
 * @returns {Promise<void>}
 */
export async function arrangeGroup(graph, group, layout, options) {
    const kind = ENGINES[layout];
    if (!kind || !group || !(graph?._groups || []).includes(group)) return;
    if (kind.lib && !window[kind.lib]) { console.error(`[EnhancementUtils] ${kind.lib} not loaded.`); return; }

    const settings = getSettings(layout === "quick" ? undefined : options);
    if (layout === "quick") settings.rankdir = "LR";
    const resolved = resolveGroups(graph);
    for (const item of [...(resolved.directMembers.get(group) || []), ...(resolved.childGroups.get(group) || [])]) {
        if (!item?.flags?.pinned) continue;
        if (typeof item.pin === "function") item.pin(false);
        else delete item.flags.pinned;
    }

    const oldRect = groupRect(group);
    const hidden = collectHiddenLinks(graph);
    const flow = computeFlowOrder(graph, hidden);
    const size = await layoutGroupTree(graph, group, resolved,
        { padding: settings.groupPadding, hidden, flow }, kind.make(settings), { recurse: false });
    if (!size) return;
    placeGroup(group, resolved.allMembers.get(group) || [], oldRect[0], oldRect[1], size);
    makeRoom(graph, resolved, group, oldRect, { gap: settings.nodesep, padding: settings.groupPadding });

    if (typeof graph.change === "function") graph.change();
    graph.setDirtyCanvas?.(true, true);
}
