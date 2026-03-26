# CLAUDE.md

Guidelines for working on this project. Read this before making changes.

## Project Goals

This is a curated collection of ComfyUI enhancement utilities. The philosophy:

- **Quality over quantity** -- take proven features from aging community packages, combine and improve them
- **Well-organized, well-documented code** -- every module, class, and function gets a docstring or JSDoc comment
- **Modern ComfyUI patterns** -- V3 schema for nodes, current best practices for JS extensions
- **Robust error handling** -- graceful degradation when optional dependencies are missing, no crashes from malformed data

This is NOT a kitchen-sink package. Features are included because they fill real gaps or meaningfully improve on existing implementations.

## Architecture

### Python (Nodes + Monitor Backend)

- **V3 schema** (`comfy_api.latest`) for all node definitions -- `io.ComfyNode`, `define_schema()`, `io.NodeOutput`
- Do NOT use V1 schema (`NODE_CLASS_MAPPINGS`, `INPUT_TYPES` dict) for new nodes
- Do NOT use Nodes 2.0 -- that's a separate, unrelated thing
- `NODE_CLASS_MAPPINGS` must NOT be present in `__init__.py` -- its presence triggers the V1 code path in ComfyUI's loader (`if/elif` fork in `nodes.py`) and silently blocks the V3 `comfy_entrypoint()`
- `WEB_DIRECTORY = "./web/js"` tells ComfyUI where to find JS/CSS extensions
- Node IDs are prefixed with `EnhancementUtils_` (e.g., `EnhancementUtils_PlaySound`)
- Node categories use existing ComfyUI categories (`utils`, `image`), not a custom top-level category
- Python logging via `logging.getLogger("enhutils.module.name")`
- New nodes: add to `nodes/`, import in `nodes/__init__.py`, add to `ALL_NODES` list

### JavaScript (Frontend Extensions)

- **Plain JavaScript** -- no TypeScript, no build step, no npm
- JS files in `web/js/` are auto-loaded by ComfyUI via the `WEB_DIRECTORY` setting (recursive `**/*.js` glob)
- Extensions register with `app.registerExtension({ name: "phazei.ExtensionName", ... })`
- Import pattern: `import { app } from "../../scripts/app.js"` and `import { api } from "../../scripts/api.js"`
- Console warnings use prefix: `[EnhancementUtils]`
- Vendored JS libraries go in `web/js/lib/` -- they get auto-loaded too (UMD bundles set globals like `window.dagre`, `window.ELK`)
- CSS is loaded manually via `<link>` tag injection from JS (ComfyUI only auto-loads `.js` files, not `.css`)
- Shared utilities in `web/js/utils.js` -- `getUniqueIdFromNode()`, `nodeMatchesUniqueId()`, `findNodeByExecutionId()`, `findNodePath()`
- New JS extensions: add to `web/js/`, follow the `app.registerExtension` pattern

### Monitor

- Background daemon thread with `threading.Event` for clean shutdown
- Uses `asyncio.new_event_loop()` per thread -- NEVER `asyncio.run()` (causes deadlocks)
- Stats pushed via WebSocket: `server.PromptServer.instance.send_sync("enhutils.monitor", data)`
- HTTP routes registered via `@server.PromptServer.instance.routes.patch(...)` decorators
- GPU monitoring: `pynvml` is optional, every single pynvml call is wrapped in try/except
- GPU names decoded with `errors='replace'` (some drivers return non-UTF-8)

### Profiler

- Monkey-patches `execution.execute` and `PromptServer.send_sync` at import time
- `send_sync` intercept captures `execution_start`, `executing` (node start times), and `executing` with `node=None` (execution end)
- `execution.execute` wrapper fires after each node to compute elapsed time
- Handles both sync and async `execution.execute` via `inspect.iscoroutinefunction`
- Emits `enhutils.profiler.executed` (per-node) and `enhutils.profiler.execution_end` (total) via WebSocket
- Console summary logged via `logging.getLogger("enhutils.profiler")`
- Frontend stores profiling data in an external `Map<execId, data>` (not on node objects) so data survives graph/subgraph navigation
- Subgraph container nodes show aggregated total time of their internal nodes
- Live elapsed-time counter on the currently executing node (100ms canvas refresh)

## Code Style

### Python

- Module-level docstring explaining what the file does and where features originated
- Docstrings on all classes and public functions
- Type hints where practical (function signatures, dataclass fields)
- `from __future__ import annotations` is not used -- keep it simple
- Imports: standard library first, then third-party, then ComfyUI/local
- Use `@classmethod` for V3 node methods (`execute`, `define_schema`, `fingerprint_inputs`, `validate_inputs`)

### JavaScript

- JSDoc comments on all functions with `@param` and `@returns`
- Section headers use `// ── Section Name ──────────` (single-line box-drawing chars)
- Major sections use `// ═══════════════════` (double-line)
- `const` by default, `let` only when reassignment is needed, never `var`
- Arrow functions for callbacks and short lambdas
- `async/await` for ELK (which returns Promises), regular functions for everything else
- Defensive checks: `node.inputs || []`, `out.links?.length > 0`, etc.

## Key Gotchas

Things that caused bugs or required non-obvious solutions:

