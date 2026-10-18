/**
 * Node search panel -- "Go to node...": a floating input with a live
 * filtered list of every node in the workflow, subgraphs included.
 *
 * Type a node number (`12`, `#12`), an execution path (`5:12`), a subgraph
 * scope (`5:`, `5: vae`) or text (title / type). Up/Down moves the highlight,
 * Enter or click jumps to the node, Esc or a click outside closes. Results
 * show the subgraph breadcrumb (`Upscale (#5) > VAE Decode (#12)`); muted /
 * bypassed nodes are dimmed. Renamed nodes show their type's display name on
 * the right (class id in the tooltip). Clicking it fills the box with it;
 * other nodes get a funnel icon on the highlighted row that does the same.
 * Clicking the `subgraph` badge fills in its scope (`5: `). Tab does
 * whichever applies to the highlighted row.
 *
 * Opened from the canvas menu and the `EnhUtils.Navigation.SearchNodes`
 * command (both registered in `nodeNavigation.js`). Matching lives in
 * `nodeSearchMatch.js`. Registers no extension itself.
 */

import { app } from "../../scripts/app.js";
import { focusNode } from "./utils.js";
import { collectSearchEntries, searchEntries, inactiveState } from "./nodeSearchMatch.js";

/** Maximum rows rendered in the result list. */
const MAX_RESULTS = 200;

/** The open panel's teardown function, or null when closed. */
let closeActive = null;

// ── Stylesheet ────────────────────────────────────────────────────────────

/**
 * Inject a <link> tag for nodeSearch.css, resolved relative to this script.
 *
 * @returns {void}
 */
function loadStylesheet() {
    const cssUrl = new URL("nodeSearch.css", import.meta.url).href;
    if (!document.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        document.head.appendChild(link);
    }
}

// ── Rendering ─────────────────────────────────────────────────────────────

/**
 * Make a row part clickable to put a query in the search box instead of
 * jumping to the node (the row's own click).
 *
 * @param {HTMLElement} el - The type text or subgraph badge.
 * @param {string} query - Query to fill in.
 * @param {string} hint - Tooltip.
 * @param {function(string): void} onFill - Puts the query in the box.
 * @returns {void}
 */
function makeFillable(el, query, hint, onFill) {
    el.classList.add("enhutils-nodesearch-fill");
    el.title = hint;
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        onFill(query);
    });
}

/**
 * The query that "filters to this" for an entry: a subgraph's scope
 * (`7162: `) or the node's type display name. Used by the badge / type /
 * funnel clicks and the Tab key.
 *
 * @param {Object} entry - Search entry.
 * @returns {string|null} Query, or null when there's nothing to filter by.
 */
function filterQueryFor(entry) {
    if (entry.isSubgraph) return `${entry.execId}: `;
    return entry.displayName || null;
}

/**
 * Second tooltip line with whatever the title doesn't already say:
 * renamed -> display name (+ class id if different); not renamed -> class id
 * only if it differs from the display name; otherwise nothing.
 *
 * @param {Object} entry - Search entry.
 * @returns {string} "\n..." or "".
 */
function typeTooltip(entry) {
    if (!entry.type) return "";
    const idPart = entry.type !== entry.displayName ? entry.type : "";
    if (entry.renamed) return `\n${entry.displayName}${idPart ? ` (${idPart})` : ""}`;
    return idPart ? `\n${idPart}` : "";
}

/**
 * Build one result row.
 *
 * @param {Object} entry - Search entry from `collectSearchEntries`.
 * @param {function(string): void} onFill - Puts a query in the search box
 *   (type text and subgraph badge clicks).
 * @returns {HTMLElement} The row element.
 */
