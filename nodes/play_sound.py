"""
PlaySound node -- plays an audio file when execution reaches this node.

Supports "always" or "on empty queue" modes. The actual audio playback happens
on the client side via the HTML5 Audio API; the server just passes through the
trigger signal and returns UI metadata for the JS handler.

Based on pythongosssss/ComfyUI-Custom-Scripts, rewritten for V3 schema.
"""

from comfy_api.latest import io


class PlaySound(io.ComfyNode):
    """Plays a sound file when triggered. Passes input through unchanged."""

    PASSTHROUGH = io.MatchType.Template("passthrough")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_PlaySound",
            display_name="Play Sound",
            description="Plays an audio file when execution reaches this node. "
                        "Connect any output to the 'any' input to trigger it.",
            category="utils",
            is_output_node=True,
            inputs=[
                io.MatchType.Input(
                    "any",
                    template=cls.PASSTHROUGH,
                    tooltip="Connect any output here to trigger the sound and pass the data through.",
                ),
                io.Combo.Input(
                    "mode",
                    options=["always", "on empty queue"],
                    default="always",
                    tooltip="'always' plays every execution. 'on empty queue' only plays when the queue is empty.",
                ),
                io.Float.Input(
                    "volume",
                    default=0.5,
                    min=0.0,
                    max=1.0,
                    step=0.1,
                    tooltip="Playback volume (0.0 = silent, 1.0 = full volume).",
                ),
                io.String.Input(
                    "file",
                    default="notify.mp3",
                    tooltip="Sound file name (from assets/) or a full URL.",
                ),
            ],
            outputs=[
                io.MatchType.Output(
                    template=cls.PASSTHROUGH,
                    display_name="passthrough",
                    tooltip="Passes the 'any' input through unchanged.",
                ),
            ],
            search_aliases=["play sound", "audio alert", "notification sound", "beep"],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        """Always re-execute so the sound plays every time."""
        return float("NaN")

    @classmethod
    def execute(cls, any, **kwargs) -> io.NodeOutput:
        # The actual sound is played client-side in playSound.js.
        # We return empty UI data to trigger the onExecuted callback,
        # and pass the input through as our output.
        return io.NodeOutput(any, ui={"played": True})
