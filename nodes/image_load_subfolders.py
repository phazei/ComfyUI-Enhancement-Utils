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


def _get_image_file_list() -> list[str]:
    """Recursively scan the input directory for image files, including subfolders.

    Returns a sorted list of relative paths using forward slashes (cross-platform).
    Non-image files are filtered out using ComfyUI's MIME-type detection.
    """
    input_dir = folder_paths.get_input_directory()
    candidates = []

    for root, dirs, files in os.walk(input_dir, followlinks=True):
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
            relpath = os.path.relpath(os.path.join(root, filename), start=input_dir)
            # Normalize to forward slashes for consistent cross-platform paths.
            candidates.append(relpath.replace("\\", "/"))

    # Use ComfyUI's built-in content type filter to keep only actual image files.
    image_files = folder_paths.filter_files_content_types(candidates, ["image"])
    return sorted(image_files)


# ── Metadata Extraction ────────────────────────────────────────────────────

def _extract_metadata(image_path: str, img: Image.Image) -> tuple[dict, dict]:
    """Extract prompt and metadata from an image file.

    Returns:
        (prompt_dict, metadata_dict): Parsed JSON dicts. Empty dicts if no
        metadata is found or parsing fails.
    """
    prompt = {}
    metadata = {}

    # File-level info.
    try:
        stat = os.stat(image_path)
        metadata["fileinfo"] = {
            "filename": os.path.basename(image_path),
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

            if key == "prompt":
                prompt = parsed if isinstance(parsed, dict) else {}
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
                    prompt = json.loads(text)
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

    return prompt, metadata


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
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Mask.Output(display_name="mask"),
                io.String.Output(display_name="prompt"),
                io.String.Output(display_name="metadata"),
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
    def execute(cls, image: str) -> io.NodeOutput:
        image_path = folder_paths.get_annotated_filepath(image)

        # Open the image with ComfyUI's resilient PIL wrapper (handles truncated files).
        img = node_helpers.pillow(Image.open, image_path)

        # Extract metadata before any transforms that might strip it.
        prompt, metadata = _extract_metadata(image_path, img)

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
        prompt_json = json.dumps(prompt, ensure_ascii=False, indent=2)
        metadata_json = json.dumps(metadata, ensure_ascii=False, indent=2)

        return io.NodeOutput(output_image, output_mask, prompt_json, metadata_json)

    @classmethod
    def fingerprint_inputs(cls, image: str, **kwargs):
        """Return a hash of the file contents so ComfyUI re-executes only when
        the actual file on disk changes (not just because settings changed)."""
        image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def validate_inputs(cls, image: str, **kwargs) -> bool | str:
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True
