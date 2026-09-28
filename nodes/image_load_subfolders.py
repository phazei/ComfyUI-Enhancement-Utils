"""
ImageLoadWithSubfolders node -- loads an image with subfolder support and metadata extraction.

Extends ComfyUI's built-in LoadImage with recursive subfolder browsing of the
input directory and metadata extraction from PNG/WebP files. Retains all the
robustness of the built-in loader (multi-frame, truncated image recovery,
palette transparency, 16-bit images).

Based on:
- ComfyUI built-in LoadImage (nodes.py)
- crystian/ComfyUI-Crystools CImageLoadWithMetadata
Rewritten for V3 schema with improvements from both sources.
"""

import hashlib
import json
import fnmatch
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence, ImageFile

import folder_paths
import node_helpers

from comfy_api.latest import io

# Optional piexif for WebP EXIF metadata extraction.
try:
    import piexif
    HAS_PIEXIF = True
except ImportError:
    HAS_PIEXIF = False


# ── File Discovery ──────────────────────────────────────────────────────────

# System/temp files to exclude from the file listing.
EXCLUDE_FILES = {"Thumbs.db", "*.DS_Store", "desktop.ini", "*.lock"}
# Folders to exclude (dot-folders, clipspace temp folder).
EXCLUDE_DIRS = {"clipspace", ".*"}


def _scan_image_dir(base_dir: str) -> list[str]:
    """Recursively scan a directory for image files, including subfolders.

    Args:
        base_dir: Absolute path to the directory to scan.

    Returns:
        A sorted list of relative paths (forward slashes, cross-platform).
        Non-image files are filtered out using ComfyUI's MIME-type detection.
    """
    candidates = []

    for root, dirs, files in os.walk(base_dir, followlinks=True):
        # Prune excluded directories in-place so os.walk doesn't descend into them.
        dirs[:] = [
            d for d in dirs
            if not any(fnmatch.fnmatch(d, pattern) for pattern in EXCLUDE_DIRS)
        ]

        # Filter out excluded system files.
        files = [
            f for f in files
            if not any(fnmatch.fnmatch(f, pattern) for pattern in EXCLUDE_FILES)
        ]

        for filename in files:
            relpath = os.path.relpath(os.path.join(root, filename), start=base_dir)
            # Normalize to forward slashes for consistent cross-platform paths.
            candidates.append(relpath.replace("\\", "/"))

    # Use ComfyUI's built-in content type filter to keep only actual image files.
    image_files = folder_paths.filter_files_content_types(candidates, ["image"])
    return sorted(image_files)


def _get_image_file_list() -> list[str]:
    """Recursively scan the ComfyUI input directory for image files.

    Convenience wrapper around :func:`_scan_image_dir` for the default input
    directory. Used by the ``image`` combo in :meth:`define_schema`.
    """
    return _scan_image_dir(folder_paths.get_input_directory())


# ── Folder Allowlist ────────────────────────────────────────────────────────

# Active allowlist file (gitignored). The repo ships ``allowed_folders.rename.txt``.
ALLOWLIST_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "allowed_folders.txt")
# Environment variable alternative: comma-separated root folders.
ALLOWLIST_ENV = "ENHUTILS_ALLOWED_FOLDERS"

# Cached parse of ALLOWLIST_FILE: (mtime, roots).
_allowlist_file_cache: tuple[float, list[str]] | None = None


class FolderNotAllowedError(ValueError):
    """Raised when a folder is outside the configured allowlist."""


def _is_within(path: str, base: str) -> bool:
    """Return True if absolute *path* is *base* or inside it (case-insensitive on Windows).

    ``os.path.commonpath`` raises on Windows when the paths are on different
    drives; that simply means "not inside".
    """
    path, base = os.path.normcase(path), os.path.normcase(base)
    try:
        return os.path.commonpath((path, base)) == base
    except ValueError:
        return False


def _canonical(path: str) -> str:
    """Absolute, symlink/junction-resolved path. Relative paths resolve against the input directory."""
    if not os.path.isabs(path):
        path = os.path.join(folder_paths.get_input_directory(), path)
    return os.path.realpath(path)


