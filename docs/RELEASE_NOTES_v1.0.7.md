# v1.0.7 — X-WIDE 提示词输入插件 / X-WIDE Prompt Input Helper

> 发 GitHub Release 时把这个文件的内容当正文（先在
> <https://github.com/XWIDE/comfyui-xwide-prompt-input-helper/releases/new> 里选好标签 `v1.0.7`，
> 再把下面整段贴进去）。

## 中文

**这一版修的是三件「P/N 键写错地方 / 把你的字抹掉」的真机毛病。全部由真机复现后修复，测试从 339 项加到 346 项全绿。**

### 1）选中节点按 P/N，提示词写进了「保存图片」的文件名里

病根：挑框的兜底档只看控件类型，而 `string` 类型的**单行小输入框**（文件名前缀、种子、连接 ID…）
在 LiteGraph 里也算"文本控件"，于是它们被当成提示词框写了进去。

新增一道硬闸门 `Bridge.isPromptBox(node, widget)`：**只认有真实 DOM 元素的 `TEXTAREA`（多行大框）**。
所有自动挑框的路径——包括「选中节点」那一档和「这个节点上第一个文本控件」那一档——都必须先过这道闸；
判据跟候选列表那边完全一致，以前那条闸只管候选列表，选节点的两条路没走，现在统一了。

> 测试：只选中「保存图片」这种单行框时**解析不到目标**，`filename_prefix` 一个字都没动；
> 同一个节点上既有单行字段又有真提示词框时，认的是那个多行提示词框。

### 2）「有的时候填入不了负向提示词」（两处）

- **绑定被误删**：绑定指向的框如果角色是另一边，旧版**直接删掉这条记忆**。判据偶发失灵一次，
  就把你锁好的写入目标抹了，下一次连记忆都没得用。现在改成**这次不用它、绑定留着**。
- **反向被排除**：「刚点过的那个框」这一档以前只放行正向。现在**反向同样可以用你刚点过的框**——
  前提是这个框过 `isPromptBox`（确实是多行大框）、而且它来自你鼠标点的那一个，面板顶部「写入目标」
  会明写要写进哪个节点。角色认不出正反、又没点过提示词框时，仍然摊开候选让你挑，**绝不拿猜的去写**。

### 3）点「清空」把你写在画布上的提示词一起抹掉了

旧版「清空」＝ 面板清空 **+ 写入目标那个框也一起写成空**（README 里写的「双清」）。听着省事，实际是
一次破坏性写入：面板开着时点一下，画布上自己写的提示词就没了，找不回来；而且**面板本来就是空的**
那种情况下，旧版会**静默**清掉画布上的框，连提示都没有。

现在（用户拍板）：**「清空」永远只清面板，绝不动画布上那个框**——代码里这条路径上再也没有任何写控件的
调用。要清画布上的提示词，请在节点自己的框里删。面板本来就是空的时，点清空什么都不做、也不出声。
按钮提示、点完的提示、「用法」卡片（中英）都同步说清楚了这个语义。

> 测试契约同步翻转：清空后断言 `画布上那个框一个字都没动（清空只清面板）`——谁改回双清，测试立刻红灯。

### 其它

- 面板顶部在"角色认不出正反"时会显示「正反都认不出来：写进你刚点过的那个框」（中英双语）。
- 版本徽章 / `__version__` / `pyproject.toml` 一起升到 **1.0.7**。

**判定器输出**：语法 `--check` 全过、`py_compile` OK、行为层 `通过 346 项，失败 0 项`。

## English

**This release fixes three real-world cases where P/N wrote into the wrong box — or erased your text.**

### 1) Selecting a node and pressing P/N wrote the prompt into the "Save Image" filename prefix

The fallback tiers only looked at the widget *type*, and single-line `string` widgets (filename prefix,
seed, connection ID…) count as text widgets in LiteGraph — so they got treated as prompt boxes.

A new hard gate `Bridge.isPromptBox(node, widget)` accepts **only widgets backed by a real `TEXTAREA`
DOM element (a multi-line box)**. Every automatic pick path — including "the selected node" and
"first text widget on that node" — must pass it now; previously the gate only guarded the candidate list.

> Tests: selecting a single-line-only node resolves to **no target** and leaves `filename_prefix` untouched;
> when a node has both a single-line field and a real prompt box, the multi-line one wins.

### 2) "Sometimes the negative prompt can't be filled" — two causes

- **The binding was being deleted.** When a bound box's role pointed the other way, the old code
  *deleted that memory*. One false reading wiped the target you had locked in, leaving nothing for the
  next attempt. The binding is now kept; it is simply not used for that one attempt.
- **Negative was excluded from the "box you just clicked" tier.** Negative may now use that box too —
  provided it passes `isPromptBox`, comes from an actual mouse click, and the panel header states which
  node will be written. If roles cannot be told apart and no prompt box was clicked, the panel still
  lists candidates instead of writing a guess.

### 3) Clicking **Clear** erased the prompt you had written on the canvas

Clear used to empty the editor **and write an empty string into the target widget on the canvas**
(documented as "double clear"). That is a destructive write: one click with the panel open lost your
text for good — and when the editor was *already empty*, the old code cleared the canvas box **silently**.

Now (user's decision): **Clear only ever clears the panel — the box on the canvas is never touched**;
there is no widget write left anywhere on that path. Clear a canvas prompt by editing it in its own box.
If the panel was already empty, clicking Clear does nothing at all. Button tooltip, toast and the
"usage" card (zh/en) all state this.

> The test contract was flipped accordingly: after Clear it asserts *"the box on the canvas was not touched
> by a single character"* — reverting to double-clear turns the suite red.

### Misc

- When neither role can be told apart, the header now says "Neither role can be told: writing into the
  box you just clicked" (zh/en).
- Version badge / `__version__` / `pyproject.toml` bumped to **1.0.7**.

**Verification**: syntax `--check` clean, `py_compile` OK, behavior suite **346 passed / 0 failed**.
