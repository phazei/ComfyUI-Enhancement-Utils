/**
 * Graph Arrange -- links and flow order, independent of any layout.
 *
 * - Hidden links (`collectHiddenLinks`: Set/Get-style virtual nodes, Use
 *   Everywhere) and bridge links through ungrouped nodes (`collectBridgeLinks`).
 * - Flow order of the whole graph (`computeFlowOrder`) and ordering of
 *   separate chains by it (`chainRanks`, `sortChainsByFlow`).
 * - Columns for blocks from weighted edges, loops broken by link count
 *   (`rankBlocks`).
 */

import { readUseEverywhereLinks } from "./flowGraph.js";

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
export function chainRanks(nodes, flow, graph, hidden = []) {
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
export function sortChainsByFlow(nodes, flow, graph, hidden = []) {
    const rank = chainRanks(nodes, flow, graph, hidden);
    return [...nodes].sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Block Ranking
// ═══════════════════════════════════════════════════════════════════════════

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
export function rankBlocks(ids, edges) {
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
