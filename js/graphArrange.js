/**
 * Graph Arrange extension -- adds auto-layout options to the canvas right-click
 * context menu under an "Arrange" submenu:
 *
 * 1. Quick (column aligned)  -- Right-aligned columns with barycenter sorting.
 *                               Group-aware: respects groups when present.
 * 2. Smart (dagre)           -- Sugiyama layout via dagre.js.
 *                               Group-aware: per-group + inter-group layout.
 * 3. Advanced (ELK)          -- Port-aware Sugiyama via ELK inside each group; groups
 *                               placed in rows wrapped like text, aiming at 16:9.
 *
 * Smart and Advanced each get a Left-Right and a Top-Bottom menu entry
 * (the direction is picked per run, not a setting).
 *
 * Right-clicking inside a group turns the submenu into "Arrange (Group)":
 * the same layouts, applied to that group only (innermost group under the
 * cursor); the rest of the graph only moves to make room.
 *
 * Settings (configurable via ComfyUI Settings panel):
 * - Node spacing                    -- affects Dagre and ELK
 * - Rank spacing                    -- affects Dagre and ELK
 * - Group padding                   -- affects all group-aware layouts
 *
 * This file only registers the settings and the menu; the layouts live in
 * `graphArrangeLayout.js`, which re-exports the `graphArrange*.js` modules
 * (no `app` import, unit-tested under Node).
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts, significantly extended with
 * dagre/ELK integration, group awareness, and layout improvements.
 */

import { app } from "../../scripts/app.js";
import { registerCanvasMenuSection } from "./canvasMenu.js";
import {
    DEFAULTS,
    setSettingsSource,
    centerGraph,
    withPreservedCenter,
    arrangeFloatRightGroups,
    arrangeDagreGroups,
    arrangeELK,
    arrangeGroup,
    groupAtPoint,
} from "./graphArrangeLayout.js";

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

const SETTING_NODESEP       = "EnhUtils.Arrange.NodeSep";
const SETTING_RANKSEP       = "EnhUtils.Arrange.RankSep";
const SETTING_GROUP_PADDING = "EnhUtils.Arrange.GroupPadding";

/** Read current settings, falling back to defaults. */
function getSettings() {
    const get = (id, fallback) => {
        try {
            const val = app.ui.settings.getSettingValue(id);
            return val != null ? val : fallback;
        } catch {
            return fallback;
        }
    };
    return {
        nodesep:      get(SETTING_NODESEP, DEFAULTS.nodesep),
        ranksep:      get(SETTING_RANKSEP, DEFAULTS.ranksep),
        groupPadding: get(SETTING_GROUP_PADDING, DEFAULTS.groupPadding),
    };
}
setSettingsSource(getSettings);

/** Flow directions offered per layout: [menu suffix, rankdir]. */
const DIRECTIONS = [["Left-Right", "LR"], ["Top-Bottom", "TB"]];

/**
 * Build one Arrange menu entry per flow direction for a layout.
 *
 * @param {string} label - Layout label, e.g. "Smart (dagre)".
 * @param {function(Object, {rankdir: string}): (void|Promise<void>)} layout - Layout function.
 * @returns {Array<Object>} Menu entries.
 */
function directionEntries(label, layout) {
    return DIRECTIONS.map(([suffix, rankdir]) => ({
        content: `${label} ${suffix}`,
        callback: () => withPreservedCenter(app.canvas.graph,
            () => layout(app.canvas.graph, { rankdir })),
    }));
}

/**
 * Menu entries arranging only one group (same layouts as the full arrange).
 *
 * @param {Object} graph - Graph holding the group.
 * @param {Object} group - Group that was right-clicked.
 * @returns {Array<Object>} Menu entries.
 */
function groupEntries(graph, group) {
    const run = (layout, rankdir) => () => arrangeGroup(graph, group, layout, { rankdir });
    return [
        { content: "Quick (column aligned)", callback: run("quick") },
        ...DIRECTIONS.map(([suffix, rankdir]) => ({ content: `Smart (dagre) ${suffix}`, callback: run("smart", rankdir) })),
        ...DIRECTIONS.map(([suffix, rankdir]) => ({ content: `Advanced (ELK) ${suffix}`, callback: run("advanced", rankdir) })),
    ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.GraphArrange",

    setup() {
        // ── Settings ───────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: SETTING_NODESEP,
            name: "Graph Arrange - Node spacing",
            type: "slider",
            defaultValue: DEFAULTS.nodesep,
            attrs: { min: 20, max: 150, step: 5 },
            tooltip: "Spacing between nodes within the same rank/column. Affects Dagre and ELK.",
        });

        app.ui.settings.addSetting({
            id: SETTING_RANKSEP,
            name: "Graph Arrange - Rank spacing",
            type: "slider",
            defaultValue: DEFAULTS.ranksep,
            attrs: { min: 30, max: 200, step: 5 },
            tooltip: "Spacing between ranks (columns/rows). Affects Dagre and ELK.",
        });

        app.ui.settings.addSetting({
            id: SETTING_GROUP_PADDING,
            name: "Graph Arrange - Group padding",
            type: "slider",
            defaultValue: DEFAULTS.groupPadding,
            attrs: { min: 10, max: 80, step: 5 },
            tooltip: "Padding inside groups around the arranged nodes.",
        });

        // ── Context Menu ───────────────────────────────────────────

        // Shared Enhancement Utils block (see canvasMenu.js). Right-clicking
        // inside a group arranges only that group (the innermost one there).
        registerCanvasMenuSection(10, (canvas) => {
            const graph = canvas?.graph;
            const mouse = canvas?.graph_mouse;
            const group = graph && mouse ? groupAtPoint(graph, mouse[0], mouse[1]) : null;
            if (group) {
                return [{
                    content: "Arrange (Group)",
                    has_submenu: true,
                    submenu: { options: groupEntries(graph, group) },
                }];
            }
            return [{
                content: "Arrange",
                has_submenu: true,
                submenu: {
                    options: [
                        {
                            content: "Center Graph (shift to 0,0)",
                            callback: () => centerGraph(app.canvas.graph),
                        },
                        null, // separator
                        {
                            content: "Quick (column aligned)",
                            callback: () => withPreservedCenter(app.canvas.graph,
                                () => arrangeFloatRightGroups(app.canvas.graph)),
                        },
                        ...directionEntries("Smart (dagre)", arrangeDagreGroups),
                        ...directionEntries("Advanced (ELK)", arrangeELK),
                    ],
                },
            }];
        });
    },
});
