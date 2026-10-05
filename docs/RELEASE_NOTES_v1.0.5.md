# v1.0.5 — X-WIDE 提示词输入插件 / X-WIDE Prompt Input Helper

> 这份文件是 GitHub Release 的现成文案：在
> <https://github.com/XWIDE/comfyui-xwide-prompt-input-helper/releases/new> 里选好标签 `v1.0.5`，
> 把下面横线以内的内容整段粘进正文即可。

---

## 中文

**这个版本只做一件事：让插件彻底不依赖任何外部图片地址，从而通过 Comfy Registry 的安全审查。**

### 为什么必须修

1.0.4 在 `web/js/prompt_helper.js` 里用一个外部图片站地址给 logo 兜底。Comfy Registry 的安全审查
把它判为 `contains_blacklisted_url`（confidence 90，命中 `web/js/prompt_helper.js:33`），
于是 **1.0.4 在 Registry 上的状态是 `Flagged`**。

后果不只是"显示个警告"：ComfyUI-Manager 查询版本时只取 `Active` / `Pending`
（`glob/cnr_utils.py`：`statuses=NodeVersionStatusActive&statuses=NodeVersionStatusPending`），
所以 Flagged 的版本在 Manager 的「安装新扩展」里**根本搜不到**，手动装也会被安全策略拦下。
1.0.5 就是把这个触发项去掉的版本。

### 改了什么

| | |
| --- | --- |
| logo 兜底 | 改为插件自己的静态目录 `extensions/<插件目录名>/…`，外部地址**全部删除**（不是拼字符串绕开，是真的没有） |
| 插件目录名 | 不再写死 `comfyui-xwide-prompt-helper`。运行时从模块 URL 反推当前目录名 —— 你把目录改成 `comfyui-xwide-prompt-input-helper`（= Registry 包名）后，logo 不会再全部 404 |
| README | 顶部 logo 改成仓库相对路径（GitHub 页面上照常显示） |
| 防回归 | 测试新增断言：前端资源文件里不允许出现任何外部资源地址 |

### 安装

- **ComfyUI Manager** → 搜 `X-WIDE Prompt Input Helper`；
- 或手动把仓库复制到 `ComfyUI/custom_nodes/comfyui-xwide-prompt-input-helper/` 后重启 ComfyUI。

功能与 1.0.4 完全一致（输入浮窗、快捷键、写回判定、设置页都没有变化）。

### 许可

GPL-3.0，全文见仓库里的 [LICENSE](https://github.com/XWIDE/comfyui-xwide-prompt-input-helper/blob/main/LICENSE)。

---

## English

**This release does one thing: the plugin no longer references any external image host, so it passes
the Comfy Registry security review.**

### Why it had to be fixed

1.0.4 used an external image host as the logo fallback in `web/js/prompt_helper.js`. The Registry
scan flagged it as `contains_blacklisted_url` (confidence 90, hit at
`web/js/prompt_helper.js:33`), which left **1.0.4 in the `Flagged` state**.

That is not just a warning: ComfyUI-Manager only asks for `Active` / `Pending` versions
(`glob/cnr_utils.py`: `statuses=NodeVersionStatusActive&statuses=NodeVersionStatusPending`), so a
flagged version **cannot be found in Manager's "Install Custom Nodes"** at all, and a manual install
is refused by the security policy. 1.0.5 removes the trigger.

### What changed

| | |
| --- | --- |
| Logo fallback | now the plugin's own static route `extensions/<folder name>/…`; the external address is **gone** (not obfuscated — removed) |
| Plugin folder name | no longer hard-coded; it is derived from the module URL at runtime, so renaming the folder to `comfyui-xwide-prompt-input-helper` (the Registry package name) no longer 404s the logo |
| README | top logo switched to a repository-relative path (still renders on GitHub) |
| Regression test | new assertion: shipped frontend assets may not contain any external asset URL |

### Install

- **ComfyUI Manager** → search `X-WIDE Prompt Input Helper`;
- or copy this repository into `ComfyUI/custom_nodes/comfyui-xwide-prompt-input-helper/` and restart ComfyUI.

Behaviour is identical to 1.0.4 (overlay, shortcuts, target resolution and settings are unchanged).

### Licence

GPL-3.0 — the full text is in the repository's
[LICENSE](https://github.com/XWIDE/comfyui-xwide-prompt-input-helper/blob/main/LICENSE).
