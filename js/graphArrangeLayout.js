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
 * 3. Advanced (ELK)          -- `arrangeELK`: ELK inside each group, groups placed in wrapped rows (16:9).
 * Dagre and ELK take an optional `{ rankdir: "LR" | "TB" }` (one menu entry per direction).
 * Menu callbacks wrap them in `withPreservedCenter`.
 *
 * Besides drawn links, all three layouts order by hidden links
 * (`collectHiddenLinks`: Set/Get-style virtual nodes, Use Everywhere).
 */

import { readUseEverywhereLinks } from "./flowGraph.js";

export const DEFAULTS = {
    rankdir: "LR",
    nodesep: 50,
    ranksep: 80,
    groupPadding: 30,
    /**
     * Smart Top-Bottom: nodes and groups share their "left" or "right" edge;
     * "mixed" = nodes fed from outside their group left, the rest right.
     */
    tbAlign: "mixed",
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
 * @param {{ rankdir?: string }} [options] - Per-call options; a valid `rankdir`
 *   ("LR" / "TB", chosen from the menu entry) overrides the settings source.
 * @returns {{ rankdir: string, nodesep: number, ranksep: number, groupPadding: number }}
 */
function getSettings(options) {
    let s = null;
    try {
        s = settingsSource();
    } catch {
        s = null;
    }
    const merged = { ...DEFAULTS, ...(s || {}) };
    const dir = options?.rankdir;
    if (dir === "LR" || dir === "TB") merged.rankdir = dir;
    return merged;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Size a node takes on screen, without its title bar: `[width, bodyHeight]`.
 * A collapsed node is only its title (body height 0, the collapsed width --
 * Set/Get nodes are usually collapsed, and laying them out at their full
 * `size` left big gaps). Otherwise the rendered size (`renderingSize`, which
 * includes Vue content growth), falling back to `size`.
 *
 * @param {Object} node - LGraphNode.
 * @returns {Array<number>} [width, height].
 */
function sizeOf(node) {
    const lg = globalThis.LiteGraph;
    if (node.flags?.collapsed && !lg?.vueNodesMode) {
        return [node._collapsed_width || lg?.NODE_COLLAPSED_WIDTH || 80, 0];
    }
    try {
        const s = node.renderingSize;
        if (s && s[0] > 0 && s[1] >= 0) return [s[0], s[1]];
    } catch {
        // Fall back to the stored size.
    }
    return [node.size[0], node.size[1]];
}

/**
 * Whether a node has no drawn input link (a source: loaders, Get nodes fed
 * only by hidden links...). At the top level such a loose node sits at the
 * end of its step, next to what it feeds -- a step is as long as its longest
 * block (often a group), and at the start the node's links crossed it all.
 *
 * @param {Object} node - LGraphNode.
 * @returns {boolean} True when no input has a link.
 */
function hasNoDrawnInput(node) {
    return !(node.inputs || []).some((input) => input?.link != null);
}

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
        x += sizeOf(node)[0] + MARGIN;
        rowH = Math.max(rowH, sizeOf(node)[1] + titleH);
        col++;
    }
}

