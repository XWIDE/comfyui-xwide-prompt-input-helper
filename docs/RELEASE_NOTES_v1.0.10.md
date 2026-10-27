# v1.0.10

**中文**

一个小功能，来自真机反馈：「当框内没有内容时，可以为空……就是可以 删除你的内容 并保存」。

- **浮窗里空着点「应用并关闭」= 把画布上那个框清空并保存。** 以前这句会被第一行闸门打回去，提示「内容是空的，没有写入。」；现在写回空串，提示「已把 #519 Prompt · text 清空」（认不出节点名时说「已把目标清空」）。`Enter` 和按钮两条路走同一段代码，行为一致。
- **不谎报**：目标本来就是空的，再空手按一次 → 提示「目标本来就是空的，没动它。」，面板保持打开，不会假装清掉了什么。
- **读不到目标文字时一律照常写**：绝不因为"我读不出来"而拒绝你的操作。
- **其它一律不变**：`→ 负向 / → 正向` 搬运、词库「存词条」照旧不吃空值（空手搬运依旧提示）；「清空」按钮仍然只清面板、一个字都不碰画布。
- 测试 **401 项全过**（新增一节专测：清空写回 = widget 变成空串、空对空不谎报且面板不关、空手搬运仍被拦）。

**English**

One small feature, from real-machine feedback: "when the box has no content it should be allowed to be empty — let me delete the content and save it".

- **Applying with an empty editor now clears the box on the canvas.** It used to be rejected on the first line with "the content is empty, nothing was written"; now an empty string is written back and you get "Cleared text on #519 Prompt" (or "Target cleared" when the node name can't be resolved). `Enter` and the button share one code path, so they behave identically.
- **No fake success**: if the target is already empty, applying again says "The target was already empty — nothing changed." and the panel stays open.
- **When the current target text cannot be read, we still write** — never refusing your action because something could not be read.
- **Everything else is unchanged**: `→ Negative / → Positive` and saving a library entry still refuse empty input; the **Clear** button still empties only the editor and never touches the canvas.
- **401 assertions pass** (a new section covers: clearing writes an empty string, empty-on-empty reports honestly and keeps the panel open, empty swaps are still blocked).
