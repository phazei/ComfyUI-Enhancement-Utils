/**
 * ImageLoader custom-folder extension.
 *
 * Enhances the ``EnhancementUtils_ImageLoadWithSubfolders`` node with:
 *
 * 1. **Dynamic combo population** -- when ``folder_path`` is set, the
 *    ``folder_image`` combo is populated from a backend endpoint that scans
 *    the folder recursively.
 *
 * 2. **Widget visibility** -- in default mode (no folder_path) only the
 *    ``image`` dropdown + upload button are shown; in custom-folder mode
 *    only ``folder_path`` + ``folder_image`` + info line are shown.
 *
 * 3. **Image preview + MaskEditor (both renderers)** -- the selected
 *    ``folder_image`` is mirrored into the hidden ``image`` widget as a
 *    ``/view``-addressable path, and the core upload widget's own callback
 *    is fired. The core then updates its reactive node output store, so the
 *    preview works in both the legacy canvas and Nodes 2.0, and the
 *    MaskEditor (which reads the ``image`` widget) opens the right file from
 *    every entry point. The ``/list`` endpoint tells us which subfolder to
 *    use: the real input-relative one for folders inside ``input/``, or a
 *    virtual ``__enhutils__/<id>`` subfolder that our ``/view`` middleware
 *    serves in place. Nothing is copied or written.
 *
 * 4. **MaskEditor save + Paste support** -- when MaskEditor saves or the
 *    user pastes via "Paste (clipspace)", the resulting annotated path is
 *    written to the ``image`` widget; a property accessor detects this and
 *    injects the path as a selectable entry in the ``folder_image`` combo.
 *    Re-opening MaskEditor on a ``clipspace-painted-masked-`` entry reloads
 *    the existing mask automatically from alpha.
 *
 * Refresh triggers:
 * - Node creation (if folder_path already has a value from a loaded workflow).
 * - ``folder_path`` widget value change (on confirm / blur).
 * - ``folder_image`` combo selection change.
 * - Global "Refresh" (R key / refresh button) via ``refreshComboInNodes``.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "EnhancementUtils_ImageLoadWithSubfolders";

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * A folder listing from ``/enhutils/image_loader/list``.
 *
 * @typedef {Object} FolderListing
 * @property {string[]} images - Sorted relative image paths.
 * @property {string} viewSubfolder - ``/view`` subfolder (``type=input``)
 *     that addresses the folder: input-relative, or ``__enhutils__/<id>``.
 */

/** @type {Map<string, FolderListing>} Cached folder listings keyed by folder path. */
const listCache = new Map();

/** Node property holding the ``image`` value to restore when leaving folder mode. */
const IMAGE_BEFORE_FOLDER_PROP = "enhutils_image_before_folder";

/**
 * Node ids detected as "old-format" during the current graph load -- saves
 * made before the ``folder_path`` input existed. ComfyUI restores
 * ``widgets_values`` positionally, so an old node's ``upload`` value (the
 * literal string ``"image"``) lands on the new ``folder_path`` widget and
 * wrongly flips the node into custom-folder mode. Populated in
 * ``beforeConfigureGraph`` (which sees the raw saved JSON) and consumed in
 * ``loadedGraphNode`` (after widget values are restored).
 *
 * @type {Set<number|string>}
 */
const oldFormatNodeIds = new Set();

// ── GET_CONFIG Symbol (Primitive Node Support) ─────────────────────────────

/**
 * The framework's ``GET_CONFIG`` symbol, used by Primitive nodes to read
 * combo options from an input slot's widget. Discovered at runtime via
 * ``Object.getOwnPropertySymbols`` on an input widget the framework has
 * already wired.
 *
 * @type {symbol|null}
 */
let _getConfigSymbol = null;

/**
 * Find the framework's ``GET_CONFIG`` symbol by inspecting an input slot's
 * widget for symbol-keyed properties whose value is a function returning
 * an array (the ``InputSpec`` shape).
 *
 * @param {Object} node - The LiteGraph node instance.
 * @returns {symbol|null} The ``GET_CONFIG`` symbol, or null if not found.
 */
