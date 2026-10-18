// Tests for js/nodeSearchMatch.js (node search collection + matching) on mock graphs.
// Run: node tests/nodeSearch.test.mjs
import assert from "node:assert/strict";

const { collectSearchEntries, searchEntries, parseQuery, inactiveState } =
    await import(new URL("../js/nodeSearchMatch.js", import.meta.url).href);

// ── Test runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
    }
}

// ── Mock graph ───────────────────────────────────────────────────────────

const node = (id, type, title, extra = {}) => ({ id: String(id), type, title, getTitle() { return this.title; }, ...extra });
const graph = (nodes) => ({ _nodes: nodes });

const inner2 = graph([node(7, "KSampler", "Detail KSampler")]);
const inner = graph([
    node(12, "VAEDecode", "VAE Decode"),
    node(3, "uuid-b", "Detail Pass", { subgraph: inner2 }),
    node(9, "LoraLoader", "Lora", { mode: 4 }),
]);
const root = graph([
    node(12, "KSampler", "KSampler"),
    node(5, "uuid-a", "Upscale", { subgraph: inner }),
    node(120, "SaveImage", "Save Image", { mode: 2 }),
    node(1, "CheckpointLoaderSimple", "Load Checkpoint"),
]);

const entries = collectSearchEntries(root, root);
const labels = (q) => searchEntries(entries, q).map((e) => e.label);

// ── Tests ────────────────────────────────────────────────────────────────

test("collects every node including containers, with exec ids and breadcrumbs", () => {
    assert.equal(entries.length, 8);
    const byExec = Object.fromEntries(entries.map((e) => [e.execId, e]));
    assert.equal(byExec["5:3:7"].label, "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)");
    assert.equal(byExec["5"].isSubgraph, true);
    assert.equal(byExec["5"].type, "");
    assert.equal(byExec["5:12"].label, "Upscale (#5) > VAE Decode (#12)");
});

test("parseQuery recognises ids, # ids and exec paths", () => {
    assert.equal(parseQuery("12").id, "12");
    assert.equal(parseQuery("#12").id, "12");
    assert.equal(parseQuery(" 5:12 ").execPath, "5:12");
    assert.equal(parseQuery("#5:12").execPath, "5:12");
    assert.equal(parseQuery("ksampler").id, null);
});

test("plain id finds every node with that id, active graph first, then prefixes", () => {
    assert.deepEqual(labels("12"), [
        "KSampler (#12)",
        "Upscale (#5) > VAE Decode (#12)",
        "Save Image (#120)",
    ]);
});

test("active graph inside a subgraph sorts its match first", () => {
    const e = collectSearchEntries(root, inner);
    assert.equal(searchEntries(e, "#12")[0].label, "Upscale (#5) > VAE Decode (#12)");
});