/** Get the bottom Y extent of positioned nodes. */
function getGraphBottom(nodes) {
    let maxY = 0;
    const titleH = TITLE_HEIGHT();
    for (const node of nodes) {
        maxY = Math.max(maxY, node.pos[1] + sizeOf(node)[1] + titleH);
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

/** Get the bounding box of positioned nodes. */
function getNodesBounds(nodes) {
    const titleH = TITLE_HEIGHT();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
        minX = Math.min(minX, node.pos[0]);
        minY = Math.min(minY, node.pos[1] - titleH);
        maxX = Math.max(maxX, node.pos[0] + sizeOf(node)[0]);
        maxY = Math.max(maxY, node.pos[1] + sizeOf(node)[1]);
    }
    return { minX, minY, maxX, maxY };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hidden Links
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Connections between nodes of one graph that are not drawn as links, as
 * layout-only edges:
 * - Virtual nodes (Set/Get style): `resolveVirtualOutput(slot)` -> edge from
 *   the returned source node; otherwise an instance `getInputLink(slot)` that
 *   returns a link into ANOTHER node (the setter) -> edge setter -> node.
 *   Same generic hooks the frontend and the Flow Visualizer use; no node type
 *   names. A broken Get node may show its own alert when asked.
 * - Use Everywhere (`graph.extra.ue_links`): edge broadcaster (or the source
 *   when there is none) -> receiving node.
 * Edges to nodes of other graphs, self edges and duplicates are dropped.
 * Never throws.
 *
 * @param {Object} graph - Graph being arranged.
 * @returns {Array<{origin_id: *, target_id: *}>} Edges, with the nodes' own ids.
 */
export function collectHiddenLinks(graph) {
    const nodes = graph?._nodes || [];
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const out = [];
    const seen = new Set();
    /** Add an edge between two nodes of this graph (objects or ids). */
    const add = (from, to) => {
        const a = typeof from === "object" ? from : byId.get(String(from));
        const b = typeof to === "object" ? to : byId.get(String(to));
        if (!a || !b || a === b) return;
        if (byId.get(String(a.id)) !== a || byId.get(String(b.id)) !== b) return; // Other graph.
        const key = a.id + ">" + b.id;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ origin_id: a.id, target_id: b.id });
    };

    for (const node of nodes) {
        if (!node?.isVirtualNode || node.subgraph) continue;
        const slots = Math.max(1, (node.outputs || []).length);
        for (let slot = 0; slot < slots; slot++) {
            try {
                const source = typeof node.resolveVirtualOutput === "function" ? node.resolveVirtualOutput(slot) : null;
                if (source?.node) {
                    add(source.node, node);
                    continue;
                }
                const link = typeof node.getInputLink === "function" ? node.getInputLink(slot) : null;
                if (link && String(link.target_id) !== String(node.id)) add(link.target_id, node);
            } catch {
                // A broken hook just contributes no edge.
            }
        }
    }

    try {
        for (const l of readUseEverywhereLinks(graph)) add(l.via ?? l.origin, l.target);
    } catch {
        // Malformed UE data: ignore.
    }
    return out;
}

/**
 * Bridge links for laying out one group's contents: when a path leaves the
 * group at member A and comes back in at member B through ungrouped nodes
 * only (drawn or Set/Get links), A -> B counts as a link inside the group.
 * Without it the group layout only sees the cut: B looks like a start node
 * and lands in the first column, though its data arrives after A. E.g. a
 * chain that runs out of the group through one loose node and back in.
 *
 * Paths through another group don't count: the order between groups
 * already shows that, and in a hub group (a settings group whose values
 * come back via Gets after a detour through later groups) such bridges
 * pushed every returning chain into its own late column, leaving large
 * empty areas.
 *
 * Never creates loops: the workflow is acyclic, so a path A -> ... -> B
 * means B runs after A. Returned in the `collectHiddenLinks` format; pass
 * them along with the hidden links (they weigh like hidden links).
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Array<Object>} members - The group's nodes.
 * @param {Array<{origin_id: *, target_id: *}>} hidden - From `collectHiddenLinks`.
 * @param {Map<*, Object>} [nodeToGroup] - Node id -> top-level group (from
 *   `resolveGroups`); the path stops at any node in it that isn't a member.
 * @returns {Array<{origin_id: *, target_id: *}>} One link per (A, B) pair, ids as on the nodes.
 */
export function collectBridgeLinks(graph, members, hidden = [], nodeToGroup = new Map()) {
    const grouped = new Set([...nodeToGroup.keys()].map(String));
    const memberById = new Map(members.map((n) => [String(n.id), n]));
    const out = new Map(); // node id -> successor ids (drawn + hidden)
    for (const l of [...Object.values(graph.links || {}), ...hidden]) {
        if (!l) continue;
        const a = String(l.origin_id), b = String(l.target_id);
        if (!out.has(a)) out.set(a, []);
        out.get(a).push(b);
    }
    const bridges = [];
    for (const [id, node] of memberById) {
        const seen = new Set();
        const found = new Set();
        // Start from the member's ungrouped successors; never enter another group.
        const stack = (out.get(id) || []).filter((s) => !memberById.has(s) && !grouped.has(s));
        while (stack.length) {
            const cur = stack.pop();
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const next of out.get(cur) || []) {
                if (memberById.has(next)) {
                    if (next !== id) found.add(next); // Back in the group: stop here.
                } else if (!seen.has(next) && !grouped.has(next)) {
                    stack.push(next);
                }
            }
        }
        for (const t of found) bridges.push({ origin_id: node.id, target_id: memberById.get(t).id });
    }
    return bridges;
}

