/**
 * Graph Arrange -- settings and geometry helpers shared by every layout.
 *
 * Settings come from the provider set with `setSettingsSource` (defaults
 * otherwise); per-call `{ rankdir }` overrides it. Node sizes always via
 * `sizeOf` (collapsed-aware), never `node.size`.
 */

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

export const MARGIN = 50;
export const TITLE_HEIGHT = () => globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;

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
export function getSettings(options) {
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
export function sizeOf(node) {
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
export function hasNoDrawnInput(node) {
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
export function layoutDisconnectedNodes(nodes, startY, startX = MARGIN) {
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
export function getGraphBottom(nodes) {
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

/** Get the bounding box of positioned nodes. */
export function getNodesBounds(nodes) {
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
export function isGroupInside(inner, outer, groups) {
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
 * Compute group title area height.
 * @param {Object} group - LiteGraph group.
 * @returns {number} Height in pixels reserved for the group title.
 */
export function groupTitleHeight(group) {
    return (group.font_size || 24) + 10;
}