function findGetConfigSymbol(node) {
    if (_getConfigSymbol) return _getConfigSymbol;

    for (const input of node.inputs ?? []) {
        if (!input.widget) continue;
        const symbols = Object.getOwnPropertySymbols(input.widget);
        for (const sym of symbols) {
            const val = input.widget[sym];
            if (typeof val === "function") {
                try {
                    const result = val();
                    if (Array.isArray(result)) {
                        _getConfigSymbol = sym;
                        return sym;
                    }
                } catch (_) {
                    // Skip symbols whose getter throws.
                }
            }
        }
    }
    return null;
}

/**
 * Install or re-install a ``GET_CONFIG`` override on the ``folder_image``
 * input slot's widget so that Primitive nodes read the live combo options
 * instead of the static node definition (which only has ``[""]``).
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function installFolderImageGetConfig(node) {
    const sym = findGetConfigSymbol(node);
    if (!sym) return;

    const input = node.inputs?.find((i) => i.widget?.name === "folder_image");
    if (!input?.widget) return;

    const combo = findWidget(node, "folder_image");
    if (!combo) return;

    const folderWidget = findWidget(node, "folder_path");

    // Return the live options list in the InputSpec shape: [valuesArray, opts].
    // The Primitive reads [0] as the combo values.
    //
    // Guard against the global "R" refresh (reloadNodeDefs) transiently
    // clobbering our combo's options to the static [""] from the node
    // definition: that clobber happens *before* our async refresh hook
    // repopulates the list, and a connected Primitive's refreshComboInNode
    // would read [""] and reset its value to item 0. When the live options
    // are empty/[""], fall back to the last-known-good list cached by
    // folder_path so the Primitive keeps its selection.
    input.widget[sym] = () => {
        const live = combo.options?.values;
        const isEmpty =
            !Array.isArray(live) ||
            live.length === 0 ||
            (live.length === 1 && live[0] === "");

        if (isEmpty) {
            const key = (folderWidget?.value ?? "").trim();
            const cached = key ? listCache.get(key)?.images : undefined;
            if (cached && cached.length > 0) {
                return [cached.slice(), {}];
            }
        }

        return [(live ?? [""]).slice(), {}];
    };
}

/**
 * Notify any Primitive node connected to the ``folder_image`` input slot
 * that its combo options have changed. The Primitive caches a reference to
 * the input slot's widget object and reads ``GET_CONFIG`` lazily; calling
 * its ``refreshComboInNode()`` forces it to re-read the (now overridden)
 * ``GET_CONFIG`` and rebuild its own dropdown.
 *
 * Without this, the Primitive's combo stays at the stale snapshot it took
 * during ``_onFirstConnection()`` (page load) or the last global Refresh.
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function refreshConnectedPrimitives(node) {
    const input = node.inputs?.find((i) => i.widget?.name === "folder_image");
    if (!input || input.link == null) return;

    const graph = node.graph;
    if (!graph) return;

    const link = graph.links?.[input.link];
    if (!link) return;

    const sourceNode = graph.getNodeById?.(link.origin_id);
    if (sourceNode && typeof sourceNode.refreshComboInNode === "function") {
        // refreshComboInNode() updates widget.options.values, and clamps/reassigns
        // widget.value ONLY if the current value fell out of range. After a
        // workflow load/switch the Primitive's value is usually still valid, so it
        // never re-assigns .value -- and a bare options.values mutation is invisible
        // to Vue (Nodes 2.0). The dropdown keeps showing the stale stub options with
        // a red "value not in list" outline until the value flows through the
        // reactive path (e.g. on Run). Force that reactive path here.
        sourceNode.refreshComboInNode();
        forceWidgetReactiveUpdate(sourceNode, sourceNode.widgets?.[0]);
    }
}

/**
 * Force a Vue (Nodes 2.0) re-render and error re-evaluation for a widget whose
 * ``options.values`` were mutated directly from JS.
 *
 * Re-assigning ``widget.value`` routes through the widget's reactive setter
 * (BaseWidget writes its backing reactive store entry), which invalidates the
 * computed that drives the rendered dropdown. Firing ``node.onWidgetChanged``
 * clears the backend ``value_not_in_list`` execution error so the red outline
 * goes away. Both are no-ops on the legacy canvas, so this is safe in either
 * renderer.
 *
 * @param {Object} node - The LiteGraph node owning the widget.
 * @param {Object} widget - The widget whose options were changed.
 */
