"""
HTTP API routes for the ImageLoadWithSubfolders custom-folder feature.

Provides:
- ``GET /enhutils/image_loader/list`` -- list the images in an arbitrary
  folder (for the ``folder_image`` combo), plus the ``view_subfolder`` the
  frontend should use to address them through the standard ``/view`` endpoint.
- A ``/view`` middleware that serves files from registered custom folders
  addressed via a virtual subfolder (``__enhutils__/<id>/...``).

Why a virtual subfolder: the frontend's image preview (both renderers) and
the MaskEditor build ``/view?filename=..&subfolder=..&type=input`` URLs from
the ``image`` widget value. By setting that widget to
``__enhutils__/<id>/<relpath>``, the core frontend's own reactive preview and
MaskEditor paths work unchanged, and files are read in place -- nothing is
copied or written. Folders inside the input directory don't need this at all;
they are addressed with their real input-relative subfolder.

Only folders registered through ``/list`` can be served, so a bare URL can't
read arbitrary paths. Which folders ``/list`` accepts is controlled by the
allowlist (``allowed_folders.txt`` / ``ENHUTILS_ALLOWED_FOLDERS``, see
``image_load_subfolders.is_folder_allowed``); without one, any folder is
accepted. The allowlist is re-checked on every virtual ``/view`` request.
"""

import hashlib
import logging
import mimetypes
import os
from io import BytesIO

from aiohttp import web
from PIL import Image
import folder_paths
import server

from .image_load_subfolders import (
    FolderNotAllowedError,
    _is_within,
    _resolve_folder,
    _scan_image_dir,
    is_folder_allowed,
)

logger = logging.getLogger("enhutils.image_loader.routes")

# Prefix of the virtual ``/view`` subfolder for folders outside the input dir.
VIRTUAL_PREFIX = "__enhutils__"

# Registered custom folders: id -> resolved absolute path.
_folder_registry: dict[str, str] = {}


def _register_folder(resolved: str) -> str:
    """Register a resolved folder and return its ``/view`` subfolder.

    Folders inside the input directory map to their real input-relative
    subfolder (served natively by ``/view``). Anything else gets a stable
    hash id under :data:`VIRTUAL_PREFIX`, served by :func:`serve_virtual_view`.
    """
    input_dir = os.path.abspath(folder_paths.get_input_directory())
    if _is_within(resolved, input_dir):
        rel = os.path.relpath(resolved, input_dir)
        return "" if rel == "." else rel.replace("\\", "/")

    folder_id = hashlib.sha1(os.path.normcase(resolved).encode("utf-8")).hexdigest()[:16]
    _folder_registry[folder_id] = resolved
    return f"{VIRTUAL_PREFIX}/{folder_id}"


@server.PromptServer.instance.routes.get("/enhutils/image_loader/list")
async def list_folder_images(request: web.Request) -> web.Response:
    """Return the list of images in a folder for the custom-folder combo.

    Query params:
        path (str, required): Absolute path or path relative to the ComfyUI
            input directory.

    Returns:
        JSON ``{"path", "count", "images", "view_subfolder"}`` on success, a
        403 ``{"error", "not_allowed": true}`` if the folder is outside the
        allowlist, or a 400 error on invalid/missing path. ``view_subfolder`` is the
        subfolder (relative to ``type=input``) to prefix image paths with when
        addressing them via ``/view``.
    """
    folder_path = request.query.get("path", "").strip()
    if not folder_path:
        return web.json_response({"error": "Missing 'path' query parameter."}, status=400)

    try:
        resolved = os.path.abspath(_resolve_folder(folder_path))
    except FolderNotAllowedError as exc:
        return web.json_response({"error": str(exc), "not_allowed": True}, status=403)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    images = _scan_image_dir(resolved)
    logger.debug("Listed %d images in %s", len(images), resolved)

    return web.json_response({
        "path": resolved,
        "count": len(images),
        "images": images,
        "view_subfolder": _register_folder(resolved),
    })


# ── Virtual /view Serving ───────────────────────────────────────────────────

def _image_response(file: str, query) -> web.StreamResponse:
    """Serve *file* honouring the ``preview`` and ``channel`` params of ``/view``.

    Mirrors the subset of ComfyUI's ``/view`` handler used by previews and
    the MaskEditor: ``preview=<webp|jpeg>;<quality>`` and ``channel=rgb|a``.
    """
    filename = os.path.basename(file)
    headers = {"Content-Disposition": f"filename=\"{filename}\""}
    channel = query.get("channel", "rgba")

    if "preview" in query:
        preview_info = query["preview"].split(";")
        image_format = preview_info[0]
        if image_format not in ("webp", "jpeg") or "a" in query.get("channel", ""):
            image_format = "webp"
        quality = int(preview_info[-1]) if preview_info[-1].isdigit() else 90
        with Image.open(file) as img:
            if image_format == "jpeg" or channel == "rgb":
                img = img.convert("RGB")
            buffer = BytesIO()
            img.save(buffer, format=image_format, quality=quality)
        return web.Response(body=buffer.getvalue(), content_type=f"image/{image_format}", headers=headers)

    if channel == "rgb":
        with Image.open(file) as img:
            out = img.convert("RGB")
            buffer = BytesIO()
            out.save(buffer, format="PNG")
        return web.Response(body=buffer.getvalue(), content_type="image/png", headers=headers)

    if channel == "a":
        with Image.open(file) as img:
            alpha = img.getchannel("A") if "A" in img.getbands() else Image.new("L", img.size, 255)
            out = Image.new("RGBA", img.size)
            out.putalpha(alpha)
            buffer = BytesIO()
            out.save(buffer, format="PNG")
        return web.Response(body=buffer.getvalue(), content_type="image/png", headers=headers)

    content_type = mimetypes.guess_type(file)[0] or "application/octet-stream"
    if not content_type.startswith("image/"):
        return web.Response(status=403)
    return web.FileResponse(file, headers={"Content-Type": content_type})


def serve_virtual_view(subfolder: str, filename: str, query) -> web.StreamResponse | None:
    """Serve a ``/view`` request addressed to a virtual custom-folder subfolder.

    Args:
        subfolder: The (already split) subfolder, e.g. ``__enhutils__/<id>/sub``.
        filename: The bare filename.
        query: The request query mapping (for ``preview``/``channel``).

    Returns:
        A response, or ``None`` if *subfolder* is not a virtual path (the
        request should fall through to the normal ``/view`` handler).
    """
    parts = subfolder.replace("\\", "/").split("/", 2)
    if parts[0] != VIRTUAL_PREFIX:
        return None
    if len(parts) < 2 or parts[1] not in _folder_registry:
        return web.Response(status=404)

    base = _folder_registry[parts[1]]
    rel = parts[2] if len(parts) == 3 else ""
    file = os.path.abspath(os.path.join(base, rel, os.path.basename(filename)))
    if not _is_within(file, base) or not os.path.isfile(file):
        return web.Response(status=404)
    # Re-check the allowlist (it may have changed since /list registered the
    # folder) against the file's real location, since symlinked subfolders
    # may point elsewhere.
    if not is_folder_allowed(os.path.dirname(os.path.realpath(file))):
        return web.Response(status=403)

    return _image_response(file, query)
