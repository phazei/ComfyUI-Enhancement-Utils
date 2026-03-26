/**
 * Node Navigation extension -- "Go to Node", "Follow Execution", and running node highlight.
 *
 * Features:
 * 1. "Go to Node" -- hierarchical right-click menu to jump to any node, grouped by
 *    type, with full subgraph support.
 * 2. "Follow Execution" -- auto-pans the canvas to track the currently executing node.
 * 3. "Show executing node" -- one-shot jump to the currently running node.
 * 4. Running/error highlight -- draws a colored border around executing or errored nodes.
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts (nodeFinder.js), cleaned up and documented.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodeByExecutionId, findNodePath } from "./utils.js";

app.registerExtension({
    name: "phazei.NodeNavigation",

    setup() {
        /** Whether the canvas should auto-pan to follow execution. */
        let followExecution = false;

        /** Debounce timer ID for follow-execution camera pans. */
        let focusDebounceId = null;

        // ── Subgraph Navigation Helpers ────────────────────────────────
        // findNodePath and findNodeByExecutionId are imported from utils.js.

        /**
         * Center the canvas viewport on a node, navigating into subgraphs
         * if the node isn't in the currently displayed graph.
         *
         * @param {Object} node - The node to focus on.
         */
        const focusNode = (node) => {
            if (!node) return;

            const centerOnNode = () => app.canvas.centerOnNode(node);

            if (app.canvas.graph !== node.graph) {
                // Node is inside a subgraph -- navigate to it first.
                const path = findNodePath(node);
                if (path) {
                    app.canvas.setGraph(app.graph); // Reset to root.
                    for (let i = 1; i < path.length; i++) {
                        app.canvas.openSubgraph(path[i]);
                    }
                }
                // Defer centering until after the graph switch renders.
                setTimeout(centerOnNode, 0);
            } else {
                centerOnNode();
            }
        };

        // ── Follow Execution ───────────────────────────────────────────

        /**
         * If follow mode is active, debounce and pan to the executing node.
         * The 50ms debounce prevents jittery rapid pans on fast-executing nodes.
         */
        const followToExecutingNode = (id) => {
            if (!followExecution || !id) return;

            if (focusDebounceId) clearTimeout(focusDebounceId);
            focusDebounceId = setTimeout(() => {
                focusNode(findNodeByExecutionId(id));
                focusDebounceId = null;
            }, 50);
        };

        // Listen for execution events from the ComfyUI WebSocket API.
        api.addEventListener("executing", ({ detail }) => followToExecutingNode(detail));

        // ── Running / Error Node Highlight ─────────────────────────────

        const origDrawNode = LGraphCanvas.prototype.drawNode;
        LGraphCanvas.prototype.drawNode = function (node, ctx) {
            origDrawNode.apply(this, arguments);

            // Determine if this node is currently executing.
            let isRunning = false;
            if (app.runningNodeId) {
                const runningSegments = String(app.runningNodeId).split(":");
                const lastSegment = Number(runningSegments[runningSegments.length - 1]);
                // Quick ID check, then verify via full path to handle subgraph ambiguity.
                if (lastSegment === node.id && findNodeByExecutionId(app.runningNodeId) === node) {
                    isRunning = true;
                }
            }

            const isError = node.color === "#FF0000" || node.bgcolor === "#FF0000" || node.has_errors;

            if (!isRunning && !isError) return;

            ctx.save();
            ctx.lineWidth = 6;
            ctx.strokeStyle = isError ? "#FF0000" : "#00FF00";

            const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
            const isCollapsed = node.flags?.collapsed;
            const boxWidth = isCollapsed ? (node._collapsed_width || node.size[0]) : node.size[0];
            const boxHeight = isCollapsed ? titleHeight : node.size[1] + titleHeight;

            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(0, -titleHeight, boxWidth, boxHeight, 8);
            } else {
                ctx.rect(0, -titleHeight, boxWidth, boxHeight);
            }
            ctx.stroke();
            ctx.restore();
        };

        // ── "Go to Node" Menu ──────────────────────────────────────────

        /**
         * Build a hierarchical menu of all nodes in a graph, grouped by type,
         * with subgraph entries that expand recursively.
         *
         * @param {Object} graph - The graph to build the menu for.
         * @param {Object} activeGraph - The currently displayed graph (for "* " prefix).
         * @returns {Array} Menu option objects for LiteGraph's context menu.
         */
        const buildGoToNodeMenu = (graph, activeGraph) => {
            const nodes = graph._nodes || graph.nodes || [];
            const typeGroups = {};
            const subgraphs = [];

            for (const node of nodes) {
                if (node.subgraph) {
                    subgraphs.push(node);
                } else {
                    if (!typeGroups[node.type]) typeGroups[node.type] = [];
                    typeGroups[node.type].push(node);
                }
            }

            const options = [];

            // Subgraph entries (sorted by X position on canvas).
            subgraphs.sort((a, b) => a.pos[0] - b.pos[0]).forEach((node) => {
                const isActive = node.subgraph === activeGraph;
                const prefix = isActive ? "* " : "";
                options.push({
                    content: `${prefix}[SUBGRAPH] (#${node.id}) ${node.getTitle()}`,
                    has_submenu: true,
                    submenu: {
                        options: [
                            { content: "Go to this Subgraph node", callback: () => focusNode(node) },
                            null, // separator
                            ...buildGoToNodeMenu(node.subgraph, activeGraph),
                        ],
                    },
                });
            });

            // Regular nodes grouped by type (sorted alphabetically).
            Object.keys(typeGroups).sort().forEach((type) => {
                options.push({
                    content: type,
                    has_submenu: true,
                    submenu: {
                        options: typeGroups[type]
                            .sort((a, b) => a.pos[0] - b.pos[0])
                            .map((node) => ({
                                content: `${node.getTitle()} - #${node.id} (${Math.round(node.pos[0])}, ${Math.round(node.pos[1])})`,
                                callback: () => focusNode(node),
                            })),
                    },
                });
            });

            return options;
        };

        // ── Canvas Context Menu Additions ──────────────────────────────

        const origGetCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;
        LGraphCanvas.prototype.getCanvasMenuOptions = function () {
            const options = origGetCanvasMenuOptions.apply(this, arguments);

            // Separator before our items.
            options.push(null);

            // Toggle follow execution.
            options.push({
                content: followExecution ? "Stop following execution" : "Follow execution",
                callback: () => {
                    followExecution = !followExecution;
                    if (followExecution) followToExecutingNode(app.runningNodeId);
                },
            });

            // Jump to currently executing node (only shown during execution).
            if (app.runningNodeId) {
                options.push({
                    content: "Show executing node",
                    callback: () => focusNode(findNodeByExecutionId(app.runningNodeId)),
                });
            }

            // "Go to node" hierarchical submenu.
            const isRootActive = app.canvas.graph === app.graph;
            options.push({
                content: `${isRootActive ? "* " : ""}Go to node`,
                has_submenu: true,
                submenu: { options: buildGoToNodeMenu(app.graph, app.canvas.graph) },
            });

            return options;
        };
    },
});