/**
 * Where every node sits in the flow of the whole graph, for ordering nodes
 * the layout itself can't tell apart (same column, no links between them --
 * e.g. two chains in a group fed from different places).
 *
 * `from` = longest path from a node with no inputs (counting starts at the
 * beginning: such a node is 0); `to` = longest path to a node with no
 * outputs. Over drawn and hidden links of the whole graph, ignoring group
 * boundaries, so a Get fed by a Set in an early group gets a low `from` and
 * a node fed back from late in the graph a high one. Loops (only possible
 * through muted/broken nodes) are broken at the remaining node with the
 * fewest open inputs.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - From `collectHiddenLinks`.
 * @returns {Map<string, {from: number, to: number}>} Keyed by `String(node.id)`.
 */
export function computeFlowOrder(graph, hidden = []) {
    const nodes = (graph._nodes || []).map((n) => String(n.id));
    const known = new Set(nodes);
    const succ = new Map(nodes.map((id) => [id, new Set()]));
    const pred = new Map(nodes.map((id) => [id, new Set()]));
    for (const l of [...Object.values(graph.links || {}), ...hidden]) {
        if (!l) continue;
        const a = String(l.origin_id), b = String(l.target_id);
        if (a === b || !known.has(a) || !known.has(b)) continue;
        succ.get(a).add(b);
        pred.get(b).add(a);
    }

    // Topological order (Kahn); loops broken at the fewest open inputs.
    const open = new Map(nodes.map((id) => [id, pred.get(id).size]));
    const done = new Set();
    const order = [];
    const queue = nodes.filter((id) => open.get(id) === 0);
    while (order.length < nodes.length) {
        if (queue.length === 0) {
            let pick = null;
            for (const id of nodes) if (!done.has(id) && (pick === null || open.get(id) < open.get(pick))) pick = id;
            queue.push(pick);
        }
        const id = queue.shift();
        if (done.has(id)) continue;
        done.add(id);
        order.push(id);
        for (const s of succ.get(id)) {
            open.set(s, open.get(s) - 1);
            if (open.get(s) === 0 && !done.has(s)) queue.push(s);
        }
    }

    const pos = new Map(order.map((id, i) => [id, i]));
    const res = new Map(nodes.map((id) => [id, { from: 0, to: 0 }]));
    for (const id of order) {
        for (const p of pred.get(id)) {
            if (pos.get(p) < pos.get(id)) res.get(id).from = Math.max(res.get(id).from, res.get(p).from + 1);
        }
    }
    for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        for (const s of succ.get(id)) {
            if (pos.get(s) > i) res.get(id).to = Math.max(res.get(id).to, res.get(s).to + 1);
        }
    }
    return res;
}

/**
 * Rank of each separate chain among `nodes`, by its place in the flow of the
 * whole graph. Chains = groups of nodes joined by links among `nodes` (drawn,
 * hidden, bridges). A chain whose earliest node sits earlier in the graph
 * (lowest `from`) ranks first; then the one with more still ahead (highest
 * `to`, so of two unfed chains the longer one); then the order of its first
 * node in `nodes`. Only whole chains are ordered -- nodes within a chain keep
 * the order they come in, so the layouts' own placement inside a chain is
 * untouched (sorting every node by flow scattered Gets around the node they
 * feed and moved chains for no gain).
 *
 * @param {Array<Object>} nodes - Nodes being laid out together.
 * @param {Map<string, {from: number, to: number}>} flow - From `computeFlowOrder`.
 * @param {Object} graph - For drawn links.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - Hidden + bridge links.
 * @returns {Map<string, number>} `String(node.id)` -> chain rank (0 = first).
 */
