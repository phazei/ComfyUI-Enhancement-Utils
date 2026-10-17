/**
 * Flow Graph model builder -- pure data-flow analysis for the Flow Visualizer.
 *
 * Builds a model of the *effective* data flow of a workflow: which real
 * (executable) nodes feed which, how deep each node sits (longest path from a
 * source), which nodes will actually run (upstream of an output node), and
 * how every visible link / virtual hop maps onto that flow in time.
 *
 * Resolution mirrors the frontend's own prompt compilation
 * (`ExecutableNodeDTO.resolveInput` / `resolveOutput` / `_getBypassSlotIndex` /
 * `_resolveSubgraphOutput`), using only generic hooks:
 *   - node modes (NEVER = 2 muted, BYPASS = 4 bypassed)
 *   - subgraph containers (`node.subgraph`, IO node ids -10 / -20)
 *   - virtual nodes (`isVirtualNode`, `resolveVirtualOutput`, `getInputLink`)
 *   - `nodeData.output_node` and the input `lazy` flag
 *
 * No drawing, no DOM, no `app` import: the root graph is passed in, so the
 * module can be unit-tested under Node with mock graphs. It does NOT register
 * an extension. Used by `flowVisualizer.js`.
 *
 * Choices left open by the spec:
 *   - Links on chains that resolve to nothing (cut by a muted node, a virtual
 *     node with no source, a broken link) get NO link info: `getLinkInfo`
 *     returns null for them.
 *   - Node depths are clamped to `maxDepth` (dead nodes past the last active
 *     depth sit at the end of the colour scale).
 *   - Nodes with no time position (muted, inactive bypassed, containers with
 *     no inner real nodes) report `depth = depthEnd = NaN`.
 *   - Muted / bypassed containers are not entered (matches the root-level
 *     behaviour of `graphToPrompt`); their inner nodes are not part of the flow.
 */

// ── Constants ─────────────────────────────────────────────────────────────

/** Node mode: muted ("never"). Same value as `LiteGraph.NEVER`. */
const MODE_NEVER = 2;

/** Node mode: bypassed. Same value as `LGraphEventMode.BYPASS`. */
const MODE_BYPASS = 4;

/** Id of a subgraph's virtual input node (a string since frontend 1.46). */
const SUBGRAPH_INPUT_ID = "-10";

/** Id of a subgraph's virtual output node (a string since frontend 1.46). */
const SUBGRAPH_OUTPUT_ID = "-20";

/** Shared empty array returned by getters with nothing to report. */
const EMPTY = Object.freeze([]);

// ── Module State ──────────────────────────────────────────────────────────

/** Warning messages already logged (each logged only once per session). */
const warnedMessages = new Set();

/**
 * Memo of virtual-node hook failures: node -> Map<slot, signature>.
 * A hook pair (resolveVirtualOutput + getInputLink) that produced nothing is
 * not called again until the node's first widget value or a graph version
 * changes, so hooks that show UI alerts on broken workflows alert only once.
 * @type {WeakMap<Object, Map<number, string>>}
 */
const hookFailMemo = new WeakMap();

/**
 * Per-build cache of each graph's links targeting the subgraph output node:
 * graph -> Map<targetSlot, link>. Reset at the start of every build.
 * @type {WeakMap<Object, Map<number, Object>>}
 */
let outputLinkIndex = new WeakMap();

// ── Small Helpers ─────────────────────────────────────────────────────────

/**
 * Log a warning once per distinct message.
 *
 * @param {string} message - Message text (without prefix).
 * @param {*} [detail] - Optional extra value logged alongside (e.g. the error).
 * @returns {void}
 */
function warnOnce(message, detail) {
    if (warnedMessages.has(message)) return;
    warnedMessages.add(message);
    try {
        if (detail !== undefined) console.warn(`[EnhancementUtils] ${message}`, detail);
        else console.warn(`[EnhancementUtils] ${message}`);
    } catch {
        // console unavailable -- nothing to do
    }
}

/**
 * Convert any value to a string without ever throwing.
 *
 * @param {*} value - Value to stringify.
 * @returns {string} String form (objects via JSON when possible).
 */
function safeString(value) {
    try {
        if (value !== null && typeof value === "object") return JSON.stringify(value);
        return String(value);
    } catch {
        return "?";
    }
}

/**
 * Get the node list of a graph (`_nodes`, falling back to `nodes`).
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @returns {Array<Object>} Node array (never null).
 */
function getGraphNodes(graph) {
    const nodes = graph?._nodes ?? graph?.nodes;
    return Array.isArray(nodes) ? nodes : EMPTY;
}

/**
 * Iterate the links of a graph. `graph.links` is a Map in current frontends
 * (with deprecated record access) and a plain object in very old ones.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @returns {Iterable<Object>} Link objects (may contain nullish entries).
 */
function iterateLinks(graph) {
    const links = graph?.links;
    if (!links) return EMPTY;
    if (typeof links.values === "function") return links.values();
    return Object.values(links);
}

/**
 * Count the links of a graph.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @returns {number} Link count.
 */
function countLinks(graph) {
    const links = graph?.links;
    if (!links) return 0;
    if (typeof links.size === "number") return links.size;
    return Object.keys(links).length;
}

/**
 * Look up a link by id in a graph.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @param {*} linkId - Link id.
 * @returns {Object|null} The link, or null.
 */
function getLinkById(graph, linkId) {
    if (linkId == null || !graph) return null;
    if (typeof graph.getLink === "function") return graph.getLink(linkId) ?? null;
    const links = graph.links;
    if (!links) return null;
    if (typeof links.get === "function") return links.get(linkId) ?? null;
    return links[linkId] ?? null;
}

/**
 * Look up a node by id in a graph.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @param {*} nodeId - Node id (string or number).
 * @returns {Object|null} The node, or null.
 */
function getNodeById(graph, nodeId) {
    if (nodeId == null || !graph) return null;
    if (typeof graph.getNodeById === "function") {
        return graph.getNodeById(nodeId) ?? graph.getNodeById(String(nodeId)) ?? null;
    }
    const id = String(nodeId);
    return getGraphNodes(graph).find((n) => String(n.id) === id) ?? null;
}

/**
 * Whether a node is a subgraph container (SubgraphNode instance).
 *
 * @param {Object} node - Node to test.
 * @returns {boolean} True for subgraph containers.
 */
function isContainer(node) {
    try {
        if (!node?.subgraph) return false;
        return typeof node.isSubgraphNode === "function" ? !!node.isSubgraphNode() : true;
    } catch {
        return false;
    }
}

/**
 * Whether a link is floating (one end unattached).
 *
 * @param {Object} link - Link object.
 * @returns {boolean} True when floating.
 */
function isFloatingLink(link) {
    return String(link.origin_id) === "-1" || String(link.target_id) === "-1";
}

/**
 * Check whether two slot types may connect. Uses `LiteGraph.isValidConnection`
 * when available (ComfyUI may patch it), else a copy of its logic.
 *
 * @param {*} typeA - First slot type.
 * @param {*} typeB - Second slot type.
 * @returns {boolean} True when compatible.
 */
