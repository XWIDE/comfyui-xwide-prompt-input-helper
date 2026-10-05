# v1.0.6 — X-WIDE 提示词输入插件 / X-WIDE Prompt Input Helper

> 发 GitHub Release 时把这个文件的内容当正文（也可以先在
> <https://github.com/XWIDE/comfyui-xwide-prompt-input-helper/releases/new> 里选好标签 `v1.0.6`，
> 再把下面整段贴进去）。

## 中文

**修的是一个「界面突然没穿衣服」的问题。**

1.0.5 装好之后，设置页会变成这样：logo 撑满一整列、卡片没有边框和底色、整页也不居中了。
原因不在排版，而在**样式表根本没加载**：

- `web/js/prompt_panel.js` 找自己的 CSS 时用的是 `document.currentScript.src`，
  可这个文件是被 `import` 进来的 —— 在 ES module 里 `document.currentScript` **恒为 null**
  （规范如此），于是每次都落到写死的兜底地址
  `/extensions/comfyui-xwide-prompt-helper/css/prompt_panel.css`。
- 1.0.4 之前目录名正好就是这个，所以一直没露馅；1.0.5 把目录改名成
  `comfyui-xwide-prompt-input-helper` 之后，这条地址 **404**，整个面板的样式就都没了。

现在样式表地址**从模块自己的 `import.meta.url` 反推**（本文件永远是 `<路由>/js/prompt_panel.js`
→ 同级 `css/prompt_panel.css`），跟 1.0.5 里 logo 的做法一致：目录名怎么改都跟着走。
`currentScript` 只留作非常规加载方式的退路，写死的旧目录名退到最后。

顺手把同一个坑钉进了测试：注入的 `<link id="xwph-style">` 地址必须等于**按模块自身位置算出来**的
`web/css/prompt_panel.css`，谁再写成死路径，测试立刻红灯。

真机（无头 Edge + CDP）复核结果：样式表地址是
`/extensions/comfyui-xwide-prompt-input-helper/css/prompt_panel.css`、`fetch` 200、表里 118 条规则；
卡片底色 `#1b1f26`、圆角 10px，logo 宽 180px、白底圆角，设置页那一行的原生标签列被隐藏、
内容居中。

## English

**This fixes an "unstyled UI" bug introduced by 1.0.5.**

After installing 1.0.5 the settings page rendered without any styling: an oversized logo, cards with no
border or background, and no centering. The cause was not layout — **the stylesheet never loaded**:

- `web/js/prompt_panel.js` located its own CSS via `document.currentScript.src`, but the file is loaded
  through `import` — and inside an ES module `document.currentScript` is **always null** (per spec).
  So it always fell back to the hard-coded
  `/extensions/comfyui-xwide-prompt-helper/css/prompt_panel.css`.
- That happened to be correct until 1.0.5, when the install directory was renamed to
  `comfyui-xwide-prompt-input-helper`, making the URL a **404** and dropping the whole stylesheet.

The stylesheet URL is now derived from the module's own `import.meta.url` (the file is always
`<route>/js/prompt_panel.js`, so the CSS sits next to it), matching how 1.0.5 resolves the logo:
rename the folder and everything still follows. A regression test now asserts that the injected
`<link id="xwph-style">` points at the CSS computed from the module's own location.

Verified on a real install (headless Edge + CDP): the link resolves to
`/extensions/comfyui-xwide-prompt-input-helper/css/prompt_panel.css`, `fetch` returns 200, the sheet
contains 118 rules, cards get `#1b1f26` with a 10px radius, the logo is 180px wide on a white rounded
card, and the settings row is centered.