function forceWidgetReactiveUpdate(node, widget) {
    if (!widget) return;
    const value = widget.value;

    // Re-assigning the SAME value is a no-op: Vue's reactive setter short-circuits
    // on Object.is(old, new), so processedWidgets never recomputes and the dropdown
    // keeps its stale options. Write a transient sentinel first to defeat the
    // equality check, then restore -- this forces the recompute that re-reads the
    // updated options.values.
    if (typeof value === "string") {
        widget.value = value + "\x00";
        widget.value = value;
    } else {
        widget.value = value;
    }

    // Clear the backend `value_not_in_list` execution error (the red outline).
    node?.onWidgetChanged?.(widget.name, value, value, widget);
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Fetch the listing for a folder from the backend. Also (re-)registers the
 * folder server-side so its virtual ``/view`` subfolder can be served.
 *
 * @param {string} folderPath - Absolute or input-relative folder path.
 * @param {boolean} [bypassCache=false] - If true, skip the cache and re-fetch.
 * @returns {Promise<FolderListing|null>} The listing, or null on failure.
 */
async function fetchFolderListing(folderPath, bypassCache = false) {
    if (!folderPath || !folderPath.trim()) return null;

    const key = folderPath.trim();
    if (!bypassCache && listCache.has(key)) {
        return listCache.get(key);
    }

    try {
        const resp = await api.fetchApi(
            `/enhutils/image_loader/list?path=${encodeURIComponent(key)}`
        );
        if (!resp.ok) {
            console.warn("[EnhancementUtils] ImageLoader: folder list request failed:", resp.status);
            return null;
        }
        const data = await resp.json();
        const listing = {
            images: data.images ?? [],
            viewSubfolder: data.view_subfolder ?? "",
        };
        listCache.set(key, listing);
        return listing;
    } catch (err) {
        console.warn("[EnhancementUtils] ImageLoader: folder list fetch error:", err);
        return null;
    }
}

// ── Widget Helpers ─────────────────────────────────────────────────────────

/**
 * Find a widget on a node by name.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} name - Widget name.
 * @returns {Object|undefined} The widget, or undefined.
 */
function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

/**
 * Hide a widget across both LiteGraph canvas and Nodes 2.0 Vue renderers.
 *
 * @param {Object|undefined} widget - The widget to hide.
 */
function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    if (!widget.options) widget.options = {};
    widget.options.hidden = true;
    widget.computeSize = () => [0, -4];
}

/**
 * Show a widget across both renderers.
 *
 * @param {Object|undefined} widget - The widget to show.
 */
function showWidget(widget) {
    if (!widget) return;
    widget.hidden = false;
    if (!widget.options) widget.options = {};
    widget.options.hidden = false;
    widget.computeSize = undefined;
}

/**
 * Check whether a value is a ComfyUI annotated path (ends with ``[type]``).
 * These come from MaskEditor saves or "Paste (clipspace)" actions.
 *
 * @param {string} value - The widget value to check.
 * @returns {boolean}
 */
function isAnnotatedPath(value) {
    return typeof value === "string" && /\s\[[^\]]+\]$/.test(value);
}

/**
 * Sync widget visibility based on whether folder_path is set.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} folderPath - Current folder_path value.
 */
