"""
节点定义 —— 这里是**空的**，而且必须保持为空。

X-WIDE Prompt Input Helper 是一个纯前端扩展：它靠全局快捷键和一个浮层
写回已有的 widget，不需要、也不应该注册任何节点。往用户的工作流里
塞节点就违背了"穿透、不改现有流程"这个前提。

ComfyUI 仍然要求 custom_nodes 下的包提供 NODE_CLASS_MAPPINGS，
所以这里给出空映射，让它能正常被 import。
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
