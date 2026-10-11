/**
 * Mock LiteGraph objects for testing `js/flowGraph.js` under Node, plus a
 * loader that builds those mocks from a serialized ComfyUI workflow (UI
 * format 0.4) and captured node definitions (see `captureNodeDefs.mjs`).
 *
 * The mocks reproduce only what the flow model reads: `_nodes`, `links`
 * (Map), `getLink`, `getNodeById`, `isRootGraph`, `_version`, subgraph
 * `inputNode` / `outputNode`, node `id` (string), `type`, `mode`, `inputs`,
 * `outputs`, `widgets`, `graph`, `isVirtualNode`, `subgraph`,
 * `isSubgraphNode`, `getInputLink`, `resolveVirtualOutput` and
 * `constructor.nodeData`.
 *
 * Importing this module sets `globalThis.LGraphNode` to {@link MockNode}, so
 * the model's prototype `getInputLink` call resolves to the default
 * implementation below.
 *
 * Frontend-only node types (no backend definition) are emulated:
 *   - `Reroute`: virtual, default getInputLink.
 *   - `SetNode` / `GetNode`: KJNodes semantics (`web/js/setgetnodes.js`):
 *     GetNode.getInputLink finds a same-named SetNode in its own graph and
 *     returns the link feeding the setter; GetNode.resolveVirtualOutput looks
 *     in ancestor graphs and only answers when the setter is in another graph.
 *   - Anything else without a definition (Note, MarkdownNote, PrimitiveNode,
 *     rgthree Bookmark...): virtual, resolves nothing.
 */

// ── Mock Classes ──────────────────────────────────────────────────────────

/** Minimal LGraphNode stand-in. */
export class MockNode {
    /**
     * @param {*} id - Node id (stored as a string, like frontend >= 1.46).
     * @param {Object} [opts] - Options.
     * @param {Array<string|Object>} [opts.inputs] - Input types or full input objects.
     * @param {Array<string>} [opts.outputs] - Output types.
     * @param {number} [opts.mode] - Node mode (0 / 2 muted / 4 bypassed).
     * @param {boolean} [opts.virtual] - Mark as virtual node.
     * @param {Array<*>} [opts.widgets] - Widget values.
     * @param {string} [opts.type] - Node type.
     */
    constructor(id, opts = {}) {
        this.id = String(id);
        if (opts.type != null) this.type = opts.type;
        this.inputs = (opts.inputs || []).map((t, i) =>
            typeof t === "string" ? { name: `in${i}`, type: t, link: null } : { link: null, ...t }
        );
        this.outputs = (opts.outputs || []).map((t, i) => (typeof t === "string" ? { name: `out${i}`, type: t } : { ...t }));
        this.mode = opts.mode ?? 0;
        if (opts.virtual) this.isVirtualNode = true;
        if (opts.widgets) this.widgets = opts.widgets.map((v) => ({ value: v }));
    }

    /**
     * Default LGraphNode.getInputLink.
     * @param {number} slot - Input slot index.
     * @returns {Object|null} The link feeding the slot, or null.
     */
    getInputLink(slot) {
        const id = this.inputs[slot]?.link;
        return id == null ? null : this.graph.getLink(id);
    }
}
globalThis.LGraphNode = MockNode;

/** Minimal LGraph / Subgraph stand-in. */
export class MockGraph {
    /**
     * @param {string} id - Graph id (subgraph definition id for subgraphs).
     * @param {boolean} [isSub] - Whether this is a subgraph (adds IO nodes -10 / -20).
     */
    constructor(id, isSub = false) {
        this.id = id;
        this._nodes = [];
        this._byId = new Map();
        this.links = new Map();
        this._version = 0;
        this.nextLink = 1;
        if (isSub) {
            this.inputNode = { id: "-10" };
            this.outputNode = { id: "-20" };
        }
    }

    /**
     * Add nodes to the graph.
     * @param {...Object} nodes - Nodes to add.
     * @returns {Object} The first node added.
     */
    add(...nodes) {
        for (const n of nodes) {
            n.graph = this;
            this._nodes.push(n);
            this._byId.set(String(n.id), n);
        }
        return nodes[0];
    }

    /**
     * @param {*} id - Node id.
     * @returns {Object|null} The node, or null.
     */
    getNodeById(id) {
        return this._byId.get(String(id)) ?? null;
    }

    /**
     * @param {*} id - Link id.
     * @returns {Object|undefined} The link.
     */
    getLink(id) {
        return this.links.get(id);
    }