function syncWidgetVisibility(node, folderPath) {
    const hasFolder = !!(folderPath && folderPath.trim());

    const imageWidget = findWidget(node, "image");
    const uploadWidget = findWidget(node, "upload");
    const folderImageWidget = findWidget(node, "folder_image");

    if (hasFolder) {
        hideWidget(imageWidget);
        hideWidget(uploadWidget);
        showWidget(folderImageWidget);
    } else {
        showWidget(imageWidget);
        showWidget(uploadWidget);
        hideWidget(folderImageWidget);

        // Folder mode left a folder path in the ``image`` widget; restore
        // the user's own selection. Only on an actual folder->regular switch.
        if (node._wasFolderMode && imageWidget) {
            restoreImageBeforeFolder(node, imageWidget);
        }
    }

    node._wasFolderMode = hasFolder;
    node.graph?.setDirtyCanvas?.(true, true);
}

// ── Combo + Info Updates ───────────────────────────────────────────────────

/**
 * Replace the ``folder_image`` combo options with a new list of images and
 * reset the selection if invalid.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string[]} images - Sorted list of relative image paths.
 */
function applyImageList(node, images) {
    const combo = findWidget(node, "folder_image");
    if (!combo) return;

    if (!combo.options) combo.options = { values: [] };
    const finalImages = images.length > 0 ? [...images] : [""];

    // If the current value is an annotated path (from a previous MaskEditor
    // save or paste, possibly persisted in the workflow), preserve it in
    // the options so it isn't lost when the folder scan replaces the list.
    const currentValue = combo.value ?? "";
    if (isAnnotatedPath(currentValue) && !finalImages.includes(currentValue)) {
        finalImages.push(currentValue);
    }

    combo.options.values = finalImages;

    if (!finalImages.includes(combo.value)) {
        combo.value = finalImages.length > 0 ? finalImages[0] : "";
        combo.callback?.(combo.value);
    }

    // Re-assert GET_CONFIG override so Primitive nodes see updated options.
    installFolderImageGetConfig(node);

    // Kick any connected Primitive to re-read the live combo values.
    refreshConnectedPrimitives(node);
}

// ── Image Widget Mirroring (Preview + MaskEditor) ──────────────────────────

/**
 * Map a ``folder_image`` value to the ``image`` widget value that addresses
 * the same file through ``/view``.
 *
 * Annotated paths (MaskEditor saves, pastes) are already addressable. Real
 * folder images are prefixed with the folder's ``viewSubfolder`` from the
 * cached listing, which the core splits into ``subfolder``/``filename``.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} folderImage - The ``folder_image`` value.
 * @returns {string|null} The ``image`` widget value, or null if the folder
 *     listing isn't loaded yet.
 */
function toImageWidgetValue(node, folderImage) {
    if (isAnnotatedPath(folderImage)) return folderImage;

    const key = (findWidget(node, "folder_path")?.value ?? "").trim();
    const listing = listCache.get(key);
    if (!listing) return null;

    return listing.viewSubfolder ? `${listing.viewSubfolder}/${folderImage}` : folderImage;
}

/**
 * Set the ``image`` widget without triggering the MaskEditor-save
 * interception, then fire the core upload widget's callback so it refreshes
 * the node's preview through the frontend's own reactive output store.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 * @param {string} value - The new value.
 */
function setImageWidget(node, imageWidget, value) {
    if (findWidget(node, "folder_path")?.value?.trim()) {
        setMirroredImageOption(node, imageWidget, value);
    }
    node._settingImageFromFolder = true;
    try {
        imageWidget.value = value;
    } finally {
        node._settingImageFromFolder = false;
    }
    imageWidget.callback?.(value);
}

/**
 * Keep the mirrored folder value registered as an ``image`` combo option.
 *
 * The frontend's missing-media scan (run after every workflow load) flags
 * an upload combo whose value isn't in its options as "Media input missing".
 * The mirrored value (``sub/x.png`` or ``__enhutils__/<id>/x.png``) is not
 * in the input-folder list, so it is added here -- replacing the previously
 * injected entry -- and removed again when leaving folder mode.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 * @param {string|null} value - The value to register, or null to only
 *     remove the previously injected entry.
 */