### ComfyUI Loader Fork
`NODE_CLASS_MAPPINGS` and `comfy_entrypoint` are mutually exclusive in ComfyUI's node loading code. If `NODE_CLASS_MAPPINGS` exists (even as an empty dict), the V1 path fires and `comfy_entrypoint()` is never called. Only `WEB_DIRECTORY` is processed before the fork.

### Subgraph Awareness
- `app.graph` is always the root graph. `app.canvas.graph` is whatever graph the user is currently viewing (root or subgraph). Always use `app.canvas.graph` for operations that should work inside subgraphs.
- Subgraph IO nodes (`graph.inputNode` id=-10, `graph.outputNode` id=-20) are NOT in `graph._nodes`. They are separate `Positionable` objects stored directly on the `Subgraph` instance. They must be positioned explicitly after any arrangement.
- Group membership must be refreshed via `group.recomputeInsideNodes()` before reading `group.nodes` or `group._children` -- the data is stale until this is called.
- ComfyUI uses three node identifier types: `node.id` (local number), execution ID (`"1:2:3"` colon-delimited string for backend/UNIQUE_ID), and locator ID (`"<uuid>:<localId>"` for UI state). Use `getUniqueIdFromNode(node)` from `web/js/utils.js` to reconstruct a node's execution ID at runtime.

### GPU Monitoring Pitfalls
- `pynvml` can throw `UnicodeDecodeError` on GPU names (some drivers return non-UTF-8 bytes)
- ZLUDA (AMD translation layer) fakes CUDA but crashes on most pynvml calls -- detect by checking `deviceGetCount() > 0`, not string matching
- `CUDA_VISIBLE_DEVICES` must be respected to avoid showing GPUs ComfyUI can't use
- `py-cpuinfo` library causes multi-second startup delays -- use platform-native detection instead

### Monitor Threading
The monitor runs in a daemon thread. Using `asyncio.run()` inside a thread can deadlock with the main server's event loop. Solution: create a dedicated event loop per thread with `asyncio.new_event_loop()`.

### Image Loading
- `node_helpers.pillow()` wraps PIL operations to retry with `LOAD_TRUNCATED_IMAGES = True` on failure
- `folder_paths.filter_files_content_types(files, ["image"])` filters by MIME type, works with relative paths
- `folder_paths.get_annotated_filepath(image)` handles subfolder-style paths like `sub/image.png` correctly
- WebP EXIF metadata uses `piexif` -- it's lightweight but can fail on malformed data (always try/except)

## Adding New Features

### New Node

1. Create `nodes/my_node.py` using the V3 pattern (see `play_sound.py` for a minimal example)
2. Import in `nodes/__init__.py` and add to `ALL_NODES`
3. If it needs client-side JS, add `web/js/myNode.js` with an `app.registerExtension` block
4. Use `io.MatchType` for wildcard/passthrough inputs (not the old `AnyType(str)` hack)
5. Use `fingerprint_inputs` returning `float("NaN")` for nodes that must always re-execute
6. Add `search_aliases` in the schema for discoverability

### New Arrange Algorithm

1. Add the layout function in `web/js/graphArrange.js`
2. Use the shared helpers: `partitionNodes()`, `resolveGroups()`, `getNodesBounds()`, `layoutDisconnectedNodes()`, `positionSubgraphIO()`, `computeGroupSize()`
3. Wrap the menu callback with `withPreservedCenter()` to preserve the graph's position
4. Always call `positionSubgraphIO(graph)` before `graph.setDirtyCanvas(true, true)`
5. Use `app.canvas.graph` (not `app.graph`) in menu callbacks for subgraph support

### New Monitor Metric

1. Add collection logic in `monitor/hardware.py` or `monitor/gpu.py`
2. Add field to `SystemStats` dataclass and its `to_dict()` method
3. Update `web/js/resourceMonitor.js`: create a bar in `setup()`, update it in the WebSocket listener
4. Add a CSS color class in `web/js/resourceMonitor.css`

## Dependencies

| Package | Required | Notes |
|---------|----------|-------|
| `psutil` | Yes | System monitoring |
| `piexif` | Yes | WebP EXIF extraction (lightweight) |
| `pynvml` | Optional | NVIDIA GPU monitoring -- graceful fallback if missing |
| `Pillow`, `torch`, `numpy` | Yes | Bundled with ComfyUI |

Vendored JS libraries (in `web/js/lib/`, no npm needed):
- `dagre.min.js` (0.8.5) -- Sugiyama layout, ~284KB
- `elk.bundled.min.js` (0.11.1) -- Eclipse Layout Kernel, ~1.5MB

## Reference

- [ComfyUI V3 Migration Guide](https://docs.comfy.org/custom-nodes/v3_migration)
- [ComfyUI Custom Nodes Walkthrough](https://docs.comfy.org/custom-nodes/walkthrough)
- [dagre Wiki](https://github.com/dagrejs/dagre/wiki)
- [ELK Documentation](https://www.eclipse.org/elk/reference.html)
- [ELK JSON Format](https://www.eclipse.org/elk/documentation/tooldevelopers/graphdatastructure/jsonformat.html)

### Source Packages

Features were drawn from these packages (rewritten and improved):
- [ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) by pythongosssss
- [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools) by crystian
- [comfyui-profiler](https://github.com/aigc-apps/comfyui-profiler) by aigc-apps
