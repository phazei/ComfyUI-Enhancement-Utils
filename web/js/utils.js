/**
 * Shared utility functions for ComfyUI Enhancement Utils.
 *
 * Provides helpers for working with ComfyUI's node identifier systems,
 * especially the colon-delimited execution IDs used for subgraph support.
 *
 * ComfyUI uses three distinct node identifier types:
 *   - node.id        (number)  -- Local to its immediate graph level.
 *   - Execution ID   (string)  -- Colon-separated path, e.g. "5:12:3".
 *                                  Used in backend progress messages and UNIQUE_ID.
 *   - Locator ID     (string)  -- "<uuid>:<localId>" for UI state (badges, errors).
 *
 * Based on utilities from ComfyUI-Prompt-Stash by phazei.
 */

import { app } from "../../scripts/app.js";

// ── Execution ID Utilities ────────────────────────────────────────────────

/**
 * Get the full colon-delimited execution ID for a node, matching the
 * backend format used in progress messages and UNIQUE_ID.
 *
 * Returns "54:62:73" for nested subgraphs, or just "73" for root-level nodes.
 *
 * @param {Object} node - The LiteGraph node.
 * @returns {string} The full execution ID path.
 */
export function getUniqueIdFromNode(node) {
    const leafId = node.id;

    // Easy case: node is in root graph.
    if (node.graph?.isRootGraph) {
        return String(leafId);
    }

    const targetUUID = node.graph?.id;
    const rootGraph = node.graph?.rootGraph;

    if (!rootGraph || !targetUUID) {
        return String(leafId); // Fallback.
    }

    // Get the set of subgraph UUIDs for quick lookup.
    const subgraphUUIDs = new Set(rootGraph.subgraphs?.keys() ?? []);

    /**
     * Recursive search: find the path of node IDs leading to targetUUID.
     * @param {Object} graph - The graph to search in.
     * @param {string} target - The UUID of the subgraph we're looking for.
     * @returns {Array<number>|null} Array of node IDs forming the path, or null.
     */
    const findPathToUUID = (graph, target) => {
        for (const graphNode of graph.nodes ?? []) {
            if (subgraphUUIDs.has(graphNode.type) && graphNode.subgraph) {
                if (graphNode.subgraph.id === target) {
                    return [graphNode.id];
                }
                const deeperPath = findPathToUUID(graphNode.subgraph, target);
                if (deeperPath) {
                    return [graphNode.id, ...deeperPath];
                }
            }
        }
        return null;
    };

    const path = findPathToUUID(rootGraph, targetUUID);

    if (path) {
        return [...path, leafId].join(":");
    }

    // Fallback if we couldn't find the path (shouldn't happen).
    console.warn("[EnhancementUtils] getUniqueIdFromNode: Could not resolve subgraph path for node", node.id);
    return String(leafId);
}

/**
 * Check if a node matches a colon-delimited execution ID from the backend.
 * Handles subgraph paths like "54:73" or "54:62:174".
 *
 * @param {Object} node - The LiteGraph node to check.
 * @param {string|number} uniqueId - The execution ID (e.g., "54:73" or "73").
 * @returns {boolean} True if the node matches.
 */
export function nodeMatchesUniqueId(node, uniqueId) {
    const parts = String(uniqueId).split(":").map(Number);
    const localId = parts.pop();

    // Quick exit: local ID must match.
    if (localId !== node.id) return false;

    // No prefix means node should be in root graph.
    if (parts.length === 0) {
        return node.graph?.isRootGraph ?? true;
    }

    // Walk the path from root to find the target subgraph's UUID.
    let current = node.graph?.rootGraph;
    if (!current) return false;

    for (const subgraphNodeId of parts) {
        const subgraphNode = current.getNodeById(subgraphNodeId);
        if (!subgraphNode?.subgraph) return false;
        current = subgraphNode.subgraph;
    }

    // current.id should now be the UUID of the subgraph containing the leaf.
    return current.id === node.graph.id;
}

// ── Node Lookup Utilities ─────────────────────────────────────────────────

/**
 * Resolve a colon-delimited execution ID (e.g. "5:12:3") to the actual
 * LiteGraph node object, traversing subgraphs as needed.
 *
 * @param {string|number} id - The execution ID.
 * @param {Object} [rootGraph] - The root graph to start from. Defaults to app.graph.
 * @returns {Object|null} The node, or null if not found.
 */
export function findNodeByExecutionId(id, rootGraph) {
    if (!id) return null;
    const root = rootGraph || app.graph;
    const segments = String(id).split(":");
    let currentGraph = root;
    let node = null;

    for (let i = 0; i < segments.length; i++) {
        node = currentGraph.getNodeById(Number(segments[i]));
        if (!node) return null;
        if (i < segments.length - 1) {
            if (!node.subgraph) return null;
            currentGraph = node.subgraph;
        }
    }
    return node;
}

/**
 * Find the path of graph references from the root graph down to the
 * graph containing a target node. Needed for navigating into subgraphs.
 *
 * @param {Object} targetNode - The node to locate.
 * @param {Object} [graph] - The graph to search in. Defaults to app.graph.
 * @param {Array} [path] - Accumulated path of graph references (internal).
 * @returns {Array|null} Array of graph refs from root to target, or null.
 */
export function findNodePath(targetNode, graph, path) {
    const g = graph || app.graph;
    const p = path || [];

    for (const node of g.nodes) {
        if (node === targetNode) {
            return [...p, node.graph];
        }
        if (node.subgraph) {
            const found = findNodePath(targetNode, node.subgraph, [...p, node.graph]);
            if (found) return found;
        }
    }
    return null;
}
