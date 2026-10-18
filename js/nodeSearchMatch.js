/**
 * Node search -- pure collection and matching logic for the "Go to node..."
 * search panel (`nodeSearch.js`).
 *
 * No DOM, no `app` import: takes the root graph as an argument so it can be
 * unit-tested under Node with mock graphs (`tests/nodeSearch.test.mjs`).
 * Loaded by ComfyUI as a plain module (no extension registered).
 */

/** LiteGraph node modes that stop a node from running. */
const MODE_MUTED = 2;
const MODE_BYPASSED = 4;

/** Rank buckets -- lower sorts first. */
const RANK_EXACT_ID = 0;
const RANK_ID_PREFIX = 1;
const RANK_TYPE_EXACT = 2;
const RANK_TITLE_PREFIX = 3;
const RANK_TITLE = 4;
const RANK_TYPE = 5;
const RANK_PATH = 6;

// ── Collection ────────────────────────────────────────────────────────────

/**
 * Safe node title lookup (`getTitle()` when present, else `title` / `type`).
 *
 * @param {Object} node - LiteGraph node.
 * @returns {string} Display title.
 */
function titleOf(node) {
    try {
        const t = typeof node.getTitle === "function" ? node.getTitle() : node.title;
        return String(t ?? node.type ?? "");
    } catch {
        return String(node.title ?? node.type ?? "");
    }
}

/**
 * The node type's display name (what ComfyUI shows, e.g. "Preview Image" for
 * `PreviewImage`): backend `display_name`, else the class's static `title`
 * (frontend-only nodes), else the type itself.
 *
 * @param {Object} node - LiteGraph node.
 * @returns {string} Display name.
 */
function displayNameOf(node) {
    const ctor = node.constructor;
    const name = ctor?.nodeData?.display_name
        || (ctor && ctor !== Object && typeof ctor.title === "string" ? ctor.title : "");
    return String(name || node.type || "");
}

/**
 * Walk the root graph and every nested subgraph, returning one entry per node
 * (subgraph containers included).
 *
 * `scope` is the top-level sort group: when a subgraph is on screen, its own
 * nodes are 0, nodes nested inside it 1, everything else 2. At the root it is
 * always 0 (no grouping -- rank decides).
 *
 * @param {Object} rootGraph - The root LGraph (`app.graph`).
 * @param {Object} [activeGraph] - The graph currently on screen.
 * @returns {Array<Object>} Entries: `{node, id, execId, title, type, displayName,
 *   renamed, isSubgraph, mode, path, depth, scope, inActiveGraph, label, parentLabel,
 *   titleLower, typeLower, displayLower, pathLower}`. `type` is the class id,
 *   `displayName` its UI name, `renamed` whether the title differs from it ("" / false
 *   for subgraph containers). `path` is the list of ancestor containers as
 *   `{id, title}`; `parentLabel` is their breadcrumb ("" at the root).
 */
export function collectSearchEntries(rootGraph, activeGraph) {
    const entries = [];
    const seen = new Set();
    const inSubgraph = !!activeGraph && activeGraph !== rootGraph;
    const crumbText = (c) => `${c.title} (#${c.id})`;

    /**
     * @param {Object} graph - Graph to walk.
     * @param {Array<Object>} path - Ancestor containers.
     * @param {boolean} underActive - An ancestor graph is the one on screen.
     */
    const walk = (graph, path, underActive) => {
        if (!graph || seen.has(graph)) return; // guard against recursive subgraph refs
        seen.add(graph);
        const isActive = graph === activeGraph;
        const scope = !inSubgraph ? 0 : isActive ? 0 : underActive ? 1 : 2;
        const parentLabel = path.map(crumbText).join(" > ");
        const nodes = graph._nodes || graph.nodes || [];
        for (const node of nodes) {
            if (!node) continue;
            const id = String(node.id);
            const title = titleOf(node);
            const isSubgraph = !!node.subgraph;
            const execId = [...path.map((p) => p.id), id].join(":");
            const crumbs = [...path, { id, title }];
            const label = crumbs.map(crumbText).join(" > ");
            const type = isSubgraph ? "" : String(node.type ?? "");
            const displayName = isSubgraph ? "" : displayNameOf(node);
            entries.push({
                node,
                id,
                execId,
                title,
                type,
                displayName,
                renamed: !!displayName && title !== displayName,
                isSubgraph,
                mode: node.mode ?? 0,
                path,
                depth: path.length,
                scope,
                inActiveGraph: isActive,
                label,
                parentLabel,
                titleLower: title.toLowerCase(),
                typeLower: type.toLowerCase(),
                displayLower: displayName.toLowerCase(),
                pathLower: path.map((p) => p.title).join(" ").toLowerCase(),
            });
            if (isSubgraph) walk(node.subgraph, crumbs, underActive || isActive);
        }
    };

    walk(rootGraph, [], false);
    return entries;
}

/**
 * Whether an entry's node is muted or bypassed (shown dimmed).
 *
 * @param {Object} entry - Search entry.
 * @returns {"muted"|"bypassed"|null} The inactive state, if any.
 */