function setMirroredImageOption(node, imageWidget, value) {
    const values = imageWidget.options?.values;
    if (!Array.isArray(values)) return;

    const previous = node._mirroredImageOption;
    if (previous !== undefined && previous !== value) {
        const idx = values.indexOf(previous);
        if (idx !== -1) values.splice(idx, 1);
    }
    node._mirroredImageOption = undefined;

    if (value && !values.includes(value)) {
        values.push(value);
        node._mirroredImageOption = value;
    } else if (value && previous === value) {
        node._mirroredImageOption = value;
    }
}

/**
 * Remember the user's own ``image`` selection before folder mode overwrites
 * it, so it can be restored when ``folder_path`` is cleared. Stored in
 * ``node.properties`` so it survives save/reload.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 */
function rememberImageBeforeFolder(node, imageWidget) {
    if (!node.properties) node.properties = {};
    if (node.properties[IMAGE_BEFORE_FOLDER_PROP] !== undefined) return;

    const value = imageWidget.value;
    if (value === node._mirroredImageOption) return;
    if (imageWidget.options?.values?.includes(value)) {
        node.properties[IMAGE_BEFORE_FOLDER_PROP] = value;
    }
}

/**
 * Restore the ``image`` selection remembered by
 * :func:`rememberImageBeforeFolder` (or the first option if none was
 * remembered and the current value isn't a real option).
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 */
function restoreImageBeforeFolder(node, imageWidget) {
    setMirroredImageOption(node, imageWidget, null);
    const values = imageWidget.options?.values ?? [];
    const saved = node.properties?.[IMAGE_BEFORE_FOLDER_PROP];
    if (node.properties) delete node.properties[IMAGE_BEFORE_FOLDER_PROP];

    let value = imageWidget.value;
    if (saved !== undefined && values.includes(saved)) {
        value = saved;
    } else if (!values.includes(value)) {
        value = values[0] ?? "";
    }
    if (value) setImageWidget(node, imageWidget, value);
}

/**
 * Clear the legacy canvas preview when there is no folder image to show
 * (e.g. an empty folder), so a previous image doesn't linger.
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function clearPreview(node) {
    node.imgs = [];
    node.imageIndex = null;
    node.graph?.setDirtyCanvas?.(true, true);
}

/**
 * Install a getter/setter on the ``image`` widget's ``value`` property to
 * detect when an annotated path is assigned -- either from a MaskEditor
 * save or a "Paste (clipspace)" action. Both write to
 * ``imageWidget.value`` directly (no ``.callback()``), so a property
 * accessor is the only reliable way to intercept them.
 *
 * The accessor chains to the widget's inherited ``value`` accessor
 * (``BaseWidget`` backs it with the frontend's widget value store), so the
 * widget stays connected to the store.
 *
 * When an annotated path (matching ``/\s\[[^\]]+\]$/``) is assigned in
 * folder mode, the setter injects it into the ``folder_image`` combo as
 * a selectable option and selects it, so ``execute()`` picks it up.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 */
