/*!
 * X-WIDE Prompt Input Helper —— ComfyUI 扩展入口 / extension entry
 *
 * 职责边界（这个文件刻意保持很薄）：
 *   - 把三个模块按顺序加载进来（i18n -> bridge -> panel）；
 *   - 向 ComfyUI 登记一个扩展（为了拿到 registerExtension 的官方通道）；
 *   - **自己完成初始化**，不等前端的 init/setup 生命周期；
 *   - 把设置项注册进 ComfyUI 原生的设置面板（左下角齿轮）；
 *   - 提供画布右键菜单和节点右键菜单两个入口。
 *
 * 它**不做**的事：不注册节点、不包装 ComfyWidgets、不改任何节点原型、
 * 不注册侧边栏。所以它对现有工作流是零侵入的。
 */
import "./i18n.js";
import "./bridge.js";
import "./prompt_panel.js";

(function () {
  "use strict";

  var PKG = "comfyui-xwide-prompt-helper";
  var I18N = globalThis.XWidePromptI18n;
  var Panel = globalThis.XWidePromptPanel;
  var PLUGIN_VERSION = "1.0.4";

  // 作者信息 / 链接：跟 X-WIDE 其它插件保持一致（logo 也是同一张横版图）。
  // 用户拍板（1.0.4）：信息页上的「作者与链接」**只留两个** —— GitHub 仓库与 B 站，
  // 跟 X-WIDE_plugin_model_manager 的信息页一致，不放商店入口。
  var AUTHOR = "X-WIDE";
  var LOGO_FILE = "logo_xwide.png";
  var LOGO_ICON_FILE = "logo_xwide_icon.png";
  var REPO_URL = "https://github.com/XWIDE/comfyui-xwide-prompt-input-helper";
  var LOGO_FALLBACK = "https://raw.githubusercontent.com/XWIDE/comfyui-xwide-prompt-input-helper/main/web/" + LOGO_FILE;
  var LOGO_ICON_FALLBACK =
    "https://raw.githubusercontent.com/XWIDE/comfyui-xwide-prompt-input-helper/main/web/" + LOGO_ICON_FILE;
  var LICENSE_URL = REPO_URL + "/blob/main/LICENSE";
  var LINKS = [
    { key: "linkRepo", url: REPO_URL },
    { key: "linkBilibili", url: "https://space.bilibili.com/374064919" },
  ];

  if (!I18N || !Panel) {
    console.error("[" + PKG + "] i18n / panel 模块没有加载成功，插件无法启动。");
    return;
  }

  if (globalThis.__xwidePromptHelperBooted) {
    // HMR 时脚本可能被重复执行；重复注册同名扩展会让前端抛错。
    console.warn("[" + PKG + "] 已经加载过了，跳过重复初始化。");
    return;
  }

  // ---------------------------------------------------------------- app 从哪来
  //
  // 这一段是踩过坑才写对的，改动前请先看完。
  //
  // 事实（都是从前端 bundle 上实读出来的）：
  //   1. 扩展模块是在前端 `app.setup()` **内部**被 import 的
  //      （loadExtensions() 里 `await import(K.fileURL(e))`）；
  //   2. `window.app = Z` 这一行写在 `await Z.setup(...)` **之后**
  //      （GraphView-Cx5xBruY.js 里就是 `await Z.setup(a.value), ..., window.app=Z`）；
  //   3. 所以模块被求值的那一刻 `globalThis.app` 是 undefined；
  //   4. 真机上实测到：`registerExtension` 明明成功了（重试时报
  //      "Extension named '...' already registered."），但前端的
  //      invokeExtensionsAsync('init'/'setup') 始终没有调用到我们 ——
  //      两个生命周期都被跳过了。
  //
  // 由 (4) 得到本项目最重要的一条设计决定：
  //
  //     **插件自己初始化，绝不依赖前端的 init/setup 生命周期。**
  //
  // registerExtension 只用来走官方登记通道（让扩展出现在扩展列表里、
  // 拿到官方 API 对象），功能本身在 boot() 里就地完成。
  // boot() 是幂等的，谁先到（拦截器还是轮询）都只会真正跑一次。

  /** 拿 app 实例：优先传进来的，其次全局的。 */
  function resolveApp(passed) {
    if (passed && typeof passed.registerExtension === "function") return passed;
    var g = globalThis.app;
    if (g && typeof g.registerExtension === "function") return g;
    return null;
  }

  // ---------------------------------------------------------------- 小工具

  var SETTINGS_NS = "XWidePromptHelper";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeButton(className, label) {
    var b = el("button", "xwph-btn " + (className || ""), label);
    b.type = "button";
    return b;
  }

  /**
   * logo 的地址。
   *
   * 刻意**不用** `new URL("./logo_xwide.png", import.meta.url)`：
   * 这个文件在浏览器里确实是 ES module（import.meta 可用），但测试是在 Node 里
   * `import()` 它的 —— 仓库里没有 "type": "module"，.js 会被当成 CommonJS 解析，
   * `import.meta` 在那儿是**语法错误**，整个测试文件都会跑不起来。
   * 所以改成按"扩展路由"拼：ComfyUI 把 web/ 挂在 /extensions/<插件目录名>/ 上。
   */
  function logoUrl() {
    // 真实浏览器里 baseURI 一定有；`document.URL` 是给测试桩兜底的
    // （桩里没实现 location，只挂了 URL）。
    var base = document.baseURI || (document.location && document.location.href) || document.URL || "";
    try {
      return new URL("extensions/" + PKG + "/" + LOGO_FILE, base).href;
    } catch (err) {
      return LOGO_FALLBACK;
    }
  }

  /**
   * 信息页上的小徽章（版本号 / 协议）。
   *
   * 抄的是 X-WIDE_plugin_model_manager 的写法：`badge(text, kind)` →
   * `<span class="…-badge …-badge-info">`，颜色分 info / plain / good / warn / bad 几档。
   */
  function badge(text, kind) {
    return el("span", "xwph-badge xwph-badge-" + (kind || "plain"), text);
  }

  /** 信息页里的卡片（一个组标题 + 可选内容）。 */
  function card(title, content) {
    var box = el("div", "xwph-card");
    if (title) box.appendChild(el("div", "xwph-card-title", title));
    if (content) box.appendChild(content);
    return box;
  }

  /**
   * 品牌区：logo（白底卡片）+ 标题 + 粉字副标题 + 版本 / 作者 / 协议徽章 + 免责声明。
   *
   * 设置面板那一页和「关于」弹窗共用这一块 —— 用户给的参考图就长这样，
   * 两处各写一份迟早会长歪。
   */
  function buildBrandBlock(t) {
    var brand = el("div", "xwph-about-brand");
    brand.appendChild(makeLogo("xwph-about-logo"));
    brand.appendChild(el("div", "xwph-about-title", t("aboutTitle")));
    brand.appendChild(el("div", "xwph-about-sub", t("aboutSub")));

    var meta = el("div", "xwph-about-meta");
    meta.appendChild(badge(t("aboutVersionLabel") + " v" + PLUGIN_VERSION, "info"));
    meta.appendChild(badge(t("aboutAuthorLabel") + " " + AUTHOR, "plain"));
    var licenseLink = el("a", "xwph-about-lic", "⚖ " + t("aboutLicenseName"));
    licenseLink.href = LICENSE_URL;
    licenseLink.target = "_blank";
    licenseLink.rel = "noreferrer noopener";
    licenseLink.title = t("aboutLicenseTip");
    meta.appendChild(licenseLink);
    brand.appendChild(meta);

    brand.appendChild(el("div", "xwph-about-disc", t("aboutDisclaimer")));
    return brand;
  }

  /** 「作者与链接」卡片：只留 GitHub 仓库与 B 站两个入口（用户拍板）。 */
  function buildLinksCard(t) {
    var linksCard = card(t("aboutLinksLabel"));
    var row = el("div", "xwph-about-row");
    LINKS.forEach(function (item) {
      row.appendChild(linkButton(t(item.key), item.url));
    });
    linksCard.appendChild(row);
    return linksCard;
  }

  /** 「用法」卡片：原来挂在设置行 tooltip 上的长文，现在住这儿。 */
  function buildUsageCard(t) {
    var usageCard = card(t("aboutUsageTitle"));
    usageCard.appendChild(el("div", "xwph-about-text", t("aboutBody")));
    return usageCard;
  }

  /**
   * 设置面板里 X-WIDE 那一页的"门面"：品牌区 + 作者与链接 + 用法。
   *
   * 用户 1.0.4 用红箭头指着设置面板左边的「X-WIDE 提示词插件」说
   * 「这个页面排版还没改」（参考图 = X-WIDE_plugin_model_manager：品牌区打头 + 卡片分区）。
   * ComfyUI 的设置页排版是它自己画的（左标签 / 右控件），我们能动手的正是右边那一列。
   */
  function buildInfoBlock() {
    var t = I18N.createTranslator(localeOf());
    var root = el("div", "xwph-page");
    root.appendChild(buildBrandBlock(t));
    root.appendChild(buildLinksCard(t));
    root.appendChild(buildUsageCard(t));
    return root;
  }

  /** 信息页里的外链按钮（GitHub / B 站这种）。 */
  function linkButton(label, url) {
    var a = el("a", "xwph-linkbtn", label);
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    return a;
  }

  function makeLogo(className, fallbackUrl) {
    var img = el("img", className);
    img.alt = I18N.createTranslator(localeOf())("aboutLogoAlt");
    img.src = logoUrl();
    // 万一把插件目录改了名（路由就变了），退回仓库里的原图；
    // 横版那张也取不到就退方形图标，别留一个碎图标。
    var firstFallback = fallbackUrl || LOGO_FALLBACK;
    if (typeof img.addEventListener === "function") {
      img.addEventListener("error", function () {
        if (img.src !== firstFallback) {
          img.src = firstFallback;
          return;
        }
        if (firstFallback !== LOGO_ICON_FALLBACK && img.src !== LOGO_ICON_FALLBACK) {
          img.src = LOGO_ICON_FALLBACK;
          return;
        }
        if (img.parentNode) img.parentNode.removeChild(img);
      });
    }
    return img;
  }

  // ---------------------------------------------------------------- 设置项
  //
  // 用户的选择：「放到本有的设置里，就是左下角那个」——
  // 也就是 ComfyUI 自带的设置面板，不再做我们自己的设置弹窗。
  //
  // addSetting 只能从**扩展 API 对象**上拿（前端把 `{settings, keybindings,
  // commands, ...}` 作为 registerExtension 的第二个参数/传给 setup 的对象）。
  // 实测 `app.extensionManager.setting` 上只有 {settings, get, set}，
  // 没有 addSetting，所以别去那儿找。
  //
  // 注册晚了也没关系：addSetting 是往响应式的 settingsById 里写的，
  // 设置面板按 id 分组渲染，晚注册的项照样会出现。

  /** 缓存最后一次拿到的扩展 API（tests 与调试都要用）。 */
  var extensionApi = null;

  /** 设置项是否已经登记过（两条注册路径只允许生效一次）。 */
  var settingsRegistered = false;

  /** 当前语言：面板管理器建好前也要能翻设置项文案。 */
  function localeOf() {
    return panelManager ? panelManager.locale : null;
  }

  /**
   * 从各种可能的位置把扩展 API 抠出来。
   *
   * 前端在不同版本里给法不一样：有时是 registerExtension 的第二个参数，
   * 有时挂在 setup 的第二个形参上，有时能从 app 上摸到。全都要试。
   */
  function resolveApi(candidate, app) {
    if (candidate && candidate.settings && typeof candidate.settings.addSetting === "function") {
      return candidate;
    }
    var fromSetup = extensionApi;
    if (fromSetup) return fromSetup;
    try {
      var em = app && app.extensionManager;
      // 有些版本会把 API 直接挂在 extensionManager 上。
      if (em && em.extensionApi && em.extensionApi.settings) return em.extensionApi;
    } catch (err) {
      /* 拿不到就算了，设置项是可选的 */
    }
    return null;
  }

  /**
   * 设置项：**只有两行**（用户 1.0.4 的排版要求）。
   *
   * 有两条路可以进原生设置面板，这里把设置项本身抽出来给两条路共用：
   *   1. 扩展对象上的 `settings` 数组 —— registerExtension 那一刻就被登记，
   *      这是**主力**（真机实测 registerExtension 会读 `n.settings?.forEach`）；
   *   2. `api.settings.addSetting` —— 前端把 API 递过来（或 setup 第二个参数）时。
   *
   * ⚠️ 两条设置的 category **绝不能完全一样**（真机踩过的坑）：
   * 前端 settingStore 建树用的是 `buildTree(list, e => e.category || e.id.split("."))`，
   * 而 buildTree 内部是 `a.leaf = e[e.length-1] !== ""; a.data = i;` ——
   * **数组最后一段所在节点被标成 leaf 并挂上 data**。两条设置喂同一个 category 数组时，
   * 第二条会把第一条的 leaf/data 覆盖掉，原生设置面板里就只剩一条。
   * 所以每条都在末尾给一段自己的分类名，落在**自己的** leaf 上。
   *
   * 这里曾经有五条：两行文字快捷键设置 + 自动粘贴 + 快捷键编辑器 + 关于。
   * 用户 1.0.4 发的真机截图点破了问题 —— 两行文字设置和编辑器说的是同一件事、
   * 却常常显示得不一样（编辑器里是 P，下面那行还写着 Ctrl+S），"关于"那一行更是
   * 渲染成一个装着版本号的可编辑文本框。
   *
   * 然后是排版：用户又发截图、用红箭头指着设置面板左边那个「X-WIDE 提示词插件」条目说
   * 「这个页面排版还没改」，参考图是 X-WIDE_plugin_model_manager 那个页面 ——
   * 品牌区（logo 白底卡片 + 标题 + 粉字副标题 + 版本/协议徽章 + 免责声明）、
   * 「作者与链接」，下面全是**卡片**。所以这一页现在长成那样：
   * 每行左边是 ComfyUI 自己的短标签（搜索还能搜到），右边是我们画的卡片。
   */
  function createShortcutSettings() {
    var t = I18N.createTranslator(localeOf());
    // ⚠️ 声明顺序与**显示顺序相反**：前端 flattenTree 是 `n.pop()` 逐个弹出来的
    // （`for(;n.length;){let e=n.pop(); …}`），所以数组里最后一条会排在最上面。
    // 真机验过：按 [info, shortcutCheck, autopaste, fontScale] 声明时，页面上从上到下
    // 依次是 文字大小 / 自动粘贴 / 快捷键 / 插件信息 —— 正好倒过来。
    // 想让它显示成「插件信息（品牌区）→ 快捷键 → 自动粘贴 → 文字大小」，
    // 这里就得**倒着写**。
    return [
      {
        // 文字大小（用户 1.0.4：「打开的对话框里文字太小，加入大小调节」）。
        // 面板标题栏的 A- / A+ 与 Ctrl+滚轮改的都是同一个值（manager 的 fontScale）。
        id: "XWidePromptHelper.fontScale",
        category: [t("settingCategory"), t("settingGroupPage"), t("settingGroupFont")],
        name: t("settingFont"),
        tooltip: t("settingFontShort"),
        type: function () {
          return card(t("settingFont"), buildFontEditor());
        },
      },
      {
        // 自动粘贴的开关。用户要的是"面板里勾一下、设置里也能勾一下"，
        // 两边的唯一真相都是插件自己的存储（XWidePromptHelper.autopaste）。
        // 这里也做成一张卡片（而不是原生 boolean）—— 因为这一页每行都要居中，
        // 原生的开关行左边挂着标签列，藏了标签就只剩一个孤零零的开关。
        id: "XWidePromptHelper.autopaste",
        category: [t("settingCategory"), t("settingGroupPage"), t("settingGroupAutoPaste")],
        name: t("settingAutoPaste"),
        tooltip: t("settingAutoPasteShort"),
        type: function () {
          return card(t("settingAutoPaste"), buildAutoPasteEditor());
        },
      },
      {
        // 函数型 type：设置面板会直接把我们返回的 DOM 挂进这一行里
        // （X-WIDE 其它插件也是这么干的），所以能放按键框、状态行和按钮。
        id: "XWidePromptHelper.shortcutCheck",
        category: [t("settingCategory"), t("settingGroupPage"), t("settingGroupShortcutCheck")],
        name: t("settingShortcutCheck"),
        // tooltip 只留一句话：长提示会挂在那儿不消失（用户截图里的现象），
        // 完整说明写在「用法」卡片里。
        tooltip: t("settingShortcutCheckShort"),
        type: function () {
          return card(t("settingShortcutCheck"), buildShortcutEditor());
        },
      },
      {
        // 品牌区 + 作者与链接 + 用法：整页的"门面"，照参考图排（声明在最后 = 显示在最上）。
        id: "XWidePromptHelper.info",
        category: [t("settingCategory"), t("settingGroupPage"), t("settingGroupInfo")],
        name: t("settingPageInfo"),
        tooltip: t("settingPageInfoShort"),
        type: function () {
          return buildInfoBlock();
        },
      },
    ];
  }

  /**
   * 「自动粘贴」：**插件的存储才是唯一真相**（面板上的勾选框也写它）。
   * 注册设置的时候把原生那一行的值对齐过来，别让两处显示得不一样。
   */
  function syncAutoPasteSetting() {
    var settings = settingStore();
    if (!panelManager || !settings) return;
    try {
      var wanted =
        typeof panelManager.getAutoPaste === "function" ? !!panelManager.getAutoPaste() : true;
      var current = settings.get("XWidePromptHelper.autopaste");
      // `undefined` 也算"没对齐"：这时候它还没被写过，而 false 和 undefined 都是假值，
      // 只比 `!!current !== wanted` 会把"关掉"这一下吞掉（真机上设置行就永远停在旧值）。
      if (current === undefined || !!current !== wanted) {
        settings.set("XWidePromptHelper.autopaste", wanted);
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------ 快捷键冲突检查
  //
  // 用户要的：「快捷键也可以自己定义，并提示有没有冲突的快捷键」。
  // 判据分两层：
  //   1. 手写的静态表 —— 系统/浏览器保留键，以及 ComfyUI 那些"一定会抢"的组合。
  //      这层只能手写：没有任何 JS 注册表看得到操作系统的保留键。
  //   2. 实时表 —— `app.extensionManager.command.commands` 里每个命令的 keybinding，
  //      涵盖核心默认 + 别的扩展注册的 + 用户自己在原生设置里改过的。
  //      （前端 1.53.6 没有 `app.extensionManager.keybinding`，只有 command.commands。）
  //
  // "有没有冲突"这件事必须**每个键各占一行**：一个键可用不代表另一个也可用。

  var MODIFIER_ONLY = { control: 1, alt: 1, shift: 1, meta: 1, altgraph: 1, capslock: 1, os: 1 };

  var KEY_ALIASES = {
    " ": "space",
    spacebar: "space",
    escape: "esc",
    arrowleft: "left",
    arrowright: "right",
    arrowup: "up",
    arrowdown: "down",
    return: "enter",
  };

  function normalizeKeyName(key) {
    var name = String(key === undefined || key === null ? "" : key).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, name)) return KEY_ALIASES[name];
    // "KeyP" / "Digit1" 这种 code 也认，省得调用方先翻译一遍。
    var m = /^key([a-z])$/.exec(name);
    if (m) return m[1];
    m = /^digit([0-9])$/.exec(name);
    if (m) return m[1];
    return name;
  }

  /** kind: system（系统/浏览器保留）| comfy（ComfyUI 自带）| risky（容易误触） */
  var KEY_CONFLICTS = {
    "alt+space": { kind: "system", why: "打开窗口菜单 / opens the window menu" },
    "alt+f4": { kind: "system", why: "关闭窗口 / closes the window" },
    "alt+tab": { kind: "system", why: "切换窗口 / switches windows" },
    "alt+left": { kind: "system", why: "浏览器后退 / browser back" },
    "alt+right": { kind: "system", why: "浏览器前进 / browser forward" },
    "ctrl+w": { kind: "system", why: "关闭标签页 / closes the tab" },
    "ctrl+shift+w": { kind: "system", why: "关闭整个窗口 / closes the window" },
    "ctrl+t": { kind: "system", why: "新标签页 / new tab" },
    "ctrl+shift+t": { kind: "system", why: "恢复刚关掉的标签页 / reopens the closed tab" },
    "ctrl+n": { kind: "system", why: "新窗口 / new window" },
    "ctrl+shift+n": { kind: "system", why: "无痕窗口 / new private window" },
    "ctrl+l": { kind: "system", why: "跳到地址栏 / focuses the address bar" },
    "ctrl+d": { kind: "system", why: "收藏这个页面 / bookmarks the page" },
    "ctrl+j": { kind: "system", why: "打开下载 / opens downloads" },
    "ctrl+h": { kind: "system", why: "打开历史 / opens history" },
    "ctrl+p": { kind: "system", why: "打印页面 / prints the page" },
    "ctrl+r": { kind: "system", why: "刷新页面 / reloads the page" },
    "f5": { kind: "system", why: "刷新页面 / reloads the page" },
    "f11": { kind: "system", why: "全屏 / fullscreen" },
    "f12": { kind: "system", why: "开发者工具 / dev tools" },
    "ctrl+shift+i": { kind: "system", why: "开发者工具 / dev tools" },
    "ctrl+shift+j": { kind: "system", why: "开发者工具控制台 / dev tools console" },
    "ctrl+shift+c": { kind: "system", why: "检查元素 / inspect element" },
    "ctrl+shift+delete": { kind: "system", why: "清除浏览数据 / clears browsing data" },
    "ctrl+=": { kind: "system", why: "浏览器放大 / browser zoom in" },
    "ctrl+-": { kind: "system", why: "浏览器缩小 / browser zoom out" },

    "ctrl+enter": { kind: "comfy", why: "排队执行 / queues the prompt" },
    "ctrl+shift+enter": { kind: "comfy", why: "排队到最前面 / queues to the front" },
    "ctrl+s": { kind: "comfy", why: "保存工作流 / saves the workflow" },
    "ctrl+o": { kind: "comfy", why: "打开工作流 / opens a workflow" },
    "ctrl+a": { kind: "comfy", why: "全选节点 / selects all nodes" },
    "ctrl+z": { kind: "comfy", why: "撤销 / undo" },
    "ctrl+y": { kind: "comfy", why: "重做 / redo" },
    "ctrl+shift+z": { kind: "comfy", why: "重做 / redo" },
    "ctrl+c": { kind: "comfy", why: "复制节点 / copies nodes" },
    "ctrl+v": { kind: "comfy", why: "粘贴节点 / pastes nodes" },
    "ctrl+x": { kind: "comfy", why: "剪切节点 / cuts nodes" },
    "ctrl+m": { kind: "comfy", why: "静音节点 / mutes nodes" },
    "ctrl+b": { kind: "comfy", why: "绕过节点 / bypasses nodes" },
    "ctrl+g": { kind: "comfy", why: "把选中的节点成组 / groups the selected nodes" },
    "ctrl+0": { kind: "comfy", why: "画布缩放到适应 / zooms the canvas to fit" },

    "delete": { kind: "risky", why: "删除选中的节点 / deletes the selected node" },
    "backspace": { kind: "risky", why: "也是删除，还会在输入框里退格 / deletes too, and backspaces in inputs" },
    "space": { kind: "risky", why: "在画布上是平移抓手 / pans the canvas" },
    "enter": { kind: "risky", why: "到处都在用它确认 / confirms almost everywhere" },
    "esc": { kind: "risky", why: "到处都在用它取消 / cancels almost everywhere" },
    "tab": { kind: "risky", why: "切换焦点 / moves the focus" },
  };

  function comboFromShortcut(s) {
    if (!s || !s.key) return "";
    if (MODIFIER_ONLY[normalizeKeyName(s.key)]) return "";
    var parts = [];
    if (s.ctrl) parts.push("ctrl");
    if (s.alt) parts.push("alt");
    if (s.shift) parts.push("shift");
    if (s.meta) parts.push("meta");
    parts.push(normalizeKeyName(s.key));
    return parts.join("+");
  }

  function comboFromEvent(e) {
    if (!e) return "";
    var parts = [];
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    if (e.metaKey) parts.push("meta");
    parts.push(normalizeKeyName(e.key));
    return parts.join("+");
  }

  /** "Alt + X" / "X:false:true:false" 两种串都吃，统一成 "alt+x"。 */
  function comboFromKeybinding(kb) {
    if (!kb) return "";
    var combo = kb.combo || kb;
    try {
      if (typeof combo.toString === "function") {
        var text = String(combo);
        if (text && text.indexOf(":") === -1 && text !== "[object Object]") {
          return comboFromTokens(text.split("+"));
        }
      }
    } catch (err) {
      /* 落到下面按字段读 */
    }
    if (typeof combo.key === "string" && combo.key) {
      return comboFromShortcut({
        key: combo.key,
        ctrl: !!(combo.ctrl || combo.control),
        alt: !!combo.alt,
        shift: !!combo.shift,
        meta: !!(combo.meta || combo.cmd),
      });
    }
    return "";
  }

  function comboFromTokens(tokens) {
    var mods = { ctrl: false, alt: false, shift: false, meta: false };
    var key = "";
    for (var i = 0; i < tokens.length; i++) {
      var name = normalizeKeyName(tokens[i]);
      if (!name) continue;
      if (name === "ctrl" || name === "control" || name === "cmdorctrl") mods.ctrl = true;
      else if (name === "alt" || name === "option") mods.alt = true;
      else if (name === "shift") mods.shift = true;
      else if (name === "meta" || name === "cmd" || name === "command" || name === "win") mods.meta = true;
      else key = name;
    }
    if (!key) return "";
    return comboFromShortcut({
      key: key,
      ctrl: mods.ctrl,
      alt: mods.alt,
      shift: mods.shift,
      meta: mods.meta,
    });
  }

  /** 给用户看的写法："ctrl+alt+p" -> "Ctrl + Alt + P"。 */
  function comboDisplay(combo) {
    if (!combo) return "";
    return combo
      .split("+")
      .map(function (part) {
        if (part === "ctrl") return "Ctrl";
        if (part === "alt") return "Alt";
        if (part === "shift") return "Shift";
        if (part === "meta") return "Win";
        if (part === "esc") return "Esc";
        return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" + ");
  }

  function commandTitleOf(cmd) {
    if (!cmd) return "";
    var title = cmd.title;
    try {
      if (typeof title === "function") title = title();
    } catch (err) {
      title = null;
    }
    if (title && typeof title === "object" && title.value) title = title.value;
    return String(title || cmd.label || cmd.id || "");
  }

  /**
   * 实时表：ComfyUI 此刻真正生效的快捷键 -> 命令。
   * 读不到就回空表（静态表仍然有效），绝不抛错。
   */
  function liveKeybindingIndex(app) {
    var index = {};
    try {
      var manager = app && app.extensionManager;
      var commands = manager && manager.command && manager.command.commands;
      if (!commands) return index;
      var list = Array.isArray(commands)
        ? commands
        : Object.keys(commands).map(function (k) {
            return commands[k];
          });
      for (var i = 0; i < list.length; i++) {
        var cmd = list[i];
        var kb = null;
        try {
          kb = cmd && cmd.keybinding;
        } catch (err) {
          kb = null;
        }
        var combo = comboFromKeybinding(kb);
        if (!combo || index[combo]) continue;
        index[combo] = {
          id: cmd.id,
          title: commandTitleOf(cmd),
          // 元素级绑定（只在画布/侧边栏上生效的那些）冲突没那么硬 —— 见 shortcutStatus。
          scoped: !!(kb && kb.targetElementId),
        };
      }
    } catch (err) {
      /* 拿不到实时表就算了 */
    }
    return index;
  }

  function shortcutStatus(kind, shortcuts, liveIndex, t) {
    var current = shortcuts[kind];
    if (!current || !current.key) return { level: "warn", text: t("shortcutOff") };

    var combo = comboFromShortcut(current);
    var other = kind === "positive" ? "negative" : "positive";
    if (combo && combo === comboFromShortcut(shortcuts[other])) {
      return { level: "bad", text: t("shortcutSame") };
    }

    var fixed = KEY_CONFLICTS[combo];
    if (fixed) {
      var what = fixed.why;
      if (fixed.kind === "system") return { level: "bad", text: t("shortcutSystem", { what: what }) };
      if (fixed.kind === "comfy") return { level: "bad", text: t("shortcutComfy", { what: what }) };
      return { level: "warn", text: t("shortcutRisky", { what: what }) };
    }

    var live = liveIndex && liveIndex[combo];
    if (live) {
      // ComfyUI 自己也有这个键（真机实测：P = 画布上的"钉住选中节点"、N = 切换节点库侧栏）。
      // 这**不算冲突**，所以只能报"提醒"（!）：插件的监听在 document 捕获相、命中就吃掉事件，
      // 真机验过按 P / N 只出浮窗 —— 节点没被钉住、侧栏也没动。
      // （早先按 `targetElementId` 判"元素级 = 软冲突"，但真机上 N 那条根本没有这个字段，
      //   于是默认键被报成 ✕ 红灯 —— 那是误报，两个默认键都会红。）
      return {
        level: "warn",
        text: t("shortcutLive", { combo: comboDisplay(combo), what: live.title }),
      };
    }

    if (!current.ctrl && !current.alt && !current.meta) {
      return { level: "warn", text: t("shortcutNoModifier") };
    }
    return { level: "ok", text: t("shortcutOk") };
  }

  // -------------------------------------------------------- 快捷键编辑器（DOM）
  //
  // 这一块是"函数型 type"返回的 DOM，会被原生设置面板直接挂到那一行下面。
  // 捕获按键用**全局捕获相**监听 + preventDefault + stopPropagation：
  // 不这么做的话，按 Ctrl+S 会先把工作流存了、按 P 会先把节点钉住。

  var shortcutEditorSync = null; // 当前那棵编辑器的刷新函数（面板没开时是 null）
  var fontEditorSync = null; // 「文字大小」那一行的刷新函数（同上）
  var autoPasteEditorSync = null; // 「自动粘贴」那张卡片里勾选框的刷新函数（同上）
  var shortcutCapture = null; // 正在等按键的那一项

  function refreshShortcutEditor() {
    if (shortcutEditorSync) shortcutEditorSync();
  }

  /**
   * 读写原生设置项的那只手。
   *
   * 两条路都要试：
   *   ① 扩展 API 对象（`api.settings.get/set`）；
   *   ② `app.extensionManager.setting.get/set`。
   * 真机上 `setup(app, api)` **从来没被调用过**（插件是自己初始化的），所以 `extensionApi`
   * 一直是 null —— 只认 ① 的话，那条开关跟插件的存储就会各说各话。所以 ② 才是主力。
   */
  function settingStore() {
    var fromApi = extensionApi && extensionApi.settings;
    if (fromApi && typeof fromApi.get === "function" && typeof fromApi.set === "function") return fromApi;
    var app = resolveApp(null);
    var manager = app && app.extensionManager;
    var fromManager = manager && manager.setting;
    if (fromManager && typeof fromManager.get === "function" && typeof fromManager.set === "function") {
      return fromManager;
    }
    return null;
  }

  /**
   * 「文字大小」那一行设置里的 DOM。
   *
   * 用函数型 type（跟快捷键那一行同一套路）：原生设置面板里没有"字号"这种控件，
   * 我们自己画 A- / A+ / 恢复默认，点一下立刻见效，中间那个百分比是当前值。
   */
  function buildFontEditor() {
    var t = I18N.createTranslator(localeOf());
    var root = el("div", "xwph-font-editor");
    var row = el("div", "xwph-font-row");
    var down = makeButton("xwph-font-down", "A-");
    var valueLabel = el("span", "xwph-font-value", "");
    var up = makeButton("xwph-font-up", "A+");
    var reset = makeButton("xwph-font-reset", t("fontReset"));

    row.appendChild(down);
    row.appendChild(valueLabel);
    row.appendChild(up);
    row.appendChild(reset);
    root.appendChild(row);
    root.appendChild(el("div", "xwph-font-note", t("fontNotice")));

    function current() {
      return panelManager && typeof panelManager.fontScale === "function" ? panelManager.fontScale() : 1;
    }
    function stepFor(value) {
      if (panelManager && typeof panelManager.fontStep === "function") return panelManager.fontStep(value);
      return 0.1;
    }
    function sync() {
      valueLabel.textContent = Math.round(current() * 100) + "%";
    }
    function apply(next) {
      if (!panelManager || typeof panelManager.setFontScale !== "function") return;
      var value = panelManager.setFontScale(next);
      sync();
      if (typeof panelManager.toast === "function") {
        panelManager.toast(t("fontScaleToast", { percent: Math.round(value * 100) }), "ok");
      }
    }

    down.addEventListener("click", function () {
      apply(current() - stepFor(current()));
    });
    up.addEventListener("click", function () {
      apply(current() + stepFor(current()));
    });
    reset.addEventListener("click", function () {
      apply(1);
    });

    fontEditorSync = sync;
    sync();
    return root;
  }

  /**
   * 面板标题栏的 A- / A+ 改了字号以后，设置面板里那一行（如果开着）要跟着刷新。
   * 跟自动粘贴一样包一层 —— 两个入口改的是同一个值，显示不能各说各话。
   */
  function installFontSync(manager) {
    if (!manager || typeof manager.setFontScale !== "function") return false;
    var original = manager.setFontScale;
    manager.setFontScale = function () {
      var value = original.apply(manager, arguments);
      if (fontEditorSync) fontEditorSync();
      return value;
    };
    return true;
  }

  function setShortcutKey(kind, parsed) {
    if (!panelManager) return false;
    var next = panelManager.getShortcuts() || {};
    next[kind] = parsed;
    panelManager.setShortcuts(next);
    panelManager.toast(panelManager.t(parsed ? "settingSaved" : "shortcutCleared"), "ok");
    refreshShortcutEditor();
    return true;
  }

  /**
   * 捕捉按键时，监听器挂哪儿。
   *
   * 插件跑在页面里时 `globalThis` 就是 window，没问题；但测试是在 Node 里
   * `import()` 这个文件的 —— 那边 `globalThis.addEventListener` 是 undefined，
   * 直接调会 TypeError，整套测试都跑不起来。所以先认 window。
   */
  function captureTarget() {
    if (typeof globalThis.addEventListener === "function") return globalThis;
    var w = globalThis.window;
    if (w && typeof w.addEventListener === "function") return w;
    return null;
  }

  function stopShortcutCapture() {
    if (!shortcutCapture) return;
    var state = shortcutCapture;
    shortcutCapture = null;
    try {
      if (state.target) {
        state.target.removeEventListener("keydown", state.onKey, true);
        state.target.removeEventListener("pointerdown", state.onPointer, true);
      }
    } catch (err) {
      /* 忽略 */
    }
    refreshShortcutEditor();
  }

  function startShortcutCapture(kind) {
    stopShortcutCapture();
    if (!panelManager) return;
    var state = { kind: kind };
    state.onKey = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      if (e.key === "Escape") {
        stopShortcutCapture();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // 空 = 关掉这个键（面板还能从右键菜单打开）
        setShortcutKey(kind, null);
        stopShortcutCapture();
        return;
      }
      if (MODIFIER_ONLY[normalizeKeyName(e.key)]) return; // 只按了修饰键：继续等
      var parsed = panelManager.parseShortcut(e);
      if (!parsed) return;
      setShortcutKey(kind, parsed);
      stopShortcutCapture();
    };
    state.onPointer = function (e) {
      var target = e && e.target;
      if (target && typeof target.closest === "function" && target.closest(".xwph-keycap")) return;
      stopShortcutCapture();
    };
    shortcutCapture = state;
    state.target = captureTarget();
    if (state.target) {
      state.target.addEventListener("keydown", state.onKey, true);
      state.target.addEventListener("pointerdown", state.onPointer, true);
    }
    refreshShortcutEditor();
  }

  function buildShortcutEditor() {
    var t = I18N.createTranslator(localeOf());
    var root = el("div", "xwph-shortcut-editor");
    var caps = {};
    var statuses = {};
    var liveIndex = liveKeybindingIndex(resolveApp(null));

    ["positive", "negative"].forEach(function (kind) {
      var row = el("div", "xwph-shortcut-row");
      row.appendChild(
        el("span", "xwph-shortcut-name", kind === "positive" ? t("settingPositive") : t("settingNegative"))
      );
      var cap = el("span", "xwph-keycap", "");
      cap.setAttribute("role", "button");
      cap.setAttribute("tabindex", "0");
      // 刻意**不给 title**：说明就在下面那行 `.xwph-shortcut-note` 里常驻着，
      // 再挂一份 tooltip 只会多出一个会挂在那儿不消失的长气泡（用户 1.0.4 截图的坑）。
      var begin = function (e) {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        startShortcutCapture(kind);
      };
      cap.addEventListener("pointerdown", begin);
      cap.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") begin(e);
      });
      row.appendChild(cap);
      root.appendChild(row);

      var status = el("div", "xwph-shortcut-status");
      root.appendChild(status);
      caps[kind] = cap;
      statuses[kind] = status;
    });

    var actions = el("div", "xwph-shortcut-actions");
    var resetBtn = makeButton("", t("shortcutReset"));
    resetBtn.addEventListener("click", function () {
      if (!panelManager) return;
      panelManager.setShortcuts(panelManager.defaultShortcuts());
      panelManager.toast(panelManager.t("settingSaved"), "ok");
      refreshShortcutEditor();
    });
    actions.appendChild(resetBtn);
    root.appendChild(actions);
    root.appendChild(el("div", "xwph-shortcut-note", t("settingShortcutCheckNote")));

    function sync() {
      var shortcuts = (panelManager && panelManager.getShortcuts()) || {};
      ["positive", "negative"].forEach(function (kind) {
        var waiting = shortcutCapture && shortcutCapture.kind === kind;
        var cap = caps[kind];
        cap.textContent = waiting
          ? t("shortcutPressKey")
          : panelManager
          ? panelManager.describeShortcut(shortcuts[kind])
          : "";
        cap.className = "xwph-keycap" + (waiting ? " xwph-keycap-capturing" : "");
        var status = shortcutStatus(kind, shortcuts, liveIndex, t);
        var line = statuses[kind];
        line.textContent = status.text;
        line.className =
          "xwph-shortcut-status " +
          (status.level === "bad" ? "xwph-bad" : status.level === "warn" ? "xwph-warn" : "xwph-ok");
      });
    }

    shortcutEditorSync = sync;
    sync();
    return root;
  }

  /**
   * 把两个快捷键注册进原生设置面板。
   *
   * 用 type: "text"：值就是 "P" / "Ctrl+Alt+P" 这种字符串，谁都会填。
   * onChange 里立刻 setShortcuts，不用重启也不用刷新。
   */
  function installSettings(manager, api) {
    if (!manager) return false;
    if (!extensionApi && api) extensionApi = api;

    // 设置项已经通过 PANEL_EXTENSION.settings 登记过了：这里只需要把管理器接上。
    if (settingsRegistered) {
      panelManager = manager;
      syncAutoPasteSetting();
      return true;
    }
    if (!api || !api.settings || typeof api.settings.addSetting !== "function") {
      return false;
    }

    try {
      var items = createShortcutSettings();
      for (var i = 0; i < items.length; i++) api.settings.addSetting(items[i]);
      panelManager = manager;
      settingsRegistered = true;
      syncAutoPasteSetting();
      return true;
    } catch (err) {
      console.warn("[" + PKG + "] 注册设置项失败（快捷键仍可用，只是不能改）：", err);
      return false;
    }
  }

  /**
   * 「自动粘贴」那张卡片里的一行：勾选框 + 一句说明。
   *
   * 跟面板页脚那个勾选框是同一个值（manager 的 getAutoPaste / setAutoPaste）。
   */
  function buildAutoPasteEditor() {
    var t = I18N.createTranslator(localeOf());
    var wrap = el("div", "xwph-check-line");
    var label = el("label", "xwph-check");
    var box = el("input", "xwph-check-box");
    box.type = "checkbox";
    box.checked =
      panelManager && typeof panelManager.getAutoPaste === "function" ? !!panelManager.getAutoPaste() : true;
    box.addEventListener("change", function () {
      if (panelManager && typeof panelManager.setAutoPaste === "function") {
        panelManager.setAutoPaste(!!box.checked);
      }
      if (panelManager && typeof panelManager.toast === "function") {
        panelManager.toast(panelManager.t(box.checked ? "autoPasteOn" : "autoPasteOff"), "ok");
      }
    });
    label.appendChild(box);
    label.appendChild(el("span", "xwph-check-text", t("settingAutoPaste")));
    wrap.appendChild(label);
    wrap.appendChild(el("div", "xwph-font-note", t("settingAutoPasteShort")));

    autoPasteEditorSync = function () {
      var on =
        panelManager && typeof panelManager.getAutoPaste === "function" ? !!panelManager.getAutoPaste() : true;
      box.checked = on;
    };
    return wrap;
  }

  /**
   * 面板页脚那个勾选框和设置面板里那一行是**同一个开关**，改的入口有两个：
   * 设置卡片里会回调我们，面板页脚只调 `manager.setAutoPaste`。
   * 这里把面板管理器那一个方法包一层：谁改都顺手把两边同步过去，
   * 免得显示得不一样（真机踩过"改完那行还写着旧值"的同类坑）。
   */
  function installAutoPasteSync(manager) {
    if (!manager || typeof manager.setAutoPaste !== "function") return false;
    var original = manager.setAutoPaste;
    manager.setAutoPaste = function () {
      var result = original.apply(manager, arguments);
      syncAutoPasteSetting();
      if (autoPasteEditorSync) autoPasteEditorSync();
      return result;
    };
    return true;
  }

  /**
   * 兼容保留：老写法是"扩展对象上挂一个 settings 数组"，现在这份数据由
   * createShortcutSettings() 统一生产，不再需要管理器实例。
   */
  function buildSettingsConfig() {
    return createShortcutSettings();
  }

  // ---------------------------------------------------------------- 信息页（关于）
  //
  // 用户 1.0.4 的要求：插件信息**不要**塞在 ComfyUI 设置面板里（那里要留干净），
  // 做成一个自己的信息页，样子照 X-WIDE_plugin_model_manager 的信息页来：
  //   logo（白底卡片）＋ 标题 ＋ 副标题 ＋ 版本徽章 ＋ 协议徽章 ＋ 免责声明，
  //   然后「作者与链接」（**只留 GitHub 仓库与 B 站两个**）、用法、快捷键三张卡片。
  // 入口不变：画布右键 →「提示词插件」→「关于」。

  function createAboutDialog(panelManager) {
    var t = panelManager.t;
    var backdrop = el("div", "xwph-settings-backdrop");
    var box = el("div", "xwph-settings xwph-about");

    // ① 品牌区（和设置面板那一页共用同一块）
    box.appendChild(buildBrandBlock(t));

    // ② 作者与链接：只要两个入口（用户拍板，跟参考插件一致）
    box.appendChild(buildLinksCard(t));

    // ③ 用法：原来挂在设置行 tooltip 上的那几段长文，现在住在这儿
    box.appendChild(buildUsageCard(t));

    // ④ 快捷键（当前值 + 去哪儿改）
    var keysCard = card(t("aboutKeysTitle"));
    var shortcuts = panelManager.getShortcuts();
    [
      [t("settingPositive"), panelManager.describeShortcut(shortcuts.positive)],
      [t("settingNegative"), panelManager.describeShortcut(shortcuts.negative)],
    ].forEach(function (pair) {
      var row = el("div", "xwph-setting-row");
      row.appendChild(el("span", "xwph-setting-label", pair[0]));
      row.appendChild(el("span", "xwph-keycap", pair[1]));
      keysCard.appendChild(row);
    });
    keysCard.appendChild(el("div", "xwph-about-text", t("aboutKeysNote")));
    box.appendChild(keysCard);

    var footer = el("div", "xwph-settings-footer");
    footer.appendChild(el("span", "xwph-spacer"));
    var closeBtn = makeButton("xwph-btn-primary", t("close"));
    footer.appendChild(closeBtn);
    box.appendChild(footer);

    backdrop.appendChild(box);

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
      }
      e.stopPropagation();
    }

    function show() {
      (document.body || document.documentElement).appendChild(backdrop);
      document.addEventListener("keydown", onKeydown, true);
      closeBtn.focus();
    }

    function hide() {
      document.removeEventListener("keydown", onKeydown, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }

    closeBtn.addEventListener("click", hide);
    backdrop.addEventListener("pointerdown", function (e) {
      if (e.target === backdrop) hide();
      e.stopPropagation();
    }, true);

    return { show: show, hide: hide };
  }

  // ---------------------------------------------------------------- 注册

  /** 初始化完成后面板管理器挂在这里。 */
  var panelManager = null;

  /** 拿到的 app 实例，存一份备用（不依赖 window.app）。 */
  var currentApp = null;

  /** 已经跑过 boot 了（幂等保护）。 */
  var booted = false;

  /**
   * 节点右键菜单那个扩展的登记结果。
   *
   * 声明必须放在 boot() **之前**：`var` 虽然会提升，但赋值语句在后面，
   * boot() 在启动期就同步执行，那时候读到的会是 undefined —— 这里踩过一次。
   */
  var NODE_MENU_EXTENSION = null;

  /** 面板扩展是否已经登记过（前端对同名扩展会直接抛错）。 */
  var registered = false;

  /**
   * 打开 ComfyUI 原生的设置面板。
   *
   * 命令 id 是 `Comfy.ShowSettingsDialog`（从 GraphView-Cx5xBruY.js 里读到的），
   * 走 app.extensionManager.command.execute 执行。老版本没有命令系统时，
   * 退回点那个左下角齿轮按钮。
   */
  function openNativeSettings() {
    if (!currentApp) return false;
    try {
      var cmd = currentApp.extensionManager && currentApp.extensionManager.command;
      if (cmd && typeof cmd.execute === "function") {
        cmd.execute("Comfy.ShowSettingsDialog");
        return true;
      }
    } catch (err) {
      console.warn("[" + PKG + "] 打开原生设置面板失败，试试老按钮：", err);
    }
    try {
      var legacy = document.querySelector("button.comfy-settings-btn");
      if (legacy && typeof legacy.click === "function") {
        legacy.click();
        return true;
      }
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  var PANEL_EXTENSION = {
    name: "X-WIDE.PromptHelper",

    /**
     * 设置项走**声明式**这条路。
     *
     * 前端 registerExtension 里就是 `n.settings?.forEach(c)`（c 是 addSetting），
     * 所以写在扩展对象上的这一项，在 registerExtension 那一刻就被登记了 ——
     * 比等 setup 递 API 过来早得多，也不怕前端压根不调用 setup。
     * onChange 内部对 panelManager 晚绑定，被点之前它一定已经建好了。
     */
    settings: buildSettingsConfig(),

    /**
     * 前端给 init/setup 的话就顺手跑一遍（幂等，不会重复初始化）。
     * 真机上这两个可能压根不被调用，所以**不靠它们**。
     */
    init() {
      // 有些老工作流会引用 ComfyWidgets，这里只是保证它存在，不做任何包装。
      if (!globalThis.ComfyWidgets) globalThis.ComfyWidgets = {};
    },

    async setup(passedApp, passedApi) {
      if (passedApi && passedApi.settings) extensionApi = passedApi;
      boot(resolveApp(passedApp));
    },
  };

  /**
   * 真正干活的地方：建面板管理器、装菜单、注册设置项。
   *
   * 幂等。前端的 init/setup、window.app 拦截器、轮询三条路都会调它，
   * 谁先到谁干活。
   */
  function boot(instance) {
    if (booted) return true;
    var app = resolveApp(instance);
    if (!app) return false;

    try {
      currentApp = app;

      panelManager = Panel.createPanelManager({
        app: app,
        document: document,
        namespace: SETTINGS_NS,
        locale: null, // 交给 i18n 按 navigator.language 自动判定
        onOpenSettings: function () {
          openNativeSettings();
        },
      });

      // 把扩展 API 递给面板管理器：它有 api.tokenizer 时就用真 CLIP tokenizer
      // 数 token（77 上限那个数），没有就一直用粗估。
      panelManager.init(resolveApi(null, app));

      // 面板页脚那个勾选框和设置面板里那一行是**同一个开关**，但改的入口有两个：
      // 设置行会回调我们（onChange），面板页脚只调 manager.setAutoPaste。包一层，
      // 谁改都把原生那一行同步过去，免得两处显示得不一样（真机踩过同类坑）。
      installAutoPasteSync(panelManager);
      // 字号同理：面板标题栏的 A- / A+ 与设置里的「文字大小」是同一个值。
      installFontSync(panelManager);

      var aboutDialog = createAboutDialog(panelManager);

      // 设置项在 registerExtension 那一刻就已经通过扩展对象上的 settings
      // 登记进原生面板了（见 PANEL_EXTENSION.settings）。这里把管理器接上去，
      // 顺便在"前端递了 API 过来"的版本里走 addSetting 那条备用路。
      var api = resolveApi(null, app);
      var settingsInstalled = installSettings(panelManager, api);
      if (!settingsInstalled) {
        // 兜底：等一小会儿再试一次（API 有时要等扩展注册回调走完才拿得到）。
        setTimeout(function () {
          if (!panelManager) return;
          installSettings(panelManager, resolveApi(null, currentApp));
        }, 1500);
      }

      // 暴露给控制台，方便用户/我们排查问题：
      //   XWidePromptHelper.open('positive')
      //   XWidePromptHelper.describeTarget('positive')
      globalThis.XWidePromptHelper = {
        open: function (kind) {
          return panelManager.open(kind);
        },
        closeAll: function () {
          panelManager.closeAll();
        },
        describeTarget: function (kind) {
          return panelManager.describeTarget(kind);
        },
        openSettings: openNativeSettings,
        openAbout: function () {
          aboutDialog.show();
        },
        shortcuts: function () {
          return panelManager.getShortcuts();
        },
        locale: panelManager.locale,
        version: PLUGIN_VERSION,
        // 内部句柄，给测试和深度排查用（名字带下划线表明不是公开 API）。
        __manager: panelManager,
        __nodeMenuExtension: NODE_MENU_EXTENSION,
        __app: app,
        __settingsInstalled: settingsInstalled,
        __api: api,
      };

      installCanvasMenu(panelManager, openNativeSettings, aboutDialog);
      installNodeMenu(panelManager);

      globalThis.__xwidePromptHelperBooted = true;
      booted = true;

      console.log(
        "[X-WIDE Prompt Input Helper] v" +
          PLUGIN_VERSION +
          " 已就绪：" +
          panelManager.describeShortcut(panelManager.getShortcuts().positive) +
          " 打开正向，" +
          panelManager.describeShortcut(panelManager.getShortcuts().negative) +
          " 打开反向。设置项：" +
          (settingsInstalled ? "已注册进原生设置面板" : "未注册（快捷键仍可用）")
      );
      return true;
    } catch (err) {
      console.error("[X-WIDE Prompt Input Helper] 初始化失败：", err);
      return false;
    }
  }

  // ---------------------------------------------------------------- 右键菜单

  /**
   * 画布空白处右键 -> 菜单里加「提示词插件」子菜单。
   *
   * 勾的是 LGraphCanvas.prototype.getCanvasMenuOptions。
   * 这个选择是查过前端源码才定的：ComfyUI 自己的核心扩展
   * （useContextMenuTranslation）也是包装同一个方法，并且它内部是先调
   * getMenuOptions()、没有再退回内置数组，最后统一追加自己收集的菜单项。
   * 所以我们包在外层、把菜单项 push 到返回值上，无论是新前端还是老前端都能生效。
   *
   * 子菜单用 has_submenu + callback 的写法（核心扩展就是这么写的），
   * 不自己 new LiteGraph.ContextMenu —— 那玩意的构造签名在版本间变过。
   *
   * 整个过程包在 try 里：万一某个前端版本不一样，也只是少了两个菜单项，
   * 绝不能把右键菜单本身搞坏。
   */
  function installCanvasMenu(manager, openSettings, aboutDialog) {
    try {
      var LGraphCanvas = globalThis.LiteGraph && globalThis.LiteGraph.LGraphCanvas;
      if (!LGraphCanvas || !LGraphCanvas.prototype) return;

      var proto = LGraphCanvas.prototype;
      if (proto.__xwphCanvasMenuPatched) return;

      var original = proto.getCanvasMenuOptions;
      if (typeof original !== "function") return;

      proto.getCanvasMenuOptions = function () {
        var options = original ? original.apply(this, arguments) : [];
        if (!Array.isArray(options)) options = [];

        try {
          var t = manager.t;
          options.push({ content: t("menuGroup"), has_submenu: true, callback: buildSubmenu(manager, openSettings, aboutDialog) });
        } catch (err) {
          console.warn("[X-WIDE Prompt Input Helper] 画布菜单注入失败：", err);
        }

        return options;
      };

      proto.__xwphCanvasMenuPatched = true;
    } catch (err) {
      console.warn("[X-WIDE Prompt Input Helper] 画布菜单钩子安装失败（不影响快捷键）：", err);
    }
  }

  /** has_submenu 的 callback 会被 LiteGraph 用 new ContextMenu(value, ...) 调用。 */
  function buildSubmenu(manager, openSettings, aboutDialog) {
    var t = manager.t;
    return [
      {
        content: t("menuPositive"),
        callback: function () {
          manager.open("positive");
        },
      },
      {
        content: t("menuNegative"),
        callback: function () {
          manager.open("negative");
        },
      },
      null,
      {
        content: t("menuSettings"),
        callback: function () {
          openSettings();
        },
      },
      {
        content: t("menuAbout"),
        callback: function () {
          aboutDialog.show();
        },
      },
    ];
  }

  /**
   * 节点右键 -> 「写入正向/反向提示词框」。
   *
   * 这里是本插件唯一接触节点原型的地方，但用的是官方推荐的
   * beforeRegisterNodeDef + 保存/恢复原函数的写法，并且只在
   * 节点里确实有文本控件时才往菜单里加东西。
   *
   * 关键时序：beforeRegisterNodeDef 是**注册扩展那一刻**就跑掉的，而节点类型
   * 在启动早期就全部注册完了。所以这个扩展注册得越早越好 —— install() 会在
   * 拿到 app 的那一刻立刻注册（就是 window.app 被赋值的那一次）。
   *
   * 面板管理器则要等 boot 才存在，于是这里用 nodeMenuManager 晚绑定：
   * 注册时该变量还是 null，菜单回调真正被点开时它早就被填上了。
   */
  var nodeMenuManager = null;

  /**
   * 暴露给测试的注册函数。
   *
   * beforeRegisterNodeDef 只在“注册扩展”这一次触发，测试里想验证节点菜单
   * 是没办法退回那一刻的，所以这里额外返回一个已经打好补丁的
   * nodeType 构造器，让测试能直接拿它 new 出来的实例调 getExtraMenuOptions。
   */
  function registerNodeMenuExtension(instance) {
    var target = resolveApp(instance);
    if (!target) return null;

    var patched = {
      name: "X-WIDE.PromptHelper.NodeMenu",
      async beforeRegisterNodeDef(nodeType) {
        try {
          var proto = nodeType && nodeType.prototype;
          if (!proto || proto.__xwphMenuPatched) return;

          var original = proto.getExtraMenuOptions;
          if (typeof original !== "function") return;

          proto.getExtraMenuOptions = function (canvas, options) {
            // 先跑原函数，保证别的插件/核心的菜单项不受影响。
            var result = original.apply(this, arguments);
            var node = this;

            try {
              var Bridge = globalThis.XWidePromptBridge;
              if (!Bridge || !Array.isArray(options)) return result;
              if (!nodeMenuManager) return result;

              // 节点里没有文本控件就什么都不加，避免污染无关节点的菜单。
              if (!Bridge.listTextWidgets(node).length) return result;

              var t = nodeMenuManager.t;
              options.push(null); // LiteGraph 用 null 画分隔线
              options.push({
                content: t("menuPositive"),
                callback: function () {
                  nodeMenuManager.openForNode(node, "positive");
                },
              });
              options.push({
                content: t("menuNegative"),
                callback: function () {
                  nodeMenuManager.openForNode(node, "negative");
                },
              });
            } catch (err) {
              // 菜单注入失败绝不能影响原菜单。
              console.warn("[X-WIDE Prompt Input Helper] 节点菜单注入失败：", err);
            }

            return result;
          };

          proto.__xwphMenuPatched = true;
        } catch (err) {
          console.warn("[X-WIDE Prompt Input Helper] beforeRegisterNodeDef 失败：", err);
        }
      },
    };

    try {
      target.registerExtension(patched);
    } catch (err) {
      console.warn("[X-WIDE Prompt Input Helper] 节点菜单扩展注册失败（不影响快捷键）：", err);
    }

    return patched;
  }

  /** boot 时调用：把真正的管理器交给已经装好的节点菜单钩子。 */
  function installNodeMenu(manager) {
    nodeMenuManager = manager;
  }

  // ---------------------------------------------------------------- 启动
  //
  // 顺序很关键，理由见文件上方「app 从哪来」那一段：
  //   1) 先装 window.app 的拦截器（此刻 app 还不存在，只登记不注册）；
  //   2) 前端一执行 `window.app = Z`，我们在同一次赋值里
  //      ① 注册两个扩展（走官方通道）② 立刻 boot() 自己初始化；
  //   3) 如果 app 已经在（模块被晚加载），当场做同样的事；
  //   4) 都没成（前端改过启动顺序）退回轮询 —— 功能一样完整，因为
  //      boot() 不依赖任何前端生命周期。
  //
  // 注意 registerExtension 只登记一次：重复注册前端会抛
  // "Extension named '...' already registered."，所以有 registered 标记。

  function install(instance) {
    var target = resolveApp(instance);
    if (!target) return false;

    if (!registered) {
      try {
        if (!NODE_MENU_EXTENSION) NODE_MENU_EXTENSION = registerNodeMenuExtension(target);
        target.registerExtension(PANEL_EXTENSION);
        registered = true;
      } catch (err) {
        // 最可能的原因就是同名扩展已经注册过了（HMR / 重复加载）。
        // 这种情况不能当失败处理，继续往下 boot。
        console.warn("[" + PKG + "] 登记扩展时出错（继续初始化）：", err);
        registered = true;
      }
    }

    return boot(target);
  }

  /**
   * 等 window.app 被前端赋值，在**那一刻**完成注册与初始化。
   *
   * 为什么用拦截器而不是死等：早注册能让 beforeRegisterNodeDef 在
   * 节点类型批量注册之前生效（节点右键菜单就靠它）。赋值一过来就把属性
   * 还原成普通数据属性，之后谁再读写 window.app 都跟原生行为一模一样。
   */
  function trapWindowApp() {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(globalThis, "app");
      if (descriptor && !descriptor.configurable) return false; // 动不了，交给轮询

      Object.defineProperty(globalThis, "app", {
        configurable: true,
        enumerable: true,
        get: function () {
          return undefined;
        },
        set: function (value) {
          // 先还原成普通属性，保证 window.app 语义完全正常。
          Object.defineProperty(globalThis, "app", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: value,
          });
          install(value);
        },
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 兜底：拦截器没装上时用轮询，慢一点但功能完全一样。 */
  function waitForApp() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (typeof globalThis.app !== "undefined" && install(null)) {
        clearInterval(timer);
        return;
      }
      if (tries > 600) {
        clearInterval(timer);
        console.error(
          "[" + PKG + "] 等了 30 秒还是拿不到 window.app，插件没能挂上。请刷新页面后重试。"
        );
      }
    }, 50);
    return timer;
  }

  var trapped = trapWindowApp();
  if (!install(null)) {
    // app 还没来（或属性不可配置）。拦截器在的话，赋值那一刻就会调 install；
    // 不在的话靠轮询兜底。
    if (!trapped) waitForApp();
  }

  // 导出给测试：模拟前端把 app 交出来（普通赋值，会触发拦截器）。
  globalThis.__xwidePromptHelperInternals = {
    install: install,
    boot: boot,
    buildSettingsConfig: buildSettingsConfig,
    installSettings: installSettings,
    trapWindowApp: trapWindowApp,
    state: function () {
      return {
        registered: registered,
        booted: booted,
        hasManager: !!panelManager,
        hasApp: !!currentApp,
        settingsInstalled: !!(globalThis.XWidePromptHelper && globalThis.XWidePromptHelper.__settingsInstalled),
      };
    },
  };
})();
