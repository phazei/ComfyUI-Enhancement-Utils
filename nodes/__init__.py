"""
Enhancement Utils - Node definitions.

All V3 schema node classes are collected here for the extension entrypoint.
"""

from .play_sound import PlaySound
from .system_notification import SystemNotification
from .image_load_subfolders import ImageLoadWithSubfolders

ALL_NODES = [
    PlaySound,
    SystemNotification,
    ImageLoadWithSubfolders,
]
