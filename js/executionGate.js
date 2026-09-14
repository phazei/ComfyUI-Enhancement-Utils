/**
 * Execution Gate client-side handler.
 *
 * Shows a toast when an Execution Gate node blocks downstream execution.
 * The block itself is silent on the backend (no execution_error, so
 * auto-queue keeps running), which makes it indistinguishable from the
 * many other reasons a branch might not run.  The node returns
 * `ui={"blocked": [true]}` on the blocked path, which arrives here via
 * the standard `onExecuted` callback -- including replays of cached
 * results, so the toast also appears when a cached blocked gate is reused.
 *
 * This extension is purely informational; it never affects execution.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "EnhancementUtils_ExecutionGate";

app.registerExtension({
    name: "phazei.ExecutionGate",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (data) {
            origOnExecuted?.apply(this, arguments);

            if (!data?.blocked?.[0]) return;

            const title = this.title || "Execution Gate";
            console.info(`[EnhancementUtils] Execution Gate "${title}" (#${this.id}) blocked downstream execution`);

            if (app.extensionManager?.toast) {
                app.extensionManager.toast.add({
                    severity: "warn",
                    summary: "Execution Gate: blocked",
                    detail: `"${title}" -- downstream execution skipped`,
                    life: 4000,
                });
            }
        };
    },
});
