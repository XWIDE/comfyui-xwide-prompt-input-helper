# v1.0.4 — X-WIDE 提示词输入插件 / X-WIDE Prompt Input Helper

> 这份文件是 GitHub Release 的现成文案：在
> <https://github.com/XWIDE/comfyui-xwide-prompt-helper/releases/new> 里选好标签 `v1.0.4`，
> 把下面横线以内的内容整段粘进正文即可。

---

## 中文

**X-WIDE 提示词输入插件** —— 给 ComfyUI 用的**穿透型**正向 / 反向提示词输入浮窗：
按一个键弹出大输入框，把提示词写完按回车，内容直接写回你正在编辑的那个文本框。

**它不新增节点、不修改任何现有节点** —— 工作流零改动，卸载只要删掉插件目录。

### 这个版本做了什么

| | |
| --- | --- |
| 输入浮窗 | `P` 开正向、`N` 开反向；回车 = 应用并关闭，`Shift+回车` = 换行，`Esc` = 关闭 |
| 写回哪儿 | 面板顶部一直写着"这次要写进哪个节点的哪个字段"，下面一行小字写着**判定依据** |
| 清空 | 面板清空 **+ 画布上那个框也一起清空**（这个框我不要了） |
| 在别处复制 | 页面里 `Ctrl+C` 自动收进面板；浏览器外面复制的，**切回页面时自动收下**（`自动粘贴` 开关控制，默认开） |
| 文字大小 | 面板标题栏 `A-` / `A+`、面板里 `Ctrl + 滚轮`、设置里那张卡片，三处同一个值；**70%–400%**（只放大输入框里的正文） |
| 快捷键 | 设置里点一下方框、直接按你想用的键；每个键一行状态（`✓ 可用` / `! 容易误触` / `✕ 冲突`，会指名道姓说是跟系统还是跟 ComfyUI 撞了） |
| 设置页 | 照 X-WIDE 插件的一贯样子：品牌区（logo / 版本 / 作者 / 协议 / 免责声明）+「作者与链接」+ 卡片分区，**整页居中** |
| 关于 / 信息页 | 画布右键 →「提示词插件」→「关于」，同样的品牌信息 + 用法说明 |

### 认正反的判据

**看接收节点自己怎么规定**：① 这个框自己的名字写着正反 → 用它；② 顺线找到接收节点，
看线落在它哪个**入口**上（`positive` / `negative`）；③ 节点自己就带正反入口。
三条都认不出来时：正向按正向填入（面板会如实说明），**反向不猜**。

目标回落有十档，**每一档都先过一道角色闸门**：角色认得出来、却跟你要的不是同一边，就直接跳过 ——
所以"点哪个框就写哪个框"永远优先，也不会写到你没看的地方。认不出来时宁可拒绝写入，
也不会瞎塞。

### 安装

- **ComfyUI Manager** → 搜 `X-WIDE Prompt Input Helper`；
- 或手动把仓库复制到 `ComfyUI/custom_nodes/comfyui-xwide-prompt-helper/` 后重启 ComfyUI。

### 兼容性

- ComfyUI 前端 ≥ 1.3（实测 1.53.6 + ComfyUI 0.38.2）；
- 纯前端插件，**不需要任何 Python 依赖**，不注册节点、不包装 `ComfyWidgets`；
- 单键快捷键在别人的输入框里一律让路（提示词里的 p / n 照常能打），
  想在任何地方都能按就在设置里换成 `Ctrl+Alt+P` 这类组合。

### 许可

GPL-3.0，全文见仓库里的 [LICENSE](https://github.com/XWIDE/comfyui-xwide-prompt-helper/blob/main/LICENSE)。

---

## English

**X-WIDE Prompt Input Helper** — a **pass-through** positive / negative prompt overlay for
ComfyUI: press one key, a large input box opens, hit Enter, and the text lands straight in the
text widget you were already editing.

**It adds no nodes and modifies no existing node** — your workflow stays untouched, and
uninstalling is just deleting the plugin folder.

### What is in this version

| | |
| --- | --- |
| Overlay | `P` for positive, `N` for negative; Enter applies and closes, `Shift+Enter` adds a line, `Esc` closes |
| Where it writes | the top bar always shows the target node/field, and the line under it states **the evidence** |
| Clear | empties the panel **and the target box on the canvas** |
| Copy anywhere | `Ctrl+C` in the page lands in the panel; text copied outside the browser is **taken in when you switch back** (the *auto-paste* switch, on by default) |
| Text size | `A-` / `A+` in the header, `Ctrl + wheel` in the panel, or the settings card — one value, **70%–400%** (the prompt text only) |
| Shortcuts | click a box and press the keys you want; each key gets a status line (`✓ available` / `! easy to trigger` / `✕ conflict`, naming the exact clash) |
| Settings page | the usual X-WIDE look: brand block (logo / version / author / licence / disclaimer) + *Author & links* + cards, centred |

### How positive/negative is decided

By **what the receiving node itself declares**: ① the box's own name; ② follow the wire and see
which **input** it lands on (`positive` / `negative`); ③ the node's own inputs. If all three fail,
positive fills as positive (and says so) while **negative refuses to guess**.

Target resolution has ten steps and **every step passes a role gate** — a box whose role is
recognisable but is the wrong side is skipped, so "click the box you want" always wins, and
nothing is ever written somewhere you were not looking.

### Install

- **ComfyUI Manager** → search `X-WIDE Prompt Input Helper`;
- or copy this repository into `ComfyUI/custom_nodes/comfyui-xwide-prompt-helper/` and restart ComfyUI.

### Compatibility

- ComfyUI frontend ≥ 1.3 (tested on 1.53.6 + ComfyUI 0.38.2);
- pure frontend: **no Python dependencies**, no registered nodes, no `ComfyWidgets` wrapping;
- single-key shortcuts always yield inside other text inputs (so you can still type `p` / `n`
  in a prompt) — switch to a chord such as `Ctrl+Alt+P` in settings if you want it everywhere.

### Licence

GPL-3.0 — the full text is in the repository's
[LICENSE](https://github.com/XWIDE/comfyui-xwide-prompt-helper/blob/main/LICENSE).
