/**
 * Graph Arrange -- folding long chains inside a group.
 *
 * A group that is one long chain (a run of LoRA loaders: each node feeds only
 * the next) comes out of every layout as one long line: very wide in
 * left-to-right, a very tall column in top-to-bottom. After a group's
 * contents are laid out, `foldChains` re-places such chains:
 *
 * - Left to right: neighbours short enough to fit one above the other within
 *   the chain's tallest node share a column. The group never gets taller,
 *   only narrower.
 * - Top to bottom: the mirror (narrow neighbours side by side within the
 *   widest node), and when the group is still more than `FOLD_RATIO` times
 *   taller than wide, the chain wraps into rows like text, each row running
 *   left to right (slots are on the sides of nodes, so every link in a row is
 *   straight) -- with the row width that brings the chain closest to square.
 *
 * Nodes keep their chain order; only where the chain breaks is chosen, by
 * `breakLines`, so that nodes of similar size end up next to each other.
 * Pure: no `app` import.
 */

import { TITLE_HEIGHT, sizeOf } from "./graphArrangeShared.js";

/** Top-to-bottom: wrap a chain when its group is more than this many times taller than wide. */
export const FOLD_RATIO = 5;

/** Shortest chain worth folding (two nodes can never share a line). */
const MIN_CHAIN = 3;

/** Line breaking is quadratic per candidate width; longer chains only get the no-grow pass. */
const MAX_WRAP_CANDIDATES = 400;

/**
 * Split a sequence into consecutive lines. Each item has a length along the
 * line (`a`) and a thickness across it (`t`); a line holds items whose
 * lengths plus `gapIn` between them fit in `limit`, and is as thick as its
 * thickest item. Picks the breaks with the smallest total thickness (lines
 * plus `gapOut` between them) -- the usual text line-breaking calculation,
 * so items of similar thickness share a line instead of a greedy fill.
 *
 * @param {Array<{a: number, t: number}>} items - In order.
 * @param {number} limit - Maximum line length.
 * @param {number} gapIn - Space between items on a line.
 * @param {number} gapOut - Space between lines.
 * @returns {Array<Array<number>>} Lines as lists of item indices; one item
 *   per line where nothing fits together (or an item alone exceeds `limit`).
 */
export function breakLines(items, limit, gapIn, gapOut) {
    const n = items.length;
    const best = new Array(n + 1).fill(Infinity);
    const from = new Array(n + 1).fill(0);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
        let len = -gapIn, thick = 0;
        for (let i = j - 1; i >= 0; i--) {
            len += items[i].a + gapIn;
            thick = Math.max(thick, items[i].t);
            // A single item always forms a line, even when longer than the limit.
            if (len > limit + 0.5 && i < j - 1) break;
            const cost = best[i] + thick + (i > 0 ? gapOut : 0);
            // Ties: fewer, fuller lines later in the chain (keep scanning).
            if (cost < best[j] - 1e-6) { best[j] = cost; from[j] = i; }
        }
    }
    const lines = [];
    for (let j = n; j > 0; j = from[j]) {
        const i = from[j];
        lines.unshift(Array.from({ length: j - i }, (_, k) => i + k));
    }
    return lines;
}

/**
 * Chains among `nodes`: connected components (by the given links, between
 * these nodes only) that form a single path -- every node has at most one
 * neighbour feeding it and one it feeds -- of at least `MIN_CHAIN` nodes.
 *
 * @param {Array<Object>} nodes - Nodes laid out together (a group's connected members).
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @returns {Array<Array<Object>>} Chains, each in flow order.
 */
export function findChains(nodes, links) {
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const outs = new Map(), ins = new Map();
    for (const id of byId.keys()) { outs.set(id, new Set()); ins.set(id, new Set()); }
    for (const l of links) {
        if (!l) continue;
        const a = String(l.origin_id), b = String(l.target_id);
        if (a === b || !byId.has(a) || !byId.has(b)) continue;
        outs.get(a).add(b);
        ins.get(b).add(a);
    }
    const seen = new Set();
    const chains = [];
    for (const id of byId.keys()) {
        if (seen.has(id)) continue;
        // Collect the component.
        const comp = [];
        const stack = [id];
        seen.add(id);
        while (stack.length) {
            const cur = stack.pop();
            comp.push(cur);
            for (const nb of [...outs.get(cur), ...ins.get(cur)]) {
                if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
            }
        }
        if (comp.length < MIN_CHAIN) continue;
        if (comp.some((c) => outs.get(c).size > 1 || ins.get(c).size > 1)) continue;
        const starts = comp.filter((c) => ins.get(c).size === 0);
        if (starts.length !== 1) continue; // A loop.
        const chain = [];
        for (let cur = starts[0]; cur != null; cur = [...outs.get(cur)][0]) chain.push(byId.get(cur));
        if (chain.length === comp.length) chains.push(chain);
    }
    return chains;
}

/**
 * Title-inclusive bounding box of placed nodes.
 *
 * @param {Array<Object>} nodes - Placed nodes.
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
function boxOf(nodes) {
    const titleH = TITLE_HEIGHT();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
        const [w, h] = sizeOf(n);
        x0 = Math.min(x0, n.pos[0]);
        y0 = Math.min(y0, n.pos[1] - titleH);
        x1 = Math.max(x1, n.pos[0] + w);
        y1 = Math.max(y1, n.pos[1] + h);
    }
    return { x0, y0, x1, y1 };
}

/**
 * Lay a chain out in lines from (0, 0): columns top to bottom (`horizontal`)
 * or rows left to right.
 *
 * @param {Array<{w: number, h: number}>} sizes - Title-inclusive node boxes, in chain order.
 * @param {Array<Array<number>>} lines - From `breakLines`.
 * @param {boolean} horizontal - Columns (left-to-right flow) instead of rows.
 * @param {number} along - Space between lines and between neighbours on a row.
 * @param {number} across - Space between neighbours in a column.
 * @returns {{pos: Array<[number, number]>, w: number, h: number}} Box top-left per node and the total size.
 */