def _file_roots() -> list[str] | None:
    """Roots from ``allowed_folders.txt``, or None if the file doesn't exist.

    Blank lines and ``#`` comments are ignored. An unreadable file yields
    ``[]`` (input folder only) rather than unrestricted access. Re-read when
    the file's mtime changes.
    """
    global _allowlist_file_cache
    try:
        mtime = os.path.getmtime(ALLOWLIST_FILE)
    except FileNotFoundError:
        _allowlist_file_cache = None
        return None
    except OSError:
        return []

    if _allowlist_file_cache and _allowlist_file_cache[0] == mtime:
        return _allowlist_file_cache[1]

    try:
        with open(ALLOWLIST_FILE, encoding="utf-8-sig") as f:
            lines = [line.strip() for line in f]
    except OSError:
        return []
    roots = [_canonical(line) for line in lines if line and not line.startswith("#")]
    _allowlist_file_cache = (mtime, roots)
    return roots


def _env_roots() -> list[str] | None:
    """Roots from ``ENHUTILS_ALLOWED_FOLDERS``, or None if it isn't set."""
    value = os.environ.get(ALLOWLIST_ENV)
    if value is None:
        return None
    return [_canonical(part.strip()) for part in value.split(",") if part.strip()]


def is_folder_allowed(resolved: str) -> bool:
    """Check a resolved folder against the allowlist(s).

    Each source (``allowed_folders.txt``, ``ENHUTILS_ALLOWED_FOLDERS``) that
    is present must allow the folder; an absent source allows everything, an
    empty one allows only the input directory. The input directory is always
    allowed.
    """
    real = os.path.realpath(resolved)
    if _is_within(real, os.path.realpath(folder_paths.get_input_directory())):
        return True
    for roots in (_file_roots(), _env_roots()):
        if roots is not None and not any(_is_within(real, root) for root in roots):
            return False
    return True


def _resolve_folder(folder_path: str) -> str:
    """Resolve a folder path to an absolute directory path.

    If *folder_path* is relative it is resolved against the ComfyUI input
    directory. Raises :class:`FolderNotAllowedError` if the folder is outside
    the allowlist, and :class:`ValueError` if it does not exist or is not a
    directory.
    """
    if not os.path.isabs(folder_path):
        folder_path = os.path.join(folder_paths.get_input_directory(), folder_path)
    folder_path = os.path.abspath(folder_path)
    if not is_folder_allowed(folder_path):
        raise FolderNotAllowedError(
            f"Folder not allowed: {folder_path} (see allowed_folders.txt / {ALLOWLIST_ENV} on the server)"
        )
    if not os.path.isdir(folder_path):
        raise ValueError(f"Folder does not exist or is not a directory: {folder_path}")
    return folder_path


def _resolve_folder_image(folder_path: str, folder_image: str) -> str:
    """Resolve *folder_image* inside the custom folder, enforcing containment.

    Raises :class:`ValueError` if the image path escapes the folder, and
    :class:`FolderNotAllowedError` if its real location (after following
    symlinked subfolders) is outside the allowlist. Existence is not checked.
    """
    base = _resolve_folder(folder_path)
    image_path = os.path.abspath(os.path.join(base, folder_image))
    if not _is_within(image_path, base):
        raise ValueError(f"Image path escapes the folder: {folder_image}")
    if not is_folder_allowed(os.path.dirname(os.path.realpath(image_path))):
        raise FolderNotAllowedError(f"Folder not allowed: {os.path.dirname(os.path.realpath(image_path))}")
    return image_path


def _is_annotated_path(value: str) -> bool:
    """Check whether a string is a ComfyUI annotated filepath.

    Annotated paths end with a ``[type]`` suffix, e.g.
    ``clipspace/file.png [input]`` or ``file.png [temp]``.  These are
    produced by MaskEditor saves and "Paste (clipspace)" actions.
    """
    return bool(value and re.search(r' \[[^\]]+\]$', value.strip()))


# ── Metadata Extraction ────────────────────────────────────────────────────