function isValidConnection(typeA, typeB) {
    const lg = globalThis.LiteGraph;
    if (typeof lg?.isValidConnection === "function") {
        try {
            return !!lg.isValidConnection(typeA, typeB);
        } catch {
            // fall through to local logic
        }
    }
    let a = typeA === "" || typeA === "*" ? 0 : typeA;
    let b = typeB === "" || typeB === "*" ? 0 : typeB;
    if (!a || !b || a == b) return true;
    a = String(a).toLowerCase();
    b = String(b).toLowerCase();
    if (!a.includes(",") && !b.includes(",")) return a === b;
    const listA = a.split(",");
    const listB = b.split(",");
    return listA.some((x) => listB.some((y) => isValidConnection(x, y)));
}

/**
 * Pick the input a bypassed node forwards to a given output slot. Mirrors
 * `ExecutableNodeDTO._getBypassSlotIndex`.
 *
 * @param {Object} node - The bypassed node.
 * @param {number} slot - Output slot index on the node.
 * @param {*} type - Type of the final target input.
 * @returns {number} Input index, or -1 when no input matches.
 */
function getBypassSlotIndex(node, slot, type) {
    const inputs = node.inputs || [];
    if (type === "*" || type === "" || type == null) {
        if (inputs.length === 0) return -1;
        return inputs.length > slot ? slot : 0;
    }
    const outputType = node.outputs?.[slot]?.type;
    const opposite = inputs[slot];
    if (opposite && isValidConnection(opposite.type, outputType) && isValidConnection(opposite.type, type)) {
        return slot;
    }
    const exact = inputs.findIndex((input) => input?.type === type);
    if (exact !== -1) return exact;
    return inputs.findIndex(
        (input) => input && isValidConnection(input.type, outputType) && isValidConnection(input.type, type)
    );
}

/**
 * Read the REAL input link of a node slot, bypassing instance overrides
 * (GetNode-style nodes override `getInputLink`; SubgraphNode overrides it to
 * return an inner link). Falls back to `inputs[slot].link`.
 *
 * @param {Object} graph - Graph the node lives in.
 * @param {Object} node - The node.
 * @param {number} slot - Input slot index.
 * @returns {Object|null} The link, or null when nothing is connected.
 */
function getRealInputLink(graph, node, slot) {
    const protoFn = globalThis.LGraphNode?.prototype?.getInputLink;
    if (typeof protoFn === "function" && node?.graph) {
        try {
            return protoFn.call(node, slot) ?? null;
        } catch {
            // fall through to the slot field
        }
    }
    const linkId = node?.inputs?.[slot]?.link;
    return linkId == null ? null : getLinkById(graph, linkId);
}

/**
 * Find the link inside a subgraph that feeds its output node's slot.
 *
 * @param {Object} subgraph - Subgraph definition.
 * @param {number} slot - Output slot index (== container output slot).
 * @returns {Object|null} The inner link, or null.
 */
