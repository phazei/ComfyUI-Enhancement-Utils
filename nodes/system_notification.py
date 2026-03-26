"""
SystemNotification node -- sends a browser notification when execution reaches this node.

Uses the browser's Notification API to show a system-level notification.
Supports "always" or "on empty queue" modes. Notification permission is
requested when the node is first added to the graph.

Based on pythongosssss/ComfyUI-Custom-Scripts, rewritten for V3 schema.
"""

from comfy_api.latest import io


class SystemNotification(io.ComfyNode):
    """Sends a browser notification when triggered. Passes input through unchanged."""

    PASSTHROUGH = io.MatchType.Template("passthrough")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_SystemNotification",
            display_name="System Notification",
            description="Sends a browser notification when execution reaches this node. "
                        "Useful for long-running workflows.",
            category="utils",
            is_output_node=True,
            inputs=[
                io.String.Input(
                    "message",
                    default="Your workflow has completed.",
                    tooltip="The notification body text.",
                ),
                io.MatchType.Input(
                    "any",
                    template=cls.PASSTHROUGH,
                    tooltip="Connect any output here to trigger the notification and pass the data through.",
                ),
                io.Combo.Input(
                    "mode",
                    options=["always", "on empty queue"],
                    default="always",
                    tooltip="'always' notifies every execution. 'on empty queue' only notifies when the queue is empty.",
                ),
            ],
            outputs=[
                io.MatchType.Output(
                    template=cls.PASSTHROUGH,
                    display_name="passthrough",
                    tooltip="Passes the 'any' input through unchanged.",
                ),
            ],
            search_aliases=["system notification", "browser notification", "alert", "notify"],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        """Always re-execute so the notification fires every time."""
        return float("NaN")

    @classmethod
    def execute(cls, any, message, **kwargs) -> io.NodeOutput:
        # The actual notification is created client-side in systemNotification.js.
        # We send the message and mode so the JS handler can use them.
        return io.NodeOutput(any, ui={"message": message})
