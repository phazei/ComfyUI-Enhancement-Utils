"""
ParseJSON node -- parses one or more JSON strings into a native Python object.

Useful for turning STRING/JSON outputs (e.g. the ``metadata``/``imagedata``
outputs of ImageLoadWithSubfolders, or LLM text) back into structured Python
objects that can be consumed by nodes accepting any-type inputs (e.g.
rgthree's Power Puter).

Behavior:

* Inputs are an autogrow group of optional STRING slots (``json0``,
  ``json1``, ...).  Unconnected inputs (e.g. the upstream node is bypassed)
  and empty strings are skipped -- they never raise.
* Invalid JSON logs a warning, is skipped, and is reported to the frontend
  via the ``ui`` payload so ``js/parseJson.js`` can show a toast.
* ``lenient`` parsing (default on) recovers common LLM output: markdown code
  fences, prose around the JSON, trailing commas, and Python-literal dicts
  (single quotes, ``True``/``None``) via ``ast.literal_eval``.
* Multiple parsed values are combined: objects are deep-merged (later slots
  win), arrays are concatenated.  Any other mix is a real error.  A single
  value of any type passes through unchanged.  No values -> ``{}``.
* An optional ``path`` (``a.b.0.c`` or ``a.b[0].c``) selects a value from
  the combined result.  A missing path warns and yields ``{}``.

Based on:
- phazei/ComfyUI-MultiLoRALoader MultiLoRA_ParseJSON
Rewritten for V3 schema.
"""

import ast
import json
import logging
import re
from typing import Any

from comfy_api.latest import io

logger = logging.getLogger("enhutils.parse_json")

MAX_INPUTS = 10

_FENCE_RE = re.compile(r"```[\w+-]*[ \t]*\r?\n?(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
_PATH_TOKEN_RE = re.compile(r"\[(-?\d+)\]|[^.\[\]]+")

# Sentinel for "this input contributed nothing" (empty, missing, or invalid).
_SKIP = object()


# ── Parsing ──────────────────────────────────────────────────────────────


def _extract_outer(text: str) -> str | None:
    """Return the span from the first ``{``/``[`` to its last matching closer.

    Args:
        text: Raw text that may contain JSON surrounded by prose.

    Returns:
        The candidate substring, or ``None`` if no bracketed span exists.
    """
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        return None
    start = min(starts)
    end = text.rfind("}" if text[start] == "{" else "]")
    if end <= start:
        return None
    return text[start:end + 1]


def _normalize(value: Any) -> Any:
    """Round-trip a Python literal through JSON so it only contains JSON types.

    ``ast.literal_eval`` can yield tuples, sets, bytes and non-string keys;
    this converts them to lists/strings so merging and serialization behave
    the same as for real JSON.
    """
    return json.loads(json.dumps(value, default=str))


def _lenient_candidates(text: str) -> list[str]:
    """Build the ordered, de-duplicated list of substrings to try parsing.

    Args:
        text: The stripped input text.

    Returns:
        Candidates: the full text, the first code-fence body, and the
        outermost bracketed span (of the fence body if present).
    """
    candidates = [text]
    fence = _FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1).strip())
    for base in list(candidates):
        outer = _extract_outer(base)
        if outer:
            candidates.append(outer)
    seen = set()
    return [c for c in candidates if c and not (c in seen or seen.add(c))]