def _extract_metadata(image_path: str, img: Image.Image) -> tuple[dict, dict]:
    """Extract embedded metadata and file stats from an image file.

    The embedded ComfyUI data (prompt, workflow, EXIF, and any other PNG text
    chunks) is collected into ``metadata``.  File-level stats (name, path,
    dimensions, size) are collected separately into ``imagedata``.

    Returns:
        (metadata_dict, imagedata_dict): Parsed JSON / stat dicts. ``metadata``
        is empty if no embedded data is found or parsing fails; ``imagedata``
        is empty only if the file cannot be stat'd.
    """
    metadata = {}
    imagedata = {}

    # File-level info.
    try:
        stat = os.stat(image_path)
        imagedata = {
            "filename": os.path.basename(image_path),
            "path": os.path.dirname(image_path),
            "width": img.width,
            "height": img.height,
            "resolution": f"{img.width}x{img.height}",
            "size_bytes": stat.st_size,
        }
    except OSError:
        pass

    # PNG: metadata is stored in img.info (text chunks).
    if img.format == "PNG":
        for key, value in img.info.items():
            if isinstance(value, bytes):
                try:
                    value = value.decode("utf-8", errors="replace")
                except Exception:
                    continue
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except (json.JSONDecodeError, ValueError):
                    parsed = value
            else:
                parsed = value

            # 'prompt' and 'workflow' chunks land here alongside any others.
            metadata[key] = parsed

    # WebP: metadata may be stored in EXIF tags (ComfyUI convention).
    elif img.format == "WEBP" and HAS_PIEXIF:
        try:
            exif_data = piexif.load(image_path)
            # Tag 271 (Make) is used by some tools to store prompt data.
            if "0th" in exif_data and piexif.ImageIFD.Make in exif_data["0th"]:
                raw = exif_data["0th"][piexif.ImageIFD.Make]
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                text = raw.replace("Prompt:", "", 1).strip()
                try:
                    metadata["prompt"] = json.loads(text)
                except (json.JSONDecodeError, ValueError):
                    metadata["prompt_raw"] = text

            # Tag 270 (ImageDescription) is used for workflow data.
            if "0th" in exif_data and piexif.ImageIFD.ImageDescription in exif_data["0th"]:
                raw = exif_data["0th"][piexif.ImageIFD.ImageDescription]
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                text = raw.replace("Workflow:", "", 1).strip()
                try:
                    metadata["workflow"] = json.loads(text)
                except (json.JSONDecodeError, ValueError):
                    metadata["workflow_raw"] = text
        except Exception:
            # piexif can fail on malformed EXIF data; silently skip.
            pass

    # JPEG: extract standard EXIF tags.
    elif img.format == "JPEG":
        try:
            exif = img.getexif()
            if exif:
                metadata["exif"] = {str(k): str(v) for k, v in exif.items()}
        except Exception:
            pass

    return metadata, imagedata


# ── Node Definition ─────────────────────────────────────────────────────────

