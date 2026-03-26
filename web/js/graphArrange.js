/**
 * Graph Arrange extension -- adds "Arrange (float left)" and "Arrange (float right)"
 * to the canvas right-click context menu.
 *
 * - Float left: uses LiteGraph's built-in arrange() (nodes flow left to right).
 * - Float right: custom algorithm that right-aligns nodes in their columns so
 *   output slots visually line up, with output nodes (SaveImage, PreviewImage)
 *   sorted to the top of their column.
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts (graphArrange.js), with bug fixes
 * and documentation.
 */

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "phazei.GraphArrange",

    setup() {
        const origGetCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;

        LGraphCanvas.prototype.getCanvasMenuOptions = function () {
            const options = origGetCanvasMenuOptions.apply(this, arguments);

            // ── Arrange (float left) ───────────────────────────────────
            options.push({
                content: "Arrange (float left)",
                callback: () => app.graph.arrange(),
            });

            // ── Arrange (float right) ──────────────────────────────────
            options.push({
                content: "Arrange (float right)",
                callback: () => arrangeFloatRight(app.graph),
            });

            return options;
        };
    },
});

/**
 * Arrange nodes in right-aligned columns based on execution order.
 *
 * Algorithm:
 * 1. Compute execution order (gives each node a ._level indicating DAG depth).
 * 2. Reassign levels by pulling nodes rightward: each node's level becomes one
 *    less than the minimum level of its direct consumers.
 * 3. Bucket nodes into columns by level.
 * 4. Sort within each column: output nodes (SaveImage, PreviewImage) first,
 *    then by input count, then by output count.
 * 5. Position nodes vertically within each column with spacing.
 * 6. Right-align all nodes within their column (right edges line up).
 *
 * @param {Object} graph - The LiteGraph graph instance.
 */
function arrangeFloatRight(graph) {
    const MARGIN = 50;

    const nodes = graph.computeExecutionOrder(false, true);
    if (!nodes || nodes.length === 0) return;

    // Step 1-2: Reassign levels by pulling nodes toward their consumers.
    // Iterate in reverse so upstream nodes see updated downstream levels.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        let minConsumerLevel = null;

        for (const output of node.outputs || []) {
            if (!output.links) continue;
            for (const linkId of output.links) {
                const linkInfo = graph.links[linkId];
                if (!linkInfo) continue;
                const consumer = graph.getNodeById(linkInfo.target_id);
                if (!consumer) continue;

                const consumerLevel = (consumer._level || 1) - 1;
                if (minConsumerLevel === null || consumerLevel < minConsumerLevel) {
                    minConsumerLevel = consumerLevel;
                }
            }
        }

        if (minConsumerLevel !== null) {
            node._level = minConsumerLevel;
        }
    }

    // Step 3: Bucket nodes into columns by their level.
    const columns = [];
    for (const node of nodes) {
        const col = node._level || 1;
        if (!columns[col]) columns[col] = [];
        columns[col].push(node);
    }

    // Known output node types that should sort to the top of their column.
    const OUTPUT_NODE_TYPES = new Set(["SaveImage", "PreviewImage"]);

    // Step 4-6: Position nodes in each column.
    let xOffset = MARGIN;
    const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;

    for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const column = columns[colIdx];
        if (!column) continue;

        // Sort: output nodes first, then fewer inputs first, then fewer outputs first.
        column.sort((a, b) => {
            const aIsOutput = OUTPUT_NODE_TYPES.has(a.type) ? 0 : 1;
            const bIsOutput = OUTPUT_NODE_TYPES.has(b.type) ? 0 : 1;
            let result = aIsOutput - bIsOutput;
            if (result === 0) result = (a.inputs?.length || 0) - (b.inputs?.length || 0);
            if (result === 0) result = (a.outputs?.length || 0) - (b.outputs?.length || 0);
            return result;
        });

        // Lay out nodes vertically, tracking the widest node for right-alignment.
        let maxWidth = 100;
        let yOffset = MARGIN + titleHeight;

        for (let j = 0; j < column.length; j++) {
            const node = column[j];
            node.pos[0] = xOffset;
            node.pos[1] = yOffset;

            if (node.size[0] > maxWidth) maxWidth = node.size[0];
            yOffset += node.size[1] + MARGIN + titleHeight;
        }

        // Right-align: shift each node so right edges are flush with the widest.
        for (const node of column) {
            node.pos[0] += maxWidth - node.size[0];
        }

        xOffset += maxWidth + MARGIN;
    }

    graph.setDirtyCanvas(true, true);
}