test("exec path matches exactly, then descendants", () => {
    assert.deepEqual(labels("5:12"), ["Upscale (#5) > VAE Decode (#12)"]);
    assert.deepEqual(labels("5:3"), [
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
});

test("text matches title prefix before title substring before type", () => {
    assert.deepEqual(labels("ksampler"), [
        "KSampler (#12)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
    assert.deepEqual(labels("checkpointloader"), ["Load Checkpoint (#1)"]);
});

test("multi-word query can match the subgraph path", () => {
    assert.deepEqual(labels("upscale vae"), ["Upscale (#5) > VAE Decode (#12)"]);
});

test("single word matching a subgraph name lists its contents after direct matches", () => {
    assert.deepEqual(labels("upscale"), [
        "Upscale (#5)",
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Lora (#9)",
        "Upscale (#5) > VAE Decode (#12)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
    // Direct title match still beats the path match of a deeper node.
    assert.deepEqual(labels("detail pass"), [
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
});

test("numbers never match through the subgraph path", () => {
    const g = graph([node(1, "x", "Stage 5", { subgraph: graph([node(2, "Y", "Inner")]) })]);
    const e = collectSearchEntries(g, g);
    assert.deepEqual(searchEntries(e, "5").map((x) => x.label), ["Stage 5 (#1)"]);
});

test("empty query at root: containers first in each section, sections by depth", () => {
    assert.deepEqual(labels(""), [
        "Upscale (#5)",
        "KSampler (#12)",
        "Load Checkpoint (#1)",
        "Save Image (#120)",
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Lora (#9)",
        "Upscale (#5) > VAE Decode (#12)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
});

test("same-rank ties put containers before regular nodes in typed searches", () => {
    const g = graph([
        node(1, "T", "Detail A"),
        node(2, "x", "Detail Z", { subgraph: graph([]) }),
    ]);
    const e = collectSearchEntries(g, g);
    assert.deepEqual(searchEntries(e, "detail").map((x) => x.label), ["Detail Z (#2)", "Detail A (#1)"]);
});

test("inside a subgraph: its nodes, then nested, then the rest -- above rank", () => {
    const e = collectSearchEntries(root, inner);
    assert.deepEqual(searchEntries(e, "").map((x) => x.label), [
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Lora (#9)",
        "Upscale (#5) > VAE Decode (#12)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
        "Upscale (#5)",
        "KSampler (#12)",
        "Load Checkpoint (#1)",
        "Save Image (#120)",
    ]);
    // Nested title-substring match beats the root's title-prefix match.
    assert.deepEqual(searchEntries(e, "ksampler").map((x) => x.label), [
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
        "KSampler (#12)",
    ]);
});

test("at root, rank still beats depth (exact #12 in a subgraph above root prefix #120)", () => {
    assert.deepEqual(labels("12").slice(0, 2), ["KSampler (#12)", "Upscale (#5) > VAE Decode (#12)"]);
});

test("exact type match ranks above title matches", () => {
    const g = graph([
        node(1, "KSamplerAdvanced", "KSampler Adv"),
        node(2, "KSampler", "Main Sampler"),
    ]);
    const e = collectSearchEntries(g, g);
    assert.deepEqual(searchEntries(e, "KSampler").map((x) => x.label), ["Main Sampler (#2)", "KSampler Adv (#1)"]);
});

test("display name: renamed flag, exact match and substring match", () => {
    class PreviewImage { static nodeData = { display_name: "Preview Image" }; }
    class SetNode { static title = "Set"; }
    const mk2 = (Cls, id, title, type) => Object.assign(new Cls(), { id: String(id), type, title, getTitle() { return this.title; } });
    const g = graph([
        mk2(PreviewImage, 1, "Preview Image", "PreviewImage"),
        mk2(PreviewImage, 2, "Final Output", "PreviewImage"),
        mk2(SetNode, 3, "Set_image", "SetNode"),
        node(4, "Plain", "Plain"),
    ]);
    const e = collectSearchEntries(g, g);
    const by = Object.fromEntries(e.map((x) => [x.id, x]));
    assert.equal(by[1].displayName, "Preview Image");
    assert.equal(by[1].renamed, false);
    assert.equal(by[2].renamed, true);
    assert.equal(by[3].displayName, "Set");
    assert.equal(by[3].renamed, true);
    assert.equal(by[4].displayName, "Plain");
    assert.equal(by[4].renamed, false);
    // Clicking the display name fills "Preview Image": both are exact-type matches.
    assert.deepEqual(searchEntries(e, "Preview Image").map((x) => x.id), ["2", "1"]);
    // Class id still works.
    assert.deepEqual(searchEntries(e, "previewimage").map((x) => x.id), ["2", "1"]);
});

test("parseQuery scope syntax", () => {
    assert.equal(parseQuery("5:").scope, "5");
    assert.equal(parseQuery("#5:").scope, "5");
    assert.equal(parseQuery("5:3: vae").scope, "5:3");
    assert.equal(parseQuery("5:3: vae").text, "vae");
    assert.equal(parseQuery("5:12").scope, null);
    assert.equal(parseQuery("5: 3:7").execPath, "5:3:7");
    assert.equal(parseQuery("5: 12").id, "12");
});

test("scope lists everything inside the subgraph (not the container)", () => {
    assert.deepEqual(labels("5:"), [
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Lora (#9)",
        "Upscale (#5) > VAE Decode (#12)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
    assert.deepEqual(labels("5:3:"), ["Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)"]);
    assert.deepEqual(labels("12:"), []);
});

test("scope plus filter", () => {
    assert.deepEqual(labels("5: vae"), ["Upscale (#5) > VAE Decode (#12)"]);
    assert.deepEqual(labels("5: 12"), ["Upscale (#5) > VAE Decode (#12)"]);
    assert.deepEqual(labels("5: 3:7"), ["Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)"]);
    // Path words inside the scope still work: "detail" lists Detail Pass's contents too.
    assert.deepEqual(labels("5: detail"), [
        "Upscale (#5) > Detail Pass (#3)",
        "Upscale (#5) > Detail Pass (#3) > Detail KSampler (#7)",
    ]);
});

test("inactive state for muted / bypassed", () => {
    const byExec = Object.fromEntries(entries.map((e) => [e.execId, e]));
    assert.equal(inactiveState(byExec["120"]), "muted");
    assert.equal(inactiveState(byExec["5:9"]), "bypassed");
    assert.equal(inactiveState(byExec["1"]), null);
});

test("tolerates odd graphs (missing nodes, throwing getTitle, self-referencing subgraph)", () => {
    const loop = graph([]);
    loop._nodes.push(node(1, "x", "Loop", { subgraph: loop }));
    const bad = graph([null, { id: 2, type: "T", getTitle() { throw new Error("boom"); } }, node(3, "Y", "y", { subgraph: loop })]);
    const e = collectSearchEntries(bad, bad);
    assert.equal(e.length, 3);
    assert.equal(e[0].title, "T");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
