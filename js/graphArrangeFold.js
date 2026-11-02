/**
 * Graph Arrange -- folding and wrapping inside a group, after a layout
 * engine placed the group's contents (`finishGroupLayout` runs all of it).
 *
 * - `foldChains`: a run of the layout's steps that each hold one node linked
 *   to the next (a run of LoRA loaders, also with a Display hanging off one
 *   or a concat fed by all -- `findRuns`) shares lines where neighbours fit
 *   within the run's thickest node -- columns left to right, rows top to
 *   bottom. Only gets shorter along the flow; what follows the run closes
 *   up.
 * - `packComponents`: separate pieces stacked into one long line *across*
 *   the flow (loaders that each feed something outside the group) wrap
 *   into several lines.
 * - Wrapping *along* the flow (`wrapRows`): contents that are still too
 *   long along the flow -- any shape, branching or not -- are cut where no
 *   node spans the cut and wrapped into rows like text, each row running
 *   left to right (slots are on the sides of nodes, so links in a row run
 *   straight; only row ends link back). Top-to-bottom contents are laid out
 *   left to right first, so their rows read the same way.
 *
 * Every wrap starts at `wrapTrigger` and aims for `wrapAspect` in the
 * orientation the contents had (`wrapOptions`, `chooseWrap`; no UI setting).
 * Order is never changed; `breakLines` / the row split only choose where
 * lines break. Pure: no `app` import.
 */

import { TITLE_HEIGHT, sizeOf, DEFAULTS } from "./graphArrangeShared.js";

/** Default wrap trigger: wrap when more than this many times longer than wide. */
export const FOLD_RATIO = DEFAULTS.wrapTrigger;

/**
 * Wrap options from layout settings (DEFAULTS unless a settings source
 * overrides them).
 *
 * @param {Object} settings - From `getSettings` (`wrapTrigger`, `wrapAspect`).
 * @returns {{aspect: number, trigger: number}} Target long side : short side
 *   (at least 1), and the ratio above which contents wrap (Infinity = never).
 */
export function wrapOptions(settings) {
    const a = Number(settings?.wrapAspect);
    const aspect = a > 0 ? Math.max(a, 1 / a) : DEFAULTS.wrapAspect;
    const trigger = Number(settings?.wrapTrigger) >= 1 ? Number(settings.wrapTrigger) : DEFAULTS.wrapTrigger;
    return { aspect, trigger };
}

/**
 * Pick the wrapped layout closest to the wrap aspect, in the orientation the
 * contents already had: too tall stays taller than wide (9:16 for 16:9),
 * too wide stays wider than tall. Of splits with the same line count and the
 * same width only the shortest (most even) competes -- otherwise a ragged
 * split (4, 4, 1) could win just because its extra length lands nearer the
 * aspect than the even one (3, 3, 3).
 *
 * @param {Array<{w: number, h: number, lines: number}>} layouts - Candidates.
 * @param {number} aspect - Long side : short side (`wrapOptions`).
 * @param {boolean} tall - The contents were too tall (else too wide).
 * @returns {Object|null} Chosen layout.
 */
function chooseWrap(layouts, aspect, tall) {
    const target = tall ? 1 / aspect : aspect;
    /** Per line count and `keep` size, only the layout smallest in `drop`. */
    const shortest = (list, keep, drop) => {
        const by = new Map();
        for (const l of list) {
            const k = l.lines + ":" + Math.round(l[keep]);
            const cur = by.get(k);
            if (!cur || l[drop] < cur[drop] - 0.5) by.set(k, l);
        }
        return [...by.values()];
    };
    const even = shortest(shortest(layouts, "w", "h"), "h", "w");
    let best = null, bestScore = Infinity;
    for (const l of even) {
        const score = Math.abs(Math.log(l.w / Math.max(1, l.h) / target));
        if (score < bestScore - 1e-9) { best = l; bestScore = score; }
    }
    return best;
}

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
 * Cut laid-out nodes into steps along the flow: slices at positions no node
 * spans, in flow order.
 *
 * @param {Array<Object>} nodes - Laid-out nodes.
 * @param {boolean} horizontal - Left-to-right flow (slices by x), else by y.
 * @returns {Array<{nodes: Array<Object>, a0: number, a1: number}>} Slices with their extent along the flow.
 */
