"""
Enhancement Utils - Resource Monitor.

Provides real-time system stats (CPU, RAM, HDD, GPU) displayed as a horizontal
bar in the ComfyUI menu. Stats are pushed to the frontend via WebSocket.
"""

from .collector import monitor_instance
