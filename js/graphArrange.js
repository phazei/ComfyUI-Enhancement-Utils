/**
 * Graph Arrange extension -- adds auto-layout options to the canvas right-click
 * context menu under an "Arrange" submenu:
 *
 * 1. Quick (column aligned)  -- Right-aligned columns with barycenter sorting.
 *                               Group-aware: respects groups when present.
 * 2. Smart (dagre)           -- Sugiyama layout via dagre.js.
 *                               Group-aware: per-group + inter-group layout.
 * 3. Advanced (ELK)          -- Port-aware Sugiyama via ELK with native hierarchy.
 *                               Auto-detects groups, models input/output slots as ports.
 *
 * Settings (configurable via ComfyUI Settings panel):
 * - Flow direction (LR or TB)       -- affects Dagre and ELK
 * - Node spacing                    -- affects Dagre and ELK
 * - Rank spacing                    -- affects Dagre and ELK
 * - Group padding                   -- affects all group-aware layouts
 *
 * This file only registers the settings and the menu; the layouts live in
 * `graphArrangeLayout.js` (no `app` import, unit-tested under Node).
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
} from "./graphArrangeLayout.js";

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

const SETTING_RANKDIR       = "EnhUtils.Arrange.RankDir";
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
        rankdir:      get(SETTING_RANKDIR, DEFAULTS.rankdir),
        nodesep:      get(SETTING_NODESEP, DEFAULTS.nodesep),
        ranksep:      get(SETTING_RANKSEP, DEFAULTS.ranksep),
        groupPadding: get(SETTING_GROUP_PADDING, DEFAULTS.groupPadding),
    };
}
setSettingsSource(getSettings);

// ═══════════════════════════════════════════════════════════════════════════
// Extension Registration
// ═══════════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.GraphArrange",

    setup() {
        // ── Settings ───────────────────────────────────────────────

        app.ui.settings.addSetting({
            id: SETTING_RANKDIR,
            name: "Graph Arrange - Flow direction",
            type: "combo",
            defaultValue: DEFAULTS.rankdir,
            options: ["LR", "TB"],
            tooltip: "LR = Left-to-Right, TB = Top-to-Bottom. Affects Dagre and ELK layouts.",
        });

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

        // Shared Enhancement Utils block (see canvasMenu.js).
        registerCanvasMenuSection(10, () => [{
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
                    {
                        content: "Smart (dagre)",
                        callback: () => withPreservedCenter(app.canvas.graph,
                            () => arrangeDagreGroups(app.canvas.graph)),
                    },
                    {
                        content: "Advanced (ELK)",
                        callback: () => withPreservedCenter(app.canvas.graph,
                            () => arrangeELK(app.canvas.graph)),
                    },
                ],
            },
        }]);
    },
});