class ImageLoadWithSubfolders(io.ComfyNode):
    """Loads an image from the input directory (with recursive subfolder support)
    and extracts embedded metadata (prompt, workflow) from PNG and WebP files."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_ImageLoadWithSubfolders",
            display_name="Load Image (With Subfolders)",
            description="Loads an image from the input directory with recursive subfolder browsing. "
                        "Also extracts embedded prompt/workflow metadata from PNG and WebP files.",
            category="image",
            inputs=[
                io.Combo.Input(
                    "image",
                    options=_get_image_file_list(),
                    upload=io.UploadType.image,
                    tooltip="Select an image from the input directory. Subfolders are fully supported.",
                ),
                io.String.Input(
                    "folder_path",
                    default="",
                    optional=True,
                    tooltip=(
                        "Absolute path or path relative to the input directory. "
                        "When set, overrides the image dropdown above. "
                        "The folder is scanned recursively for images."
                    ),
                ),
                io.Combo.Input(
                    "folder_image",
                    options=[""],
                    optional=True,
                    tooltip=(
                        "Pick an image from the custom folder. "
                        "Populated automatically when folder_path is set."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Mask.Output(display_name="mask"),
                io.String.Output(display_name="metadata"),
                io.String.Output(display_name="imagedata"),
            ],
            search_aliases=[
                "load image subfolders",
                "image subfolders",
                "subfolder image",
                "image loader subfolders",
                "load image metadata",
                "image with metadata",
            ],
        )

    @classmethod
    def execute(cls, image: str, folder_path: str = "", folder_image: str = "") -> io.NodeOutput:
        # Resolve the image path: custom folder overrides the dropdown.
        if folder_path.strip():
            if not folder_image or not folder_image.strip():
                raise ValueError("folder_path is set but no folder_image selected.")

            # If folder_image is an annotated path (from MaskEditor save or
            # clipspace paste, e.g. "file.png [temp]"), resolve it via the
            # annotated-filepath mechanism.  Otherwise resolve it as a
            # relative path inside the custom folder.
            if _is_annotated_path(folder_image):
                image_path = folder_paths.get_annotated_filepath(folder_image)
            else:
                image_path = _resolve_folder_image(folder_path, folder_image)
                if not os.path.isfile(image_path):
                    raise FileNotFoundError(
                        f"Image not found in custom folder: {folder_image} "
                        f"(resolved to {image_path})"
                    )
        else:
            image_path = folder_paths.get_annotated_filepath(image)

        # Open the image with ComfyUI's resilient PIL wrapper (handles truncated files).
        img = node_helpers.pillow(Image.open, image_path)

        # Extract metadata before any transforms that might strip it.
        metadata, imagedata = _extract_metadata(image_path, img)

        # Process image frames (handles animated GIF/APNG, multi-page TIFF, MPO).
        output_images = []
        output_masks = []
        first_w, first_h = None, None

        for frame in ImageSequence.Iterator(img):
            frame = node_helpers.pillow(ImageOps.exif_transpose, frame)

            # 16-bit grayscale ('I' mode) needs manual normalization.
            if frame.mode == "I":
                frame = frame.point(lambda i: i * (1 / 255))

            rgb = frame.convert("RGB")

            # Lock dimensions to the first frame (skip mismatched frames).
            if first_w is None:
                first_w, first_h = rgb.size
            elif rgb.size != (first_w, first_h):
                continue

            image_tensor = torch.from_numpy(
                np.array(rgb).astype(np.float32) / 255.0
            )[None,]

            # Extract alpha mask. Handles:
            # - RGBA images (direct alpha channel)
            # - Palette mode ('P') with transparency info
            # - Images with no alpha (returns a zero mask)
            if "A" in frame.getbands():
                mask = 1.0 - torch.from_numpy(
                    np.array(frame.getchannel("A")).astype(np.float32) / 255.0
                )
            elif frame.mode == "P" and "transparency" in frame.info:
                mask = 1.0 - torch.from_numpy(
                    np.array(frame.convert("RGBA").getchannel("A")).astype(np.float32) / 255.0
                )
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")

            output_images.append(image_tensor)
            output_masks.append(mask.unsqueeze(0))

            # MPO format: only use the first frame.
            if img.format == "MPO":
                break

        # Batch frames into single tensors.
        if len(output_images) > 1:
            output_image = torch.cat(output_images, dim=0)
            output_mask = torch.cat(output_masks, dim=0)
        else:
            output_image = output_images[0]
            output_mask = output_masks[0]

        # Serialize metadata to JSON strings for the STRING outputs.
        metadata_json = json.dumps(metadata, ensure_ascii=False, indent=2)
        imagedata_json = json.dumps(imagedata, ensure_ascii=False, indent=2)

        return io.NodeOutput(output_image, output_mask, metadata_json, imagedata_json)

    @classmethod
    def fingerprint_inputs(cls, image: str, folder_path: str = "",
                           folder_image: str = "", **kwargs):
        """Return a hash of the file contents so ComfyUI re-executes only when
        the actual file on disk changes (not just because settings changed)."""
        if folder_path.strip():
            if _is_annotated_path(folder_image or ""):
                image_path = folder_paths.get_annotated_filepath(folder_image)
            else:
                image_path = _resolve_folder_image(folder_path, folder_image)
        else:
            image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def validate_inputs(cls, image: str, folder_path: str = "",
                        folder_image: str = "", **kwargs) -> bool | str:
        """Validate inputs before execution.

        In custom-folder mode, verify the folder exists and the selected image
        is a real file inside it. In dropdown mode, fall back to the standard
        annotated-filepath check.
        """
        if folder_path.strip():
            if not folder_image or not folder_image.strip():
                return "folder_path is set but no folder_image selected."
            # Annotated paths (from MaskEditor save or clipspace paste) are
            # resolved via the annotated-filepath mechanism.
            if _is_annotated_path(folder_image):
                if not folder_paths.exists_annotated_filepath(folder_image):
                    return f"Image not found: {folder_image}"
                return True
            try:
                resolved = _resolve_folder_image(folder_path, folder_image)
            except ValueError as exc:
                return str(exc)
            if not os.path.isfile(resolved):
                return f"Image not found in custom folder: {folder_image}"
            return True
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True
