# v1.0.9

**中文**

这一版全部来自真机反馈：缩放（滚轮 / `A-` `A+`）和设置页版式。

- **按住 `Ctrl` 滚滚轮调字号，在 ComfyUI 0.42.5 上失效了 —— 这一版修好。** 0.42.5（前端包 1.55.18）新增了一个画布手势转发器：`isCanvasGestureWheel = e.ctrlKey || e.metaKey || |deltaX| > |deltaY|`，把「按 Ctrl 滚」「横着滚」一律当成要缩画布；它 `preventDefault + stopPropagation` 之后**还会复制一份 WheelEvent 派发进画布元素**。所以在浮窗里按 Ctrl 滚，字号和画布一起变 = 用户说的「整个页面都在缩放」。
  这版不跟它抢事件，改用宿主自己的官方闸门：浮窗开着时把当前画布实例的 `allow_dragcanvas` 临时置 false（`LGraphCanvas.processMouseWheel` 第一行就 return），浮窗一关原值还回去；overlay 同时打上官方的 `data-capture-wheel="true"`。**插件不写画布的 `ds.scale` / `ds.offset`，也不改宿主的任何函数。**
- **字号倍数只放大输入框里的字**：浮窗外框、标题栏、按钮命中区全部钳成固定尺寸。以前 400% 时标题栏被撑满整屏，看起来就像"整页在缩放"。
- **删掉了「画布视图快照 / 回写」整套机制**：它会直接写宿主 `ds.scale` / `ds.offset`，把你自己缩好的画布拧回旧位置 —— 那是"整页在缩放"的另一半来源。现在画布一个字节都不动。
- **输入框里不带 Ctrl 的滚轮 = 滚提示词**（几千字的长提示词再也不会顺手把画布缩没）；标题栏、页脚这些不滚东西的地方，滚轮被吃掉，不漏到背后。面板外面的滚轮一概不碰。
- **设置页 = 居中一列 + 一个帮助小按钮**：最上面是我的信息（logo / 版本号 / `⚖ GPL-3.0` / 免责声明）加一个 `📖 使用帮助` 按钮，点它就是浮窗 `⚙` 那份帮助；下面快捷键 / 自动粘贴 / 文字大小三行装进卡片居中成一列。左边那列标签由 CSS 藏掉 —— 不藏就会把同一句话重复两遍。
- **浮窗标题栏的 `⚙` = 使用帮助**：我的信息 → 快捷键全表（含 `Shift + Enter` 换行）→ 使用说明 → 作者与链接。设置页那个小按钮和它开的是同一份。
- 测试 **388 项全过**；无头 Edge 实测 1× / 2× / 4× 三档：浮窗 720×480、标题栏 39px、按钮 28×26、整页 1600×1000 **全部不变**，只有输入区字号 12.5 → 25 → 50px；设置页四行标签列全藏、三张卡片各 640 宽居中（左右留白都是 167）、帮助按钮 132×32、开关行 38 高 + 勾选框 18×18、对比度 11.71:1 / 12.17:1、无横向溢出。

**English**

Every change in this release comes from real-machine feedback about zooming (wheel / `A-` `A+`) and the settings page layout.

- **`Ctrl + wheel` text zoom is fixed on ComfyUI 0.42.5.** That release (frontend 1.55.18) added a canvas gesture forwarder — `isCanvasGestureWheel = e.ctrlKey || e.metaKey || |deltaX| > |deltaY|` — which treats any Ctrl-wheel or horizontal wheel as canvas zoom, and after `preventDefault + stopPropagation` it **dispatches a copy of the WheelEvent into the canvas element**. That is why scaling text inside our overlay also scaled the canvas ("the whole page is zooming").
  We no longer race it for events. We use the host's own official gate: while an overlay is open, the current canvas instance gets `allow_dragcanvas = false` (`LGraphCanvas.processMouseWheel` returns on its first line), and the original value is handed back when the overlays close; the overlay also carries the official `data-capture-wheel="true"`. **The plugin never writes `ds.scale` / `ds.offset` and never patches host functions.**
- **The font multiplier only enlarges text inside the editor**: the panel frame, title bar and button hit areas are clamped to fixed sizes. At 400% the title bar used to stretch across the screen, which looked like "the whole page is zooming".
- **The canvas view snapshot / restore mechanism is gone.** It wrote `ds.scale` / `ds.offset` directly and snapped your own canvas zoom back — the other half of that effect. The canvas is now untouched.
- **A plain wheel inside the editor scrolls the prompt** (a long prompt no longer zooms the canvas away); in the header/footer the wheel is swallowed so it cannot leak behind. Wheels outside the overlay are never touched.
- **Settings page = one centered column + a small help button**: my info (logo / version / `⚖ GPL-3.0` / disclaimer) plus a `📖 Help` button at the top — it opens the same help the overlay's `⚙` opens; below it the shortcut / auto-paste / text-size rows sit in centered cards. The label column on the left is hidden by CSS, otherwise every sentence would be printed twice.
- **The overlay's `⚙` opens the Help page**: my info → full key table (including `Shift + Enter` for a line break) → usage notes → author & links.
- **388 assertions pass**; headless Edge measurements at 1× / 2× / 4×: panel 720×480, title bar 39px, buttons 28×26, page 1600×1000 — **all unchanged** — while only the editor text goes 12.5 → 25 → 50px.