export function inactiveState(entry) {
    if (entry.mode === MODE_MUTED) return "muted";
    if (entry.mode === MODE_BYPASSED) return "bypassed";
    return null;
}

// ── Matching ──────────────────────────────────────────────────────────────

/**
 * Rank one entry against a parsed query.
 *
 * @param {Object} entry - Search entry.
 * @param {Object} q - Parsed query from `parseQuery`.
 * @returns {number} Rank bucket, or -1 when it doesn't match.
 */
function rankEntry(entry, q) {
    if (q.execPath) {
        if (entry.execId === q.execPath) return RANK_EXACT_ID;
        return entry.execId.startsWith(q.execPath) ? RANK_ID_PREFIX : -1;
    }
    if (q.id) {
        if (entry.id === q.id) return RANK_EXACT_ID;
        if (entry.id.startsWith(q.id)) return RANK_ID_PREFIX;
    }
    if (!q.text) return -1;
    // Exact type: class id or display name (the type click fills the display name).
    if (entry.typeLower && (entry.typeLower === q.text || entry.displayLower === q.text)) {
        return RANK_TYPE_EXACT;
    }
    if (entry.titleLower.startsWith(q.text)) return RANK_TITLE_PREFIX;
    if (entry.titleLower.includes(q.text)) return RANK_TITLE;
    if (entry.typeLower.includes(q.text) || entry.displayLower.includes(q.text)) return RANK_TYPE;
    // Every word somewhere in title / type / subgraph path, so a subgraph's
    // name also lists its contents (ranked last). Not for numbers -- `5` would
    // pull in every subgraph whose title contains a 5.
    if (!q.id) {
        const hay = `${entry.titleLower} ${entry.typeLower} ${entry.displayLower} ${entry.pathLower}`;
        if (q.words.every((w) => hay.includes(w))) return RANK_PATH;
    }
    return -1;
}

/**
 * Parse the raw query string.
 *
 * `12` / `#12` -> node id; `5:12` / `#5:12` -> execution path; anything else -> text.
 * A numeric query also matches as text (titles like "Seed 12").
 *
 * A leading path with a trailing colon (`7162:`, `5:3:`, `#7162:`) is a scope:
 * only nodes inside that subgraph (any depth) match, and the rest of the query
 * (`7162: vae`) filters them as usual. An exec path in the rest is relative
 * to the scope (`5: 3:7` -> `5:3:7`).
 *
 * @param {string} raw - Query typed by the user.
 * @returns {{scope: string|null, id: string|null, execPath: string|null, text: string,
 *   words: string[]}} Parsed query.
 */
export function parseQuery(raw) {
    let trimmed = String(raw ?? "").trim();
    let scope = null;
    const scoped = /^#?(\d+(?::\d+)*):(?!\d)\s*(.*)$/.exec(trimmed);
    if (scoped) {
        scope = scoped[1];
        trimmed = scoped[2].trim();
    }
    const bare = trimmed.replace(/^#/, "");
    const text = trimmed.toLowerCase();
    const execPath = /^\d+(:\d+)+$/.test(bare) ? bare : null;
    return {
        scope,
        id: /^\d+$/.test(bare) ? bare : null,
        execPath: execPath && scope ? `${scope}:${execPath}` : execPath,
        text,
        words: text.split(/\s+/).filter(Boolean),
    };
}

/**
 * Filter and sort entries for a query.
 *
 * Order:
 * 1. scope -- inside a subgraph: its own nodes, then nodes nested in it, then the rest
 * 2. rank -- exact id, id prefix, exact type, title prefix, title, type, path words
 * 3. depth -- shallower first
 * 4. section -- grouped by parent subgraph (breadcrumb, alphabetical)
 * 5. subgraph containers before regular nodes within a section
 * 6. label, alphabetical (numbers compared numerically)
 * An empty query returns every entry, ordered by the same keys minus rank.
 * A scope (`7162:`) first restricts the entries to that subgraph's contents.
 *
 * @param {Array<Object>} entries - From `collectSearchEntries`.
 * @param {string} raw - Query typed by the user.
 * @param {number} [limit=200] - Maximum results.
 * @returns {Array<Object>} Matching entries, best first.
 */
export function searchEntries(entries, raw, limit = 200) {
    const q = parseQuery(raw);
    const empty = !q.text;
    const scopePrefix = q.scope ? `${q.scope}:` : null;
    const ranked = [];
    for (const entry of entries) {
        if (scopePrefix && !entry.execId.startsWith(scopePrefix)) continue;
        const rank = empty ? 0 : rankEntry(entry, q);
        if (rank >= 0) ranked.push({ entry, rank });
    }
    const cmp = (x, y) => x.localeCompare(y, undefined, { numeric: true });
    ranked.sort((a, b) =>
        a.entry.scope - b.entry.scope
        || a.rank - b.rank
        || (a.entry.depth - b.entry.depth)
        || cmp(a.entry.parentLabel, b.entry.parentLabel)
        || (b.entry.isSubgraph - a.entry.isSubgraph)
        || cmp(a.entry.label, b.entry.label),
    );
    return ranked.slice(0, limit).map((r) => r.entry);
}
