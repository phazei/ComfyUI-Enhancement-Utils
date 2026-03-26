"""
ComfyUI Enhancement Utils
=========================

A curated collection of enhancement utilities for ComfyUI, combining and
improving features from several community packages:

- **Resource Monitor**: Real-time CPU/RAM/HDD/GPU stats in the menu bar.
- **ImageLoadWithMetadata**: Image loader with subfolder support and metadata extraction.
- **PlaySound**: Play a sound when a workflow step (or the whole queue) completes.
- **SystemNotification**: Browser notification on workflow completion.
- **Node Navigation**: "Go to Node" menu, "Follow Execution" camera tracking.
- **Graph Arrange**: Auto-arrange nodes (float left / float right).

All nodes use the V3 schema (comfy_api). Frontend extensions are plain JS.
"""

from comfy_api.latest import ComfyExtension, io
from .nodes import ALL_NODES

# Import monitor to start the background stats collector and register HTTP routes.
from . import monitor  # noqa: F401
from .monitor import routes  # noqa: F401


class EnhancementUtilsExtension(ComfyExtension):
    """Main extension class that registers all Enhancement Utils nodes."""

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return ALL_NODES


async def comfy_entrypoint() -> EnhancementUtilsExtension:
    return EnhancementUtilsExtension()


# ── Web Directory ──────────────────────────────────────────────────────────
# WEB_DIRECTORY tells ComfyUI where to find our JS/CSS extensions.
# This is processed before the V1/V3 entrypoint fork, so it works with both.
# NOTE: NODE_CLASS_MAPPINGS is intentionally absent -- its presence would
# trigger the V1 code path and skip our comfy_entrypoint() entirely.
WEB_DIRECTORY = "./web/js"
__all__ = ["WEB_DIRECTORY"]
