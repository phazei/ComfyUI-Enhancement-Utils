/**
 * SystemNotification client-side handler.
 *
 * Fires a browser Notification when the SystemNotification node executes.
 * Requests notification permission proactively when the node is first added
 * to the graph, so the user isn't surprised by a permission prompt mid-run.
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts, cleaned up and modernized.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "EnhancementUtils_SystemNotification";

/**
 * Checks browser Notification support and requests permission if needed.
 * @returns {boolean} true if notifications are available and not blocked.
 */
function ensureNotificationPermission() {
    if (!("Notification" in window)) {
        console.warn("[EnhancementUtils] SystemNotification: browser does not support notifications.");
        return false;
    }
    if (Notification.permission === "denied") {
        console.warn("[EnhancementUtils] SystemNotification: notifications are blocked in browser settings.");
        return false;
    }
    if (Notification.permission !== "granted") {
        Notification.requestPermission();
    }
    return true;
}

app.registerExtension({
    name: "phazei.SystemNotification",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== NODE_TYPE) return;

        // Request notification permission as soon as the node is added to the graph.
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            ensureNotificationPermission();
        };

        // Fire the notification when the node finishes executing.
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (data) {
            origOnExecuted?.apply(this, arguments);

            const getWidgetValue = (name) => {
                const widget = this.widgets?.find((w) => w.name === name);
                return widget?.value;
            };

            const mode = getWidgetValue("mode") ?? "always";
            const message = data?.message ?? getWidgetValue("message") ?? "Your workflow has completed.";

            // In "on empty queue" mode, wait briefly then check if the queue is
            // still processing. If so, skip the notification.
            if (mode === "on empty queue") {
                if (app.ui.lastQueueSize !== 0) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                if (app.ui.lastQueueSize !== 0) {
                    return;
                }
            }

            if (!ensureNotificationPermission()) return;

            try {
                new Notification("ComfyUI", { body: message });
            } catch (err) {
                console.warn("[EnhancementUtils] SystemNotification: failed to create notification:", err);
            }
        };
    },
});