    /**
     * Connect two slots with a new link.
     * @param {Object|string} from - Origin node, or "-10" (subgraph input).
     * @param {number} fromSlot - Origin slot.
     * @param {Object|string} to - Target node, or "-20" (subgraph output).
     * @param {number} toSlot - Target slot.
     * @returns {Object} The new link.
     */
    connect(from, fromSlot, to, toSlot) {
        const id = this.nextLink++;
        const link = {
            id,
            origin_id: typeof from === "string" ? from : from.id,
            origin_slot: fromSlot,
            target_id: typeof to === "string" ? to : to.id,
            target_slot: toSlot,
            type: "*",
        };
        this.links.set(id, link);
        if (typeof to !== "string") to.inputs[toSlot].link = id;
        this._version++;
        return link;
    }
}

/**
 * Make a real node whose class carries `nodeData`.
 *
 * @param {*} id - Node id.
 * @param {Object} [opts] - MockNode options plus `output` (output node) and `nodeInput` (input spec).
 * @returns {MockNode} The node.
 */
export function mk(id, opts = {}) {
    const C = class extends MockNode {};
    C.nodeData = { output_node: !!opts.output, input: opts.nodeInput || { required: {} } };
    return new C(id, opts);
}

/**
 * Turn a node into a subgraph container: `subgraph`, `isSubgraphNode()`,
 * `isVirtualNode = true` and a `getInputLink` override returning a bogus
 * link (mimics SubgraphNode returning the INNER link; the model must not use it).
 *
 * @param {MockNode} node - Node to decorate.
 * @param {MockGraph} subgraph - Subgraph definition graph.
 * @returns {MockNode} The same node.
 */
function makeContainer(node, subgraph) {
    node.isVirtualNode = true;
    node.subgraph = subgraph;
    node.isSubgraphNode = () => true;
    node.getInputLink = () => ({ id: 999, origin_id: "bogus", origin_slot: 0, target_id: node.id, target_slot: 0 });
    return node;
}

/**
 * Make a subgraph container node.
 *
 * @param {*} id - Node id.
 * @param {MockGraph} subgraph - Subgraph definition graph.
 * @param {Array<string|Object>} inputs - Input types.
 * @param {Array<string>} outputs - Output types.
 * @returns {MockNode} The container.
 */
export function mkContainer(id, subgraph, inputs, outputs) {
    return makeContainer(new MockNode(id, { inputs, outputs }), subgraph);
}

// ── KJNodes Set/Get Emulation ─────────────────────────────────────────────

/**
 * Ancestor chain of a graph, nearest first: [graph, parent, ..., root].
 * Mirrors KJNodes `getGraphAncestors` (parent = first graph found holding a
 * container of it, root searched first).
 *
 * @param {MockGraph} graph - Starting graph.
 * @returns {Array<MockGraph>} Ancestor chain.
 */
function getGraphAncestors(graph) {
    const root = graph?.rootGraph ?? graph;
    if (!graph || graph === root) return [root];
    const chain = [graph];
    let current = graph;
    while (current !== root) {
        let parent = null;
        if (root._nodes.some((n) => n.subgraph === current)) {
            parent = root;
        } else {
            for (const sg of root._subgraphs.values()) {
                if (sg !== current && sg._nodes.some((n) => n.subgraph === current)) {
                    parent = sg;
                    break;
                }
            }
        }
        if (!parent || chain.includes(parent)) {
            if (!chain.includes(root)) chain.push(root);
            break;
        }
        chain.push(parent);
        current = parent;
    }
    return chain;
}

/**
 * Scoped setter lookup: own graph first, then ancestors (KJNodes `findSetterByName`).
 *
 * @param {MockGraph} graph - Graph of the getter.
 * @param {*} name - Set/Get name.
 * @returns {{node: MockNode, graph: MockGraph}|null} The setter, or null.
 */
function findSetterByName(graph, name) {
    if (!name) return null;
    for (const g of getGraphAncestors(graph)) {
        for (const node of g._nodes) {
            if (node.type === "SetNode" && node.widgets?.[0]?.value === name) return { node, graph: g };
        }
    }
    return null;
}

/** KJNodes GetNode: virtual, resolves through a same-named SetNode. */
class GetNodeMock extends MockNode {
    /**
     * Same-graph resolution: the link feeding the setter's input slot.
     * @param {number} slot - Slot index.
     * @returns {Object|null} Link, or null.
     */
    getInputLink(slot) {
        const name = this.widgets?.[0]?.value;
        if (!name) return null;
        const setter = this.graph._nodes.find((n) => n.type === "SetNode" && n.widgets?.[0]?.value === name);
        if (!setter) return null;
        const id = setter.inputs[slot]?.link;
        return id == null ? null : this.graph.getLink(id) ?? null;
    }

