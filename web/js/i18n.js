/*!
 * X-WIDE Prompt Input Helper —— 双语文案 / bilingual strings
 *
 * 这里刻意不依赖 ComfyUI 的 i18n 运行时，原因有两个：
 *   1. 本插件的界面是挂在 document.body 上的浮层，不属于任何 Vue 组件树，
 *      拿不到 $t()；
 *   2. 老前端（canvas 版 LiteGraph）根本没有 i18n 运行时，
 *      直接读 navigator.language 反而在两种前端上表现一致。
 *
 * 想改文案只需要改这个文件。
 */
(function (global) {
  "use strict";

  var I18N = {
    "zh-CN": {
      _label: "简体中文",

      titlePositive: "正向提示词",
      titleNegative: "反向提示词",
      titleSettings: "提示词插件 · 快捷键设置",
      titleAbout: "关于 提示词插件",

      close: "关闭",
      closeHint: "关闭（Esc）",
      closePlain: "关闭",
      applyHint: "应用并关闭（回车）",
      dragHint: "按住这里可以拖动窗口",
      resizeHint: "拖动可缩放",

      apply: "应用并关闭",
      applyOnly: "应用",
      clear: "清空",
      clearHint: "清空面板，并把写入目标那个框也一起清空（这个框我不要了）",
      clearedPanelOnly: "面板已清空；这次没找到写入目标，所以画布上的框没动。",
      copy: "复制",
      copyToOther: "送去对面",
      copyToNeg: "→ 负向",
      copyToPos: "→ 正向",
      paste: "粘贴",
      pasteHint: "从剪贴板读进来（浏览器不给读时就按 Ctrl + V）",
      undo: "撤销",
      library: "词库",
      settings: "设置",
      saved: "已保存",
      save: "保存",
      cancel: "取消",
      reset: "恢复默认",
      remove: "删除",

      target: "写入目标",
      targetNone: "还没定这个写哪儿 —— 在下面点一下",
      targetNoneShort: "无目标",
      targetHint: "目标是怎么定下来的：顺着这个提示词框连出去的那条线，看它落到对面节点的哪个入口 —— 落到 positive 就是正向，落到 negative 就是反向。目标条上写的就是这个判据。",
      targetAutoHint: "这个目标是我顺着连线自己认出来的（这个框连到对面节点的这个入口）。认错了的话，在下面点一下你要写的那个框就行。",
      targetDontWrite: "— 不写入，只编辑 —",
      targetDeclined: "你选了「不写入」，所以这次没有写到画布上。想写的话，在下面的列表里点一个框。",
      targetPick: "可选目标",
      targetManual: "手动指定…",
      targetField: "字段",

      rolePositive: "正向",
      roleNegative: "反向",
      // 「凭什么这么认」——判定依据摊开给用户看（这一轮返工的教训：判定失败表现成了写错地方）
      viaWidget: "依据：这个框自己的名字写明了正反",
      viaLink: "依据：线落在接收节点的这个入口上",
      viaOwnPort: "依据：这个节点自己带着这个入口",
      viaAssumedPositive: "这个框的正反认不出来，按正向处理",
      pickOne: "这张图里还没定过写哪个框 —— 点一下要写的那个：",
      pickMulti: "这张图里有好几处提示词框（比如分了两次采样）—— 点一下你要写的那一个，选完就记住：",
      pickConnectsTo: "连到 {where}",
      pickEmpty: "（空）",
      pickNoBox: "这张图里没找到能写的大文本框。提示词框必须是多行文本框才认得出来。",

      counter: "{chars} 字符 · {lines} 行 · 约 {tokens} tokens",
      counterMixed: "{chars} 字符 · {lines} 行 · 约 {approx} tokens（实际 {actual}）",
      counterTipApprox: "约数：按字符数粗估。CLIP 的 77 token 上限请以实际编码为准。",
      counterTipActual: "实际 {actual} tokens（ComfyUI 自己那套 CLIP tokenizer 数的）。",
      counterEmpty: "空",

      appliedTo: "已写入 {node} · {field}",
      appliedPlain: "已写入",
      nothingToApply: "内容是空的，没有写入。",
      noTarget: "没有找到可写入的文本节点，请先在画布上点一下目标文本框。",
      targetGone: "目标节点已经不在图里了，请重新选一个。",
      writeFailed: "写入失败，详见浏览器控制台（F12）。",
      writeVerified: "写入成功",
      writeUnverified: "写入后校验不一致，可能被其他插件拦截",

      copied: "已复制到剪贴板",
      copyFailed: "复制失败，请手动选择文本复制",
      pasted: "已粘贴",
      pasteDenied: "浏览器不许脚本读剪贴板 —— 请按 Ctrl + V：面板开着时在页面里按，内容会自动进面板",
      pasteEmpty: "剪贴板里没有文字",
      autoPasted: "已自动收下 {count} 个字符",
      autoPasteHint: "在页面里选中文字按 Ctrl + C，内容会自动进面板",
      // 「自动粘贴」开关（面板页脚的勾选框 = 设置里那一项）
      autoPaste: "自动粘贴",
      autoPasteOn: "自动粘贴：开 —— 在别处复制，切回这个页面时自己收进来",
      autoPasteOff: "自动粘贴：关",
      autoPasteDenied: "浏览器这次没让自动读剪贴板 —— 在页面里按 Ctrl + V 一样能收进来。",
      autoPasteUnsupported: "这个浏览器（Firefox）不许脚本自动读剪贴板 —— 在页面里按 Ctrl + V 就行，效果一样。",
      swapped: "已送去对面",
      cleared: "已清空",
      undone: "已撤销",
      librarySaved: "已存入词库：{name}",
      libraryRemoved: "已从词库删除",
      libraryEmpty: "词库还是空的。先写好内容，再点“存为词条”。",
      saveAsPreset: "存为词条…",
      presetName: "给这个提示词起个名字",
      presetDefaultName: "新词条",
      overwrite: "同名词条已存在，是否覆盖？",

      settingIntro: "直接填一个按键即可，例如单独一个 P、N，也可以填 Ctrl+Alt+P 这样的组合键。",
      settingPositive: "打开「正向提示词」的按键",
      settingNegative: "打开「反向提示词」的按键",
      settingPress: "请按组合键…",
      settingReset: "恢复默认（P / N）",
      settingSaved: "快捷键已保存，立即生效。",
      settingInvalid: "这个按键填不了，试试单个字母（P、N）或 Ctrl+Alt+P 这样的组合。",
      settingRestored: "已恢复默认快捷键。",
      clickToChange: "点击修改",
      notSet: "未设置",
      plainKeyNeedsBlur: "先点一下画布空白处再按 {key}（免得抢走文本框里的输入）",
      settingCategory: "X-WIDE 提示词输入插件",
      settingGroupShortcuts: "快捷键",
      // —— 设置面板里那一页（用户要的排版：品牌区打头 + 卡片分区）
      settingGroupPage: "面板设置",
      settingGroupInfo: "插件信息",
      settingPageInfo: "插件信息",
      settingPageInfoShort: "插件名 / 版本 / 作者 / 链接 / 用法，还有下面那几张卡片。",
      // —— 自动粘贴（和面板页脚那个勾选框是同一个开关）
      // 注意：设置行上的 tooltip **只留一行**。以前这里是一整段长文，真机上会变成
      // 一个挂在那儿不消失的大气泡（用户 1.0.4 的截图）；完整说明在信息页的「用法」里。
      settingAutoPaste: "自动粘贴：在别处复制，切回页面时自动收进面板",
      settingAutoPasteShort: "在别处复制，切回页面时自动收进面板；面板页脚也有同一个开关。",
      settingGroupAutoPaste: "自动粘贴",
      // —— 文字大小（只放大输入框里的正文；面板标题栏的 A- / A+ 与 Ctrl+滚轮也是改这个）
      settingFont: "文字大小",
      settingFontShort: "只调输入框里正文的大小；面板本身不变大。也可以 Ctrl + 滚轮实时调。",
      settingGroupFont: "文字大小",
      fontSmaller: "缩小文字",
      fontBigger: "放大文字",
      fontReset: "恢复默认大小",
      fontScaleToast: "文字大小 {percent}%",
      fontNotice: "只影响输入框里的正文。除了这里，还能在面板里用 Ctrl + 滚轮实时调，或用标题栏的 A- / A+（最小 70%，最大 400%）。",
      // —— 快捷键检查（点一下方框，按下组合键，下面立刻说有没有冲突）
      settingGroupShortcutCheck: "快捷键",
      // 设置行的名字要短：真机截图里那一行长到换行，左边栏全被它占了。
      settingShortcutCheck: "快捷键",
      settingShortcutCheckShort: "点一下方框，再按下你想用的键；下面会说这个组合能不能用。",
      settingShortcutCheckNote:
        "点一下某个方框，然后直接按下你想用的组合键即可。\n" +
        "下面每个键各有一行状态：✓ 可用 / ! 容易误触 / ✕ 冲突。\n" +
        "按 Delete 或 Backspace 可以把这个键关掉（关掉后那个面板就只能用菜单打开）。",
      shortcutCapture: "点这里改",
      shortcutPressKey: "按下组合键…",
      shortcutOk: "✓ 这个组合可用，未发现冲突。",
      shortcutOff: "这个键关着 —— 按一下方框再设一个，或按下面的按钮恢复默认。",
      shortcutSame: "✕ 和上面那个键一样：两个键会互相抢，改掉一个。",
      shortcutNoModifier: "! 没有 Ctrl / Alt / Shift：在节点搜索框里打字时会误触发。想在任何地方都能按，建议加一个修饰键。",
      shortcutComfy: "✕ 和 ComfyUI 自带的快捷键冲突：{what}",
      shortcutSystem: "✕ 系统 / 浏览器保留：{what}",
      shortcutRisky: "! 容易误触：{what}",
      shortcutLive: "! ComfyUI 自带里 {combo} 也有主了（「{what}」）—— 插件会先接到这个键，画布上不会误触发；想彻底避开就换一个组合。",
      shortcutApply: "用这个键",
      shortcutHintHead: "当前：",
      shortcutReset: "恢复默认按键",
      shortcutCleared: "已关掉这个键（面板还能从右键菜单打开）。",

      // —— 信息页（关于）：品牌 + 作者与链接 + 用法 + 快捷键
      aboutVersionLabel: "版本",
      aboutAuthorLabel: "作者",
      aboutLinksLabel: "作者与链接",
      aboutUsageTitle: "用法",
      aboutKeysTitle: "快捷键",
      aboutKeysNote: "在 ComfyUI 设置面板（左下角齿轮）→ X-WIDE 提示词输入插件 里可以随时改，也可以关掉。",
      aboutLicenseName: "GPL-3.0",
      aboutLicenseTip: "以 GPL-3.0 授权发布，完整许可文本见仓库里的 LICENSE 文件",
      aboutSub: "穿透式正 / 反提示词浮窗 · 不新增节点，不改任何现有流程",
      aboutDisclaimer:
        "免责声明：本插件按原样提供，不对使用后果作任何担保。" +
        "它不新增节点、不修改任何现有节点，工作流零改动；卸载只要删掉插件目录。",
      aboutLogoAlt: "X-WIDE",
      linkRepo: "GitHub 仓库",
      linkAuthorHome: "X-WIDE 主页",
      linkBilibili: "B 站",
      linkRegistry: "ComfyUI Registry",

      aboutTitle: "X-WIDE 提示词输入插件",
      aboutBody:
        "· 按 P 打开正向提示词框、按 N 打开反向；也可以点一下画布上那个提示词框，或选中节点之后再按。\n" +
        "· 写完按回车 = 应用并关闭；面板里 Shift+回车 = 换行；Esc = 关闭。\n" +
        "· 面板上「写入目标」那一行显示的是这条提示词会写到哪个节点上。\n" +
        "· 「清空」＝ 面板清空 + 写入目标那个框也一起清空（这个框我不要了）。\n" +
        "· 面板开着时，你在页面里选一段字按 Ctrl+C，它就自己收进面板；在别处复制的，" +
        "切回页面时也会自己收进来（要按 Ctrl+V 也行）。这一条可以用面板页脚的「自动粘贴」勾选框关掉。\n" +
        "· 面板内部的复制用 Ctrl+C 也行：内容不会自己喂给自己。\n" +
        "· 它不新增节点、也不改任何现有节点，工作流零改动。",

      menuGroup: "提示词插件",
      menuPositive: "打开正向提示词框",
      menuNegative: "打开反向提示词框",
      menuSettings: "快捷键设置…",
      menuAbout: "关于",

      savedOn: "（有草稿）",
      draftRestored: "已恢复上次未应用的草稿",
    },

    "en-US": {
      _label: "English",

      titlePositive: "Positive Prompt",
      titleNegative: "Negative Prompt",
      titleSettings: "Prompt Helper · Shortcuts",
      titleAbout: "About Prompt Helper",

      close: "Close",
      closeHint: "Close (Esc)",
      closePlain: "Close",
      applyHint: "Apply and close (Enter)",
      dragHint: "Drag here to move the window",
      resizeHint: "Drag to resize",

      apply: "Apply and close",
      applyOnly: "Apply",
      clear: "Clear",
      clearHint: "Clear the panel and the target box on the canvas as well (this box is no longer wanted)",
      clearedPanelOnly: "Panel cleared; no target was found this time, so nothing on the canvas changed.",
      copy: "Copy",
      copyToOther: "Send to the other",
      copyToNeg: "→ Negative",
      copyToPos: "→ Positive",
      paste: "Paste",
      pasteHint: "Read from the clipboard (press Ctrl + V if the browser refuses)",
      undo: "Undo",
      library: "Library",
      settings: "Settings",
      saved: "Saved",
      save: "Save",
      cancel: "Cancel",
      reset: "Reset to default",
      remove: "Delete",

      target: "Target",
      targetNone: "Not set yet — pick one below",
      targetNoneShort: "no target",
      targetHint:
        "How the target is decided: follow the wire leaving this prompt box and see which input port it lands on at the node across it — a “positive” port means positive, “negative” means negative. That is exactly what the target bar shows.",
      targetAutoHint:
        "I recognised this target from the wire itself (this box connects to that input port on the node across it). If it is wrong, just click the box you want in the list below.",
      targetDontWrite: "— don't write, just edit —",
      targetDeclined: "You picked “don't write”, so nothing was written to the canvas. To write, click a box in the list below.",
      targetPick: "Target",
      targetManual: "Pick manually…",
      targetField: "field",

      rolePositive: "positive",
      roleNegative: "negative",
      viaWidget: "Evidence: this box's own name says positive/negative",
      viaLink: "Evidence: the wire lands on this input of the receiving node",
      viaOwnPort: "Evidence: this node declares that input itself",
      viaAssumedPositive: "This box's role cannot be told; treated as positive",
      pickOne: "This workflow has no box set for this yet — click the one you want to write into:",
      pickMulti:
        "This workflow has several prompt boxes (e.g. two sampling stages) — click the one you want; it is remembered after that:",
      pickConnectsTo: "connects to {where}",
      pickEmpty: "(empty)",
      pickNoBox: "No writable multi-line text box found in this workflow. Only multi-line boxes are recognised as prompt boxes.",

      counter: "{chars} chars · {lines} lines · ~{tokens} tokens",
      counterMixed: "{chars} chars · {lines} lines · ~{approx} tokens (actually {actual})",
      counterTipApprox:
        "Approximate — derived from character count. For CLIP's 77-token limit, trust the real encoding.",
      counterTipActual: "Actually {actual} tokens, counted with ComfyUI's own CLIP tokenizer.",
      counterEmpty: "empty",

      appliedTo: "Written to {node} · {field}",
      appliedPlain: "Written",
      nothingToApply: "Nothing to apply — the box is empty.",
      noTarget: "No writable text node found. Click the target text box on the canvas first.",
      targetGone: "The target node is no longer in the graph. Pick another one.",
      writeFailed: "Write failed — see the browser console (F12).",
      writeVerified: "Write verified",
      writeUnverified: "Value did not verify after writing; another extension may be intercepting it.",

      copied: "Copied to clipboard",
      copyFailed: "Copy failed — please select and copy manually",
      pasted: "Pasted",
      pasteDenied:
        "The browser blocked clipboard reads — press Ctrl + V instead: with a panel open, it lands in the panel",
      pasteEmpty: "No text on the clipboard",
      autoPasted: "Took in {count} characters automatically",
      autoPasteHint: "Select text in the page and press Ctrl + C — it lands in the panel automatically",
      autoPaste: "auto-paste",
      autoPasteOn: "Auto-paste: on — copy elsewhere, and it is taken in when you come back to this page",
      autoPasteOff: "Auto-paste: off",
      autoPasteDenied: "The browser did not allow reading the clipboard this time — pressing Ctrl + V in the page works just as well.",
      autoPasteUnsupported: "This browser (Firefox) forbids scripts from reading the clipboard — press Ctrl + V in the page instead; same result.",
      swapped: "Sent to the other box",
      cleared: "Cleared",
      undone: "Undone",
      librarySaved: "Saved to library: {name}",
      libraryRemoved: "Removed from library",
      libraryEmpty: "The library is empty. Type something, then click “Save as entry”.",
      saveAsPreset: "Save as entry…",
      presetName: "Name this prompt",
      presetDefaultName: "New entry",
      overwrite: "An entry with that name exists. Overwrite it?",

      settingIntro: "Just type a single key — P, N — or a combination like Ctrl+Alt+P.",
      settingPositive: "Key that opens “Positive Prompt”",
      settingNegative: "Key that opens “Negative Prompt”",
      settingPress: "Press keys…",
      settingReset: "Reset to defaults (P / N)",
      settingSaved: "Shortcuts saved and applied.",
      settingInvalid: "That key cannot be used — try a single letter (P, N) or a combination such as Ctrl+Alt+P.",
      settingRestored: "Default shortcuts restored.",
      clickToChange: "click to change",
      notSet: "not set",
      plainKeyNeedsBlur: "Click an empty spot on the canvas first, then press {key} (so typing in text boxes is not stolen)",
      settingCategory: "X-WIDE Prompt Input Helper",
      settingGroupShortcuts: "Shortcuts",
      // —— the page inside the settings panel (brand block first, then cards)
      settingGroupPage: "Panel settings",
      settingGroupInfo: "plugin info",
      settingPageInfo: "Plugin info",
      settingPageInfoShort: "Name, version, author, links and usage — plus the cards below.",
      settingAutoPaste: "Auto-paste: copy elsewhere, and it is taken in when you return to the page",
      settingAutoPasteShort: "Copy elsewhere and it is taken in when you switch back; the panel footer has the same switch.",
      settingGroupAutoPaste: "auto-paste",
      // —— text size (only the prompt text inside the box; A- / A+ and Ctrl+wheel change it)
      settingFont: "Text size",
      settingFontShort: "Sizes the prompt text inside the box only; the panel itself does not grow. Ctrl + wheel works too.",
      settingGroupFont: "text size",
      fontSmaller: "Smaller text",
      fontBigger: "Larger text",
      fontReset: "Restore the default size",
      fontScaleToast: "Text size {percent}%",
      fontNotice: "Affects the prompt text inside the box only. Besides this row you can use Ctrl + wheel inside the panel, or the A- / A+ buttons in its header (70% to 400%).",
      settingGroupShortcutCheck: "shortcuts",
      settingShortcutCheck: "Shortcuts",
      settingShortcutCheckShort: "Click a box, then press the keys you want; the line below says whether it is safe.",
      settingShortcutCheckNote:
        "Click one of the boxes and press the combination you want.\n" +
        "Each key gets its own status line: ✓ available / ! easy to trigger by accident / ✕ conflict.\n" +
        "Press Delete or Backspace to switch a key off (with it off, that panel only opens from the menu).",
      shortcutCapture: "click to change",
      shortcutPressKey: "press keys…",
      shortcutOk: "✓ This combination is available; no conflict found.",
      shortcutOff: "This key is off — click the box and set one, or use the button below to restore the defaults.",
      shortcutSame: "✕ Same as the key above: the two will fight over the key press; change one.",
      shortcutNoModifier: "! No Ctrl / Alt / Shift: it will fire by accident while you type in the node search box. Add a modifier if you want it to work anywhere.",
      shortcutComfy: "✕ Conflicts with a built-in ComfyUI shortcut: {what}",
      shortcutSystem: "✕ Reserved by the system / browser: {what}",
      shortcutRisky: "! Easy to trigger by accident: {what}",
      shortcutLive: "! ComfyUI already binds {combo} to “{what}” — the plugin takes the key first, so nothing else fires on the canvas; pick another combo to stay clear.",
      shortcutApply: "Use this key",
      shortcutHintHead: "Current: ",
      shortcutReset: "Restore the default keys",
      shortcutCleared: "This key is now off (the panel still opens from the right-click menu).",
      aboutVersionLabel: "Version",
      aboutAuthorLabel: "Author",
      aboutLinksLabel: "Author & links",
      aboutUsageTitle: "How to use it",
      aboutKeysTitle: "Shortcuts",
      aboutKeysNote: "Change or switch them off any time in ComfyUI's settings panel (bottom-left gear) → X-WIDE Prompt Input Helper.",
      aboutLicenseName: "GPL-3.0",
      aboutLicenseTip: "Released under GPL-3.0; the full license text is the LICENSE file in the repository",
      aboutSub: "A pass-through positive / negative prompt overlay · no new nodes, no changes to any workflow",
      aboutDisclaimer:
        "Disclaimer: this plugin is provided as is, without warranty of any kind. " +
        "It adds no nodes and modifies no existing node — your workflow stays untouched; " +
        "uninstalling is just deleting the plugin folder.",
      aboutLogoAlt: "X-WIDE",
      linkRepo: "GitHub repository",
      linkAuthorHome: "X-WIDE on GitHub",
      linkBilibili: "Bilibili",
      linkRegistry: "ComfyUI Registry",

      aboutTitle: "X-WIDE Prompt Input Helper",
      aboutBody:
        "· Press P for the positive prompt box, N for the negative one — or click the prompt box on the " +
        "canvas first, or select the node, then press the key.\n" +
        "· Enter applies and closes; Shift+Enter inserts a new line inside the panel; Esc closes.\n" +
        "· The “writing to” line in the panel shows which node the text will be written to.\n" +
        "· “Clear” empties the panel and the target box on the canvas (that box is no longer wanted).\n" +
        "· With a panel open, select text anywhere in the page and press Ctrl+C — it lands in the panel; " +
        "text copied elsewhere is taken in when you switch back to the page (Ctrl+V works too). " +
        "The “auto-paste” checkbox in the panel footer switches this off.\n" +
        "· Copying inside the panel with Ctrl+C is fine too: the text is not fed back into itself.\n" +
        "· It adds no nodes and changes no existing node — your workflow stays untouched.",

      menuGroup: "Prompt Helper",
      menuPositive: "Open positive prompt box",
      menuNegative: "Open negative prompt box",
      menuSettings: "Shortcut settings…",
      menuAbout: "About",

      savedOn: "（draft kept）",
      draftRestored: "Restored the draft you had not applied yet",
    },
  };

  /** 把 {name} 占位符替换掉；缺参数就留着原样，方便定位漏翻的串。 */
  function format(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
    });
  }

  var LOCALES = Object.keys(I18N);

  /**
   * 语言判定顺序：
   *   1. 用户手动指定（localStorage）；
   *   2. navigator.languages / navigator.language 里第一个能匹配上的；
   *   3. navigator.language 以 "zh" 开头 -> zh-CN；
   *   4. 兜底 en-US。
   * 刻意只支持这两个语种：多语种维护成本高，而这两个覆盖了本插件的全部用户。
   */
  function detectLocale(override) {
    if (override && I18N[override]) return override;

    var tags = [];
    try {
      if (globalThis.navigator) {
        if (Array.isArray(globalThis.navigator.languages)) tags = tags.concat(globalThis.navigator.languages);
        if (globalThis.navigator.language) tags.push(globalThis.navigator.language);
      }
    } catch (err) {
      /* navigator 在某些沙箱里会抛异常，忽略即可 */
    }

    for (var i = 0; i < tags.length; i++) {
      var tag = String(tags[i] || "").toLowerCase();
      if (!tag) continue;
      if (tag === "zh-cn" || tag === "zh-sg" || tag === "zh-hans" || tag.indexOf("zh-hans") === 0) return "zh-CN";
      if (tag === "zh-tw" || tag === "zh-hk" || tag === "zh-mo" || tag === "zh-hant" || tag.indexOf("zh-hant") === 0) return "zh-CN";
      if (tag.indexOf("zh") === 0) return "zh-CN";
      if (tag.indexOf("en") === 0) return "en-US";
    }

    return "en-US";
  }

  /**
   * 建立 t() 函数。找不到的 key 会回落到英文，再找不到就把 key 原样返回，
   * 这样界面上不会出现空白按钮。
   */
  function createTranslator(locale) {
    var resolved = detectLocale(locale);
    var dict = I18N[resolved] || I18N["en-US"];
    var fallback = I18N["en-US"];

    function t(key, params) {
      var template;
      if (Object.prototype.hasOwnProperty.call(dict, key)) template = dict[key];
      else if (Object.prototype.hasOwnProperty.call(fallback, key)) template = fallback[key];
      else template = key;
      return format(template, params);
    }

    t.locale = resolved;
    t.available = LOCALES.slice();
    return t;
  }

  var api = {
    I18N: I18N,
    LOCALES: LOCALES,
    detectLocale: detectLocale,
    createTranslator: createTranslator,
    format: format,
  };

  // 两个出口都写上，别写成 if/else：
  // 在前端它是普通 <script>（global 路径），在测试里是 ES module 导入（global 路径同样要生效），
  // 而 CommonJS 的 module 对象在 ESM 下根本不存在，if/else 会让 global 那半边被跳过。
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.XWidePromptI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
