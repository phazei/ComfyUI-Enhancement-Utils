/**
 * Graph Arrange -- row wrapping for the Advanced layout.
 *
 * Pure (no graph, no LiteGraph): orders the blocks of each layer
 * (`orderLayers`) and wraps the layers into rows like text, choosing the row
 * count closest to the target aspect (`placeWrappedLayers`).
 */

/**
 * Order the blocks inside each layer to reduce crossings: barycenter sweeps
 * (down using predecessors, up using successors). A block without neighbours
 * in the reference layer keeps its place. Deterministic.
 *
 * @param {Array<Array<string>>} layers - Block ids per layer (start order).
 * @param {Map<string, Array<string>>} preds - Forward-edge predecessors (from `rankBlocks`).
 * @returns {Array<Array<string>>} Reordered layers.
 */
export function orderLayers(layers, preds) {
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