function buildRow(entry, onFill) {
    const row = document.createElement("div");
    row.className = "enhutils-nodesearch-row";
    row.setAttribute("role", "option");

    const inactive = inactiveState(entry);
    if (inactive) row.classList.add("enhutils-nodesearch-inactive");

    const label = document.createElement("span");
    label.className = "enhutils-nodesearch-label";
    for (const crumb of entry.path) {
        const part = document.createElement("span");
        part.className = "enhutils-nodesearch-crumb";
        part.textContent = `${crumb.title} (#${crumb.id})`;
        label.appendChild(part);
        const sep = document.createElement("span");
        sep.className = "enhutils-nodesearch-sep";
        sep.textContent = " > ";
        label.appendChild(sep);
    }
    const own = document.createElement("span");
    own.className = "enhutils-nodesearch-own";
    own.textContent = `${entry.title} (#${entry.id})`;
    label.appendChild(own);
    row.appendChild(label);

    const tags = [];
    if (entry.isSubgraph) tags.push("subgraph");
    if (inactive) tags.push(inactive);
    const meta = document.createElement("span");
    meta.className = "enhutils-nodesearch-meta";
    // Renamed nodes show what they really are (display name, not the class id).
    if (entry.renamed) {
        const type = document.createElement("span");
        type.className = "enhutils-nodesearch-type";
        type.textContent = entry.displayName;
        const idPart = entry.type !== entry.displayName ? ` (${entry.type})` : "";
        makeFillable(type, entry.displayName, `Show all ${entry.displayName} nodes${idPart}`, onFill);
        meta.appendChild(type);
    } else if (!entry.isSubgraph && entry.displayName) {
        // No text to click -- a funnel (shown on the highlighted row only) does the same.
        const funnel = document.createElement("i");
        funnel.className = "pi pi-filter enhutils-nodesearch-filter";
        makeFillable(funnel, entry.displayName, `Show all ${entry.displayName} nodes (Tab)`, onFill);
        meta.appendChild(funnel);
    }
    for (const tag of tags) {
        const t = document.createElement("span");
        t.className = `enhutils-nodesearch-tag enhutils-nodesearch-tag-${tag}`;
        t.textContent = tag;
        if (tag === "subgraph") {
            makeFillable(t, filterQueryFor(entry), `Show everything inside ${entry.title} (Tab)`, onFill);
        }
        meta.appendChild(t);
    }
    row.appendChild(meta);
    row.title = entry.label + typeTooltip(entry);
    return row;
}

// ── Panel ─────────────────────────────────────────────────────────────────

/**
 * Open the search panel (or refocus it if already open). The node list is
 * collected once on open.
 *
 * @returns {void}
 */