function placeLines(sizes, lines, horizontal, along, across) {
    const pos = new Array(sizes.length);
    let u = 0, w = 0, h = 0;
    for (const line of lines) {
        let v = 0, thick = 0;
        for (const i of line) {
            if (horizontal) {
                pos[i] = [u, v];
                v += sizes[i].h + across;
                thick = Math.max(thick, sizes[i].w);
            } else {
                pos[i] = [v, u];
                v += sizes[i].w + along;
                thick = Math.max(thick, sizes[i].h);
            }
        }
        const len = v - (horizontal ? across : along);
        if (horizontal) { w = u + thick; h = Math.max(h, len); } else { h = u + thick; w = Math.max(w, len); }
        u += thick + along;
    }
    return { pos, w, h };
}

/**
 * Re-place a chain at the top-left of where it was and make room for the
 * rest: nodes wholly right of the old box move right by the growth in width,
 * nodes wholly below it down by the growth in height. Space freed by
 * shrinking is left as is (pulling other nodes in could make them collide).
 *
 * @param {Array<Object>} chain - Chain nodes.
 * @param {{pos: Array<[number, number]>, w: number, h: number}} layout - From `placeLines`.
 * @param {Array<Object>} others - The other nodes laid out with the chain.
 * @returns {void}
 */
function applyLayout(chain, layout, others) {
    const titleH = TITLE_HEIGHT();
    const old = boxOf(chain);
    const dw = layout.w - (old.x1 - old.x0), dh = layout.h - (old.y1 - old.y0);
    for (const n of others) {
        const b = boxOf([n]);
        let [x, y] = n.pos;
        if (dw > 0 && b.x0 >= old.x1 - 0.5) x += dw;
        if (dh > 0 && b.y0 >= old.y1 - 0.5) y += dh;
        if (x !== n.pos[0] || y !== n.pos[1]) n.pos = [x, y];
    }
    chain.forEach((n, i) => {
        n.pos = [old.x0 + layout.pos[i][0], old.y0 + layout.pos[i][1] + titleH];
    });
}

/**
 * Fold long chains among nodes that were just laid out together (a group's
 * connected members), see the module comment. Call after the layout engine
 * placed them and before the group-relative offsets are stored.
 *
 * @param {Array<Object>} nodes - The laid-out nodes.
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @param {{horizontal: boolean, along: number, across: number}} opts - Flow
 *   direction; space between steps of the flow and between nodes of a step.
 * @returns {void}
 */
export function foldChains(nodes, links, { horizontal, along, across }) {
    const chains = findChains(nodes, links);
    if (chains.length === 0) return;
    const titleH = TITLE_HEIGHT();
    const sizesOf = (chain) => chain.map((n) => ({ w: sizeOf(n)[0], h: sizeOf(n)[1] + titleH }));
    const othersOf = (chain) => { const s = new Set(chain); return nodes.filter((n) => !s.has(n)); };

    // No-grow pass: neighbours share a line within the chain's thickest node.
    for (const chain of chains) {
        const sizes = sizesOf(chain);
        const items = sizes.map((s) => (horizontal ? { a: s.h, t: s.w } : { a: s.w, t: s.h }));
        const limit = Math.max(...items.map((it) => it.a));
        const gapIn = horizontal ? across : along;
        const lines = breakLines(items, limit, gapIn, along);
        if (lines.length === chain.length) continue;
        applyLayout(chain, placeLines(sizes, lines, horizontal, along, across), othersOf(chain));
    }
    if (horizontal) return;

    // Top to bottom: wrap the tallest chains into rows while the whole set
    // is more than FOLD_RATIO times taller than wide.
    const ratio = () => { const b = boxOf(nodes); return (b.y1 - b.y0) / Math.max(1, b.x1 - b.x0); };
    const byHeight = chains.map((c) => ({ c, h: boxOf(c).y1 - boxOf(c).y0 })).sort((a, b) => b.h - a.h);
    for (const { c: chain } of byHeight) {
        if (ratio() <= FOLD_RATIO) break;
        const sizes = sizesOf(chain);
        const items = sizes.map((s) => ({ a: s.w, t: s.h }));
        // Candidate row widths: every run of consecutive nodes.
        const widths = new Set();
        for (let i = 0; i < items.length; i++) {
            let len = -along;
            for (let j = i; j < items.length; j++) { len += items[j].a + along; widths.add(Math.round(len)); }
        }
        const candidates = [...widths].sort((a, b) => a - b).slice(0, MAX_WRAP_CANDIDATES);
        let best = null;
        for (const limit of candidates) {
            const layout = placeLines(sizes, breakLines(items, limit, along, along), false, along, across);
            const score = Math.abs(Math.log(layout.h / Math.max(1, layout.w)));
            if (!best || score < best.score - 1e-9) best = { layout, score };
        }
        if (best) applyLayout(chain, best.layout, othersOf(chain));
    }
}
