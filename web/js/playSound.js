/**
 * PlaySound client-side handler.
 *
 * Listens for the PlaySound node's onExecuted callback and plays an audio file
 * using the HTML5 Audio API. Supports "on empty queue" mode which waits until
 * the entire queue has finished before playing.
 *
 * Based on pythongosssss/ComfyUI-Custom-Scripts, cleaned up and modernized.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "EnhancementUtils_PlaySound";

app.registerExtension({
    name: "phazei.PlaySound",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (data) {
            origOnExecuted?.apply(this, arguments);

            // Find widget values by ID. V3 widget order matches schema input order,
            // but looking up by name is more resilient to future changes.
            const getWidgetValue = (name) => {
                const widget = this.widgets?.find((w) => w.name === name);
                return widget?.value;
            };

            const mode = getWidgetValue("mode") ?? "always";
            const volume = getWidgetValue("volume") ?? 0.5;
            let file = getWidgetValue("file") ?? "notify.mp3";

            // In "on empty queue" mode, wait briefly then check if the queue is
            // still processing. If so, skip playback.
            if (mode === "on empty queue") {
                if (app.ui.lastQueueSize !== 0) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                if (app.ui.lastQueueSize !== 0) {
                    return;
                }
            }

            // Resolve the file path:
            // - Full URLs (http/https) are used as-is.
            // - Bare filenames get "assets/" prepended (relative to this script).
            // - Paths with "/" are treated as relative to this script.
            if (!file.startsWith("http")) {
                if (!file.includes("/")) {
                    file = "assets/" + file;
                }
                file = new URL(file, import.meta.url);
            }

            try {
                const audio = new Audio(file);
                audio.volume = Math.max(0, Math.min(1, volume));
                await audio.play();
            } catch (err) {
                console.warn("[EnhancementUtils] PlaySound: audio playback failed:", err);
            }
        };
    },
});