function getSubgraphOutputLink(subgraph, slot) {
    let index = outputLinkIndex.get(subgraph);
    if (!index) {
        index = new Map();
        for (const link of iterateLinks(subgraph)) {
            if (!link || String(link.target_id) !== SUBGRAPH_OUTPUT_ID) continue;
            if (!index.has(link.target_slot)) index.set(link.target_slot, link);
        }
        outputLinkIndex.set(subgraph, index);
    }
    const found = index.get(slot);
    if (found) return found;
    try {
        return subgraph.outputNode?.slots?.[slot]?.getLinks?.()?.[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * Whether an input of a node is declared lazy in its node definition.
 *
 * @param {Object} node - The node.
 * @param {number} slot - Input slot index.
 * @returns {boolean} True when the input is lazy.
 */
function isLazyInput(node, slot) {
    try {
        const name = node.inputs?.[slot]?.name;
        if (name == null) return false;
        const def = node.constructor?.nodeData?.input;
        const spec = def?.required?.[name] ?? def?.optional?.[name];
        return !!(Array.isArray(spec) && spec[1]?.lazy);
    } catch {
        return false;
    }
}

/**
 * Whether an input slot is required by the node definition AND has no widget
 * to fall back on -- i.e. the backend rejects the node ("Required input is
 * missing") when nothing resolves into it. Unknown inputs (dynamic / V3
 * autogrow names not present in the definition) are treated as optional so a
 * wrong guess can never grey out a working workflow.
 *
 * @param {Object} node - The node.
 * @param {number} slot - Input slot index.
 * @returns {boolean} True when an unresolved input invalidates the node.
 */
function isRequiredLinkInput(node, slot) {
    try {
        const input = node.inputs?.[slot];
        if (!input || input.widget) return false;
        const name = input.name;
        if (name == null) return false;
        const required = node.constructor?.nodeData?.input?.required;
        return !!(required && Object.prototype.hasOwnProperty.call(required, name));
    } catch {
        return false;
    }
}

/**
 * Whether a node is declared as an output node.
 *
 * @param {Object} node - The node.
 * @returns {boolean} True for output nodes.
 */
function isOutputNode(node) {
    try {
        return node.constructor?.nodeData?.output_node === true;
    } catch {
        return false;
    }
}

/**
 * Signature used to memoise virtual-hook failures for a node.
 *
 * @param {Object} node - The virtual node.
 * @returns {string} Signature string.
 */
function hookSignature(node) {
    let w0;
    try {
        w0 = node.widgets?.[0]?.value;
    } catch {
        w0 = undefined;
    }
    const graph = node.graph;
    return `${safeString(w0)}|${graph?._version}|${graph?.rootGraph?._version}`;
}

// ── Implicit Links ────────────────────────────────────────────────────────

/**
 * Implicit-link reader for Use Everywhere (cg-use-everywhere). UE's
 * connections are not links: it adds them only while building the prompt.
 * It does keep its current list of connections on each graph it analyses,
 * `graph.extra.ue_links` (also saved with the workflow), as
 * `{ downstream, downstream_slot, upstream, upstream_slot, controller }`.
 * Reads nothing else from UE; returns [] when the field is absent.
 *
 * @param {Object} graph - Graph to read.
 * @returns {Array<{target: *, targetSlot: number, origin: *, originSlot: number, via: *}>}
 *   Implicit links (graph-local node ids; `via` = the broadcasting node).
 */
export function readUseEverywhereLinks(graph) {
    const list = graph?.extra?.ue_links;
    if (!Array.isArray(list)) return EMPTY;
    const out = [];
    for (const e of list) {
        if (!e || e.downstream == null || e.upstream == null) continue;
        const targetSlot = Number(e.downstream_slot);
        const originSlot = Number(e.upstream_slot);
        if (!Number.isInteger(targetSlot) || !Number.isInteger(originSlot)) continue;
        out.push({ target: e.downstream, targetSlot, origin: e.upstream, originSlot, via: e.controller ?? null });
    }
    return out;
}

/**
 * Default implicit-link readers used when `buildFlowModel` gets no
 * `implicitLinks` option.
 */
const DEFAULT_IMPLICIT_READERS = Object.freeze([readUseEverywhereLinks]);

/**
 * Cheap signature of a graph's implicit links (for live rebuilds).
 *
 * @param {Object} graph - Graph to read.
 * @param {Array<function(Object): Array<Object>>} readers - Implicit-link readers.
 * @returns {string} Signature part ("" when there are none).
 */
function implicitSignature(graph, readers) {
    let s = "";
    for (const read of readers) {
        let links = EMPTY;
        try {
            links = read(graph) || EMPTY;
        } catch {
            links = EMPTY;
        }
        for (const l of links) s += `${l.origin}.${l.originSlot}>${l.target}.${l.targetSlot}@${l.via ?? ""};`;
    }
    return s;
}

// ── Key Helpers ───────────────────────────────────────────────────────────

/**
 * Graph key: "root" for the root graph, the subgraph id otherwise.
 *
 * @param {Object} graph - LGraph or Subgraph.
 * @returns {string} Graph key.
 */
function graphKeyOf(graph) {
    if (!graph) return "none";
    try {
        if (graph.isRootGraph === true) return "root";
        if (graph.isRootGraph === false) return graph.id != null ? String(graph.id) : "subgraph";
        if (graph.rootGraph && graph.rootGraph !== graph && graph.id != null) return String(graph.id);
        if ("inputNode" in graph && graph.id != null) return String(graph.id);
    } catch {
        // fall through
    }
    return "root";
}

/**
 * Graph-scoped key of a node (shared by model and renderer).
 *
 * @param {Object} graph - Graph containing the node.
 * @param {Object} node - The node.
 * @returns {string} `${graphKey}|N${node.id}`.
 */
export function nodeKey(graph, node) {
    return `${graphKeyOf(graph)}|N${node?.id}`;
}

/**
 * Graph-scoped key of a link (shared by model and renderer).
 *
 * @param {Object} graph - Graph containing the link.
 * @param {*} linkId - Graph-local link id.
 * @returns {string} `${graphKey}|L${linkId}`.
 */
export function linkKey(graph, linkId) {
    return `${graphKeyOf(graph)}|L${linkId}`;
}

/**
 * Graph-scoped key of a virtual (ghost) segment. Unique across all graphs.
 *
 * @param {Object} graph - Graph containing both nodes.
 * @param {Object} fromNode - Segment start node.
 * @param {Object} toNode - Segment end node.
 * @param {number} toSlot - Output slot on toNode.
 * @returns {string} Virtual segment key.
 */
function virtualKey(graph, fromNode, toNode, toSlot) {
    return `${graphKeyOf(graph)}|V${fromNode?.id}>${toNode?.id}:${toSlot}`;
}

// ── Change Signature ──────────────────────────────────────────────────────

/**
 * Cheap change signature for live rebuild detection. Covers each graph's
 * `_version`, node and link counts, every node's mode and the first widget
 * value of virtual nodes (Set/Get names) and the implicit links, recursing
 * into subgraphs.
 *
 * @param {Object} rootGraph - The root LGraph.
 * @param {Object} [options] - Same `implicitLinks` option as buildFlowModel.
 * @returns {string} Signature string (compare with ===).
 */
export function computeFlowSignature(rootGraph, options = {}) {
    const readers = Array.isArray(options?.implicitLinks) ? options.implicitLinks : DEFAULT_IMPLICIT_READERS;
    try {
        const parts = [];
        const seen = new Set();
        /**
         * Append one graph's signature part and recurse into its containers.
         * @param {Object} graph - Graph to visit.
         * @returns {void}
         */
        const visit = (graph) => {
            if (!graph || seen.has(graph)) return;
            seen.add(graph);
            const nodes = getGraphNodes(graph);
            let modes = "";
            const children = [];
            for (const node of nodes) {
                if (!node) continue;
                modes += `${node.mode ?? 0},`;
                if (isContainer(node)) {
                    children.push(node.subgraph);
                } else if (node.isVirtualNode) {
                    let w0;
                    try {
                        w0 = node.widgets?.[0]?.value;
                    } catch {
                        w0 = undefined;
                    }
                    modes += `<${safeString(w0)}>`;
                }
            }
            parts.push(`${graphKeyOf(graph)}#${graph._version ?? ""}#${nodes.length}#${countLinks(graph)}#${modes}` +
                `#${implicitSignature(graph, readers)}`);
            for (const child of children) visit(child);
        };
        visit(rootGraph);
        return parts.join("/");
    } catch (err) {
        warnOnce("Flow: failed to compute graph signature", err);
        return "error";
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Model Builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an empty (but fully functional) model, used for null input or on a
 * fatal error.
 *
 * @returns {Object} FlowModel with no nodes.
 */
function createEmptyModel() {
    return {
        maxDepth: 1,
        noOutputs: true,
        nodes: new Map(),
        edges: [],
        getNodeInfo: () => null,
        getLinkInfo: () => null,
        getVirtualSegments: () => EMPTY,
        traceSelection: () => ({ nodeKeys: new Set(), linkKeys: new Set(), virtualKeys: new Set() }),
        getGateTrace: () => null,
    };
}

/**
 * Build the flow model for the whole workflow (root graph plus all subgraphs
 * reached through container nodes). Never throws.
 *
 * @param {Object} rootGraph - The root LGraph (`app.graph`).
 * @param {Object} [options] - Build options.
 * @param {"start"|"late"} [options.sourcePlacement="start"] - Where nodes without
 *   resolved inputs sit: depth 0 ("start"), or just before their first consumer ("late").
 * @param {Array<function(Object): Array<Object>>} [options.implicitLinks] - Readers of
 *   connections that exist without a link (default: [readUseEverywhereLinks]). Each
 *   `reader(graph)` returns `{target, targetSlot, origin, originSlot, via}` records with
 *   graph-local node ids (`origin` may be the subgraph input id "-10"). An implicit link
 *   only fills an input that has no real link; it is drawn as a ghost from `via` (or the
 *   origin) to the target input, and `via` (when it is not the origin) becomes a hop.
 * @returns {Object} FlowModel (see SPEC: maxDepth, noOutputs, nodes, edges and getters).
 */
export function buildFlowModel(rootGraph, options = {}) {
    if (!rootGraph) return createEmptyModel();
    try {
        return buildModelInternal(rootGraph, options || {});
    } catch (err) {
        warnOnce("Flow: failed to build flow model", err);
        return createEmptyModel();
    } finally {
        outputLinkIndex = new WeakMap();
    }
}

/**
 * The actual model build (may throw; wrapped by {@link buildFlowModel}).
 *
 * @param {Object} rootGraph - The root LGraph.
 * @param {Object} options - Build options (see buildFlowModel).
 * @returns {Object} FlowModel.
 */
function buildModelInternal(rootGraph, options) {
    outputLinkIndex = new WeakMap();
    const sourcePlacement = options.sourcePlacement === "late" ? "late" : "start";
    const implicitReaders = Array.isArray(options.implicitLinks) ? options.implicitLinks : DEFAULT_IMPLICIT_READERS;

    /** graph -> { byTarget: Map<"id|slot", record>, vias: Set<string> } */
    const implicitIndex = new Map();

    /**
     * Implicit links of a graph, indexed by target input (built once per build).
     * Records whose broadcasting node is missing, muted or bypassed are
     * dropped (that node no longer broadcasts).
     * @param {Object} graph - Graph to index.
     * @returns {{byTarget: Map<string, Object>, vias: Set<string>}} Index.
     */
    const getImplicitIndex = (graph) => {
        let index = implicitIndex.get(graph);
        if (index) return index;
        index = { byTarget: new Map(), vias: new Set() };
        implicitIndex.set(graph, index);
        for (const read of implicitReaders) {
            let links = EMPTY;
            try {
                links = read(graph) || EMPTY;
            } catch (err) {
                warnOnce("Flow: an implicit-link reader threw", err);
            }
            for (const l of links) {
                if (!l || l.target == null || l.origin == null) continue;
                const via = l.via == null ? null : String(l.via);
                if (via !== null && via !== String(l.origin)) {
                    const viaNode = getNodeById(graph, via);
                    if (!viaNode || viaNode.mode === MODE_NEVER || viaNode.mode === MODE_BYPASS) continue;
                    index.vias.add(via);
                }
                const key = `${l.target}|${l.targetSlot}`;
                if (!index.byTarget.has(key)) index.byTarget.set(key, { ...l, via });
            }
        }
        return index;
    };

    /** execId -> FlowNode */
    const nodes = new Map();
    /** All FlowEdges. */
    const edges = [];
    /** Exec path string -> walk context. */
    const ctxByPath = new Map();
    /** nodeKey -> fixed info for muted / bypassed / container nodes found during the walk. */
    const walkInfo = new Map();
    /** Real FlowNode -> its walk context (internal). */
    const ctxOfNode = new Map();

    // ── Walk ──────────────────────────────────────────────────────────────

    /**
     * Walk one graph instance, registering real nodes and recursing into
     * active containers.
     * @param {Object} ctx - Walk context { graph, path, parent, container }.
     * @returns {void}
     */
    const walk = (ctx) => {
        ctxByPath.set(ctx.path.join(":"), ctx);
        for (const node of getGraphNodes(ctx.graph)) {
            if (!node) continue;
            try {
                const key = nodeKey(ctx.graph, node);
                const mode = node.mode;
                const container = isContainer(node);
                if (container && mode !== MODE_NEVER && mode !== MODE_BYPASS) {
                    if (!walkInfo.has(key)) walkInfo.set(key, { kind: "container" });
                    let cyclic = false;
                    for (let c = ctx; c; c = c.parent) {
                        if (c.graph === node.subgraph) cyclic = true;
                    }
                    if (cyclic) {
                        warnOnce(`Flow: recursive subgraph detected at node ${node.id}; not entering it`);
                        continue;
                    }
                    walk({
                        graph: node.subgraph,
                        path: [...ctx.path, String(node.id)],
                        parent: ctx,
                        container: node,
                    });
                    continue;
                }
                if (mode === MODE_NEVER) {
                    walkInfo.set(key, { kind: "muted" });
                    continue;
                }
                if (mode === MODE_BYPASS) {
                    walkInfo.set(key, { kind: "bypassed" });
                    continue;
                }
                if (container || node.isVirtualNode) continue;
                // A node that only broadcasts implicit links (UE node) is wiring, not work.
                if (getImplicitIndex(ctx.graph).vias.has(String(node.id))) continue;
                const execId = [...ctx.path, String(node.id)].join(":");
                const flowNode = {
                    execId,
                    node,
                    graph: ctx.graph,
                    depth: 0,
                    active: false,
                    conditional: false,
                    invalid: false,
                    isOutput: isOutputNode(node),
                    inEdges: [],
                    outEdges: [],
                };
                nodes.set(execId, flowNode);
                ctxOfNode.set(flowNode, ctx);
            } catch (err) {
                warnOnce("Flow: error while scanning a node", err);
            }
        }
    };
    walk({ graph: rootGraph, path: [], parent: null, container: null });

    // ── Resolution ────────────────────────────────────────────────────────

    /**
     * Execution id of a node within a context.
     * @param {Object} ctx - Walk context.
     * @param {Object} node - The node.
     * @returns {string} Execution id.
     */
    const execIdOf = (ctx, node) => [...ctx.path, String(node.id)].join(":");

    /**
     * Find the nearest context (self or ancestor) whose graph is `graph`.
     * @param {Object} ctx - Starting context.
     * @param {Object} graph - Graph to find.
     * @returns {Object|null} Matching context, or null.
     */
    const findCtxForGraph = (ctx, graph) => {
        for (let c = ctx; c; c = c.parent) {
            if (c.graph === graph) return c;
        }
        return null;
    };

    /**
     * Resolve an input slot of a node backward to its real source.
     * @param {Object} ctx - Context of the node.
     * @param {Object} node - The node whose input is resolved.
     * @param {number} slot - Input slot index.
     * @param {*} type - Type to match through bypassed nodes (undefined = this input's type).
     * @param {Array<Object>} segs - Segment accumulator (target -> source order).
     * @param {Set<string>} visited - Recursion guard.
     * @returns {Object|null} { ctx, node, slot } of the real source, or null.
     */
    const resolveInput = (ctx, node, slot, type, segs, visited) => {
        const guard = `${ctx.path.join(":")}|${node.id}[I]${slot}`;
        if (visited.has(guard)) return null;
        visited.add(guard);
        const link = getRealInputLink(ctx.graph, node, slot);
        if (!link) return resolveImplicit(ctx, node, slot, type ?? node.inputs?.[slot]?.type, segs, visited);
        return resolveFromLink(ctx, link, type ?? node.inputs?.[slot]?.type, segs, visited);
    };

    /**
     * Resolve an unlinked input through an implicit link (see options.implicitLinks):
     * ghost from the broadcasting node to the input, through the broadcaster as a
     * hop and its real input link when it has one from the origin, then on to
     * the origin output.
     * @param {Object} ctx - Context of the node.
     * @param {Object} node - The node whose input is resolved.
     * @param {number} slot - Input slot index.
     * @param {*} type - Target type.
     * @param {Array<Object>} segs - Segment accumulator.
     * @param {Set<string>} visited - Recursion guard.
     * @returns {Object|null} Real source, or null.
     */
    const resolveImplicit = (ctx, node, slot, type, segs, visited) => {
        const imp = getImplicitIndex(ctx.graph).byTarget.get(`${node.id}|${slot}`);
        if (!imp) return null;
        const originIsInput = String(imp.origin) === SUBGRAPH_INPUT_ID;
        const origin = originIsInput ? null : getNodeById(ctx.graph, imp.origin);
        if (!origin && !originIsInput) return null;
        const via = imp.via !== null && imp.via !== String(imp.origin) ? getNodeById(ctx.graph, imp.via) : null;
        const from = via ?? origin;
        if (from) {
            segs.push({
                type: "virtual",
                graph: ctx.graph,
                key: virtualKey(ctx.graph, from, node, `i${slot}`),
                fromNode: from,
                toNode: node,
                toSlot: -1,
                toInput: slot,
            });
        }
        if (via) {
            segs.push({ type: "hop", graph: ctx.graph, node: via });
            for (let i = 0; i < (via.inputs?.length ?? 0); i++) {
                const l = getRealInputLink(ctx.graph, via, i);
                if (l && String(l.origin_id) === String(imp.origin) && Number(l.origin_slot) === imp.originSlot) {
                    return resolveFromLink(ctx, l, type, segs, visited);
                }
            }
        }
        if (originIsInput) {
            if (!ctx.parent || !ctx.container) return null;
            return resolveInput(ctx.parent, ctx.container, imp.originSlot, undefined, segs, visited);
        }
        return resolveOutput(ctx, origin, imp.originSlot, type, segs, visited);
    };

    /**
     * Continue resolution from a link (recording it) to its origin.
     * @param {Object} ctx - Context of the graph the link lives in.
     * @param {Object} link - The link.
     * @param {*} type - Target type.
     * @param {Array<Object>} segs - Segment accumulator.
     * @param {Set<string>} visited - Recursion guard.
     * @returns {Object|null} Real source, or null.
     */
    const resolveFromLink = (ctx, link, type, segs, visited) => {
        if (!link || isFloatingLink(link)) return null;
        segs.push({ type: "link", graph: ctx.graph, linkId: link.id });
        if (String(link.origin_id) === SUBGRAPH_INPUT_ID) {
            if (!ctx.parent || !ctx.container) return null;
            return resolveInput(ctx.parent, ctx.container, link.origin_slot, undefined, segs, visited);
        }
        const origin = getNodeById(ctx.graph, link.origin_id);
        if (!origin) return null;
        return resolveOutput(ctx, origin, link.origin_slot, type, segs, visited);
    };

    /**
     * Resolve an output slot of a node to a real source (handles muted,
     * bypassed, container and virtual nodes).
     * @param {Object} ctx - Context of the node.
     * @param {Object} node - The origin node.
     * @param {number} slot - Output slot index.
     * @param {*} type - Target type.
     * @param {Array<Object>} segs - Segment accumulator.
     * @param {Set<string>} visited - Recursion guard.
     * @returns {Object|null} Real source, or null.
     */
    const resolveOutput = (ctx, node, slot, type, segs, visited) => {
        const guard = `${ctx.path.join(":")}|${node.id}[O]${slot}`;
        if (visited.has(guard)) return null;
        visited.add(guard);

        if (node.mode === MODE_NEVER) return null;

        if (node.mode === MODE_BYPASS) {
            const index = getBypassSlotIndex(node, slot, type);
            if (index === -1) return null;
            segs.push({ type: "hop", graph: ctx.graph, node });
            return resolveInput(ctx, node, index, undefined, segs, visited);
        }

        if (isContainer(node)) {
            const innerCtx = ctxByPath.get([...ctx.path, String(node.id)].join(":"));
            if (!innerCtx) return null;
            const innerLink = getSubgraphOutputLink(node.subgraph, slot);
            if (!innerLink) return null;
            return resolveFromLink(innerCtx, innerLink, type, segs, visited);
        }

        if (node.isVirtualNode) return resolveVirtual(ctx, node, slot, type, segs, visited);

        return { ctx, node, slot };
    };

    /**
     * Resolve through a virtual node via its generic hooks.
     * @param {Object} ctx - Context of the virtual node.
     * @param {Object} node - The virtual node.
     * @param {number} slot - Output slot index.
     * @param {*} type - Target type.
     * @param {Array<Object>} segs - Segment accumulator.
     * @param {Set<string>} visited - Recursion guard.
     * @returns {Object|null} Real source, or null.
     */
    const resolveVirtual = (ctx, node, slot, type, segs, visited) => {
        const signature = hookSignature(node);
        let memo = hookFailMemo.get(node);
        if (memo?.get(slot) === signature) return null;

        let virtualSource = null;
        try {
            virtualSource = node.resolveVirtualOutput?.(slot) ?? null;
        } catch {
            virtualSource = null;
        }
        if (virtualSource?.node) {
            const sourceGraph = virtualSource.node.graph;
            const sourceCtx = findCtxForGraph(ctx, sourceGraph);
            if (sourceCtx) {
                segs.push({ type: "hop", graph: ctx.graph, node });
                if (sourceGraph === ctx.graph) {
                    segs.push({
                        type: "virtual",
                        graph: ctx.graph,
                        key: virtualKey(ctx.graph, virtualSource.node, node, slot),
                        fromNode: virtualSource.node,
                        toNode: node,
                        toSlot: slot,
                    });
                }
                return resolveOutput(sourceCtx, virtualSource.node, virtualSource.slot ?? 0, type, segs, visited);
            }
        }

        let link = null;
        try {
            link = typeof node.getInputLink === "function" ? node.getInputLink(slot) ?? null : null;
        } catch {
            link = null;
        }
        if (link) {
            segs.push({ type: "hop", graph: ctx.graph, node });
            if (String(link.target_id) !== String(node.id)) {
                const setter = getNodeById(ctx.graph, link.target_id);
                if (setter) {
                    segs.push({
                        type: "virtual",
                        graph: ctx.graph,
                        key: virtualKey(ctx.graph, setter, node, slot),
                        fromNode: setter,
                        toNode: node,
                        toSlot: slot,
                    });
                    segs.push({ type: "hop", graph: ctx.graph, node: setter });
                }
            }
            return resolveFromLink(ctx, link, type, segs, visited);
        }

        if (!memo) {
            memo = new Map();
            hookFailMemo.set(node, memo);
        }
        memo.set(slot, signature);
        return null;
    };

    for (const flowNode of nodes.values()) {
        const ctx = ctxOfNode.get(flowNode);
        let inputCount = 0;
        try {
            inputCount = flowNode.node.inputs?.length ?? 0;
        } catch (err) {
            warnOnce("Flow: could not read a node's inputs", err);
        }
        for (let slot = 0; slot < inputCount; slot++) {
            try {
                const segs = [];
                const source = resolveInput(ctx, flowNode.node, slot, undefined, segs, new Set());
                const fromId = source ? execIdOf(source.ctx, source.node) : null;
                const fromNode = fromId ? nodes.get(fromId) : null;
                if (!fromNode || fromId === flowNode.execId) {
                    // Nothing real feeds this input (unconnected, or cut by a
                    // muted node / broken virtual hop). The backend's prompt
                    // validation rejects the node if the input is required.
                    if (isRequiredLinkInput(flowNode.node, slot)) flowNode.invalid = true;
                    continue;
                }
                const edge = {
                    from: fromId,
                    fromSlot: source.slot,
                    to: flowNode.execId,
                    toSlot: slot,
                    lazy: isLazyInput(flowNode.node, slot),
                    active: false,
                    segments: segs.reverse(),
                };
                edges.push(edge);
                fromNode.outEdges.push(edge);
                flowNode.inEdges.push(edge);
            } catch (err) {
                warnOnce("Flow: error while resolving an input link", err);
            }
        }
    }

    // ── Activity ──────────────────────────────────────────────────────────

    /**
     * Whether an output node survives backend prompt validation: the backend
     * validates every input recursively (lazy ones included) and drops the
     * whole output if any node upstream has a missing required input.
     * @param {Object} root - Output FlowNode.
     * @returns {boolean} True when no node in its upstream closure is invalid.
     */
    const passesValidation = (root) => {
        const seen = new Set([root.execId]);
        const stack = [root];
        while (stack.length) {
            const n = stack.pop();
            if (n.invalid) return false;
            for (const e of n.inEdges) {
                if (seen.has(e.from)) continue;
                seen.add(e.from);
                stack.push(nodes.get(e.from));
            }
        }
        return true;
    };

    // ── Guaranteed Execution ("will run if S runs") ───────────────────────

    /** execId -> Set of exec ids guaranteed to run whenever that node runs (memoised). */
    const willRunMemo = new Map();
    /** Marker for nodes whose set is being computed (cycle guard). */
    const IN_PROGRESS = new Set();

    /**
     * Nodes guaranteed to run when `n` runs: `n` itself, everything feeding it
     * through non-lazy inputs, and -- for a switch with two or more connected
     * lazy inputs, which always requests one of them -- the nodes common to
     * every branch. A single lazy input (a gate) guarantees nothing upstream.
     * Switch values are never interpreted.
     * @param {Object} n - FlowNode.
     * @returns {Set<string>} Guaranteed exec ids (do not mutate).
     */
    const willRun = (n) => {
        const cached = willRunMemo.get(n.execId);
        if (cached) return cached === IN_PROGRESS ? new Set([n.execId]) : cached;
        willRunMemo.set(n.execId, IN_PROGRESS);
        const result = new Set([n.execId]);
        let branches = null;
        for (const e of n.inEdges) {
            const from = nodes.get(e.from);
            if (!from) continue;
            if (e.lazy) {
                (branches ??= []).push(from);
                continue;
            }
            for (const id of willRun(from)) result.add(id);
        }
        if (branches && branches.length >= 2) {
            const sets = branches.map(willRun).sort((a, b) => a.size - b.size);
            for (const id of sets[0]) {
                if (sets.every((s) => s.has(id))) result.add(id);
            }
        }
        willRunMemo.set(n.execId, result);
        return result;
    };

    const outputNodes = [...nodes.values()].filter((n) => n.isOutput);
    const noOutputs = outputNodes.length === 0;
    const roots = outputNodes.filter(passesValidation);
    if (noOutputs) {
        for (const n of nodes.values()) n.active = true;
    } else {
        const active = new Set(roots.map((n) => n.execId));
        const stack = [...roots];
        while (stack.length) {
            const n = stack.pop();
            for (const e of n.inEdges) {
                if (active.has(e.from)) continue;
                active.add(e.from);
                stack.push(nodes.get(e.from));
            }
        }
        // Same result as the union of willRun(root), but sets are only built
        // for switch branches, so graphs without switches stay linear.
        const certain = new Set();
        const pending = [];
        /**
         * Mark an exec id as certain and queue it for propagation.
         * @param {string} id - Exec id.
         * @returns {void}
         */
        const markCertain = (id) => {
            if (certain.has(id)) return;
            certain.add(id);
            pending.push(nodes.get(id));
        };
        for (const root of roots) markCertain(root.execId);
        while (pending.length) {
            const n = pending.pop();
            let branches = null;
            for (const e of n.inEdges) {
                if (e.lazy) (branches ??= []).push(nodes.get(e.from));
                else markCertain(e.from);
            }
            if (branches && branches.length >= 2) {
                const sets = branches.map(willRun).sort((a, b) => a.size - b.size);
                for (const id of sets[0]) {
                    if (sets.every((s) => s.has(id))) markCertain(id);
                }
            }
        }
        for (const n of nodes.values()) {
            n.active = active.has(n.execId);
            n.conditional = n.active && !certain.has(n.execId);
        }
    }
    for (const e of edges) e.active = !!nodes.get(e.to)?.active;

    // ── Switches ──────────────────────────────────────────────────────────

    for (const n of nodes.values()) {
        n.lazySlots = [];
        for (const e of n.inEdges) {
            if (e.lazy && e.active) n.lazySlots.push(e.toSlot);
        }
        n.isSwitch = n.lazySlots.length > 0;
    }

    // ── Depth ─────────────────────────────────────────────────────────────

    const indegree = new Map();
    for (const n of nodes.values()) indegree.set(n.execId, n.inEdges.length);
    const queue = [];
    for (const n of nodes.values()) {
        if (n.inEdges.length === 0) queue.push(n);
    }
    let processed = 0;
    for (let qi = 0; qi < queue.length; qi++) {
        const n = queue[qi];
        processed++;
        for (const e of n.outEdges) {
            const target = nodes.get(e.to);
            if (target.depth < n.depth + 1) target.depth = n.depth + 1;
            const left = indegree.get(e.to) - 1;
            indegree.set(e.to, left);
            if (left === 0) queue.push(target);
        }
    }
    if (processed < nodes.size) {
        let max = 0;
        for (const n of nodes.values()) max = Math.max(max, n.depth);
        for (const n of nodes.values()) {
            if (indegree.get(n.execId) > 0) n.depth = max + 1;
        }
        warnOnce("Flow: cycle detected in the data flow; cyclic nodes placed last");
    }
    if (sourcePlacement === "late") {
        for (const n of nodes.values()) {
            if (n.inEdges.length !== 0 || n.outEdges.length === 0) continue;
            let minConsumer = Infinity;
            for (const e of n.outEdges) minConsumer = Math.min(minConsumer, nodes.get(e.to).depth);
            n.depth = Math.max(0, minConsumer - 1);
        }
    }
    let maxDepth = 0;
    for (const n of nodes.values()) {
        if (n.active) maxDepth = Math.max(maxDepth, n.depth);
    }
    maxDepth = Math.max(1, maxDepth);
    for (const n of nodes.values()) {
        if (n.depth > maxDepth) n.depth = maxDepth;
    }

    // ── Segment Timing ────────────────────────────────────────────────────

    /** linkKey -> link info */
    const linkInfo = new Map();
    /** virtual key -> virtual segment record */
    const virtualInfo = new Map();
    /** graphKey -> virtual segment records */
    const virtualByGraph = new Map();
    /** nodeKey -> hop aggregate */
    const hopInfo = new Map();
    /** nodeKey -> edges passing through the hop */
    const hopEdges = new Map();

    for (const e of edges) {
        const d0 = nodes.get(e.from).depth;
        const d1 = nodes.get(e.to).depth;
        const timed = e.segments.filter((s) => s.type !== "hop").length || 1;
        const edgeConditional = !noOutputs && e.active && (e.lazy || nodes.get(e.to).conditional);
        let k = 0;
        for (const seg of e.segments) {
            if (seg.type === "hop") {
                const t = d0 + ((d1 - d0) * k) / timed;
                const key = nodeKey(seg.graph, seg.node);
                let hop = hopInfo.get(key);
                if (!hop) {
                    hop = { node: seg.node, depth: t, active: false, allConditional: true };
                    hopInfo.set(key, hop);
                    hopEdges.set(key, []);
                }
                hop.depth = Math.min(hop.depth, t);
                if (e.active) {
                    hop.active = true;
                    if (!edgeConditional) hop.allConditional = false;
                }
                hopEdges.get(key).push(e);
                continue;
            }
            const t0 = d0 + ((d1 - d0) * k) / timed;
            const t1 = d0 + ((d1 - d0) * (k + 1)) / timed;
            k++;
            if (seg.type === "link") {
                const key = linkKey(seg.graph, seg.linkId);
                const info = linkInfo.get(key);
                if (!info) {
                    linkInfo.set(key, { t0, t1, active: e.active, lazy: e.lazy, toIds: [e.to] });
                } else {
                    info.t0 = Math.min(info.t0, t0);
                    info.t1 = Math.max(info.t0, Math.min(info.t1, t1));
                    info.active = info.active || e.active;
                    info.lazy = info.lazy && e.lazy;
                    if (!info.toIds.includes(e.to)) info.toIds.push(e.to);
                }
            } else if (seg.type === "virtual") {
                let info = virtualInfo.get(seg.key);
                if (!info) {
                    info = {
                        key: seg.key,
                        fromNode: seg.fromNode,
                        toNode: seg.toNode,
                        toSlot: seg.toSlot,
                        toInput: seg.toInput ?? -1,
                        t0,
                        t1,
                        active: e.active,
                        lazy: e.lazy,
                        toIds: [e.to],
                    };
                    virtualInfo.set(seg.key, info);
                    const gk = graphKeyOf(seg.graph);
                    if (!virtualByGraph.has(gk)) virtualByGraph.set(gk, []);
                    virtualByGraph.get(gk).push(info);
                } else {
                    info.t0 = Math.min(info.t0, t0);
                    info.t1 = Math.max(info.t0, Math.min(info.t1, t1));
                    info.active = info.active || e.active;
                    info.lazy = info.lazy && e.lazy;
                    if (!info.toIds.includes(e.to)) info.toIds.push(e.to);
                }
            }
        }
    }

    // ── Node Infos ────────────────────────────────────────────────────────

    /** nodeKey -> getNodeInfo result */
    const nodeInfo = new Map();
    /** execId -> node keys of all containers around it */
    const containerKeysOf = new Map();
    /** container nodeKey -> aggregate */
    const containerAgg = new Map();

    for (const n of nodes.values()) {
        const key = nodeKey(n.graph, n.node);
        let info = nodeInfo.get(key);
        if (!info) {
            info = {
                kind: "real",
                depth: n.depth,
                depthEnd: n.depth,
                active: n.active,
                conditional: n.conditional,
                invalid: n.invalid,
                isSwitch: n.isSwitch,
                lazySlots: n.lazySlots,
                execIds: [n.execId],
            };
            nodeInfo.set(key, info);
        } else {
            info.invalid = info.invalid || n.invalid;
            if (n.isSwitch && !info.isSwitch) {
                info.isSwitch = true;
                info.lazySlots = n.lazySlots;
            }
            info.depth = info.depthEnd = Math.min(info.depth, n.depth);
            info.conditional = info.active ? info.conditional && (!n.active || n.conditional) : n.conditional;
            info.active = info.active || n.active;
            info.execIds.push(n.execId);
        }

        const keys = [];
        for (let c = ctxOfNode.get(n); c?.container; c = c.parent) {
            const ckey = nodeKey(c.parent.graph, c.container);
            keys.push(ckey);
            let agg = containerAgg.get(ckey);
            if (!agg) {
                agg = {
                    activeMin: Infinity,
                    activeMax: -Infinity,
                    allMin: Infinity,
                    allMax: -Infinity,
                    active: false,
                    allConditional: true,
                    execIds: [],
                };
                containerAgg.set(ckey, agg);
            }
            agg.allMin = Math.min(agg.allMin, n.depth);
            agg.allMax = Math.max(agg.allMax, n.depth);
            if (n.active) {
                agg.active = true;
                agg.activeMin = Math.min(agg.activeMin, n.depth);
                agg.activeMax = Math.max(agg.activeMax, n.depth);
                if (!n.conditional) agg.allConditional = false;
            }
            agg.execIds.push(n.execId);
        }
        containerKeysOf.set(n.execId, keys);
    }

    for (const [key, fixed] of walkInfo) {
        if (fixed.kind === "container") {
            const agg = containerAgg.get(key);
            if (!agg) {
                nodeInfo.set(key, {
                    kind: "container",
                    depth: NaN,
                    depthEnd: NaN,
                    active: false,
                    conditional: false,
                    execIds: [],
                });
                continue;
            }
            const depth = agg.active ? agg.activeMin : agg.allMin;
            const depthEnd = agg.active ? agg.activeMax : agg.allMax;
            nodeInfo.set(key, {
                kind: "container",
                depth,
                depthEnd,
                active: agg.active,
                conditional: agg.active && agg.allConditional,
                execIds: agg.execIds,
            });
        } else if (fixed.kind === "muted") {
            nodeInfo.set(key, {
                kind: "muted",
                depth: NaN,
                depthEnd: NaN,
                active: false,
                conditional: false,
                execIds: [],
            });
        } else if (fixed.kind === "bypassed" && !hopInfo.has(key)) {
            nodeInfo.set(key, {
                kind: "bypassed",
                depth: NaN,
                depthEnd: NaN,
                active: false,
                conditional: false,
                execIds: [],
            });
        }
    }

    for (const [key, hop] of hopInfo) {
        if (nodeInfo.has(key)) continue;
        nodeInfo.set(key, {
            kind: hop.node.mode === MODE_BYPASS ? "bypassed" : "virtual",
            depth: hop.depth,
            depthEnd: hop.depth,
            active: hop.active,
            conditional: hop.active && hop.allConditional,
            execIds: [],
        });
    }

    // Uniform fields on every info.
    for (const info of nodeInfo.values()) {
        info.certain = !!info.active && !info.conditional;
        info.isSwitch = !!info.isSwitch;
        info.lazySlots ??= EMPTY;
        info.invalid = !!info.invalid;
    }

    // ── Gate Tracing ──────────────────────────────────────────────────────

    /**
     * Nearest downstream switches where a conditional node stops being
     * guaranteed to run. Walks downstream while the node stays in the target's
     * "will run" set; a lazy edge into a node whose set no longer contains it
     * marks that node as a gate.
     * @param {string} execId - Conditional real node.
     * @param {Object} acc - Accumulator { gateIds: Set, edges: Set }.
     * @returns {void}
     */
    const collectGates = (execId, acc) => {
        const seen = new Set([execId]);
        const stack = [execId];
        while (stack.length) {
            const n = nodes.get(stack.pop());
            for (const e of n.outEdges) {
                if (!e.active) continue;
                const target = nodes.get(e.to);
                if (willRun(target).has(execId)) {
                    acc.edges.add(e);
                    if (!seen.has(e.to)) {
                        seen.add(e.to);
                        stack.push(e.to);
                    }
                } else if (e.lazy) {
                    acc.edges.add(e);
                    acc.gateIds.add(e.to);
                }
            }
        }
    };

    // ── Getters ───────────────────────────────────────────────────────────

    /**
     * Info for any node object shown in some graph.
     * @param {Object} graph - Graph the node is shown in.
     * @param {Object} node - The node.
     * @returns {Object|null} Node info, or null when the node is not part of the flow.
     */
    const getNodeInfo = (graph, node) => {
        try {
            return nodeInfo.get(nodeKey(graph, node)) ?? null;
        } catch {
            return null;
        }
    };

    /**
     * Info for a visual link.
     * @param {Object} graph - Graph the link lives in.
     * @param {*} linkId - Graph-local link id.
     * @returns {Object|null} { t0, t1, active, lazy, toIds }, or null when not on a resolved data path
     *   (`toIds`: exec ids of the real nodes the link feeds).
     */
    const getLinkInfo = (graph, linkId) => {
        try {
            return linkInfo.get(linkKey(graph, linkId)) ?? null;
        } catch {
            return null;
        }
    };

    /**
     * Ghost segments (Set/Get style virtual hops) to draw in a graph.
     * @param {Object} graph - The viewed graph.
     * @returns {Array<Object>} Virtual segment records (do not mutate).
     */
    const getVirtualSegments = (graph) => {
        try {
            return virtualByGraph.get(graphKeyOf(graph)) ?? EMPTY;
        } catch {
            return EMPTY;
        }
    };

    /**
     * Upstream + downstream closure of a selection.
     * @param {Object} graph - The viewed graph.
     * @param {Iterable<Object>} selectedNodes - Selected LGraphNode objects in `graph`.
     * @returns {{nodeKeys: Set<string>, linkKeys: Set<string>, virtualKeys: Set<string>}} Keys in the trace.
     */
    const traceSelection = (graph, selectedNodes) => {
        const result = { nodeKeys: new Set(), linkKeys: new Set(), virtualKeys: new Set() };
        try {
            const upSeeds = [];
            const downSeeds = [];
            const forced = new Set();
            for (const node of selectedNodes || EMPTY) {
                if (!node) continue;
                const key = nodeKey(graph, node);
                result.nodeKeys.add(key);
                const info = nodeInfo.get(key);
                if (!info) continue;
                for (const id of info.execIds) {
                    upSeeds.push(id);
                    downSeeds.push(id);
                }
                for (const e of hopEdges.get(key) ?? EMPTY) {
                    upSeeds.push(e.from);
                    downSeeds.push(e.to);
                    forced.add(e);
                }
            }

            /**
             * Closure over edges in one direction.
             * @param {Array<string>} seeds - Starting exec ids.
             * @param {boolean} upstream - Walk inEdges (true) or outEdges (false).
             * @returns {Set<string>} Reached exec ids (including seeds).
             */
            const closure = (seeds, upstream) => {
                const seen = new Set();
                const stack = [];
                for (const id of seeds) {
                    if (nodes.has(id) && !seen.has(id)) {
                        seen.add(id);
                        stack.push(id);
                    }
                }
                while (stack.length) {
                    const n = nodes.get(stack.pop());
                    for (const e of upstream ? n.inEdges : n.outEdges) {
                        const next = upstream ? e.from : e.to;
                        if (seen.has(next)) continue;
                        seen.add(next);
                        stack.push(next);
                    }
                }
                return seen;
            };
            const up = closure(upSeeds, true);
            const down = closure(downSeeds, false);

            for (const set of [up, down]) {
                for (const id of set) {
                    const n = nodes.get(id);
                    result.nodeKeys.add(nodeKey(n.graph, n.node));
                    for (const ck of containerKeysOf.get(id) ?? EMPTY) result.nodeKeys.add(ck);
                }
            }
            for (const e of edges) {
                const included =
                    forced.has(e) || (up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to));
                if (!included) continue;
                for (const seg of e.segments) {
                    if (seg.type === "link") result.linkKeys.add(linkKey(seg.graph, seg.linkId));
                    else if (seg.type === "virtual") result.virtualKeys.add(seg.key);
                    else result.nodeKeys.add(nodeKey(seg.graph, seg.node));
                }
            }
        } catch (err) {
            warnOnce("Flow: error while tracing the selection", err);
        }
        return result;
    };

    /**
     * Gate trace of a conditional node: the switches it depends on, plus the
     * keys of everything to highlight (gates, their enclosing containers, and
     * the links / ghosts from the node to the gates).
     * @param {Object} graph - Graph the node is shown in.
     * @param {Object} node - The node (real, container or hop).
     * @returns {null|{gates: Array<Object>, nodeKeys: Set<string>, linkKeys: Set<string>, virtualKeys: Set<string>}}
     *   Trace, or null when the node is not conditional.
     */
    const getGateTrace = (graph, node) => {
        try {
            const key = nodeKey(graph, node);
            const info = nodeInfo.get(key);
            if (!info?.conditional) return null;
            const seeds = new Set(info.execIds);
            for (const e of hopEdges.get(key) ?? EMPTY) {
                if (e.active) seeds.add(e.from);
            }
            const acc = { gateIds: new Set(), edges: new Set() };
            for (const id of seeds) {
                if (nodes.get(id)?.conditional) collectGates(id, acc);
            }
            for (const e of hopEdges.get(key) ?? EMPTY) {
                if (e.active) acc.edges.add(e);
            }
            const result = { gates: [], nodeKeys: new Set(), linkKeys: new Set(), virtualKeys: new Set() };
            for (const id of acc.gateIds) {
                const g = nodes.get(id);
                let title = g.node.type;
                try {
                    title = g.node.getTitle?.() || g.node.title || g.node.type;
                } catch {
                    // keep the type
                }
                result.gates.push({ execId: id, node: g.node, graph: g.graph, title });
                result.nodeKeys.add(nodeKey(g.graph, g.node));
                for (const ck of containerKeysOf.get(id) ?? EMPTY) result.nodeKeys.add(ck);
            }
            for (const e of acc.edges) {
                for (const seg of e.segments) {
                    if (seg.type === "link") result.linkKeys.add(linkKey(seg.graph, seg.linkId));
                    else if (seg.type === "virtual") result.virtualKeys.add(seg.key);
                }
            }
            result.gates.sort((a, b) => a.execId.localeCompare(b.execId));
            return result;
        } catch (err) {
            warnOnce("Flow: error while tracing gating switches", err);
            return null;
        }
    };

    return {
        maxDepth,
        noOutputs,
        nodes,
        edges,
        getNodeInfo,
        getLinkInfo,
        getVirtualSegments,
        traceSelection,
        getGateTrace,
    };
}