function installImageWidgetAccessor(node, imageWidget) {
    let proto = Object.getPrototypeOf(imageWidget);
    let inherited;
    while (proto && !inherited) {
        inherited = Object.getOwnPropertyDescriptor(proto, "value");
        proto = Object.getPrototypeOf(proto);
    }

    // Fallback for widgets with a plain data ``value`` (no inherited accessor).
    let rawValue = imageWidget.value;
    const read = inherited?.get
        ? () => inherited.get.call(imageWidget)
        : () => rawValue;
    const write = inherited?.set
        ? (v) => inherited.set.call(imageWidget, v)
        : (v) => { rawValue = v; };

    node._settingImageFromFolder = false;

    Object.defineProperty(imageWidget, "value", {
        get() {
            return read();
        },
        set(newValue) {
            write(newValue);

            // Skip our own programmatic writes, and anything outside folder mode.
            if (node._settingImageFromFolder) return;

            const folderPath = findWidget(node, "folder_path")?.value ?? "";
            if (!folderPath || !folderPath.trim()) return;

            // Only annotated paths (MaskEditor saves / clipspace pastes).
            if (!isAnnotatedPath(newValue)) return;

            const combo = findWidget(node, "folder_image");
            if (!combo) return;

            // Keep exactly one injected annotated entry.
            if (!combo.options) combo.options = { values: [] };
            combo.options.values = combo.options.values.filter(
                (v) => !isAnnotatedPath(v)
            );
            combo.options.values.push(newValue);

            combo.value = newValue;
            combo.callback?.(newValue);

            installFolderImageGetConfig(node);
            refreshConnectedPrimitives(node);
        },
        enumerable: true,
        configurable: true,
    });
}

// ── folder_image Selection Handler ─────────────────────────────────────────

/**
 * Handle a ``folder_image`` selection change by mirroring it into the
 * ``image`` widget (see :func:`toImageWidgetValue`). The core then refreshes
 * the preview, and the MaskEditor reads the same value.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} value - The newly selected folder_image value.
 */
function handleFolderImageChange(node, value) {
    const folderPath = findWidget(node, "folder_path")?.value ?? "";
    if (!folderPath.trim() || !value || !value.trim()) return;

    const imageWidget = findWidget(node, "image");
    if (!imageWidget) return;

    const imageValue = toImageWidgetValue(node, value);
    if (imageValue === null) return;

    rememberImageBeforeFolder(node, imageWidget);
    setImageWidget(node, imageWidget, imageValue);
}

// ── Refresh Orchestration ──────────────────────────────────────────────────

/**
 * Refresh the folder_image combo and preview for a single node.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {boolean} [bypassCache=false] - Force a fresh fetch.
 */
async function refreshFolderCombo(node, bypassCache = false) {
    const folderPath = findWidget(node, "folder_path")?.value ?? "";

    if (!folderPath.trim()) {
        applyImageList(node, []);
        return;
    }

    const listing = await fetchFolderListing(folderPath, bypassCache);
    applyImageList(node, listing?.images ?? []);

    const combo = findWidget(node, "folder_image");
    if (combo?.value && combo.value.trim()) {
        handleFolderImageChange(node, combo.value);
    } else {
        clearPreview(node);
    }
}

/**
 * Walk a graph and its subgraphs recursively.
 *
 * @param {Object} graph - A LiteGraph graph object.
 * @param {function(Object): void} callback - Called with each node.
 */
function walkGraph(graph, callback) {
    for (const node of graph?.nodes ?? []) {
        callback(node);
        if (node.subgraph) walkGraph(node.subgraph, callback);
    }
}

// ── Extension Registration ─────────────────────────────────────────────────

