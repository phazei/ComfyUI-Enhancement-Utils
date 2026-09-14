"""
ExecutionGate node -- conditional, lazy, non-output pass-through.

Replaces the "Stop" behavior of Impact Pack's Control Bridge without its
main drawback: Control Bridge is an OUTPUT node, so its whole upstream
dependency chain executes on every queue even when the gated value is
never consumed.  This node is a plain (non-output) node, so ComfyUI's
normal dead-branch pruning applies -- if nothing downstream of the gate
reaches a real output node, neither the gate nor anything feeding it runs.

Semantics::

    enabled == True   -> request the lazy ``value`` input, pass it through
                         unchanged (same Python object, type-matched output)
    enabled == False  -> ``value`` is never requested (upstream not executed),
                         output is a silent ExecutionBlocker so downstream
                         nodes are skipped without reporting an error

Two native ComfyUI mechanisms are combined:

* **Lazy input** (``lazy=True`` + ``check_lazy_status``) prevents *upstream*
  work: the scheduler does not add lazy links as dependencies until the node
  explicitly asks for them.
* **ExecutionBlocker(None)** prevents *downstream* work: any node receiving a
  blocker as an input is skipped and forwards the blocker to its own outputs.
  A ``None`` message means no ``execution_error`` event is emitted, so the
  frontend's auto-queue ("Run (Instant)") keeps going.

Typical use: an LLM produces text, a length/range check reduces to a bool,
and the gate sits between the text and an expensive generator.  Invalid text
skips the generator; if the generator branch is disconnected, the LLM does
not run at all.

When the gate blocks, it logs at INFO and returns ``ui={"blocked": [True]}``
so ``js/executionGate.js`` can show a toast -- otherwise a silent block is
indistinguishable from the many other reasons a branch might not run.
ComfyUI re-sends cached ``ui`` data, so the toast also appears on later runs
where the blocked gate result is served from cache.
"""

import logging

from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker

logger = logging.getLogger("enhutils.execution_gate")


class ExecutionGate(io.ComfyNode):
    """Pass ``value`` through when ``enabled``; otherwise silently block downstream.

    Not an output node.  ``value`` is lazy and only evaluated when ``enabled``
    is true.  Works anywhere (including subgraphs) because it relies solely on
    ComfyUI's lazy-evaluation and blocker-propagation semantics.
    """

    PASSTHROUGH = io.MatchType.Template("gate")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_ExecutionGate",
            display_name="Execution Gate (EnhUtils)",
            description=(
                "Conditional pass-through. When 'enabled' is true, 'value' is "
                "evaluated and passed through unchanged. When false, 'value' is "
                "never evaluated (its upstream nodes do not run) and downstream "
                "execution is silently blocked -- no error, so auto-queue keeps "
                "running. Not an output node: if the gate's output does not "
                "reach a real output, nothing feeding it executes."
            ),
            category="utils",
            inputs=[
                io.Boolean.Input(
                    "enabled",
                    default=True,
                    label_on="pass through",
                    label_off="block",
                    tooltip=(
                        "When true, evaluates and passes through 'value'. "
                        "When false, 'value' is not evaluated and downstream "
                        "execution is silently blocked."
                    ),
                ),
                io.MatchType.Input(
                    "value",
                    template=cls.PASSTHROUGH,
                    lazy=True,
                    tooltip=(
                        "Value to pass through when 'enabled' is true. "
                        "Not evaluated when 'enabled' is false."
                    ),
                ),
            ],
            outputs=[
                io.MatchType.Output(
                    template=cls.PASSTHROUGH,
                    display_name="value",
                    tooltip=(
                        "The original 'value' when enabled, or a silent "
                        "execution blocker when disabled."
                    ),
                ),
            ],
            hidden=[io.Hidden.unique_id],
            search_aliases=[
                "execution gate", "conditional execution", "block execution",
                "lazy gate", "conditional passthrough", "execution blocker",
                "control bridge", "stop", "halt",
            ],
        )

    @classmethod
    def check_lazy_status(cls, enabled, value=None):
        """Tell the scheduler which lazy inputs still need evaluating.

        ComfyUI passes not-yet-evaluated lazy inputs as ``None``.  ``enabled``
        is not lazy, so it is always resolved by the time this runs.

        Args:
            enabled: The resolved boolean condition.
            value:   The pass-through value, or ``None`` if not yet evaluated.

        Returns:
            ``["value"]`` if the gate is enabled and ``value`` has not been
            evaluated yet; otherwise an empty list.
        """
        if enabled and value is None:
            return ["value"]
        return []

    @classmethod
    def execute(cls, enabled, value=None) -> io.NodeOutput:
        """Pass ``value`` through, or emit a silent blocker.

        Note on the blocker: it is returned as a positional *result*, i.e.
        ``io.NodeOutput(ExecutionBlocker(None))``, NOT via
        ``io.NodeOutput(block_execution=...)``.  The ``block_execution``
        kwarg treats ``None`` as "no block", so it cannot express a silent
        block -- and returning a bare ``ExecutionBlocker`` from a V3 node is
        normalized into exactly that no-op.  Placing the blocker in the
        result tuple is the only form that reaches downstream nodes' input
        checks.

        The ``ui`` payload on the blocked path triggers the node's
        ``onExecuted`` on the frontend (see ``js/executionGate.js``), which
        shows a toast.  Values must be lists -- ComfyUI merges ``ui`` dicts
        by extending per-key lists.
        """
        if enabled:
            return io.NodeOutput(value)

        logger.info(
            "Execution Gate %s: 'enabled' is false, downstream execution "
            "blocked ('value' not evaluated)",
            cls.hidden.unique_id or "?",
        )
        return io.NodeOutput(ExecutionBlocker(None), ui={"blocked": [True]})