function chainRanks(nodes, flow, graph, hidden = []) {
    const ids = nodes.map((n) => String(n.id));
    const known = new Set(ids);
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (id) => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
    for (const l of [...Object.values(graph.links || {}), ...hidden]) {
        if (!l) continue;
        const a = String(l.origin_id), b = String(l.target_id);
        if (known.has(a) && known.has(b)) parent.set(find(a), find(b));
    }
    const chains = new Map(); // root -> { from, to, first }
    ids.forEach((id, i) => {
        const at = flow.get(id) || { from: 0, to: 0 };
        const c = chains.get(find(id));
        if (!c) chains.set(find(id), { from: at.from, to: at.to, first: i });
        else { c.from = Math.min(c.from, at.from); c.to = Math.max(c.to, at.to); }
    });
    const order = [...chains.entries()].sort(([, a], [, b]) => (a.from - b.from) || (b.to - a.to) || (a.first - b.first));
    const rankOf = new Map(order.map(([root], i) => [root, i]));
    return new Map(ids.map((id) => [id, rankOf.get(find(id))]));
}

/**
 * `nodes` with whole chains sorted by `chainRanks`, nodes within a chain in
 * their given order (stable sort). The layouts keep this as their start order.
 *
 * @param {Array<Object>} nodes - Nodes to sort (not modified).
 * @param {Map<string, {from: number, to: number}>} flow - From `computeFlowOrder`.
 * @param {Object} graph - For drawn links.
 * @param {Array<{origin_id: *, target_id: *}>} [hidden] - Hidden + bridge links.
 * @returns {Array<Object>} Sorted copy.
 */
