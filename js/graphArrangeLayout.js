/**
 * Graph Arrange layouts -- pure layout code for `graphArrange.js`.
 *
 * No `app` import and no DOM: works on any LiteGraph-like graph passed in,
 * so it can be unit-tested under plain Node (`tests/graphArrange.test.mjs`).
 * Uses `window.dagre` / `window.ELK` (vendored in `js/lib/`) and
 * `LiteGraph` constants when present. Settings come from the provider set
 * with `setSettingsSource` (defaults otherwise).
 *
 * Layouts:
 * 1. Quick (column aligned)  -- `arrangeFloatRightGroups`: right-aligned columns with barycenter sorting.
 * 2. Smart (dagre)           -- `arrangeDagreGroups`: per-group + inter-group dagre layout.
 * 3. Advanced (ELK)          -- `arrangeELK`: ELK inside each group, groups placed in wrapped rows (16:9).
 * Dagre and ELK take an optional `{ rankdir: "LR" | "TB" }` (one menu entry per direction).
 * Menu callbacks wrap them in `withPreservedCenter`.
 * 4. One group in place       -- `arrangeGroup(graph, group, "quick" | "smart" | "advanced")`:
 *    that layout's per-group engine, then the rest of the graph makes room. Not recentred.
 *
 * Nested groups are rigid blocks in their parent's layout (laid out first in a
 * full arrange, kept as they are when arranging one group).
 *
 * Besides drawn links, all three layouts order by hidden links
 * (`collectHiddenLinks`: Set/Get-style virtual nodes, Use Everywhere).
 *
 * This file only re-exports the public API; the code lives in:
 * - graphArrangeShared.js   -- settings, node sizes, bounds, subgraph IO
 * - graphArrangeCenter.js   -- `withPreservedCenter` (menu wrapper)
 * - graphArrangeFlow.js     -- hidden / bridge links, flow order, `rankBlocks`
 * - graphArrangeGroups.js   -- group resolution and nesting, per-group phase, satellites
 * - graphArrangeQuick.js    -- Quick
 * - graphArrangeSmart.js    -- Smart (dagre)
 * - graphArrangeAdvanced.js -- Advanced (ELK)
 * - graphArrangeWrap.js     -- Advanced row wrapping
 * - graphArrangeFold.js     -- folding long chains inside a group
 * - graphArrangeSingleGroup.js -- one group in place, making room
 */

export { DEFAULTS, setSettingsSource, partitionNodes, positionSubgraphIO } from "./graphArrangeShared.js";
export { centerGraph, withPreservedCenter } from "./graphArrangeCenter.js";
export { collectHiddenLinks, collectBridgeLinks, computeFlowOrder } from "./graphArrangeFlow.js";
export { resolveGroups, groupAtPoint } from "./graphArrangeGroups.js";
export { arrangeGroup, makeRoom, pushAlong } from "./graphArrangeSingleGroup.js";
export { arrangeFloatRight, arrangeFloatRightGroups } from "./graphArrangeQuick.js";
export { arrangeDagre, arrangeDagreGroups } from "./graphArrangeSmart.js";
export { arrangeELK } from "./graphArrangeAdvanced.js";
export { placeWrappedLayers } from "./graphArrangeWrap.js";
export { breakLines, findChains, FOLD_RATIO } from "./graphArrangeFold.js";
