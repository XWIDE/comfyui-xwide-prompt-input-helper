"""
X-WIDE Prompt Input Helper
====================

正向 / 反向提示词浮窗。按 Ctrl+Alt+P 开正向、Ctrl+Alt+N 开反向，
从任何地方把提示词粘进来，应用就直接写回你正在编辑的那个文本框 ——
不需要往工作流里加任何节点，也不需要谁去改现有的节点。

这个包**只**提供前端扩展（`web/`）。它不注册任何节点，
所以 `NODE_CLASS_MAPPINGS` 是空的 —— 这是有意为之：
本插件是"穿透型"的，加了节点反而会污染用户的工作流。

安装：
    把整个目录放进 ComfyUI/custom_nodes/，重启 ComfyUI 即可。

许可：MIT，详见 LICENSE。
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# ComfyUI 前端会自动加载这个目录下的 .js（作为 ES module）。
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

__version__ = "1.0.4"