function slicesAlong(nodes, horizontal) {
    const span = (n) => { const b = boxOf([n]); return horizontal ? [b.x0, b.x1] : [b.y0, b.y1]; };
    const slices = [];
    for (const { n, s } of nodes.map((n) => ({ n, s: span(n) })).sort((p, q) => p.s[0] - q.s[0])) {
        const last = slices[slices.length - 1];
        if (last && s[0] < last.a1 - 0.5) {
            last.nodes.push(n);
            last.a1 = Math.max(last.a1, s[1]);
        } else {
            slices.push({ nodes: [n], a0: s[0], a1: s[1] });
        }
    }
    return slices;
}

/**
 * Runs worth folding in a layout: per separate piece (component by the given
 * links), consecutive steps (`slicesAlong`) that each hold a single node
 * linked straight to the next one's, at least `MIN_CHAIN` long. The nodes
 * may have other links too (a Display hanging off one, a concat fed by all),
 * so a run of LoRA loaders still counts once something else is wired to it.
 *
 * @param {Array<Object>} nodes - Laid-out nodes (a group's connected members).
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @param {boolean} horizontal - Left-to-right flow.
 * @returns {Array<Array<Object>>} Runs, each in flow order.
 */
export function findRuns(nodes, links, horizontal) {
    const linked = new Set();
    for (const l of links) if (l) linked.add(String(l.origin_id) + ">" + String(l.target_id));
    const runs = [];
    for (const comp of findComponents(nodes, links)) {
        let run = [];
        const close = () => { if (run.length >= MIN_CHAIN) runs.push(run); run = []; };
        for (const slice of slicesAlong(comp, horizontal)) {
            const node = slice.nodes.length === 1 ? slice.nodes[0] : null;
            if (!node) { close(); continue; }
            const prev = run[run.length - 1];
            if (prev && !linked.has(String(prev.id) + ">" + String(node.id))) close();
            run.push(node);
        }
        close();
    }
    return runs;
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
 * @returns {{pos: Array<[number, number]>, w: number, h: number, lines: number}} Box top-left per
 *   node, the total size and the number of lines.
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
    return { pos, w, h, lines: lines.length };
}

/**
 * Re-place a folded run at the top-left of where it was. Its piece's nodes
 * after it along the flow move up to close the space it freed (nothing of the
 * piece is beside the run -- its steps hold only run nodes -- so they can't
 * collide); if the run grew across the flow, every node wholly beyond its old
 * box across the flow moves out by the growth.
 *
 * @param {Array<Object>} run - Run nodes.
 * @param {{pos: Array<[number, number]>, w: number, h: number}} layout - From `placeLines`.
 * @param {Array<Object>} piece - The other nodes of the run's piece.
 * @param {Array<Object>} others - Every other laid-out node.
 * @param {boolean} horizontal - Left-to-right flow.
 * @returns {void}
 */
function applyLayout(run, layout, piece, others, horizontal) {
    const titleH = TITLE_HEIGHT();
    const old = boxOf(run);
    const dw = layout.w - (old.x1 - old.x0), dh = layout.h - (old.y1 - old.y0);
    const inPiece = new Set(piece);
    for (const n of [...piece, ...others]) {
        const b = boxOf([n]);
        let [x, y] = n.pos;
        if (horizontal) {
            if (inPiece.has(n) && b.x0 >= old.x1 - 0.5) x += dw;
            if (dh > 0 && b.y0 >= old.y1 - 0.5) y += dh;
        } else {
            if (inPiece.has(n) && b.y0 >= old.y1 - 0.5) y += dh;
            if (dw > 0 && b.x0 >= old.x1 - 0.5) x += dw;
        }
        if (x !== n.pos[0] || y !== n.pos[1]) n.pos = [x, y];
    }
    run.forEach((n, i) => {
        n.pos = [old.x0 + layout.pos[i][0], old.y0 + layout.pos[i][1] + titleH];
    });
}