app.registerExtension({
    name: "phazei.ImageLoaderSubfolders",

    /**
     * Set up each new node instance: wire callbacks for folder_path /
     * folder_image, install the image widget accessor, sync visibility, and
     * load the initial folder listing.
     *
     * @param {Object} node - The newly created node instance.
     */
    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        // Enable MaskEditor context menu ("Open in MaskEditor").
        node.previewMediaType = "image";

        // ── folder_path callback ───────────────────────────────────────
        const folderWidget = findWidget(node, "folder_path");
        if (folderWidget) {
            const origCallback = folderWidget.callback;
            folderWidget.callback = function (value) {
                origCallback?.call(this, value);
                listCache.delete((folderWidget._prevPath ?? "").trim());
                folderWidget._prevPath = value;
                syncWidgetVisibility(node, value);
                refreshFolderCombo(node, /* bypassCache */ true);
            };
        }

        // ── folder_image callback ──────────────────────────────────────
        const folderImageCombo = findWidget(node, "folder_image");
        if (folderImageCombo) {
            const origCallback = folderImageCombo.callback;
            folderImageCombo.callback = function (value) {
                origCallback?.call(this, value);
                handleFolderImageChange(node, value);
            };
        }

        // ── Initial setup (deferred so injected widgets like 'upload' exist) ─
        requestAnimationFrame(() => {
            const fp = folderWidget?.value ?? "";
            syncWidgetVisibility(node, fp);

            const imageWidget = findWidget(node, "image");
            if (imageWidget) {
                installImageWidgetAccessor(node, imageWidget);
            }

            // Override GET_CONFIG on the folder_image input so Primitive
            // nodes read the live combo options instead of the static [""].
            installFolderImageGetConfig(node);

            if (fp.trim()) {
                refreshFolderCombo(node);
            }
        });
    },

    /**
     * Re-fetch folder image lists on global Refresh (R key).
     * Walks all graphs including subgraphs.
     *
     * @param {Record<string, Object>} _defs - All node definitions (unused).
     */
    async refreshComboInNodes(_defs) {
        const promises = [];
        walkGraph(app.graph, (node) => {
            if (node.comfyClass !== NODE_TYPE) return;
            promises.push(refreshFolderCombo(node, /* bypassCache */ true));
        });
        await Promise.all(promises);
    },

    /**
     * Detect old-format saves before any widget values are restored.
     *
     * Reads the raw workflow JSON (the only hook where each node's ``inputs``
     * reflect the original save, unmutated by ComfyUI's ``configure``
     * reconciliation). A node saved before the ``folder_path`` input existed
     * has no ``folder_path`` entry in its ``inputs`` array; we record its id
     * so ``loadedGraphNode`` can scrub the leaked value afterwards.
     *
     * @param {Object} graphData - The parsed workflow JSON.
     * @param {string[]} _missing - Missing node types (unused).
     */
    beforeConfigureGraph(graphData, _missing) {
        // Clear stale ids from any previous graph load.
        oldFormatNodeIds.clear();

        for (const node of graphData?.nodes ?? []) {
            if (node?.type !== NODE_TYPE) continue;
            const hasFolderPathInput = (node.inputs ?? []).some(
                (i) => i?.name === "folder_path"
            );
            if (!hasFolderPathInput) {
                oldFormatNodeIds.add(node.id);
            }
        }
    },

    /**
     * Runs per node after widget values are restored, before the frontend's
     * missing-media scan.
     *
     * 1. Folder-mode nodes: register the saved mirrored ``image`` value as a
     *    combo option so the scan doesn't report "Media input missing" (see
     *    ``setMirroredImageOption``).
     * 2. Old-format nodes: scrub the leaked ``folder_path`` value.
     *
     * For old-format nodes flagged by ``beforeConfigureGraph``, ComfyUI's positional
     * ``widgets_values`` restore put the old ``upload`` value (the literal
     * string ``"image"``) onto the ``folder_path`` widget. Clear it so the
     * node returns to its default (dropdown) mode. Only the exact leaked
     * value is cleared, so a genuine folder named ``image`` (which only
     * exists in new-format saves that carry a ``folder_path`` input, and are
     * therefore never flagged) is never affected.
     *
     * @param {Object} node - A fully-configured node instance.
     */
    loadedGraphNode(node) {
        if (node?.comfyClass !== NODE_TYPE) return;

        const folderWidget = findWidget(node, "folder_path");

        if (oldFormatNodeIds.has(node.id)) {
            oldFormatNodeIds.delete(node.id);
            if (folderWidget && folderWidget.value === "image") {
                folderWidget.value = "";
                // Return the node to default (dropdown) mode.
                syncWidgetVisibility(node, "");
            }
        }

        const imageWidget = findWidget(node, "image");
        const imageValue = imageWidget?.value;
        if (folderWidget?.value?.trim() && typeof imageValue === "string" && imageValue.trim()) {
            setMirroredImageOption(node, imageWidget, imageValue);
        }
    },
});
