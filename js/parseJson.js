/**
 * Parse JSON client-side handler.
 *
 * Shows a warning toast when a Parse JSON node skips an input because it is
 * not valid JSON, or when its `path` does not resolve.  The backend never
 * fails on these (so a bypassed or flaky upstream does not stop the queue);
 * it returns `ui={"enhutils_warnings": [...]}` instead, which arrives here
 * via the standard `onExecuted` callback -- including replays of cached
 * results.
 *
 * This extension is purely informational; it never affects execution.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "EnhancementUtils_ParseJSON";

app.registerExtension({
    name: "phazei.ParseJSON",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (data) {
            origOnExecuted?.apply(this, arguments);

            const warnings = data?.enhutils_warnings;
            if (!Array.isArray(warnings) || warnings.length === 0) return;

            const title = this.title || "Parse JSON";
            console.warn(`[EnhancementUtils] Parse JSON "${title}" (#${this.id}):`, warnings);

            app.extensionManager?.toast?.add({
                severity: "warn",
                summary: `Parse JSON: "${title}"`,
                detail: warnings.join("\n"),
                life: 6000,
            });
        };
    },
});