/**
 * Fold runs (`findRuns`: consecutive single-node steps, each linked to the
 * next) among nodes that were just laid out together, see the module
 * comment: neighbours share a line where they fit within the run's thickest
 * node. Call after the layout engine placed them and before the
 * group-relative offsets are stored.
 *
 * @param {Array<Object>} nodes - The laid-out nodes.
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @param {{horizontal: boolean, along: number, across: number}} opts - Flow
 *   direction; space between steps of the flow and between nodes of a step.
 * @returns {void}
 */
export function foldChains(nodes, links, { horizontal, along, across }) {
    const runs = findRuns(nodes, links, horizontal);
    if (runs.length === 0) return;
    const titleH = TITLE_HEIGHT();
    const pieceOf = new Map();
    for (const comp of findComponents(nodes, links)) for (const n of comp) pieceOf.set(n, comp);

    // Last run first: closing the space behind a run doesn't move earlier ones.
    for (const run of runs.reverse()) {
        const sizes = run.map((n) => ({ w: sizeOf(n)[0], h: sizeOf(n)[1] + titleH }));
        const items = sizes.map((s) => (horizontal ? { a: s.h, t: s.w } : { a: s.w, t: s.h }));
        const limit = Math.max(...items.map((it) => it.a));
        const gapIn = horizontal ? across : along;
        const lines = breakLines(items, limit, gapIn, along);
        if (lines.length === run.length) continue;
        const inRun = new Set(run);
        const piece = pieceOf.get(run[0]).filter((n) => !inRun.has(n));
        const others = nodes.filter((n) => !inRun.has(n) && pieceOf.get(n) !== pieceOf.get(run[0]));
        applyLayout(run, placeLines(sizes, lines, horizontal, along, across), piece, others, horizontal);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapping Along the Flow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether laid-out contents are more than `trigger` times longer along the
 * flow than across it (left to right: wider than tall).
 *
 * @param {Array<Object>} nodes - Laid-out nodes.
 * @param {boolean} horizontal - Left-to-right flow.
 * @param {number} trigger - From `wrapOptions`.
 * @returns {boolean}
 */
export function tooLongAlong(nodes, horizontal, trigger) {
    if (nodes.length < 2) return false;
    const b = boxOf(nodes);
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    return (horizontal ? w / h : h / w) > trigger;
}

/**
 * Wrap a left-to-right layout into rows like text. The layout is cut into
 * slices at x positions no node spans (so a step is never split), runs of
 * consecutive slices form rows, and each row keeps its own geometry: it is
 * the original strip of the layout, moved to the start of the row and below
 * the previous row. The row count is the one whose result is closest to the
 * wrap aspect (`chooseWrap`), per row count the split with the thinnest rows.
 * Keeps the old top-left.
 *
 * @param {Array<Object>} nodes - Laid-out nodes (left to right).
 * @param {{rowGap: number, aspect: number, tall: boolean}} opts - Space
 *   between rows; long side : short side; aim taller than wide.
 * @returns {void}
 */
export function wrapRows(nodes, { rowGap, aspect, tall }) {
    const boxes = nodes.map((n) => ({ n, b: boxOf([n]) })).sort((p, q) => p.b.x0 - q.b.x0);
    const slices = [];
    for (const it of boxes) {
        const last = slices[slices.length - 1];
        if (last && it.b.x0 < last.x1 - 0.5) {
            last.items.push(it);
            last.x1 = Math.max(last.x1, it.b.x1);
            last.y0 = Math.min(last.y0, it.b.y0);
            last.y1 = Math.max(last.y1, it.b.y1);
        } else {
            slices.push({ items: [it], x0: it.b.x0, x1: it.b.x1, y0: it.b.y0, y1: it.b.y1 });
        }
    }
    const n = slices.length;
    if (n < 2) return;

    // Thickness of a row of slices i..j (their y extent together).
    const thick = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        let y0 = Infinity, y1 = -Infinity;
        for (let j = i; j < n; j++) {
            y0 = Math.min(y0, slices[j].y0);
            y1 = Math.max(y1, slices[j].y1);
            thick[i][j] = y1 - y0;
        }
    }
    const len = (i, j) => slices[j].x1 - slices[i].x0;

    /**
     * Rows (slice index ranges) no longer than `limit`, least total
     * thickness. A last row shorter than a third of the limit costs as much
     * as the limit (a widow: one small node -- a Set -- alone at the bottom,
     * away from what feeds it), so the split prefers moving more down to it.
     */
    const split = (limit) => {
        const best = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(0);
        best[0] = 0;
        for (let j = 1; j <= n; j++) {
            for (let i = j - 1; i >= 0; i--) {
                if (len(i, j - 1) > limit + 0.5 && i < j - 1) break;
                const widow = j === n && i > 0 && len(i, j - 1) < limit / 3 ? limit : 0;
                const cost = best[i] + thick[i][j - 1] + (i > 0 ? rowGap : 0) + widow;
                if (cost < best[j] - 1e-6) { best[j] = cost; from[j] = i; }
            }
        }
        const rows = [];
        for (let j = n; j > 0; j = from[j]) rows.unshift([from[j], j - 1]);
        const w = Math.max(...rows.map(([i, j]) => len(i, j)));
        const h = rows.reduce((s, [i, j]) => s + thick[i][j], 0) + rowGap * (rows.length - 1);
        return { rows, w, h, lines: rows.length };
    };

    const limits = new Set();
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) limits.add(Math.round(len(i, j)));
    let candidates = [...limits].sort((a, b) => a - b);
    if (candidates.length > MAX_WRAP_CANDIDATES) {
        const step = candidates.length / MAX_WRAP_CANDIDATES;
        candidates = Array.from({ length: MAX_WRAP_CANDIDATES }, (_, k) => candidates[Math.floor(k * step)]);
    }
    const layouts = candidates.map(split);
    const best = chooseWrap(layouts, aspect, tall);
    if (!best || best.lines < 2) return;

    const x0 = slices[0].x0;
    let y = Math.min(...slices.map((s) => s.y0));
    for (const [i, j] of best.rows) {
        const dx = x0 - slices[i].x0;
        let top = Infinity;
        for (let k = i; k <= j; k++) top = Math.min(top, slices[k].y0);
        const dy = y - top;
        for (let k = i; k <= j; k++) {
            for (const { n: node } of slices[k].items) node.pos = [node.pos[0] + dx, node.pos[1] + dy];
        }
        y += thick[i][j] + rowGap;
    }
}

