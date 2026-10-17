/**
 * Shared canvas context-menu block for all Enhancement Utils features.
 *
 * Each feature registers a section builder here instead of adding its own
 * `getCanvasMenuItems` hook (or patching `LGraphCanvas.prototype.
 * getCanvasMenuOptions`, which the frontend now flags as deprecated). One
 * extension returns every section, sorted by `order` and separated by
 * one divider before the block (none between sections), so our entries always
 * appear together in a fixed order instead of being split up by other packs' items.
 *
 * Section order in use:
 *   10 -- Arrange (graphArrange.js)
 *   20 -- Follow execution / Show executing node (nodeNavigation.js)
 *   30 -- Flow visualization (flowVisualizer.js)
 *   40 -- Go to node... (nodeNavigation.js)
 *
 * Does not depend on any feature module; features import it.
 */

import { app } from "../../scripts/app.js";

const LOG_PREFIX = "[EnhancementUtils]";

/** @type {Array<{order: number, build: function(Object): Array<Object|null>}>} */
const sections = [];

/**
 * Register a canvas-menu section.
 *
 * @param {number} order - Position (lower = earlier).
 * @param {function(Object): Array<Object|null>} build - Returns the section's items for the
 *   canvas (null = separator inside the section); an empty array hides the section.
 * @returns {void}
 */
export function registerCanvasMenuSection(order, build) {
    if (typeof build !== "function") return;
    sections.push({ order: Number(order) || 0, build });
    sections.sort((a, b) => a.order - b.order);
}

app.registerExtension({
    name: "phazei.CanvasMenu",

    /**
     * All registered sections as one block, preceded by a single separator.
     *
     * @param {Object} canvas - LGraphCanvas.
     * @returns {Array<Object|null>} Menu items.
     */
    getCanvasMenuItems(canvas) {
        const items = [];
        for (const section of sections) {
            let built = [];
            try {
                built = section.build(canvas) || [];
            } catch (err) {
                console.warn(`${LOG_PREFIX} a canvas menu section failed:`, err);
                continue;
            }
            if (!built.length) continue;
            items.push(...built);
        }
        return items.length ? [null, ...items] : items;
    },
});