def parse_json_text(text: str | None, lenient: bool = True) -> tuple[Any, str | None]:
    """Parse a JSON string, optionally recovering from common LLM formatting.

    Args:
        text:    The input string.  ``None`` or whitespace-only is skipped.
        lenient: Try fence stripping, bracket extraction, trailing-comma
                 removal and ``ast.literal_eval`` when strict parsing fails.

    Returns:
        ``(value, error)``.  ``value`` is ``_SKIP`` when the input is empty
        or unparseable; ``error`` is a message only in the unparseable case.
    """
    if text is None:
        return _SKIP, None
    if not isinstance(text, str):
        return _SKIP, f"expected a string, got {type(text).__name__}"
    stripped = text.strip()
    if not stripped:
        return _SKIP, None

    try:
        return json.loads(stripped), None
    except (ValueError, RecursionError) as exc:
        strict_error = str(exc)
    if not lenient:
        return _SKIP, strict_error

    for candidate in _lenient_candidates(stripped):
        for attempt in (candidate, _TRAILING_COMMA_RE.sub(r"\1", candidate)):
            try:
                return json.loads(attempt), None
            except (ValueError, RecursionError):
                pass
        try:
            return _normalize(ast.literal_eval(candidate)), None
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            pass
    return _SKIP, strict_error


# ── Combining ────────────────────────────────────────────────────────────


def deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge two dicts without mutating either.

    Nested dicts are merged; every other value (including lists) from
    ``override`` replaces the one in ``base``.
    """
    result = dict(base)
    for key, value in override.items():
        if isinstance(result.get(key), dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def combine_values(values: list[tuple[str, Any]]) -> Any:
    """Combine parsed values from several inputs.

    Args:
        values: ``(slot_name, value)`` pairs in slot order, skips removed.

    Returns:
        ``{}`` for no values, the value itself for one, a deep-merged dict
        if all are dicts, or a concatenated list if all are lists.

    Raises:
        ValueError: If there are multiple values that are not all dicts or
            all lists.
    """
    if not values:
        return {}
    if len(values) == 1:
        return values[0][1]
    if all(isinstance(v, dict) for _, v in values):
        merged: dict = {}
        for _, v in values:
            merged = deep_merge(merged, v)
        return merged
    if all(isinstance(v, list) for _, v in values):
        return [item for _, v in values for item in v]
    kinds = ", ".join(f"{name}={_kind(v)}" for name, v in values)
    raise ValueError(
        "[Parse JSON] Cannot combine inputs: all must be objects or all must "
        f"be arrays (got {kinds})"
    )


def _kind(value: Any) -> str:
    """Return the JSON type name of a parsed value for error messages."""
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    return type(value).__name__


# ── Path lookup ──────────────────────────────────────────────────────────


def resolve_path(data: Any, path: str) -> tuple[Any, str | None]:
    """Select a nested value using ``a.b.0.c`` / ``a.b[0].c`` notation.

    Dict keys are matched as strings (so ``prompt.3.inputs`` works on
    ComfyUI prompt dicts); list indices may be negative.

    Args:
        data: The combined parsed value.
        path: The path expression.  Blank means "whole value".

    Returns:
        ``(value, error)``; ``error`` describes the first failing segment.
    """
    path = (path or "").strip()
    if not path:
        return data, None
    current = data
    walked = ""
    for match in _PATH_TOKEN_RE.finditer(path):
        token = match.group(1) if match.group(1) is not None else match.group(0)
        token = token.strip()
        if isinstance(current, dict):
            if token not in current:
                return _SKIP, f"key '{token}' not found at '{walked or '<root>'}'"
            current = current[token]
        elif isinstance(current, list):
            try:
                current = current[int(token)]
            except (ValueError, IndexError):
                return _SKIP, (
                    f"index '{token}' invalid at '{walked or '<root>'}' "
                    f"(array of {len(current)})"
                )
        else:
            return _SKIP, f"cannot index {_kind(current)} at '{walked or '<root>'}'"
        walked = f"{walked}.{token}" if walked else token
    return current, None


# ═══════════════════════════════════════════════════════════════════════
# Node
# ═══════════════════════════════════════════════════════════════════════


def _slot_index(name: str) -> int:
    """Sort key for autogrow slot names like ``json3`` -> 3."""
    digits = re.search(r"(\d+)$", name)
    return int(digits.group(1)) if digits else 0


class ParseJSON(io.ComfyNode):
    """Parses and combines JSON strings into a native Python object.

    The result is emitted on an any-type output so it can be wired into
    nodes that accept arbitrary inputs, plus a re-serialized JSON string.
    """

    @classmethod
    def define_schema(cls):
        template = io.Autogrow.TemplatePrefix(
            io.String.Input(
                "json",
                optional=True,
                tooltip="A JSON string. Empty or unconnected inputs are ignored.",
            ),
            prefix="json",
            min=1,
            max=MAX_INPUTS,
        )
        return io.Schema(
            node_id="EnhancementUtils_ParseJSON",
            display_name="Parse JSON (EnhUtils)",
            description=(
                "Parses one or more JSON strings into a Python object (dict, "
                "list, number, etc.). Multiple objects are deep-merged (later "
                "inputs win); multiple arrays are concatenated. Empty or "
                "unconnected inputs are ignored and invalid JSON shows a "
                "warning instead of failing. An optional path selects a "
                "nested value."
            ),
            category="utils",
            inputs=[
                io.Autogrow.Input(
                    "values",
                    template=template,
                    optional=True,
                    tooltip="JSON strings to parse and combine.",
                ),
                io.Boolean.Input(
                    "lenient",
                    default=True,
                    optional=True,
                    tooltip=(
                        "Recover JSON from LLM-style output: strips markdown "
                        "code fences and surrounding text, removes trailing "
                        "commas, and accepts Python-style dicts (single "
                        "quotes, True/None)."
                    ),
                ),
                io.String.Input(
                    "path",
                    default="",
                    optional=True,
                    tooltip=(
                        "Optional path to a nested value, e.g. "
                        "'workflow.nodes.0.type' or 'items[2].name'. "
                        "Leave empty to output the whole result."
                    ),
                ),
            ],
            outputs=[
                io.AnyType.Output(
                    display_name="data",
                    tooltip="The parsed (and combined) Python object.",
                ),
                io.String.Output(
                    display_name="json_string",
                    tooltip="The result re-serialized as formatted JSON.",
                ),
            ],
            hidden=[io.Hidden.unique_id],
            search_aliases=[
                "parse json",
                "json parse",
                "json to object",
                "decode json",
                "merge json",
                "combine json",
                "json path",
            ],
        )

    @classmethod
    def execute(
        cls,
        values: io.Autogrow.Type = None,
        lenient: bool = True,
        path: str = "",
    ) -> io.NodeOutput:
        """Parse, combine, and optionally select from the JSON inputs.

        Recoverable problems (invalid JSON, missing path) are logged and
        returned in ``ui["enhutils_warnings"]`` for ``js/parseJson.js`` to
        toast.  Only incompatible input types raise.
        """
        node_label = f"Parse JSON #{cls.hidden.unique_id or '?'}"
        warnings: list[str] = []
        parsed: list[tuple[str, Any]] = []

        values = values or {}
        for name in sorted(values.keys(), key=_slot_index):
            value, error = parse_json_text(values[name], lenient=lenient)
            if error:
                msg = f"{name}: invalid JSON ({error})"
                logger.warning("%s: %s", node_label, msg)
                warnings.append(msg)
            if value is not _SKIP:
                parsed.append((name, value))

        result = combine_values(parsed)

        if parsed and (path or "").strip():
            selected, error = resolve_path(result, path)
            if error:
                msg = f"path '{path.strip()}': {error}"
                logger.warning("%s: %s", node_label, msg)
                warnings.append(msg)
                result = {}
            else:
                result = selected

        json_string = _to_json_string(result)
        ui = {"enhutils_warnings": warnings} if warnings else None
        return io.NodeOutput(result, json_string, ui=ui)


def _to_json_string(value: Any) -> str:
    """Serialize ``value`` as indented JSON, stringifying unknown types."""
    try:
        return json.dumps(value, indent=2, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        logger.warning("Parse JSON: could not serialize result: %s", exc)
        return ""