/**
 * Everything a per-group engine runs after its layout: fold chains, pack
 * separate pieces, then wrap along the flow when the contents are more than
 * `wrap.trigger` times longer along the flow than across it. Left to right
 * the layout is wrapped into rows (`wrapRows`, wider than tall). Top to
 * bottom the contents are laid out again left to right with `layoutLR` and
 * wrapped the same way, aiming taller than wide: each row then runs left to
 * right like the slots do, and only row ends link back.
 *
 * @param {Array<Object>} items - The laid-out items.
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @param {{horizontal: boolean, along: number, across: number, wrap: {aspect: number, trigger: number}}} opts
 *   - As for `foldChains` / `packComponents`.
 * @param {function(Array<Object>): (void|boolean|Promise<void|boolean>)} [layoutLR] - Lays the items
 *   out left to right (top-to-bottom engines); false = failed.
 * @param {{along: number, across: number}} [lrGaps] - Spacing of that layout (default: `opts`).
 * @returns {Promise<void|boolean>} False when `layoutLR` failed.
 */
export async function finishGroupLayout(items, links, opts, layoutLR, lrGaps) {
    foldChains(items, links, opts);
    packComponents(items, links, opts);
    if (!tooLongAlong(items, opts.horizontal, opts.wrap.trigger)) return;
    let gaps = opts;
    if (!opts.horizontal) {
        if (!layoutLR) return;
        if ((await layoutLR(items)) === false) return false;
        gaps = { ...opts, ...(lrGaps || {}), horizontal: true };
        foldChains(items, links, gaps);
        packComponents(items, links, gaps);
    }
    wrapRows(items, { rowGap: gaps.along, aspect: opts.wrap.aspect, tall: !opts.horizontal });
}

