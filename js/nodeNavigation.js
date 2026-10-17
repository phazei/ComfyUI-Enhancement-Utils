/**
 * Node Navigation extension -- "Go to Node", "Follow Execution", and running node highlight.
 *
 * Features:
 * 1. "Go to node..." -- opens the node search panel (`nodeSearch.js`): a filterable
 *    list of every node, subgraphs included. Also the
 *    `EnhUtils.Navigation.SearchNodes` command, bindable to a key. Replaces the
 *    original hierarchical "Go to node" submenu.
 * 2. "Follow Execution" -- auto-pans the canvas to track the currently executing node.
 * 3. "Show executing node" -- one-shot jump to the currently running node.
 * 4. Running/error highlight -- draws a colored border around executing or errored nodes.
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts (nodeFinder.js), cleaned up and documented.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodeByExecutionId, focusNode } from "./utils.js";
import { openNodeSearch } from "./nodeSearch.js";
import { registerCanvasMenuSection } from "./canvasMenu.js";

app.registerExtension({
    name: "phazei.NodeNavigation",

    commands: [
        {
            id: "EnhUtils.Navigation.SearchNodes",
            label: "Search graph nodes",
            icon: "pi pi-search",
            function: () => openNodeSearch(),
        },
    ],

    setup() {
        /** Whether the canvas should auto-pan to follow execution. */
        let followExecution = false;

        /** Debounce timer ID for follow-execution camera pans. */
        let focusDebounceId = null;

        // ── Subgraph Navigation Helpers ────────────────────────────────
        // focusNode and findNodeByExecutionId are imported from utils.js.

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
                const lastSegment = runningSegments[runningSegments.length - 1];
                // Quick ID check, then verify via full path to handle subgraph ambiguity.
                // node.id is a string since frontend 1.46, a number before -- compare as strings.
                if (lastSegment === String(node.id) && findNodeByExecutionId(app.runningNodeId) === node) {
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

        // ── Canvas Context Menu Additions (shared block, see canvasMenu.js) ──

        registerCanvasMenuSection(20, () => {
            const items = [
                {
                    content: followExecution ? "Stop following execution" : "Follow execution",
                    callback: () => {
                        followExecution = !followExecution;
                        if (followExecution) followToExecutingNode(app.runningNodeId);
                    },
                },
            ];
            // Jump to currently executing node (only shown during execution).
            if (app.runningNodeId) {
                items.push({
                    content: "Show executing node",
                    callback: () => focusNode(findNodeByExecutionId(app.runningNodeId)),
                });
            }
            return items;
        });

        // Node search panel (by number, subgraph path, title or type); after Flow visualization.
        registerCanvasMenuSection(40, () => [{ content: "Go to node...", callback: () => openNodeSearch() }]);
    },
});