function sortChainsByFlow(nodes, flow, graph, hidden = []) {
    const rank = chainRanks(nodes, flow, graph, hidden);
    return [...nodes].sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
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
function buildTopLevelEdges(graph, nodeToGroup, ungroupedConnected, hidden = []) {
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
function findSatellites(graph, nodeToGroup, ungroupedConnected, hidden, gap) {
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

/**
 * Assign columns to top-level blocks (groups / ungrouped nodes) from the
 * edges between them, Quick-layout style:
 * 1. Topological order (Kahn). When only cycles remain, the loop is broken by
 *    link count (Eades-Lin-Smyth style): the remaining block whose links to
 *    other remaining blocks go out most and come in least (out weight minus
 *    in weight; then the lower in weight, then earliest in `ids`) goes next,
 *    and its unprocessed inputs become back edges. So when group A feeds B
 *    through four links and B feeds A through one, only that one points back.
 * 2. Longest path from the sources over the forward edges.
 * 3. Pull every block with consumers right up to one column before its
 *    nearest consumer (like `floatRightLayout`), so feeders sit next to
 *    what they feed.
 * Deterministic for a given structure, so re-running moves nothing.
 *
 * @param {Array<string>} ids - Block ids in a stable order.
 * @param {Array<{srcTopId: string, tgtTopId: string, weight?: number}>} edges - Block
 *   edges; `weight` (default 1) = number of links behind the edge.
 * @returns {{ level: Map<string, number>, preds: Map<string, Array<string>> }}
 *   Column per block (0-based) and forward-edge predecessors per block.
 */
function rankBlocks(ids, edges) {
    const index = new Map(ids.map((id, i) => [id, i]));
    const outs = new Map(ids.map((id) => [id, []]));
    const ins = new Map(ids.map((id) => [id, []]));
    const indeg = new Map(ids.map((id) => [id, 0]));
    for (const { srcTopId: a, tgtTopId: b, weight = 1 } of edges) {
        if (!index.has(a) || !index.has(b) || a === b) continue;
        outs.get(a).push(b);
        ins.get(b).push([a, weight]);
        indeg.set(b, indeg.get(b) + 1);
    }
    const outW = new Map(ids.map((id) => [id, []]));
    for (const [b, list] of ins) for (const [a, w] of list) outW.get(a).push([b, w]);

    const done = new Set();
    const order = [];
    const ready = ids.filter((id) => indeg.get(id) === 0);
    /** Sum of weights to blocks not yet placed. */
    const open = (list) => list.reduce((s, [o, w]) => (done.has(o) ? s : s + w), 0);
    while (order.length < ids.length) {
        if (ready.length === 0) {
            // Cycle: place the block that most clearly comes first by link count.
            let pick = null, pickScore = 0, pickIn = 0;
            for (const id of ids) {
                if (done.has(id)) continue;
                const inW = open(ins.get(id));
                const score = open(outW.get(id)) - inW;
                if (pick === null || score > pickScore || (score === pickScore && inW < pickIn)) {
                    pick = id; pickScore = score; pickIn = inW;
                }
            }
            ready.push(pick);
        }
        ready.sort((a, b) => index.get(a) - index.get(b));
        const id = ready.shift();
        if (done.has(id)) continue;
        done.add(id);
        order.push(id);
        for (const t of outs.get(id)) {
            if (done.has(t)) continue;
            indeg.set(t, indeg.get(t) - 1);
            if (indeg.get(t) === 0) ready.push(t);
        }
    }

    const pos = new Map(order.map((id, i) => [id, i]));
    const fwdOuts = new Map(ids.map((id) => [id, []]));
    const preds = new Map(ids.map((id) => [id, []]));
    for (const id of ids) {
        for (const t of outs.get(id)) {
            if (pos.get(t) > pos.get(id) && !fwdOuts.get(id).includes(t)) {
                fwdOuts.get(id).push(t);
                preds.get(t).push(id);
            }
        }
    }

    const level = new Map(ids.map((id) => [id, 0]));
    for (const id of order) {
        for (const t of fwdOuts.get(id)) level.set(t, Math.max(level.get(t), level.get(id) + 1));
    }
    for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        const consumers = fwdOuts.get(id);
        if (consumers.length) level.set(id, Math.min(...consumers.map((t) => level.get(t))) - 1);
    }
    return { level, preds };
}

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
 * Arrange nodes using dagre respecting group boundaries.
 *
 * Phase 1: Dagre layout within each group.
 * Phase 2: Dagre layout of groups as mega-nodes + ungrouped nodes.
 * Phase 3: Disconnected nodes below.
 *
 * @param {Object} graph - Graph being arranged.
 * @param {{ rankdir?: string }} [options] - `rankdir` "LR" / "TB" overrides the setting.
 * @returns {void}
 */
export function arrangeDagreGroups(graph, options) {
    if (!window.dagre) { console.error("[EnhancementUtils] dagre not loaded."); return; }
    const allNodes = graph._nodes || [];
    if (allNodes.length === 0) return;
    if ((graph._groups || []).length === 0) { arrangeDagre(graph, options); return; }

    const settings = getSettings(options);
    const titleH = TITLE_HEIGHT();
    const padding = settings.groupPadding;

    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolveGroups(graph);
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);
    const hidden = collectHiddenLinks(graph);

    // ── Phase 1: Layout within each group ──────────────────────────

    const groupSizes = new Map();

    const flow = computeFlowOrder(graph, hidden);
    for (const group of topLevelGroups) {
        const nodes = groupNodesMap.get(group) || [];
        groupSizes.set(group, layoutGroupContents(group, nodes, padding,
            (gc) => {
                const links = [...hidden, ...collectBridgeLinks(graph, nodes, hidden, nodeToGroup)];
                return runDagreLayout(sortChainsByFlow(gc, flow, graph, links), graph.links, settings, links);
            }));
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

    const children = nodes.map((node) => {
        const id = elkId(node.id);
        const child = { id, width: sizeOf(node)[0], height: sizeOf(node)[1] + titleH };
        if (horizontal) {
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
        edges.push(horizontal
            ? { id: "e" + i, sources: [elkId(l.origin_id) + "_out_" + (l.origin_slot ?? 0)], targets: [elkId(l.target_id) + "_in_" + (l.target_slot ?? 0)] }
            : { id: "e" + i, sources: [elkId(l.origin_id)], targets: [elkId(l.target_id)] });
    });
    hid.forEach((l, i) => {
        edges.push(horizontal
            ? { id: "h" + i, sources: [elkId(l.origin_id) + "_hout"], targets: [elkId(l.target_id) + "_hin"] }
            : { id: "h" + i, sources: [elkId(l.origin_id)], targets: [elkId(l.target_id)] });
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
 * Order the blocks inside each layer to reduce crossings: barycenter sweeps
 * (down using predecessors, up using successors). A block without neighbours
 * in the reference layer keeps its place. Deterministic.
 *
 * @param {Array<Array<string>>} layers - Block ids per layer (start order).
 * @param {Map<string, Array<string>>} preds - Forward-edge predecessors (from `rankBlocks`).
 * @returns {Array<Array<string>>} Reordered layers.
 */
function orderLayers(layers, preds) {
    const succs = new Map();
    for (const [id, ps] of preds) for (const p of ps) (succs.get(p) || succs.set(p, []).get(p)).push(id);
    const pos = new Map();
    const index = () => layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
    index();
    for (let sweep = 0; sweep < 4; sweep++) {
        const down = sweep % 2 === 0;
        const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
        for (const li of order) {
            const layer = layers[li];
            if (layer.length < 2) continue;
            const keyed = layer.map((id, i) => {
                const ns = ((down ? preds : succs).get(id) || []).filter((n) => pos.has(n));
                const bary = ns.length ? ns.reduce((s, n) => s + pos.get(n), 0) / ns.length : i;
                return { id, i, bary };
            });
            keyed.sort((a, b) => (a.bary - b.bary) || (a.i - b.i));
            layers[li] = keyed.map((k) => k.id);
            layers[li].forEach((id, i) => pos.set(id, i));
        }
    }
    return layers;
}

/**
 * Place layers of blocks along the flow direction, wrapped into rows like
 * lines of text: every row runs with the flow and starts again at the
 * beginning (rows that alternated direction made every link in a backwards
 * row enter its node from the far side, and in TB put single groups at the
 * bottom of their column). The number of rows is the one whose bounding box
 * is closest to `aspect`; layers are split into rows of near-equal length.
 * Coordinates start at the origin.
 *
 * Left-to-right: layers are columns, rows stack downwards. Top-to-bottom:
 * layers are rows, bands stack to the right, each starting at the top.
 *
 * @param {Array<Array<{id: string, w: number, h: number, atEnd?: boolean, chainEnd?: boolean, preds?: Array<string>, feeds?: Array<{id: string, offset: number}>}>>} layers
 *   Blocks per layer, in order. `atEnd` (loose sources) go to the end of their
 *   step, across the flow level with the block they `feeds`. `chainEnd` blocks
 *   (no forward consumer) move back along the flow into free space, after
 *   whatever is in their way across the flow and after their `preds`.
 * @param {{horizontal: boolean, layerGap: number, itemGap: number, rowGap: number, aspect: number}} opts
 * @returns {{ pos: Map<string, {x: number, y: number}>, width: number, height: number, rows: number }}
 */
export function placeWrappedLayers(layers, opts) {
    const { horizontal, layerGap, itemGap, rowGap, aspect } = opts;
    const main = (b) => (horizontal ? b.w : b.h);
    const cross = (b) => (horizontal ? b.h : b.w);
    /** A step's blocks with their length along the flow (`m`) and across it (`c`). */
    const part = (blocks) => ({
        blocks,
        m: Math.max(0, ...blocks.map(main)),
        c: blocks.reduce((s, b) => s + cross(b), 0) + itemGap * Math.max(0, blocks.length - 1),
    });
    const parts = layers.map(part);
    const rowMain = (row) => row.reduce((s, p) => s + p.m, 0) + layerGap * Math.max(0, row.length - 1);

    /**
     * Split layers greedily into rows no longer than `limit`. The loose
     * sources (`atEnd`) of a row's last step move to the start of the next
     * row as a step of their own: they feed the step after them, and left
     * behind their links ran back across the whole row.
     */
    const pack = (limit) => {
        const rows = [];
        let row = [], len = 0;
        for (let p of parts) {
            const add = row.length ? layerGap + p.m : p.m;
            if (row.length && len + add > limit + 1e-6) {
                const last = row[row.length - 1];
                const src = last.blocks.filter((b) => b.atEnd);
                const rest = last.blocks.filter((b) => !b.atEnd);
                let carry = [];
                if (src.length && (rest.length || row.length > 1)) {
                    row.pop();
                    if (rest.length) row.push(part(rest));
                    carry = [part(src)];
                }
                // The mirror case: loose sinks (`sink`: no drawn output) of the
                // step that starts the next row, fed only from this row, stay
                // at the end of this row as a step of their own.
                const ids = new Set(row.flatMap((q) => q.blocks.map((b) => b.id)));
                const back = p.blocks.filter((b) => b.sink && b.fedBy?.length && b.fedBy.every((f) => ids.has(f.id)));
                if (back.length) {
                    row.push({ ...part(back), back: true });
                    const keep = p.blocks.filter((b) => !back.includes(b));
                    p = keep.length ? part(keep) : null;
                }
                rows.push(row);
                row = carry;
                len = rowMain(carry);
                if (!p) continue;
            }
            len += row.length ? layerGap + p.m : p.m;
            row.push(p);
        }
        if (row.length) rows.push(row);
        return rows;
    };
    const rowCross = (row) => Math.max(0, ...row.map((p) => p.c));

    let best = null;
    const total = rowMain(parts);
    const longest = Math.max(0, ...parts.map((p) => p.m));
    for (let r = 1; r <= layers.length; r++) {
        // Shortest row length that fits in r rows.
        let lo = longest, hi = Math.max(total, longest);
        for (let k = 0; k < 40 && hi - lo > 0.5; k++) {
            const mid = (lo + hi) / 2;
            if (pack(mid).length <= r) hi = mid; else lo = mid;
        }
        const rows = pack(hi);
        if (best && rows.length === best.rows.length) continue;
        const mainExt = Math.max(...rows.map(rowMain));
        const crossExt = rows.reduce((s, row) => s + rowCross(row), 0) + rowGap * (rows.length - 1);
        const [w, h] = horizontal ? [mainExt, crossExt] : [crossExt, mainExt];
        const score = Math.abs(Math.log(Math.max(w, 1) / Math.max(h, 1) / aspect));
        if (!best || score < best.score - 1e-9) best = { rows, score, mainExt, crossExt, w, h };
    }
    if (!best) return { pos: new Map(), width: 0, height: 0, rows: 0 };

    const pos = new Map();
    const set = (b, u, c) => pos.set(b.id, horizontal ? { x: u, y: c } : { x: c, y: u });
    let v = 0, mainExt = 0, crossEnd = 0;
    for (const row of best.rows) {
        // Regular blocks: stacked from the row's edge, at the start of their step.
        // A step without groups keeps its sources in the step's own order
        // (`orderLayers` already puts them next to what they feed, and the
        // step stays one even line); only next to a group, which the order
        // can't account for, do they move to line up with their consumers.
        // A step of nothing but sources (e.g. carried to the start of a row)
        // has no order to keep.
        const inline = (p) => !p.blocks.some((b) => b.group) && p.blocks.some((b) => !b.atEnd);
        const crossAt = new Map();
        for (const p of row) {
            let c = v;
            if (p.back) continue;
            for (const b of p.blocks) {
                if (b.atEnd && !inline(p)) continue;
                crossAt.set(b.id, c);
                c += cross(b) + itemGap;
            }
        }
        let u = 0, rowEnd = v;
        /** Blocks placed in this row: along-flow span [u0, u1], across [c0, c1]. */
        const placed = new Map();
        for (const p of row) {
            if (p.back) {
                // Pulled-back sinks: level with the first block feeding them
                // (plus the feeding node's offset inside it), packed.
                const want = p.blocks.map((b, i) => {
                    const cs = b.fedBy.filter((f) => placed.has(f.id)).map((f) => placed.get(f.id).c0 + (f.offset || 0));
                    return { b, i, c: cs.length ? Math.min(...cs) : v };
                }).sort((a, b) => (a.c - b.c) || (a.i - b.i));
                let next = -Infinity;
                for (const { b, c: want0 } of want) {
                    const c = Math.max(want0, next);
                    set(b, u, c);
                    placed.set(b.id, { u0: u, u1: u + main(b), c0: c, c1: c + cross(b) });
                    rowEnd = Math.max(rowEnd, c + cross(b));
                    next = c + cross(b) + itemGap;
                }
                mainExt = Math.max(mainExt, u + p.m);
                u += p.m + layerGap;
                continue;
            }
            const regs = p.blocks.filter((b) => !b.atEnd);
            const srcs = p.blocks.filter((b) => b.atEnd);
            const regStart = new Map();
            for (const b of regs) {
                const c0 = crossAt.get(b.id), c1 = c0 + cross(b);
                let s = u;
                if (b.chainEnd) {
                    // Nothing comes after it: move back into free space, right
                    // after whatever is in its way across the flow and after the
                    // blocks feeding it (a step is as long as its longest block,
                    // so behind a tall group it sat far from everything).
                    s = 0;
                    for (const q of placed.values()) {
                        if (q.c0 < c1 && c0 < q.c1) s = Math.max(s, q.u1 + layerGap);
                    }
                    for (const id of b.preds || []) {
                        const q = placed.get(id);
                        if (q) s = Math.max(s, q.u1 + layerGap);
                    }
                    s = Math.min(s, u);
                }
                regStart.set(b.id, s);
                set(b, s, c0);
                rowEnd = Math.max(rowEnd, c1);
            }
            const mReg = Math.max(0, ...regs.map((b) => regStart.get(b.id) + main(b) - u));
            // Loose sources: across the flow level with the first block they
            // feed in this row (`feeds`: block id + offset of the fed node
            // inside it), packed without overlap; others after the regular blocks.
            const lastReg = regs[regs.length - 1];
            const fallback = lastReg ? crossAt.get(lastReg.id) + cross(lastReg) + itemGap : v;
            const band = [];
            if (inline(p)) {
                for (const b of srcs) band.push({ b, c: crossAt.get(b.id) });
            } else {
                const want = srcs.map((b, i) => {
                    const cs = (b.feeds || []).filter((f) => crossAt.has(f.id)).map((f) => crossAt.get(f.id) + (f.offset || 0));
                    return { b, i, c: cs.length ? Math.min(...cs) : fallback };
                }).sort((p1, p2) => (p1.c - p2.c) || (p1.i - p2.i));
                let next = -Infinity;
                for (const s of want) {
                    const c = Math.max(s.c, next);
                    band.push({ b: s.b, c });
                    next = c + cross(s.b) + itemGap;
                }
            }
            const bandT = Math.max(0, ...srcs.map(main));
            const stepLen = Math.max(mReg, bandT);
            // At the end of the step where that is free, else in a thin band
            // of their own right after it.
            const collides = band.some(({ b, c }) => regs.some((r) => {
                const r0 = crossAt.get(r.id);
                return regStart.get(r.id) + main(r) > u + stepLen - main(b) && r0 < c + cross(b) && c < r0 + cross(r);
            }));
            const end = collides ? u + mReg + itemGap + bandT : u + stepLen;
            for (const b of regs) {
                const s = regStart.get(b.id), c0 = crossAt.get(b.id);
                placed.set(b.id, { u0: s, u1: s + main(b), c0, c1: c0 + cross(b) });
            }
            for (const { b, c } of band) {
                set(b, end - main(b), c);
                placed.set(b.id, { u0: end - main(b), u1: end, c0: c, c1: c + cross(b) });
                rowEnd = Math.max(rowEnd, c + cross(b));
            }
            mainExt = Math.max(mainExt, end);
            u = end + layerGap;
        }
        crossEnd = rowEnd;
        v = rowEnd + rowGap;
    }
    const [width, height] = horizontal ? [mainExt, crossEnd] : [crossEnd, mainExt];
    return { pos, width, height, rows: best.rows.length };
}

/**
 * Arrange nodes using ELK's layered (Sugiyama) algorithm.
 *
 * Without groups: one port-aware ELK layout of all connected nodes.
 * With groups (two passes):
 * 1. Each group's connected members are laid out by ELK on their own
 *    (unconnected members in a grid below them inside the group).
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

    const { topLevelGroups, groupNodesMap, nodeToGroup, ungroupedNodes } = resolveGroups(graph);
    const { connected: ungroupedConnected, disconnected } = partitionNodes(ungroupedNodes);

    // ── Phase 1: ELK inside each group ─────────────────────────────

    const groupSizes = new Map();
    for (const group of topLevelGroups) {
        const nodes = groupNodesMap.get(group) || [];
        const { connected } = partitionNodes(nodes);
        const withBridges = [...hidden, ...collectBridgeLinks(graph, nodes, hidden, nodeToGroup)];
        if (!(await runElkLayout(sortChainsByFlow(connected, flow, graph, withBridges), graph, withBridges, settings))) return;
        // Connected members are already placed; this adds the grid of
        // unconnected ones and stores the group-relative offsets.
        groupSizes.set(group, layoutGroupContents(group, nodes, padding, () => {}));
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