/**
 * Separate pieces among `nodes`: connected components by the given links,
 * between these nodes only.
 *
 * @param {Array<Object>} nodes - Nodes laid out together.
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @returns {Array<Array<Object>>} Components.
 */
function findComponents(nodes, links) {
    const parent = new Map(nodes.map((n) => [String(n.id), String(n.id)]));
    const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    for (const l of links) {
        if (!l) continue;
        const a = String(l.origin_id), b = String(l.target_id);
        if (!parent.has(a) || !parent.has(b)) continue;
        parent.set(find(a), find(b));
    }
    const comps = new Map();
    for (const n of nodes) {
        const r = find(String(n.id));
        if (!comps.has(r)) comps.set(r, []);
        comps.get(r).push(n);
    }
    return [...comps.values()];
}

/**
 * Wrap separate pieces that the layout stacked into one long line across
 * the flow (a group of loaders that each feed something outside it: one
 * step, so a tall column in left-to-right, a wide row in top-to-bottom).
 * When the laid-out nodes are more than `wrap.trigger` times longer across
 * the flow than along it, the pieces -- each kept as it is -- are broken
 * into several such lines placed one after another along the flow, in their
 * current order, with the line length that brings the whole closest to the
 * wrap shape (`chooseWrap`). Call after `foldChains`.
 *
 * @param {Array<Object>} nodes - The laid-out nodes.
 * @param {Array<{origin_id: *, target_id: *}>} links - Drawn, hidden and bridge links.
 * @param {{horizontal: boolean, along: number, across: number, wrap?: {aspect: number, trigger: number}}} opts -
 *   Flow direction; space between steps of the flow and between nodes of a
 *   step; wrap shape and trigger (`wrapOptions`, defaults when missing).
 * @returns {void}
 */
export function packComponents(nodes, links, { horizontal, along, across, wrap = wrapOptions() }) {
    const comps = findComponents(nodes, links);
    if (comps.length < 2) return;
    const all = boxOf(nodes);
    const W = all.x1 - all.x0, H = all.y1 - all.y0;
    const long = (w, h) => (horizontal ? h / Math.max(1, w) : w / Math.max(1, h));
    if (long(W, H) <= wrap.trigger) return;

    // a = length across the flow (along a line), t = thickness along the flow.
    const boxes = comps.map((c) => ({ c, b: boxOf(c) }))
        .sort((p, q) => (horizontal ? p.b.y0 - q.b.y0 || p.b.x0 - q.b.x0 : p.b.x0 - q.b.x0 || p.b.y0 - q.b.y0));
    const items = boxes.map(({ b }) => (horizontal
        ? { a: b.y1 - b.y0, t: b.x1 - b.x0 }
        : { a: b.x1 - b.x0, t: b.y1 - b.y0 }));

    const place = (lines) => {
        const pos = new Array(items.length);
        let u = 0, len = 0;
        for (const line of lines) {
            let v = 0, thick = 0;
            for (const i of line) {
                pos[i] = [u, v];
                v += items[i].a + across;
                thick = Math.max(thick, items[i].t);
            }
            len = Math.max(len, v - across);
            u += thick + along;
        }
        const depth = u - along;
        return { pos, lines: lines.length, w: horizontal ? depth : len, h: horizontal ? len : depth };
    };

    const widths = new Set();
    for (let i = 0; i < items.length; i++) {
        let len = -across;
        for (let j = i; j < items.length; j++) { len += items[j].a + across; widths.add(Math.round(len)); }
    }
    const layouts = [...widths].sort((a, b) => a - b).slice(0, MAX_WRAP_CANDIDATES)
        .map((limit) => place(breakLines(items, limit, across, along)));
    // Left to right the pieces stack too tall, top to bottom too wide.
    const best = chooseWrap(layouts, wrap.aspect, horizontal);
    if (!best || best.lines < 2) return;

    boxes.forEach(({ c, b }, i) => {
        const [u, v] = best.pos[i];
        const dx = all.x0 + (horizontal ? u : v) - b.x0;
        const dy = all.y0 + (horizontal ? v : u) - b.y0;
        for (const n of c) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
    });
}