    /**
     * Cross-graph resolution: source node feeding a setter in an ancestor graph.
     * @param {number} slot - Slot index.
     * @returns {{node: MockNode, slot: number}|undefined} Source, or undefined.
     */
    resolveVirtualOutput(slot) {
        const name = this.widgets?.[0]?.value;
        const result = findSetterByName(this.graph, name);
        if (!result || result.graph === this.graph) return undefined;
        const ancestors = getGraphAncestors(this.graph);
        let count = 0;
        for (const g of ancestors) {
            for (const n of g._nodes) {
                if (n.type === "SetNode" && n.widgets?.[0]?.value === name) count++;
            }
        }
        if (count > 1) return undefined;
        const id = result.node.inputs[slot]?.link;
        if (id == null) return undefined;
        const link = result.graph.getLink(id);
        if (!link) return undefined;
        const source = result.graph.getNodeById(link.origin_id);
        return source ? { node: source, slot: link.origin_slot } : undefined;
    }
}

/** Frontend-only virtual node that resolves nothing (Note, PrimitiveNode, Bookmark...). */
class InertVirtualMock extends MockNode {
    /**
     * @returns {null} Never resolves.
     */
    getInputLink() {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Loader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalise a serialized link (array or object form) into a link object.
 *
 * @param {Array|Object} raw - `[id, origin_id, origin_slot, target_id, target_slot, type]` or object.
 * @returns {Object|null} Link object with string node ids, or null.
 */
function normaliseLink(raw) {
    if (!raw) return null;
    const l = Array.isArray(raw)
        ? { id: raw[0], origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4], type: raw[5] }
        : { ...raw };
    l.origin_id = String(l.origin_id);
    l.target_id = String(l.target_id);
    return l;
}

/**
 * Build mock graphs from a serialized workflow.
 *
 * @param {Object} workflow - Serialized workflow (UI format 0.4).
 * @param {Object} nodeDefs - type -> `{output_node, input: {required, optional}}`.
 * @returns {{root: MockGraph, subgraphs: Map<string, MockGraph>, virtualTypes: Set<string>}}
 *   Root graph, subgraph graphs by id, and the node types emulated as virtual.
 */
export function loadWorkflow(workflow, nodeDefs) {
    const root = new MockGraph(workflow.id ?? "root");
    root.isRootGraph = true;
    root.rootGraph = root;
    root._subgraphs = new Map();

    const defs = workflow?.definitions?.subgraphs || [];
    for (const def of defs) {
        const sg = new MockGraph(def.id, true);
        sg.isRootGraph = false;
        sg.rootGraph = root;
        sg.name = def.name;
        root._subgraphs.set(def.id, sg);
    }

    /** type -> real node class carrying nodeData */
    const classes = new Map();
    const virtualTypes = new Set();

    /**
     * Pick (and cache) the class for a node type.
     * @param {string} type - Node type.
     * @returns {Function} Class to instantiate.
     */
    const classFor = (type) => {
        let C = classes.get(type);
        if (C) return C;
        if (type === "GetNode") C = GetNodeMock;
        else if (type === "SetNode" || type === "Reroute") C = class extends MockNode {};
        else if (nodeDefs[type]) {
            C = class extends MockNode {};
            C.nodeData = nodeDefs[type];
        } else C = InertVirtualMock;
        classes.set(type, C);
        return C;
    };

    /**
     * Instantiate one serialized node into a graph.
     * @param {MockGraph} graph - Target graph.
     * @param {Object} raw - Serialized node.
     * @returns {void}
     */
    const addNode = (graph, raw) => {
        const C = classFor(raw.type);
        const node = new C(raw.id, {
            type: raw.type,
            mode: raw.mode ?? 0,
            inputs: (raw.inputs || []).map((i) => ({
                name: i.name,
                type: i.type,
                link: i.link ?? null,
                ...(i.widget ? { widget: i.widget } : {}),
            })),
            outputs: (raw.outputs || []).map((o) => ({ name: o.name, type: o.type, links: o.links ?? null })),
            widgets: Array.isArray(raw.widgets_values) ? raw.widgets_values : [],
        });
        node.title = raw.title;
        const sub = root._subgraphs.get(raw.type);
        if (sub) {
            makeContainer(node, sub);
        } else if (!nodeDefs[raw.type]) {
            node.isVirtualNode = true;
            virtualTypes.add(raw.type);
        }
        graph.add(node);
    };

    /**
     * Fill a graph's nodes and links.
     * @param {MockGraph} graph - Target graph.
     * @param {Array<Object>} nodes - Serialized nodes.
     * @param {Array<Array|Object>} links - Serialized links.
     * @returns {void}
     */
    const fill = (graph, nodes, links) => {
        for (const raw of nodes || []) addNode(graph, raw);
        for (const raw of links || []) {
            const link = normaliseLink(raw);
            if (link) graph.links.set(link.id, link);
        }
    };

    fill(root, workflow.nodes, workflow.links);
    for (const def of defs) fill(root._subgraphs.get(def.id), def.nodes, def.links);
    return { root, subgraphs: root._subgraphs, virtualTypes };
}
