# v1.0.8

**中文**

ComfyUI 升到 **0.42.5** 之后，面板里的「滚轮调字号」没反应了 —— 这一版修好它，另外收掉两条你反馈的问题。

- **Ctrl + 滚轮 调字号恢复了。** 新版前端把 Ctrl/Cmd + 滚轮定义成画布缩放手势，而且在**文档级捕获**就把输入框上的滚轮拦走（真机探针逐层量出来的：事件只走到 `document:capture` 就停）。我们把监听挂到 window 的捕获相，站在那个拦截器上面；范围只限「落在插件浮窗里」的滚轮，画布上照旧缩放，零侵入。
- **输入框里光滚轮 = 照常滚提示词。** 0.42.5 会把 textarea 上的光滚轮也转去缩放画布（等于滚几千字提示词就把画布缩没了），现在这条由我们自己处理。
- **关掉快捷键要连按两次。** 之前一次 `Delete` 就把 P / N 悄悄关掉，回来只看到"按 P 没反应"；现在第一下只提示一句，第二下才真的关掉。设置里那一行的说明同步改了，还有「恢复默认按键」一键复原。
- **原生设置页收回 ComfyUI 自己的排版**：只有三行（快捷键 / 自动粘贴 / 文字大小），左边名字右边控件，不再塞品牌大 logo 和长文、也不再藏它的标签列。插件信息（logo / 版本号 / 作者 / 用法）只在「关于」弹窗里 —— 画布空白处右键 → X-WIDE → 关于。
- 测试 354 项全过；真机（ComfyUI 0.42.5 + 前端 1.55.18）复验：Ctrl+滚轮字号 1→1.1、输入框里光滚 scrollTop 动而字号不动、画布上滚轮完全不被插件碰、设置页 `row_count = 3` 且标签列可见、按 P 浮窗出现。

**English**

- **Ctrl + wheel text-size zoom is back on ComfyUI 0.42.5.** The new frontend claims Ctrl/Cmd + wheel as a canvas-zoom gesture and intercepts wheel events at the **document capture** level (measured layer by layer on a real machine). Our listener now sits on the window capture phase, scoped to events inside our overlay — the canvas keeps its zoom, zero intrusion.
- **Plain wheel inside the text box scrolls the prompt again** instead of zooming the canvas.
- **Turning a shortcut off now takes two presses** of Delete / Backspace, so one accidental tap can no longer silently disable P / N. *Restore defaults* puts them back in one click.
- **The native settings page goes back to ComfyUI's own layout**: exactly three rows (shortcuts / auto-paste / text size), name on the left and control on the right. Plugin information (logo, version, author, usage) lives only in the **About** dialog — right-click empty canvas → X-WIDE → About.
- 354 assertions pass; verified live against ComfyUI 0.42.5 (frontend 1.55.18).