export function openNodeSearch() {
    if (closeActive) {
        document.querySelector(".enhutils-nodesearch input")?.focus();
        return;
    }
    if (!app.graph) return;
    loadStylesheet();

    const entries = collectSearchEntries(app.graph, app.canvas?.graph);

    const panel = document.createElement("div");
    panel.className = "enhutils-nodesearch";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "enhutils-nodesearch-input";
    input.placeholder = "Go to node: #12, 5:12, title or type -- 5: for inside subgraph #5";
    input.spellcheck = false;
    input.autocomplete = "off";

    // Clear button inside the right edge of the input; hidden while empty.
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "enhutils-nodesearch-clear";
    clear.textContent = "\u00d7";
    clear.title = "Clear search";
    clear.tabIndex = -1;
    clear.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
    clear.addEventListener("click", () => fill(""));

    const inputWrap = document.createElement("div");
    inputWrap.className = "enhutils-nodesearch-inputwrap";
    inputWrap.append(input, clear);
    panel.appendChild(inputWrap);

    const list = document.createElement("div");
    list.className = "enhutils-nodesearch-list";
    list.setAttribute("role", "listbox");
    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "enhutils-nodesearch-footer";
    panel.appendChild(footer);

    let results = [];
    let rows = [];
    let selected = 0;

    /**
     * Move the highlight to a row index (clamped) and scroll it into view.
     *
     * @param {number} index - Row index.
     * @returns {void}
     */
    const select = (index) => {
        if (!rows.length) return;
        rows[selected]?.classList.remove("enhutils-nodesearch-selected");
        selected = Math.max(0, Math.min(rows.length - 1, index));
        rows[selected].classList.add("enhutils-nodesearch-selected");
        rows[selected].scrollIntoView({ block: "nearest" });
    };

    /**
     * Replace the query (type / subgraph badge clicks) and keep typing focus.
     *
     * @param {string} query - New query.
     * @returns {void}
     */
    const fill = (query) => {
        input.value = query;
        refresh();
        input.focus();
        input.setSelectionRange(query.length, query.length);
    };

    /**
     * Re-run the search for the current input and rebuild the list.
     *
     * @returns {void}
     */
    const refresh = () => {
        results = searchEntries(entries, input.value, MAX_RESULTS);
        clear.hidden = !input.value;
        list.replaceChildren();
        list.scrollTop = 0;
        rows = results.map((entry, i) => {
            const row = buildRow(entry, fill);
            row.addEventListener("mousemove", () => { if (selected !== i) select(i); });
            row.addEventListener("click", () => choose(i));
            list.appendChild(row);
            return row;
        });
        selected = 0;
        if (rows.length) rows[0].classList.add("enhutils-nodesearch-selected");
        else {
            const none = document.createElement("div");
            none.className = "enhutils-nodesearch-empty";
            none.textContent = entries.length ? "No matching nodes" : "Graph is empty";
            list.appendChild(none);
        }
        const total = entries.length;
        footer.textContent = results.length >= MAX_RESULTS
            ? `First ${MAX_RESULTS} of many matches -- keep typing to narrow`
            : `${results.length} of ${total} node${total === 1 ? "" : "s"}`;
    };

    /**
     * Close the panel and jump to a result.
     *
     * @param {number} index - Result index.
     * @returns {void}
     */
    const choose = (index) => {
        const entry = results[index];
        close();
        if (entry) focusNode(entry.node);
    };

    /**
     * Keyboard handling. Stops propagation so canvas / app keybindings
     * don't fire while typing.
     *
     * @param {KeyboardEvent} e - Key event.
     * @returns {void}
     */
    const onKeyDown = (e) => {
        e.stopPropagation();
        switch (e.key) {
            case "ArrowDown": e.preventDefault(); select(selected + 1); break;
            case "ArrowUp": e.preventDefault(); select(selected - 1); break;
            case "PageDown": e.preventDefault(); select(selected + 10); break;
            case "PageUp": e.preventDefault(); select(selected - 10); break;
            case "Enter": e.preventDefault(); if (results.length) choose(selected); break;
            case "Tab": {
                // Filter to the highlighted row's type / subgraph contents.
                e.preventDefault();
                const query = results[selected] && filterQueryFor(results[selected]);
                if (query) fill(query);
                break;
            }
            case "Escape": e.preventDefault(); close(); break;
            default: break;
        }
    };

    /**
     * Close on a pointer press outside the panel.
     *
     * @param {PointerEvent} e - Pointer event.
     * @returns {void}
     */
    const onOutside = (e) => {
        if (!panel.contains(e.target)) close();
    };

    /**
     * Remove the panel and its listeners.
     *
     * @returns {void}
     */
    const close = () => {
        if (closeActive !== close) return;
        closeActive = null;
        document.removeEventListener("pointerdown", onOutside, true);
        panel.remove();
    };

    input.addEventListener("input", refresh);
    input.addEventListener("keydown", onKeyDown);
    panel.addEventListener("keyup", (e) => e.stopPropagation());

    document.body.appendChild(panel);
    closeActive = close;
    refresh();
    input.focus();
    // Defer so the click that opened the panel (menu item) doesn't close it.
    setTimeout(() => {
        if (closeActive === close) document.addEventListener("pointerdown", onOutside, true);
    }, 0);
}
