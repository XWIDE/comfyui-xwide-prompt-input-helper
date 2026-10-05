/*!
 * X-WIDE Prompt Input Helper —— 提示词浮层 / prompt overlay
 *
 * 设计要点（这些“为什么”比代码本身重要，改之前先读一遍）：
 *
 * 1. 只有两个窗口：正向和反向。它们共享同一套渲染代码，靠 kind 区分。
 *
 * 2. 「穿透」= 不新增节点、不包装 ComfyWidgets、不改任何节点的原型。
 *    浮层挂在 document.body 上，唯一和画布的接触面是 bridge.js 里那几行读写。
 *    所以对现存工作流是零侵入的：卸载插件后画布上不留任何痕迹。
 *
 * 3. 写入目标靠三级回落，因为“当前该写哪个框”在画布应用里没有唯一答案：
 *      ① 用户此刻正在编辑 / 刚刚点过的那个文本框（最准，捕获阶段记录）；
 *      ② 画布上当前选中的节点里的文本控件（次准）；
 *      ③ 上一次成功写入过的节点（用户明确要求记住它）。
 *    三级都拿不到，就打开面板但明确提示“没有目标”，绝不让写入落到随机节点上。
 *
 * 4. 面板打开期间在捕获阶段 stopPropagation，画布收不到这一串按键/点击，
 *    不会出现“在这里打字把节点删了”这类事故。
 *
 * 5. 内容永远先写进草稿存储，应用成功才清掉；关掉面板不丢内容。
 */
(function (global) {
  "use strict";

  var I18N = globalThis.XWidePromptI18n;
  var Bridge = globalThis.XWidePromptBridge;

  /**
   * 本文件自己的 URL —— 它永远是 `<路由>/js/prompt_panel.js`。
   *
   * 用途只有一个：找自己的 CSS。**不能用 `document.currentScript`** ——
   * 本文件是被 `import` 进来的，而 ES module 里 `document.currentScript`
   * **恒为 null**（规范如此），所以那条路在真机上永远走不通。
   *
   * 血案（1.0.5 装机版）：正因为 currentScript 是 null，样式表地址一直落到写死的
   * `/extensions/comfyui-xwide-prompt-helper/css/prompt_panel.css`；目录被改名成
   * `comfyui-xwide-prompt-input-helper` 之后它 **404**，于是整个面板 CSS 都没加载
   * —— logo 撑满整列、卡片没有边框、设置页也不居中，界面像“没穿衣服”。
   *
   * 写法上必须是完整的 `import.meta.url`：拆成对象属性就不是 import.meta 语法了。
   * 仓库里同时有 `"type": "module"` 的 package.json，测试（Node/Electron）也一样拿得到。
   */
  var SELF_URL = (function () {
    try {
      return String(import.meta.url || "");
    } catch (err) {
      return "";
    }
  })();

  var VALID_KINDS = ["positive", "negative"];

  /** 面板默认尺寸：够看 8 行提示词，又不至于盖住整个画布。 */
  var DEFAULT_SIZE = { width: 560, height: 330 };
  var MIN_SIZE = { width: 340, height: 200 };
  var VIEWPORT_MARGIN = 8;

  /** 草稿落盘的防抖：提示词可能有几千字，逐键写 localStorage 会卡。 */
  var DRAFT_DEBOUNCE_MS = 250;
  /** 交互记忆的有效期：超过这个时间就不再认为“用户刚点过那个框”。 */
  var INTERACTION_TTL_MS = 5 * 60 * 1000;

  function siblingKind(kind) {
    return kind === "negative" ? "positive" : "negative";
  }

  /** 撤销栈：每个面板一条，最多 50 步。 */
  function createHistory(limit) {
    var stack = [];
    return {
      push: function (value) {
        stack.push(String(value === null || value === undefined ? "" : value));
        if (stack.length > (limit || 50)) stack.shift();
      },
      pop: function () {
        return stack.length ? stack.pop() : null;
      },
      size: function () {
        return stack.length;
      },
      clear: function () {
        stack.length = 0;
      },
    };
  }

  /**
   * 工作流身份。
   *
   * “记住上次写的那个框”必须**只在一张工作流内生效**。节点 id 只在单张图里唯一，
   * 换一张工作流之后，那边的 3 号节点可能是完全无关的东西 —— 如果只比对 id，
   * 用户在新工作流里一按快捷键、一应用，内容就被静默写进一个他从没碰过的节点。
   *
   * 所以记忆的键里必须带工作流身份。这里的做法：
   *   1) 收集“哪几个对象算当前工作流的根图”——canvas.graph / app.graph /
   *      LiteGraph.rootGraph（实测 rootGraph 在切标签时稳定指向当前工作流的根图）；
   *   2) 优先用根图自己的 id（LiteGraph 里每张图都有唯一 id，切回来还是它）；
   *   3) 拿不到 id 就退回会话内的对象登记表：同一个对象永远给同一个键，
   *      这样切走再切回来仍能认出“是同一张工作流”，而新工作流必然是新的对象、新的键；
   *   4) 实在认不出来就返回空字符串 —— 调用方会因此**完全不用记忆**，
   *      宁可让用户再点一下目标框，也不冒写错节点的风险。
   */
  var graphRegistry = [];
  var graphRegistrySeq = 0;

  /**
   * 前端自己给工作流起的身份（有就用，最可靠）。
   *
   * 全部走可选访问 + try 包住：不同前端版本这几个字段时有时无，
   * 任何一个不存在都必须安静地跳过，绝不能因为探测身份把插件搞崩。
   */
  function workflowIdentityFromApp(app) {
    try {
      var manager = app && app.extensionManager;
      var workflow =
        (manager && manager.workflow && manager.workflow.activeWorkflow) ||
        (manager && manager.workflowStore && manager.workflowStore.activeWorkflow) ||
        null;
      if (workflow) {
        var key = workflow.key || workflow.id || workflow.path || workflow.filename;
        if (key) return "w:" + String(key);
      }
      var id = manager && manager.workflow && manager.workflow.activeWorkflowId;
      if (id) return "w:" + String(id);
    } catch (err) {
      /* ignore */
    }
    return "";
  }

  function workflowKeyFor(identity, candidates) {
    if (identity) return identity;

    for (var i = 0; i < candidates.length; i++) {
      var graph = candidates[i];
      if (!graph || typeof graph !== "object") continue;

      var id = null;
      try {
        id = graph.id !== undefined && graph.id !== null ? String(graph.id) : null;
      } catch (err) {
        id = null;
      }
      var real = id && id !== "0" && id !== "undefined" && id !== "null";
      if (real) return "g" + id;

      for (var j = 0; j < graphRegistry.length; j++) {
        if (graphRegistry[j].graph === graph) return graphRegistry[j].key;
      }
      graphRegistrySeq += 1;
      var key = "o" + graphRegistrySeq;
      graphRegistry.push({ graph: graph, key: key });
      // 登记表只用于识别“是不是同一张工作流”，一张图一条，正常使用下不会长到需要清理。
      if (graphRegistry.length > 64) graphRegistry.splice(0, 32);
      return key;
    }
    return "";
  }

  /** 极粗的 token 估算：CJK 按字算 1 个，其余约 3.6 字符算 1 个。只为给个量级。 */
  function estimateTokens(text) {
    var str = String(text || "");
    if (!str) return 0;
    var wide = 0;
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0x2e80) wide++;
    }
    return wide + Math.round((str.length - wide) / 3.6);
  }

  /**
   * 真·CLIP tokenizer（ComfyUI 自己那个）。
   *
   * 为什么要它：77 个 token 是硬上限，用户看计数器就是要判断"塞不塞得下"。
   * 按字符数粗估在英文上会偏小十几个点，容易让人以为还能再写。
   * 后端把 tokenizer 暴露在扩展 API 上（`api.tokenizer`，旧版是
   * `api.comfyWidgets`...），能拿到就用真数，拿不到才退回粗估。
   * 整段是可选能力：任何一步失败都只是"用不了真数"，绝不影响计数器本身。
   */
  var clipTokenizer = null;

  function resolveTokenizer(api) {
    if (api && api.tokenizer) return api.tokenizer;
    var g =
      (globalThis.comfyAPI && globalThis.comfyAPI.tokenizer) ||
      (globalThis.comfyAPI && globalThis.comfyAPI.v1 && globalThis.comfyAPI.v1.tokenizer);
    return g || null;
  }

  /**
   * 用真 tokenizer 数；失败就 resolve 成 null（调用方保留粗估）。
   */
  function countTokensExact(tokenizer, text) {
    if (!tokenizer) return Promise.resolve(null);
    try {
      if (typeof tokenizer.tokenizeWithMetadata === "function") {
        return Promise.resolve(tokenizer.tokenizeWithMetadata(text)).then(function (res) {
          if (!res || !Array.isArray(res.tokens)) return null;
          return res.tokens.length;
        }, function () {
          return null;
        });
      }
      if (typeof tokenizer.tokenize === "function") {
        return Promise.resolve(tokenizer.tokenize(text)).then(function (res) {
          return Array.isArray(res) ? res.length : null;
        }, function () {
          return null;
        });
      }
    } catch (_err) {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  }

  /**
   * 存储封装。
   * 只暴露字符串读写 + 文本插入，不做 JSON —— 内容全是纯文本，少一层编解码少一类 bug。
   * localStorage 不可用（隐私模式 / 配额满）时退化成同进程内存，功能不降级，只是不持久。
   */
  function createStorage(namespace) {
    var memory = {};
    var backend = null;
    var backendName = "memory";

    try {
      if (globalThis.localStorage) {
        var probe = namespace + ".__probe__";
        globalThis.localStorage.setItem(probe, "1");
        globalThis.localStorage.removeItem(probe);
        backend = globalThis.localStorage;
        backendName = "localStorage";
      }
    } catch (err) {
      backend = null;
    }

    function fullKey(key) {
      return namespace + "." + key;
    }

    function getText(key, fallback) {
      var full = fullKey(key);
      if (backend) {
        try {
          var raw = backend.getItem(full);
          return raw === null || raw === undefined ? fallback : raw;
        } catch (err) {
          return fallback;
        }
      }
      return Object.prototype.hasOwnProperty.call(memory, full) ? memory[full] : fallback;
    }

    function setText(key, value) {
      var full = fullKey(key);
      var text = String(value === null || value === undefined ? "" : value);
      if (backend) {
        try {
          backend.setItem(full, text);
          return true;
        } catch (err) {
          /* 配额满：继续走内存分支 */
        }
      }
      memory[full] = text;
      return false;
    }

    function getJson(key, fallback) {
      var raw = getText(key, null);
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    }

    function setJson(key, value) {
      var text;
      try {
        text = JSON.stringify(value);
      } catch (err) {
        return false;
      }
      return setText(key, text);
    }

    function remove(key) {
      var full = fullKey(key);
      if (backend) {
        try {
          backend.removeItem(full);
        } catch (err) {
          /* ignore */
        }
      }
      delete memory[full];
    }

    return {
      getText: getText,
      setText: setText,
      getJson: getJson,
      setJson: setJson,
      remove: remove,
      kind: backendName,
    };
  }

  function createPanelManager(options) {
    var opts = options || {};
    var doc = opts.document || globalThis.document;
    var app = opts.app || globalThis.app;
    var namespace = opts.namespace || "XWidePromptHelper";

    // createTranslator 返回的**就是** t 函数本身（函数上挂了 .locale / .available），
    // 不是一个 { t } 包装对象 —— 这里以前写成了 translator.t，结果 t 是 undefined，
    // 直到面板第一次建 DOM 才炸，属于“能过语法检查、一跑就崩”的那种错。
    var t = I18N.createTranslator(opts.locale);
    var storage = createStorage(namespace);

    var panels = {};
    var lastInteracted = { element: null, time: 0 };
    /**
     * 用户最后碰过的是哪个面板。
     *
     * 两个面板可以同时开着（这是他早先要的），于是「别处复制的文本该送进哪一个」
     * 就必须有个答案。按"最后碰过的那个"来：他刚在哪儿编辑，就是要往哪儿粘。
     * 每次 open()、每次在某个面板里按下鼠标、每次焦点落进某个面板，都会更新它。
     */
    var lastActiveKind = "";
    var debugEnabled = storage.getText("debug", "0") === "1";

    function debugLog() {
      if (!debugEnabled) return;
      try {
        var args = Array.prototype.slice.call(arguments);
        args.unshift("[X-WIDE Prompt Input Helper]");
        console.debug.apply(console, args);
      } catch (err) {
        /* ignore */
      }
    }

    // ---------------------------------------------------------------- DOM 小工具

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function button(className, label, title) {
      var b = el("button", "xwph-btn " + (className || ""), label);
      b.type = "button";
      if (title) b.title = title;
      return b;
    }

    function iconButton(label, title) {
      var b = button("xwph-btn-icon", label, title);
      b.setAttribute("aria-label", title || label);
      return b;
    }

    function stopEvent(e) {
      if (!e) return;
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }

    function preventEvent(e) {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
    }

    /** 捕获阶段把事件整个吃掉，别让画布拿到。 */
    function swallow(e) {
      stopEvent(e);
      preventEvent(e);
    }

    function clamp(value, min, max) {
      if (typeof value !== "number" || !isFinite(value)) return min;
      return Math.max(min, Math.min(max, value));
    }

    function viewportSize() {
      var w = (doc.documentElement && doc.documentElement.clientWidth) || globalThis.innerWidth || 1280;
      var h = (doc.documentElement && doc.documentElement.clientHeight) || globalThis.innerHeight || 800;
      return { width: w, height: h };
    }

    // ---------------------------------------------------------------- 提示条

    var toast = (function () {
      var host = null;
      var hideTimer = null;

      function ensureHost() {
        if (host && host.parentNode) return host;
        host = doc.createElement("div");
        host.className = "xwph-toasts";
        (doc.body || doc.documentElement).appendChild(host);
        return host;
      }

      function destroy() {
        if (host && host.parentNode) host.parentNode.removeChild(host);
        host = null;
        hideTimer = null;
      }

      return function show(message, level) {
        if (!message) return;
        var box = ensureHost();
        var item = el("div", "xwph-toast" + (level ? " xwph-toast-" + level : ""), message);
        box.appendChild(item);

        // 最多留 3 条，避免刷屏。
        while (box.childElementCount > 3) box.removeChild(box.firstChild);

        if (hideTimer) globalThis.clearTimeout(hideTimer);
        hideTimer = globalThis.setTimeout(destroy, 2800);
      };
    })();

    // ---------------------------------------------------------------- 目标解析

    /** 从一个真实文本框反查它属于哪个节点、哪个控件。 */
    function resolveFromElement(element) {
      if (!Bridge.isElement(element)) return null;

      /**
       * 顺序很重要：**先用元素反查控件**，再退回"顺着 DOM 往上爬"。
       *
       * 真机上（ComfyUI 前端 1.53.6）textarea 上没有任何指回节点的属性，
       * `el.__comfy_node` 和 `el.node` 都是 undefined —— 爬 DOM 那条路恒为 null。
       * 而按元素反查控件是拿对象身份比对，前端怎么改内部结构都不会错。
       */
      var found = Bridge.findWidgetByElement(element, app);
      if (found && found.node && found.widget) {
        return Bridge.inspectTarget(found.node, found.widget);
      }

      var node = Bridge.findNodeByElement(element);
      if (!node || !Array.isArray(node.widgets)) {
        /**
         * 元素在画布上但拿不到 node（前端内部结构变了、或元素在某个弹窗里）。
         * 仍然把它当成有效目标——只写 DOM 元素这条路是安全的，
         * 而“点一下再按快捷键”是最常用的用法，不该因为拿不到 node 就整个失效。
         */
        return {
          node: null,
          widget: null,
          element: element,
          nodeId: null,
          nodeTitle: "",
          field: "",
          widgetName: "",
          value: String(element.value || ""),
          detached: true,
        };
      }

      var widgets = Bridge.listTextWidgets(node);
      var matched = null;
      for (var i = 0; i < widgets.length; i++) {
        if (Bridge.getWidgetElement(widgets[i].widget) === element) {
          matched = widgets[i].widget;
          break;
        }
      }

      if (!matched) {
        return {
          node: node,
          widget: null,
          element: element,
          nodeId: node.id,
          nodeTitle: String(node.title || node.type || ("#" + node.id)),
          field: "",
          widgetName: "",
          value: String(element.value || ""),
          detached: true,
        };
      }

      return Bridge.inspectTarget(node, matched);
    }

    /**
     * 用户刚用鼠标点过的那个**画布提示词框**（只认画布上的多行文本框）。
     *
     * 为什么单列一条：`resolveFromElement` 会把「没有 node 的游离元素」也算成功
     * （那是对"点一下再按快捷键"的兜底），但换目标必须拿到真节点 + 真控件 ——
     * 所以这里要求反查得到 node 和 widget。
     *
     * ⚠️ 2026-10 改成走 `resolveFromElement`（先用对象身份反查控件、再退回爬 DOM），
     * 不再只认 `Bridge.findWidgetByElement`：用户的提示词框在自造节点上（UUID 类型），
     * 只走一条反查路太容易在"前端结构一变"时静默失败 —— 而这条静默失败正是
     * 「点框没用、插件继续写旧目标」的根因，必须留一条备用路。
     */
    function recentlyClickedPromptBox() {
      var el = lastInteracted.element;
      if (!el || !Bridge.isElement(el) || el.isConnected === false) return null;
      if (Date.now() - lastInteracted.time >= INTERACTION_TTL_MS) return null;
      if (String(el.tagName || "").toUpperCase() !== "TEXTAREA") return null;
      var target = resolveFromElement(el);
      if (!target) return null;
      if (!target.node || !target.widget) return null;
      target.detached = false;
      return { node: target.node, widget: target.widget, target: target };
    }

    function currentGraph() {
      try {
        return (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
      } catch (err) {
        return null;
      }
    }

    /** 当前工作流的根图候选（顺序即优先级）。 */
    function rootGraphCandidates() {
      var out = [];
      var push = function (graph) {
        if (graph && typeof graph === "object" && out.indexOf(graph) === -1) out.push(graph);
      };

      push(currentGraph());
      try {
        push(app && app.graph);
      } catch (err) {
        /* ignore */
      }
      try {
        push(globalThis.LiteGraph && globalThis.LiteGraph.rootGraph);
      } catch (err) {
        /* ignore */
      }

      return out;
    }

    /** 当前工作流的身份键；认不出来时是空字符串（调用方据此禁用记忆）。 */
    function currentWorkflowKey() {
      return workflowKeyFor(workflowIdentityFromApp(app), rootGraphCandidates());
    }

    /** 画布上当前选中的节点（兼容新老前端几种存法）。 */
    function selectedNodes() {
      var out = [];
      var seen = {};
      var push = function (node) {
        if (!node || typeof node !== "object" || !Array.isArray(node.widgets)) return;
        var key = String(node.id);
        if (seen[key]) return;
        seen[key] = true;
        out.push(node);
      };

      var graph = currentGraph();
      try {
        if (graph && graph.selected_nodes) {
          for (var id in graph.selected_nodes) {
            if (Object.prototype.hasOwnProperty.call(graph.selected_nodes, id)) push(graph.selected_nodes[id]);
          }
        }
      } catch (err) {
        /* ignore */
      }

      try {
        var map = app && app.canvas && app.canvas.selected_nodes;
        if (map && typeof map === "object") {
          for (var id2 in map) {
            if (Object.prototype.hasOwnProperty.call(map, id2)) push(map[id2]);
          }
        }
      } catch (err) {
        /* ignore */
      }

      try {
        var items = app && app.canvas && app.canvas.selectedItems;
        if (Array.isArray(items)) {
          for (var i = 0; i < items.length; i++) push(items[i]);
        }
      } catch (err) {
        /* ignore */
      }

      return out;
    }

    /** 遍历整张图（含子图）里的所有节点。只在“找回上次目标”时用。 */
    function collectGraphNodes() {
      var out = [];
      var visited = [];

      function walk(graph) {
        if (!graph || visited.indexOf(graph) !== -1) return;
        visited.push(graph);

        var body = null;
        try {
          body = graph._nodes || graph.nodes || null;
        } catch (err) {
          body = null;
        }

        if (Array.isArray(body)) {
          for (var i = 0; i < body.length; i++) {
            var node = body[i];
            if (!node) continue;
            if (Array.isArray(node.widgets)) out.push(node);
            if (node.subgraph) walk(node.subgraph);
          }
        }

        var children = null;
        try {
          children = graph.subgraphs;
        } catch (err) {
          children = null;
        }
        if (children) {
          var list = typeof children.values === "function" ? Array.from(children.values()) : children;
          if (Array.isArray(list)) {
            for (var k = 0; k < list.length; k++) walk(list[k]);
          }
        }
      }

      walk(currentGraph());
      return out;
    }

    /** 下拉框最多列多少个目标；画布上提示词框再多也不至于让人翻不到。 */
    var MAX_CANDIDATES = 40;

    /**
     * 面板下拉框的候选目标：当前目标 + 选中节点里的文本控件 + 画布上其余的。
     *
     * 为什么要带上"画布上其余的"：提示词经常不在你当前选中的那个节点上
     * （典型场景是同一张图里既有正向编码器又有反向编码器，还有别的插件的提示词节点）。
     * 以前只列选中节点，没选中任何东西时下拉框是**空的**，
     * 用户只能靠"先点一下那个文本框"来指定目标，点错了就写不进去 —— 这正是踩过的坑。
     * 现在把所有能写的地方都列出来，目标条上写清楚了要写进哪个节点哪个字段，
     * 选错了用户自己就能改回来。
     */
    function buildCandidates(current, limit) {
      var cap = typeof limit === "number" && limit > 0 ? limit : MAX_CANDIDATES;
      var out = [];
      var seen = {};

      function push(node, widget) {
        if (!node || !widget) return;
        var key = String(node.id) + "/" + String(widget.name);
        if (seen[key]) return;
        seen[key] = true;
        out.push({ node: node, widget: widget });
      }

      if (current && current.node && current.widget) push(current.node, current.widget);

      var nodes = selectedNodes();
      for (var i = 0; i < nodes.length; i++) {
        var widgets = Bridge.listTextWidgets(nodes[i]);
        for (var j = 0; j < widgets.length; j++) push(nodes[i], widgets[j].widget);
      }

      // 其余节点按画布位置（上到下、左到右）排，跟眼睛扫过去的顺序一致。
      var rest = collectGraphNodes().sort(function (a, b) {
        var ay = a && a.pos ? Number(a.pos[1]) || 0 : 0;
        var by = b && b.pos ? Number(b.pos[1]) || 0 : 0;
        if (ay !== by) return ay - by;
        var ax = a && a.pos ? Number(a.pos[0]) || 0 : 0;
        var bx = b && b.pos ? Number(b.pos[0]) || 0 : 0;
        return ax - bx;
      });
      for (var k = 0; k < rest.length; k++) {
        var ws = Bridge.listTextWidgets(rest[k]);
        for (var m = 0; m < ws.length; m++) push(rest[k], ws[m].widget);
      }

      return out.slice(0, cap);
    }

    /**
     * 上次成功写入过的目标，按“工作流 + 节点 id + 控件名”重新在图里定位
     * （只存 id 和名字，不缓存对象，避免野指针）。
     *
     * 为什么必须带工作流键：节点 id 只在单张图内唯一。少了工作流这一层，
     * 用户在 A 图里写过节点 3，切到 B 图后 B 图的节点 3 会被当成同一个目标，
     * 内容就被静默写进一个他从没碰过的节点 —— 这是最糟的一类 bug。
     */
    function resolveFromMemory(kind) {
      var workflowKey = currentWorkflowKey();
      // 认不出当前工作流（极端情况），就不要用记忆：宁可让用户再点一下目标框。
      if (!workflowKey) return null;

      var remembered = storage.getJson("lastTarget." + workflowKey + "." + kind, null);
      if (!remembered || !remembered.widgetName) return null;
      if (Date.now() - Number(remembered.at || 0) > 30 * 24 * 60 * 60 * 1000) return null;

      var all = collectGraphNodes();
      for (var i = 0; i < all.length; i++) {
        var node = all[i];
        if (String(node.id) !== String(remembered.nodeId)) continue;
        var widgets = Bridge.listTextWidgets(node);
        for (var j = 0; j < widgets.length; j++) {
          if (String(widgets[j].widget.name) === String(remembered.widgetName)) {
            return Bridge.inspectTarget(node, widgets[j].widget);
          }
        }
      }
      return null;
    }

    /**
     * 按「工作流 + 正/反」读回用户定过的那个框。
     *
     * 只存 id 和控件名，每次重新在图里找（不缓存对象，避免野指针）。
     * 这是**唯一**能让插件在用户没点任何地方时也知道该写哪儿的依据，
     * 所以绑定一旦定下就一直用，换工作流各记各的。
     */
    /**
     * 记忆里存着的绑定 → 当前图里那个**还活着**的控件。
     *
     * 返回 `{ node, widget, target }`（不再是裸 target）：调用方需要 node/widget 才能
     * 重新判一次角色（`resolveTrace` 里也要报出来）。
     *
     * 连带的自愈：存着的节点/控件在当前工作流里已经找不到（被删掉、被停用、
     * 或是别的版本的工作流留下的），就**顺手把这条记忆删掉**。
     * 不删的话它会一直挂在存储里，每次解析都要白找一遍 —— 用户真机上那条
     * 指向已停用节点的 `#520` 就是这么来的。
     */
    function resolveBound(kind) {
      var workflowKey = currentWorkflowKey();
      if (!workflowKey) return null;

      var bound = storage.getJson(bindingStorageKey(kind), null);
      if (!bound || !bound.widgetName) return null;

      var nodes = collectGraphNodes();
      for (var i = 0; i < nodes.length; i++) {
        if (String(nodes[i].id) !== String(bound.nodeId)) continue;
        var widgets = Bridge.listTextWidgets(nodes[i]);
        for (var j = 0; j < widgets.length; j++) {
          if (String(widgets[j].widget.name) === String(bound.widgetName)) {
            return {
              node: nodes[i],
              widget: widgets[j].widget,
              target: Bridge.inspectTarget(nodes[i], widgets[j].widget),
            };
          }
        }
      }

      storage.remove(bindingStorageKey(kind));
      debugLog("binding 已失效，删掉这条记忆", kind, "#" + bound.nodeId, String(bound.widgetName));
      return null;
    }

    /** 定下「正/反各写哪个框」；这是插件以后一直照着做的依据。 */
    function setBinding(kind, node, widget) {
      var workflowKey = currentWorkflowKey();
      if (!workflowKey || !node || !widget) return false;
      storage.setJson(bindingStorageKey(kind), {
        nodeId: node.id,
        widgetName: widget.name,
        at: Date.now(),
      });
      debugLog("bound", kind, "-> #" + node.id, String(widget.name));
      return true;
    }

    /** 图里所有"能装提示词的真实文本框"以及它们各自认出来的正反角色。 */
    function promptBoxes() {
      var out = Bridge.listPromptBoxes(app) || [];
      for (var i = 0; i < out.length; i++) {
        if (!out[i].target) out[i].target = Bridge.inspectTarget(out[i].node, out[i].widget);
        if (out[i].target) out[i].label = formatLinkLabel(out[i].node, out[i].role);
      }
      return out;
    }

    /**
     * 从候选里挑出"唯一确定的那一个"。
     *
     * 为什么只有唯一才敢自动定：正向和反向的判据是**线落到哪个入口**
     * （positive / negative），这个不会错；但同一张图里可能有好几段采样，
     * 那段就同时有好几个 positive 入口，谁也不是"那一个"，必须让用户点。
     */
    function soleCandidateByRole(boxes, role) {
      var hits = [];
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].role === role) hits.push(boxes[i]);
      }
      return hits.length === 1 ? hits[0] : null;
    }

    /**
     * 这个候选能不能当本次要写的那一边？
     *
     * 规矩只有一条：**角色认得出来、而且跟按下的键不一致 → 不能用**。
     * 角色认不出来（`""`）不算冲突 —— "读不到正反"是另一回事，交给第 ⑦⑧ 档处理。
     *
     * 为什么必须有这道闸门（用户原话 m05635：「正 反 提示词会认错，写到正有的时候会填到反
     * 里面，写到反，有的时候会填到正里面，有的时候结果又是正确的」）：
     * 病根是**有几条路根本不看角色** —— 旧绑定、刚才指过的元素、选中节点的兜底、老记忆，
     * 全是"找到就用"。于是同一张图里一会儿对一会儿错：对的那几次是判据赢的，
     * 错的那几次是这几条路赢的。判据既然已经能认出正反（依据行上写着凭什么认的），
     * 就不该再让任何一条路绕过它。
     */
    function roleBlocks(candidate, kind) {
      if (!candidate || !candidate.node || !candidate.widget) return false;
      var role =
        candidate.role !== undefined && candidate.role !== null
          ? candidate.role
          : roleOfNode(candidate.node, candidate.widget);
      return !!role && role !== kind;
    }

    /** 这个框顺着线落到哪个接收节点上（认不出来就回 ""）。配对全靠它。 */
    function receivingNodeIdOf(box) {
      if (!box || !box.node) return "";
      var trace = roleTraceOf(box.node, box.widget);
      var hops = trace && trace.hops;
      if (!hops || !hops.length) return "";
      var last = hops[hops.length - 1];
      if (!last || last.id === undefined || last.id === null) return "";
      return String(last.id);
    }

    /**
     * 「同一对里的另一半」：跟参照框连到**同一个接收节点**、角色正好是 kind 的那个框。
     *
     * 为什么这条判据可信：正反提示词本来就是一对接在同一个节点上的东西
     * （真机取证：`#767 → #5615 · positive_prompt`、`#5640 → #5615 · negative_prompt`）。
     * 所以只要有一半的位置是确定的，另一半就是唯一的 —— 用户点着正向框按 N、
     * 或者已经认定了反向那个框再按 P，都不用再猜。
     *
     * 只在**唯一**时才敢用：两段采样各接一个、又都落在同一个接收节点上时分不清，
     * 宁可回 null 让用户点一次（他说过这种时候"脱下视图去选"最方便）。
     */
    function partnerBox(boxes, kind, refBox) {
      if (!refBox || !refBox.node) return null;
      var refId = receivingNodeIdOf(refBox);
      if (!refId) return null;

      var hits = [];
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.role !== kind) continue;
        // 参照框自己不算（点着反向框按 N 的时候它本来就在候选里）。
        if (b.node === refBox.node && b.widget === refBox.widget) continue;
        if (receivingNodeIdOf(b) === refId) hits.push(b);
      }
      return hits.length === 1 ? hits[0] : null;
    }

    /**
     * 另一侧（正/反里对称的那一个）此刻**当前这张图自己说清了**的框 —— 给配对当参照。
     *
     * 只看两处证据：另一侧在全图唯一认得出来的那个框；另一侧存着的绑定（且现在还验得出角色）。
     * 刻意**不**递归调 `resolveTarget(另一侧)`：那会互相调用，还会把"猜出来的结论"
     * 当成证据再用一遍。
     */
    function referenceBoxForKind(kind, boxes) {
      var other = otherKind(kind);

      var sole = soleCandidateByRole(boxes, other);
      if (sole) return sole;

      var bound = resolveBound(other);
      if (!bound || !bound.node || !bound.widget) return null;
      if (roleOfNode(bound.node, bound.widget) !== other) return null;
      return { node: bound.node, widget: bound.widget, target: bound.target, role: other };
    }

    /**
     * 认不出角色时，用户此刻指着的那个框（"就当读不到正反时，只用正向向里填"用）。
     *
     * 只认**刚点过的那个框**：它带着明确的"就是它"的意图。
     * 不在这里读 `lastInteracted.element` 的残留、也不读"选中的节点"——
     * 那些都不足以支撑"把字写进这个框"，宁可让用户点一次（第 ⑧ 条摊候选）。
     */
    function unroleBox() {
      var clicked = recentlyClickedPromptBox();
      if (!clicked || !clicked.target) return null;
      var trace = roleTraceOf(clicked.node, clicked.widget);
      if (trace && trace.role) return null; // 认得出来就不算"认不出来"，交给上面各条判
      return clicked;
    }

    /**
     * 一句话说清"这个目标是怎么定下来的" —— 给目标条下面那行灰字用。
     *
     * 为什么要给用户看这个：这一整轮的返工都是因为"判定失败"表现成了"写错地方"，
     * 用户看到的只是结果不对、不知道插件凭什么。把依据摊开（控件名 / 线落在哪个入口 /
     * 兜底按正向），下次一眼就能看出是哪一环不对。
     */
    function roleViaText(target) {
      if (!target) return "";
      var via = target.roleVia;
      if (!via) return "";
      if (via === "widget") return t("viaWidget");
      if (via === "link") return t("viaLink");
      if (via === "own-port") return t("viaOwnPort");
      if (via === "fallback-positive") return t("viaAssumedPositive");
      return "";
    }

    /**
     * 「#67 CLIP文本编码 → K采样器 · positive」——给用户看"凭什么这么认"。
     * 起点不算在链路里，看到的第一站就是它连过去的那个节点。
     */
    function formatLinkLabel(node, role) {
      var trace = Bridge.tracePromptRole(node, { app: app });
      var last = trace.hops.length ? trace.hops[trace.hops.length - 1] : null;
      if (!last) return role === "positive" ? t("rolePositive") : role === "negative" ? t("roleNegative") : "";
      return last.title + " · " + last.port;
    }

    /**
     * 认出一个**框**的角色（带缓存，同一个 节点+控件 只顺着线走一次）。
     *
     * 统一走 `Bridge.traceRoleForBox`：控件名 → 顺线的入口声明（label/name）→ 节点自己的口。
     * 缓存键里带上控件名，因为同一个节点上可能有正、反两个框。
     */
    var roleCache = {};
    function roleTraceOf(node, widget) {
      if (!node) return null;
      var key = String(node.id) + "@" + String(node.type || "") + "#" + String((widget && widget.name) || "");
      if (roleCache[key] !== undefined) return roleCache[key];
      var trace = Bridge.traceRoleForBox(node, widget || null, { app: app });
      roleCache[key] = trace;
      return trace;
    }

    /** 只要角色字符串的老调用点用这个。 */
    function roleOfNode(node, widget) {
      var trace = roleTraceOf(node, widget);
      return (trace && trace.role) || "";
    }

    /** 用户可能在画布上补了连线，所以每次打开面板都让缓存作废。 */
    function clearRoleCache() {
      roleCache = {};
    }

    /** 正反互为一对，用来"绑一个顺手绑上另一个"。 */
    function otherKind(kind) {
      return kind === "positive" ? "negative" : "positive";
    }

    /** 绑定的存储键：必须带工作流身份，节点的 id 只在单张图里唯一。 */
    function bindingStorageKey(kind) {
      return "bind." + currentWorkflowKey() + "." + kind;
    }

    /**
     * 在**一个节点自己身上**按控件名找出本种的提示词控件。
     *
     * 用户原话（m04549/m04569）：
     *   「同样选择某个节点，它也会有正负提示词，也是要被 P 和 N 这两个键识别，
     *     这样的话，用到通用性就会增加」；
     *   「这里面有个少量的情况会出现，就是它并不会在框里面写正提示词和负提示词，
     *     但它两个框是分出来的，我估计它的节点内部应该是会区分的」。
     *
     * 也就是两种都认：
     *   1. **框的名字写明了正反** —— 控件名里带 positive / negative 的（`positive_prompt`
     *      / `negative_prompt` 这种最常见）。判据复用 `Bridge.roleFromPortName`，
     *      跟"线落到哪个入口"用的是同一份词表，不另起一套。
     *   2. **框的名字没写，但节点上正好只有一个文本控件** —— 那它就是唯一能写的那个。
     *      这一条兜住"两个框分出来了、名字里却没写正反"的少量情形，也顺带让
     *      `Text Multiline` 这类只有一个框的节点照旧能用。
     *
     * 刻意**不**在节点上有多个框、名字又都没写明时瞎挑：那是用户说的"非常少"的情形，
     * 宁可认不出来（面板会如实说没目标），也不要写错框。
     */
    function fieldOfNodeForRole(node, kind) {
      var widgets = Bridge.listTextWidgets(node);
      if (!widgets.length) return null;
      // 名字写明了正反的，按名字认（跟按连线认用的是同一份词表）。
      for (var i = 0; i < widgets.length; i++) {
        if (Bridge.roleFromPortName(widgets[i].widget && widgets[i].widget.name) === kind) return widgets[i];
      }
      // 名字没写，但**顺着线**能看出它落在接收节点本种的入口上。真机上用户那两个自造节点
      // 就是这一种：控件的真名只有 `prompt`，写着 positive_prompt 的是入口的显示名 ——
      // 只按控件名认的话，用户明明选中了那个节点，② 这一档却认不出它来。
      for (var j = 0; j < widgets.length; j++) {
        if (roleOfNode(node, widgets[j].widget) === kind) return widgets[j];
      }
      // 名字没写、但只有这一个文本控件：它就是唯一能写的那个。
      if (widgets.length === 1) return widgets[0];
      return null;
    }

    /**
     * 画布上此刻选中的节点里，有没有能当这个种目标的框。
     *
     * `selectedNodes()` 的顺序是"用户最后点选的那个在最前面"（前端 graph.selected_nodes
     * 的键顺序），所以取第一个命中的就等于"用户刚点的那个节点说了算"。
     *
     * @param {string} kind        "positive" / "negative"
     * @param {boolean} anyWidget  true 时放宽成"这个节点上第一个文本控件"（只给最后的兜底用）。
     *                             第 ①-2 级**不能**放宽：那时候用户明确选中了某个节点，
     *                             该按名字认，认不出就别乱写。
     */
    function recentlySelectedNodeForKind(kind, options) {
      var anyWidget = !!(options && options.anyWidget);
      var selected = selectedNodes();
      for (var i = 0; i < selected.length; i++) {
        var node = selected[i];
        if (!node) continue;
        var pick = fieldOfNodeForRole(node, kind);
        if (!pick && anyWidget) {
          var widgets = Bridge.listTextWidgets(node);
          if (widgets.length) pick = widgets[0];
        }
        if (pick && pick.widget) {
          var role = roleOfNode(node, pick.widget);
          /**
           * 角色认得出来、却是**另一边**（这个节点上唯一那个框其实接着 negative，
           * 用户却按了 P）：这个节点不能当本种的目标。看下一个选中的节点，
           * 而不是硬塞给用户 —— "识错了我自己去点框"是他自己定的兜底。
           */
          if (role && role !== kind) continue;
          var target = Bridge.inspectTarget(node, pick.widget);
          if (role) target.linkLabel = formatLinkLabel(node, role);
          return { node: node, widget: pick.widget, target: target };
        }
      }
      return null;
    }

    /**
     * 给某个面板解析写入目标。
     *
     * **顺序（2026-10 用户拍板后重排过一次，别再改回去）**：
     *
     *   ⓪ 用户刚用鼠标点过的那个提示词框。角色**认得出来且与本种一致**就用它；
     *      认得出来但**不一致**（点着反向框按 P）就去找**跟它配成一对的另一半**
     *      （连到同一个接收节点、角色正好是本种的那个），找不到再跳过它往下找。
     *      角色**认不出来**时也用它（"你点哪个就写哪个"是用户自己按下 P 的意图）。
     *   ① 当前工作流的判据能**唯一**认出本种的那个框（控件名 / 线落在接收节点的入口声明）。
     *      用户原话（m04922）：「这个判断不应该从正反提示词这个层面去考虑，应该从接收节点
     *      这一块去考虑……我的看法，你应该是读……这个节点内部的规定吧」。
     *   ② 用户刚在画布上点选的节点里、能认出本种的那个框（控件名或顺线的入口声明）。
     *   ③ 跟**另一侧配对**的那个框：另一侧的位置是确定的（全图唯一认得出，或用户定过的
     *      绑定现在还验得出角色）时，本侧就是它那一半。治的是"两段采样、正反各有俩框"。
     *   ④ 记忆里的绑定 —— **降到最后这一档**，且只在它当前还认得出来时才用。
     *      为什么降级：它是"上一次"的结论。老顺序把它排在 ① 前面，于是用户点新框、
     *      甚至换了工作流之后，插件仍抱着旧目标写 —— 真机上表现在
     *      「选择了正向，弹出来的却是反向的框，点应用也填进反向那个框里面」，
     *      而面板上显示的 `#520 … 风格提示词选择器 · negative` 其实是个**已停用**的节点。
     *      还多一道闸门：绑定指向的框如果角色是另一边，那是**污染不是依据**，直接删掉。
     *   ⑤ 用户指过的框（`lastInteracted` / 当前焦点元素），同样要角色不冲突。
     *   ⑥ 选中的节点（放宽成"这个节点上第一个文本控件"的兜底），同样要角色不冲突。
     *   ⑦ 绑定机制之前的旧记忆键。
     *   ⑧ 全都认不出来时：**正向**用用户刚点过的那个框（用户 m02771 拍板：「就当读不到
     *      正反时，只用正向向里填，就行。大部份这个时候可能会把正负提示词写一起，
     *      或是提示词里，没有区分正负，就没有正反之分。他就是提行词」）；
     *      **反向不猜** —— 摊开候选让用户点一次，因为把反向内容写进正向框代价太大。
     *   ⑨ 摊开候选（或明说没有目标）：绝不拿"猜的"去写。
     *
     * **贯穿全部档位的一条硬规矩（2026-10 用户 m05635 报"正反会认错"之后加的）**：
     * 任何一个候选，只要**角色认得出来、而且不是本种**，就一律不能用 —— 无论它是从
     * 绑定、从"刚指过的元素"、从选中节点还是从老记忆来的。这几条路以前都是"找到就用"，
     * 于是同一张图里时对时错：对的那些次是判据档赢的，错的那些次是它们赢的。
     * 见 `roleBlocks()`。
     *
     * 老规矩仍然有效：第 ⓪②③ 条都**不写绑定** —— "这次写它"和"以后一直算它"是两回事。
     * 唯一例外是第 ① 条：那是"全图只有这一个框认得出来"的确定性结论（而且读的时候
     * 还会重新验一次角色），记下来才名实相符。其余绑定都由 doApply 写成功后落。
     *
     * ===================================================================
     * 已记下、尚未处理的两个边界情形（都来自用户口头提出，等确认后动手）
     * -------------------------------------------------------------------
     * (A) 用户原话（m03655）：「会有可能有的节点，它只有一个这样的连上去的情况」
     *     —— 对面的节点只接了一条线（比如只有 positive，negative 根本没连出来）。
     *     **待确认**：这算不算用户能接受的表现？
     *
     * (B) 用户原话（m03661）：「有的人他没有把这种节点连出来的时候，同样选择某个节点，
     *     它也会有正负提示词，也是要被 P 和 N 这两个键识别……」
     *      两种情况：
     *       B1 提示词框**没有连到任何下游**（只有框，没有线）→ 已由第 ④⑦ 条兜住。
     *       B2 两个框**不在框里写"正/负"字样**、但确实是分开的。
     *     B2 现在**有判据了**：入口的 `label` / `localized_name`（真机取证：
     *     用户看到的 `positive_prompt` 是 `label`，入口真名是 `prompt`）+
     *     按结构判断的可走链（UUID 类型节点也算）。这正是这次改动解决的问题。
     * ===================================================================
     */
    function resolveTarget(kind) {
      var now = Date.now();

      // 全图的提示词框只扫一次：第 ⓪ 档（点过的框要配对）和第 ① 档都要用。
      var boxesCache = null;
      function boxesOnce() {
        if (!boxesCache) boxesCache = promptBoxes();
        return boxesCache;
      }

      /**
       * ⓪ 用户刚用鼠标点过的那个提示词框 —— **优先级最高，压过绑定**。
       *
       * 为什么它必须排在绑定前面（用户原话 m04455）：「弹了框之后，应用没有到我要去的
       * 节点里面」。老顺序里第 ① 条绑定命中就 return，于是"点另一个框再按 P"只改了面板
       * 停靠位置（锚点），写入目标仍是老绑定 —— 点框改不了去向，用户纠不回来。
       *
       * **这里刻意不设"角色必须对得上"的闸门**。一开始加过一条（只有线认得出角色、
       * 且角色与按下的键一致才夺权），后来发现它正好把用户要的场景堵死：他那张图里的
       * 提示词节点是第三方节点，线走两步就"认不出角色"了，于是点框照旧不生效 ——
       * 等于没修。用户拍板（m04455）的原话是「在画布上点某个提示词框，再按 P/N，
       * 就改写到这个框」，这就是一次**明确的用户指定**，不该被插件的猜测推翻。
       * （这一段原来写的是"点着反向框按 P 会写进反向框"，那是加角色闸门之前的旧行为；
       * 现在按下一段处理。）
       *
       * 注意**不在这里写绑定**：点一下框只是"这次写它"，跟"以后一直算它"是两回事。
       * 绑定由 doApply 真正写成功之后才落（那样才名实相符）。
       *
       * 2026-10 补：点过的框如果**角色也认得出来、而且跟按下的键对不上**（点着反向框按 P），
       * 就**不用它**，继续往下找本种该写的那个框。这条是用户反馈
       * 「我选择箭头，这个它是正向的，但弹出来的却是反向的框，点应用也填进反向那个框里面」
       * 之后定的：判定已经能认出正反了，就不该再靠"你点哪个就写哪个"去赌。
       * 只有当角色**认不出来**时，才退回"你点哪个就写哪个"。
       */
      var clicked = recentlyClickedPromptBox();
      if (clicked && clicked.target) {
        var clickedTrace = roleTraceOf(clicked.node, clicked.widget);
        var clickedRole = (clickedTrace && clickedTrace.role) || "";
        if (clickedRole) {
          clicked.target.role = clickedRole;
          clicked.target.roleVia = clickedTrace.via;
          clicked.target.linkLabel = formatLinkLabel(clicked.node, clickedRole);
        }
        if (!clickedRole || clickedRole === kind) {
          debugLog("target from clicked box", kind, "-> #" + clicked.node.id, clickedRole || "(角色认不出来)");
          return { target: clicked.target, candidates: [], source: "focus" };
        }

        /**
         * 角色认得出来、却跟按下的键对不上（点着反向框按 P）：不写错的那边，
         * 改去找**跟它配成一对的另一半**（连到同一个接收节点、角色正好是 kind）。
         *
         * 用户点着某一段采样里的框、按另一个键，要的几乎总是"这一对的另一边"，
         * 而不是"另外随便哪个" —— 这正是他说"有时候写对了"的那一次的做法，
         * 现在把它变成每次都对。
         */
        var clickedPartner = partnerBox(boxesOnce(), kind, clicked);
        if (clickedPartner && clickedPartner.target) {
          clickedPartner.target.linkLabel = clickedPartner.label;
          debugLog("clicked box 角色不符，改用配对的另一半", kind, "-> #" + clickedPartner.node.id);
          return { target: clickedPartner.target, candidates: [], source: "pair" };
        }

        debugLog("clicked box 角色不符、也没配对的另一半，忽略", kind, "-> #" + clicked.node.id, clickedRole);
      }

      // ① 当前工作流里，线/控件名能**唯一**认出本种的那个框 —— 这是最硬的判据
      //    （用户 m04922：「这个判断不应该从正反提示词这个层面去考虑，应该从接收节点
      //     这一块去考虑……读这个节点内部的规定」）。
      //    老顺序把"记忆里的绑定"排在它前面，于是用户点新框、改连线之后插件还抱着
      //    旧目标写（真机现象：#520 已经是停用节点，面板却仍显示"写入目标 #520 … negative"）。
      var boxes = boxesOnce();
      var auto = soleCandidateByRole(boxes, kind);
      if (auto && auto.target) {
        setBinding(kind, auto.node, auto.widget);
        var counterPart = soleCandidateByRole(boxes, otherKind(kind));
        if (counterPart && counterPart.node) setBinding(otherKind(kind), counterPart.node, counterPart.widget);
        auto.target.linkLabel = auto.label;
        // 来源叫 "auto" 而不是 "link"：这一档是"当前画布自己说清了本种是哪个框"，
        // 判据可能是线落到哪个口、也可能是控件名自己写着正反（后者见 tests 里
        // 「选中节点：节点自己带两个提示词框」那一节）。具体是哪一种，看 `roleVia`。
        return { target: auto.target, candidates: [], source: "auto" };
      }

      // ② 用户**刚在画布上点选了一个节点**：就在这个节点自己身上按控件名找本种的那个框。
      //      用户要的是"选中节点即可，不用点它里面的文本框"（m04549），也就是
      //      `positive_prompt` / `negative_prompt` 这种节点（对面通常是 KSampler 之类）。
      //      用"刚点选"换"不瞎挑"：只有他此刻真的选中了这个节点，才从它身上取。
      //
      //      同样**不在这里写绑定**：只是"这次写它"。绑定留给 doApply 写成功之后。
      //      这一条很重要 —— 老写法在这里 setBinding，"选中一下节点"就会永久改掉去向，
      //      把"选一下别的节点看看"变成破坏性操作。
      var picked = recentlySelectedNodeForKind(kind);
      if (picked && picked.target) {
        debugLog("target from selected node", kind, "-> #" + picked.node.id);
        return { target: picked.target, candidates: [], source: "selection" };
      }

      // ③ 跟**另一侧配对**的那个框（正反是一对，接在同一个接收节点上）。
      //      这一档治的正是"同一张图里两段采样、正反各有俩框"时按下键写错边：
      //      只要另一侧的位置是确定的（全图唯一认得出，或者用户定过的绑定现在还认得出），
      //      这一侧就是它那一半，不用猜。参照框只从"当前这张图说清了"的证据里取。
      //      同样**不在这里写绑定**：只是一次结论，绑定仍由 doApply 写成功后落。
      var refBox = referenceBoxForKind(kind, boxes);
      if (refBox) {
        var partner = partnerBox(boxes, kind, refBox);
        if (partner && partner.target) {
          partner.target.linkLabel = partner.label;
          debugLog("target from partner box", kind, "-> #" + partner.node.id, "参照 #" + refBox.node.id);
          return { target: partner.target, candidates: [], source: "pair" };
        }
      }

      // ④ 记忆里的绑定 —— 降到最后这一档，而且**只在它当前还认得出来时**才用。
      //    为什么降级：它是"上次"的结论，可能指向已经被停用/删掉的节点；把它排在
      //    当前判据前面，就等于让旧结论否决眼前这张图（真机上就是这么错的）。
      //    还多一道闸门：绑定指向的框如果**角色认得出来、却是另一边**（老版本判据认不出
      //    正反时写下的），那它就是污染而不是依据 —— 用了就等于把正向内容写进反向框，
      //    用户报的"写到正有的时候会填到反里面"正是这一条。直接删掉它。
      var bound = resolveBound(kind);
      if (bound && bound.target) {
        var boundRole = roleOfNode(bound.node, bound.widget);
        if (boundRole && boundRole !== kind) {
          storage.remove(bindingStorageKey(kind));
          debugLog("binding 指向了另一侧的框，删掉这条记忆", kind, "-> #" + bound.node.id, boundRole);
        } else {
          if (boundRole) bound.target.linkLabel = formatLinkLabel(bound.node, boundRole);
          bound.target.role = boundRole || "";
          return { target: bound.target, candidates: [], source: "binding" };
        }
      }

      // ⑤ 用户指过的框（没被更硬的判据抢先时）。同样要求"角色不冲突"：
      //    点着反向框按 P 时，这一档以前会把那个反向框再捡回来（第 ⓪ 档刚拒绝过它），
      //    于是"点正向框按 P"这条本该最顺的路反而是错的源头之一。
      var el = lastInteracted.element;
      if (el && Bridge.isElement(el) && el.isConnected !== false && now - lastInteracted.time < INTERACTION_TTL_MS) {
        var byElement = resolveFromElement(el);
        if (byElement && !roleBlocks(byElement, kind)) return { target: byElement, candidates: [], source: "focus" };
      }

      try {
        var active = doc.activeElement;
        if (Bridge.isWidgetElement(active)) {
          var byActive = resolveFromElement(active);
          if (byActive && !roleBlocks(byActive, kind)) return { target: byActive, candidates: [], source: "active" };
        }
      } catch (err) {
        /* ignore */
      }

      // ⑥ 选中的节点（这里只是"上面都没命中"时的兜底：挑本种第一个，或这个节点上唯一那个文本控件）。
      var fallbackSel = recentlySelectedNodeForKind(kind, { anyWidget: true });
      if (fallbackSel && fallbackSel.target) return { target: fallbackSel.target, candidates: [], source: "selection" };

      // ⑦ 老记忆兜底（绑定机制之前的键，用户升级上来时还能用一次）。
      var byMemory = resolveFromMemory(kind);
      if (byMemory && !roleBlocks(byMemory, kind)) return { target: byMemory, candidates: [], source: "memory" };

      // ⑦ 全都认不出来时 —— 按用户 2026-10 拍板的规矩（m02771 原话：
      //    「都读不到时，可以顺线找到上一个接定看他接的是什么地方才对，就当读不到正反时，
      //      只用正向向里填，就行。大部份这个时候可能会把正负提示词写一起，或是提示词里，
      //      没有区分正负，就没有正反之分。他就是提行词。」）：
      //      **正向**就用用户刚点过/光标所在的那个框；
      //      **反向**不猜 —— 摊开候选让他点一次，因为把反向内容写进正向框代价太大。
      var unrole = unroleBox();
      if (unrole && kind === "positive") {
        unrole.target.roleVia = "fallback-positive";
        return { target: unrole.target, candidates: [], source: "assumed-positive" };
      }

      // ⑧ 摊开候选（或明说没有目标）：绝不拿"猜的"去写。
      return { target: null, candidates: boxes, source: unrole ? "ambiguous" : "unbound" };
    }

    // ---------------------------------------------------------------- 词库

    var LIBRARY_SEP = "\u0000";
    var LIBRARY_LIMIT = 100;

    /** 词库序列化成 "名字\\0内容\\0名字\\0内容…" 的纯文本，空内容用哨兵占位。 */
    function libraryAll() {
      var raw = storage.getText("library", "");
      if (!raw) return [];

      var parts = String(raw).split(LIBRARY_SEP);
      var out = [];
      for (var i = 0; i + 1 < parts.length; i += 2) {
        if (!parts[i]) continue;
        out.push({ name: parts[i], text: parts[i + 1] === "\u0001" ? "" : parts[i + 1] });
      }
      return out;
    }

    function libraryWrite(list) {
      var flat = [];
      for (var i = 0; i < list.length; i++) {
        flat.push(list[i].name);
        flat.push(list[i].text === "" ? "\u0001" : list[i].text);
      }
      storage.setText("library", flat.join(LIBRARY_SEP));
    }

    function librarySave(name, text) {
      var list = libraryAll();
      var trimmed = String(name || "").trim();
      if (!trimmed) return null;

      var entry = { name: trimmed, text: String(text || "") };
      var found = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === trimmed) {
          found = i;
          break;
        }
      }
      if (found >= 0) list.splice(found, 1);
      list.unshift(entry);
      if (list.length > LIBRARY_LIMIT) list.length = LIBRARY_LIMIT;
      libraryWrite(list);
      return entry;
    }

    function libraryRemove(name) {
      var list = libraryAll();
      var next = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].name !== name) next.push(list[i]);
      }
      libraryWrite(next);
    }

    // ---------------------------------------------------------------- 单面板

    function createPanel(kind) {
      if (VALID_KINDS.indexOf(kind) === -1) throw new Error("unknown prompt kind: " + kind);

      var history = createHistory(50);
      var state = {
        kind: kind,
        visible: false,
        target: null,
        candidates: [],
        targetSource: "none",
        position: { x: 0, y: 0 },
        size: { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height },
        anchorElement: null,
        editorDirty: false,
        lastCommitted: "",
        draftNoticed: false,
        draftTimer: null,
        // 草稿是否已经被「应用」消费掉（消费过就不要再落盘了）。
        draftCleared: false,
        // 候选列表是不是用户自己要求摊开的（决定提示语写"选一个"还是"好几段采样"）。
        pickerManual: false,
      };

      // ------------------------------------------------------------ 结构

      var overlay = el("div", "xwph-overlay xwph-hidden");
      overlay.setAttribute("data-xwph-kind", kind);

      var dialog = el("div", "xwph-dialog");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "false");

      var header = el("div", "xwph-header");
      var grip = el("span", "xwph-grip", "⠿");
      grip.title = t("dragHint");
      var title = el("span", "xwph-title", t(kind === "positive" ? "titlePositive" : "titleNegative"));
      var headSpacer = el("span", "xwph-spacer");
      // 每个图标按钮都带一个自己的类名。面板是浮层，两个面板同时开着时
      // 它们在同一棵 DOM 里，`.xwph-btn-icon` 这种通用类选择器会选到**另一个**
      // 面板的按钮上去（测试里就这么错过一次），所以按名字定位才可靠。
      //
      // 2026-10：用户反馈标题栏右边那两个按钮（🔍 定位目标 / ✕ 关闭）**点了没有任何反应**，
      // 拍板「就不要那两个按钮了」。所以标题栏现在只剩齿轮一个：关闭有页脚的「关闭」
      // 按钮和 Esc 两条路，写哪儿的目标条 + 依据行已经把信息说全了。
      // 文字大小：用户 1.0.4「文字太小，加入大小调节」。两个按钮就在标题栏上，
      // 点一下立刻见效（写的是插件存储里的 fontScale，设置里那一行也是同一个值）。
      var fontDownBtn = iconButton("A-", t("fontSmaller"));
      fontDownBtn.classList.add("xwph-font-down");
      var fontUpBtn = iconButton("A+", t("fontBigger"));
      fontUpBtn.classList.add("xwph-font-up");

      var settingsBtn = iconButton("⚙", t("settings"));
      settingsBtn.classList.add("xwph-settings-btn");
      header.appendChild(grip);
      header.appendChild(title);
      header.appendChild(headSpacer);
      header.appendChild(fontDownBtn);
      header.appendChild(fontUpBtn);
      header.appendChild(settingsBtn);

      // 目标条：明确告诉用户“这一按会写到哪里”，避免写错节点。
      var targetBar = el("div", "xwph-targetbar");
      var targetLabel = el("span", "xwph-target-label", t("target") + "：");
      var targetSelect = doc.createElement("select");
      targetSelect.className = "xwph-target-select";
      targetBar.appendChild(targetLabel);
      targetBar.appendChild(targetSelect);

      // 「凭什么这么认」：判定依据直接用一行小字说清楚，不再藏在问号图标后面
      // （那个图标用户点了也说不清，等于不存在）。文案见 i18n 的 via*。
      var evidenceLine = el("div", "xwph-evidence xwph-hidden");

      /**
       * 一次性候选列表：**平时是隐藏的**，只有没绑定、或者分不清哪一段采样时才展开。
       * 用户明确不要常驻列表（m03294：「不要列表了，把事情做复杂了」），
       * 所以这里必须保持"平时看不见"。
       */
      var pickerRow = el("div", "xwph-picker xwph-hidden");
      var pickerList = el("div", "xwph-picker-list");

      var body = el("div", "xwph-body");
      var textarea = doc.createElement("textarea");
      textarea.className = "xwph-textarea";
      textarea.spellcheck = false;
      textarea.setAttribute("wrap", "soft");
      textarea.placeholder = t(kind === "positive" ? "titlePositive" : "titleNegative") + "…";
      body.appendChild(textarea);

      var footer = el("div", "xwph-footer");
      var counter = el("span", "xwph-counter", "");
      var footSpacer = el("span", "xwph-spacer");

      var applyBtn = button("xwph-btn-primary", t("apply"), t("applyHint"));
      // 页脚上也放一个「关闭」：用户明确说过「Esc 也要有按钮呀」，
      // 光有标题栏那个 ✕ 不够显眼（标题栏的 ✕ 仍然保留）。
      var closeFootBtn = button("xwph-btn-close", t("closePlain"), t("closeHint"));
      var clearBtn = button("", t("clear"), t("clearHint"));
      var swapBtn = button("", t(kind === "negative" ? "copyToPos" : "copyToNeg"));

      /**
       * 「自动粘贴」勾选框 —— 就摆在原来那个「粘贴」按钮的位置上。
       *
       * 2026-10 用户拍板（m0627x）：**粘贴按钮去掉**；改成"别处一复制，面板自己收下"，
       * 并且「在界面和设置里都给一个勾选」。所以这里是个勾选框而不是按钮 ——
       * 它管的是"要不要自动收"，不是一个"去读一次剪贴板"的动作。
       * 真正的读取在 manager 里（页面重新获得焦点时读一次，见 tryAutoPasteFromClipboard）。
       */
      var autoPasteLabel = el("label", "xwph-check");
      autoPasteLabel.title = t("autoPasteHint");
      var autoPasteBox = doc.createElement("input");
      autoPasteBox.type = "checkbox";
      autoPasteBox.className = "xwph-check-box";
      autoPasteBox.checked = autoPasteEnabled();
      autoPasteLabel.appendChild(autoPasteBox);
      autoPasteLabel.appendChild(el("span", "xwph-check-text", t("autoPaste")));
      // 登记一下：面板是**一份**一份建好留着的（不是每次开都重建），
      // 所以面板建好之后开关要是变了，得能回头把这一份也刷成一样的。
      registerAutoPasteBox(autoPasteBox);

      /**
       * 2026-10 用户拍板：撤销、复制、词库三个按钮拆掉（m05666），粘贴按钮也拆掉（m0627x）。
       * 页脚现在只剩「清空 / 自动粘贴开关 / → 负向」＋ 应用并关闭 / 关闭。
       */
      footer.appendChild(counter);
      footer.appendChild(footSpacer);
      footer.appendChild(applyBtn);
      footer.appendChild(closeFootBtn);
      footer.appendChild(clearBtn);
      footer.appendChild(autoPasteLabel);
      footer.appendChild(swapBtn);

      var resizer = el("div", "xwph-resizer");
      resizer.title = t("resizeHint");

      pickerRow.appendChild(pickerList);

      dialog.appendChild(header);
      dialog.appendChild(targetBar);
      dialog.appendChild(evidenceLine);
      dialog.appendChild(pickerRow);
      dialog.appendChild(body);
      dialog.appendChild(footer);
      dialog.appendChild(resizer);
      overlay.appendChild(dialog);

      // ------------------------------------------------------------ 位置与尺寸

      function applyGeometry() {
        var vp = viewportSize();
        var maxX = Math.max(VIEWPORT_MARGIN, vp.width - state.size.width - VIEWPORT_MARGIN);
        var maxY = Math.max(VIEWPORT_MARGIN, vp.height - state.size.height - VIEWPORT_MARGIN);

        state.position.x = Math.round(clamp(state.position.x, VIEWPORT_MARGIN, maxX));
        state.position.y = Math.round(clamp(state.position.y, VIEWPORT_MARGIN, maxY));

        dialog.style.left = state.position.x + "px";
        dialog.style.top = state.position.y + "px";
        dialog.style.width = state.size.width + "px";
        dialog.style.height = state.size.height + "px";
      }

      function persistGeometry() {
        storage.setJson("geometry." + kind, { position: state.position, size: state.size });
      }

      function restoreGeometry() {
        var geom = storage.getJson("geometry." + kind, null);
        var vp = viewportSize();

        var size = (geom && geom.size) || DEFAULT_SIZE;
        state.size = {
          width: clamp(Number(size.width) || DEFAULT_SIZE.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, vp.width - VIEWPORT_MARGIN * 2)),
          height: clamp(Number(size.height) || DEFAULT_SIZE.height, MIN_SIZE.height, Math.max(MIN_SIZE.height, vp.height - VIEWPORT_MARGIN * 2)),
        };

        var pos = geom && geom.position;
        if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
          state.position = { x: pos.x, y: pos.y };
        } else {
          // 首次打开：两个面板左右错开，方便对照着写正反向。
          state.position =
            kind === "positive"
              ? { x: Math.round(vp.width * 0.5 - state.size.width - 20), y: Math.round(vp.height * 0.30) }
              : { x: Math.round(vp.width * 0.5 + 20), y: Math.round(vp.height * 0.30) };
        }
        applyGeometry();
      }

      /** 把面板挪到目标控件旁边（找得到就落过去，找不到就不动）。 */
      function moveNearTarget() {
        var element = state.target && state.target.element;
        if (!Bridge.isElement(element) || typeof element.getBoundingClientRect !== "function") return false;

        var rect = null;
        try {
          rect = element.getBoundingClientRect();
        } catch (err) {
          return false;
        }
        if (!rect || (!rect.width && !rect.height)) return false;

        var vp = viewportSize();
        // 优先放右边，右边放不下放左边，再不行贴着边。
        var x = rect.right + 12;
        if (x + state.size.width > vp.width - VIEWPORT_MARGIN) x = rect.left - state.size.width - 12;
        if (x < VIEWPORT_MARGIN) x = VIEWPORT_MARGIN;

        var y = rect.top;
        if (y + state.size.height > vp.height - VIEWPORT_MARGIN) y = vp.height - state.size.height - VIEWPORT_MARGIN;
        if (y < VIEWPORT_MARGIN) y = VIEWPORT_MARGIN;

        state.position = { x: Math.round(x), y: Math.round(y) };
        applyGeometry();
        return true;
      }

      // ------------------------------------------------------------ 拖动 / 缩放

      function bindDrag(handle, onMove) {
        handle.addEventListener(
          "pointerdown",
          function (e) {
            if (e.button !== undefined && e.button !== 0) return;
            swallow(e);

            if (handle.setPointerCapture) {
              try {
                handle.setPointerCapture(e.pointerId);
              } catch (err) {
                /* ignore */
              }
            }

            var startX = e.clientX;
            var startY = e.clientY;
            var start = onMove.begin();

            function move(ev) {
              swallow(ev);
              onMove.update(start, ev.clientX - startX, ev.clientY - startY);
            }

            function up(ev) {
              swallow(ev);
              doc.removeEventListener("pointermove", move, true);
              doc.removeEventListener("pointerup", up, true);
              doc.removeEventListener("pointercancel", up, true);
              onMove.end();
            }

            doc.addEventListener("pointermove", move, true);
            doc.addEventListener("pointerup", up, true);
            doc.addEventListener("pointercancel", up, true);
          },
          true
        );
      }

      bindDrag(header, {
        begin: function () {
          return { x: state.position.x, y: state.position.y };
        },
        update: function (start, dx, dy) {
          state.position = { x: start.x + dx, y: start.y + dy };
          applyGeometry();
        },
        end: persistGeometry,
      });

      bindDrag(grip, {
        begin: function () {
          return { x: state.position.x, y: state.position.y };
        },
        update: function (start, dx, dy) {
          state.position = { x: start.x + dx, y: start.y + dy };
          applyGeometry();
        },
        end: persistGeometry,
      });

      bindDrag(resizer, {
        begin: function () {
          return { width: state.size.width, height: state.size.height };
        },
        update: function (start, dx, dy) {
          var vp = viewportSize();
          state.size = {
            width: clamp(start.width + dx, MIN_SIZE.width, Math.max(MIN_SIZE.width, vp.width - state.position.x - VIEWPORT_MARGIN)),
            height: clamp(start.height + dy, MIN_SIZE.height, Math.max(MIN_SIZE.height, vp.height - state.position.y - VIEWPORT_MARGIN)),
          };
          applyGeometry();
        },
        end: persistGeometry,
      });

      // ------------------------------------------------------------ 内容

      /**
       * 刷新右下角计数。
       *
       * 先用粗估立刻显示（不能等 await，否则打字时数字会滞后），
       * 再异步问真 CLIP tokenizer 要准数；两次结果**明显不一致**才把真数也写出来
       * （阈值 25%），差得不多就保持安静，免得闪来闪去。
       */
      var counterRequest = 0;

      function refreshCounter() {
        var value = textarea.value;
        counterRequest++;
        var request = counterRequest;

        // 懒加载兜底：init 时前端还没递 API，但窗口上的 tokenizer 可能已经就位。
        // 只是读一个属性，代价可忽略。
        if (!clipTokenizer) {
          var late = resolveTokenizer(app && app.extensionManager);
          if (late) clipTokenizer = late;
        }

        if (!value) {
          counter.textContent = t("counterEmpty");
          counter.title = "";
          return;
        }

        var chars = value.length;
        var lines = value.split("\n").length;
        var approx = estimateTokens(value);

        function render(actual) {
          if (request !== counterRequest) return; // 已经不是最新的那一次了
          if (
            typeof actual === "number" &&
            actual > 0 &&
            Math.abs(actual - approx) >= Math.max(4, approx * 0.25)
          ) {
            counter.textContent = t("counterMixed", {
              chars: chars,
              lines: lines,
              approx: approx,
              actual: actual,
            });
            counter.title = t("counterTipActual", { actual: actual });
            return;
          }
          counter.textContent = t("counter", { chars: chars, lines: lines, tokens: approx });
          counter.title = t("counterTipApprox");
        }

        render(null);
        countTokensExact(clipTokenizer, value).then(render, function () {});
      }

      /** 防抖落盘：用户打字时不要每敲一个键就写一次 localStorage。 */
      function scheduleDraftSave() {
        if (state.draftTimer) globalThis.clearTimeout(state.draftTimer);
        state.draftTimer = globalThis.setTimeout(function () {
          state.draftTimer = null;
          saveDraftNow();
        }, DRAFT_DEBOUNCE_MS);
      }

      /**
       * 关面板 / 关页面时的“抢救性落盘”。
       *
       * 这里**只**把待写的防抖取消掉，然后走同一套 saveDraftNow —— 千万别在这里
       * 无条件把 `textarea.value` 写进存储。踩过的坑：“应用”已经 clearDraft()
       * 把草稿清了，紧接着 hide() 又原样写回去，于是草稿复活，用户下次打开
       * 面板看到的还是上一次的内容，而它其实早就写进节点里了。
       */
      function flushDraft() {
        if (state.draftTimer) {
          globalThis.clearTimeout(state.draftTimer);
          state.draftTimer = null;
        }
        saveDraftNow();
      }

      /** 内容为空就删掉草稿键：空草稿没有任何意义，留着还会盖掉目标控件的内容。 */
      function saveDraftNow() {
        // 「应用」已经把这个草稿消费掉了，别在关面板时又把它写回去。
        // saveDraftNow 会被 hide() -> flushDraft() 调用，而 apply 的收尾顺序是
        // clearDraft() 然后 hide()，没有这个开关的话草稿必然复活。
        if (state.draftCleared) return;

        var value = textarea.value;
        if (value) storage.setText("draft." + kind, value);
        else storage.remove("draft." + kind);
      }

      function clearDraft() {
        if (state.draftTimer) {
          globalThis.clearTimeout(state.draftTimer);
          state.draftTimer = null;
        }
        storage.remove("draft." + kind);
        state.draftCleared = true;
        state.editorDirty = false;
        state.lastCommitted = "";
      }

      /** 替换内容并记进撤销栈（供撤销/粘贴/来自对面的推送共用）。 */
      function commitText(next) {
        history.push(textarea.value);
        textarea.value = String(next === null || next === undefined ? "" : next);
        state.editorDirty = false;
        state.lastCommitted = textarea.value;
        state.pastedOnce = true;
        scheduleDraftSave();
        refreshCounter();
      }

      // ------------------------------------------------------------ 目标条

      function renderTarget() {
        targetSelect.textContent = "";
        clearPicker();
        renderEvidence();

        if (!state.target) {
          var option = doc.createElement("option");
          option.value = "";
          option.textContent = t("targetNone");
          targetSelect.appendChild(option);
          targetSelect.disabled = true;
          targetSelect.classList.add("xwph-target-missing");
          // 没绑定就让他点一次，选完锁死；以后从任何角度按 P/N 都不会再问。
          renderPicker();
          return;
        }

        targetSelect.classList.remove("xwph-target-missing");

        var auto = doc.createElement("option");
        auto.value = "0";
        auto.textContent = Bridge.formatTargetLabel(state.target) || state.target.nodeTitle || t("targetManual");
        targetSelect.appendChild(auto);

        /**
         * 「不写入，只编辑」逃生门。
         *
         * 有了它，用户才有一个明确说"这次只编辑、不要动画布"的办法；
         * 没有它的话，目标永远是某个具体节点，用户想不写都做不到。
         */
        var none = doc.createElement("option");
        none.value = "-2";
        none.textContent = t("targetDontWrite");
        targetSelect.appendChild(none);

        // 这里原来还有一项「换一个框…」（把候选摊开让用户点）。已经删掉：
        // 用户拍板（m04545）——"在画布上点哪个框就写哪个框"落地之后，这个入口是重复的，
        // 而他要的就是面板上**没有可选项**。候选列表本身留着，只在"实在分不清"
        // （没有目标 / 多个同种入口）时自动弹出来一次，见 renderPicker()。

        targetSelect.disabled = false;
        targetSelect.value = "0";
      }

      /**
       * 依据行：把"这个目标是怎么认出来的"如实写在目标条下面。
       *
       * 没有 `roleVia`（用户自己点的候选 / 旧记忆 / 手动指定）就整行收起来 ——
       * 不解释也是一种信息（这些情况不需要解释）。
       */
      function renderEvidence() {
        if (!evidenceLine) return;
        var text = roleViaText(state.target);
        if (!text) {
          evidenceLine.classList.add("xwph-hidden");
          evidenceLine.textContent = "";
          return;
        }
        evidenceLine.textContent = text;
        evidenceLine.classList.remove("xwph-hidden");
      }

      /** 收起候选列表。 */
      function clearPicker() {
        if (pickerRow) pickerRow.classList.add("xwph-hidden");
        if (pickerList) pickerList.textContent = "";
      }

      /**
       * 只在"没有目标"或"分不清"的时候出现的那一次选择。
       *
       * 平时用户看不到任何列表 —— 这是他明确要求的（m03294）：
       * "不要列表了，把事情做复杂了"。只有两种情况才弹：
       *   1. 这张图里还没定过这个种写哪个框；
       *   2. 有好几段采样、同时存在多个同种入口（比如 1采/2采各一套正反）——
       *      那时谁也分不出该写哪个，让他点一次最直接。
       * 选完就写进绑定，以后不再问。
       */
      function renderPicker() {
        if (!pickerRow || !pickerList) return;
        var boxes = state.candidates && state.candidates.length ? state.candidates : promptBoxes();
        if (!boxes.length) {
          pickerRow.classList.remove("xwph-hidden");
          pickerList.textContent = "";
          var none = el("div", "xwph-picker-hint", t("pickNoBox"));
          pickerList.appendChild(none);
          return;
        }

        pickerRow.classList.remove("xwph-hidden");
        pickerList.textContent = "";
        var hint = el(
          "div",
          "xwph-picker-hint",
          state.candidates.length && !state.pickerManual ? t("pickMulti") : t("pickOne")
        );
        pickerList.appendChild(hint);

        // 同种的排前面（按 P 时最可能就是这个），其余按画布顺序跟在后面。
        var sorted = boxes.slice(0).sort(function (a, b) {
          var am = a.role === kind ? 0 : 1;
          var bm = b.role === kind ? 0 : 1;
          return am - bm;
        });

        for (var i = 0; i < sorted.length; i++) {
          var box = sorted[i];
          if (!box.target) continue;
          var row = el("button", "xwph-picker-item", "");
          row.type = "button";
          row.appendChild(el("div", "xwph-picker-title", Bridge.formatTargetLabel(box.target)));
          if (box.label) row.appendChild(el("div", "xwph-picker-link", t("pickConnectsTo", { where: box.label })));
          var value = String(box.target.value == null ? "" : box.target.value).replace(/\s+/g, " ").trim();
          row.appendChild(el("div", "xwph-picker-preview", value ? value.slice(0, 40) : t("pickEmpty")));
          bindPickerRow(row, box);
          pickerList.appendChild(row);
        }
      }

      /** 点一下候选：定为这个种的目标，并立刻记住。 */
      function bindPickerRow(row, box) {
        row.addEventListener("click", function (e) {
          if (e) {
            preventEvent(e);
            if (typeof e.stopPropagation === "function") e.stopPropagation();
          }
          if (!box || !box.node || !box.widget) return;
          setBinding(kind, box.node, box.widget);
          state.target = Bridge.inspectTarget(box.node, box.widget);
          if (state.target && box.label) state.target.linkLabel = box.label;
          state.targetSource = "manual";
          state.candidates = [];
          state.pickerManual = false;
          debugLog("picked target", state.target && state.target.nodeTitle);
          renderTarget();
          moveNearTarget();
        });
      }

      function onTargetChange() {
        var index = parseInt(targetSelect.value, 10);
        if (isNaN(index)) return;

        // -2 是「不写入」：把目标清掉，应用时会如实拒绝并提示，绝不乱写。
        if (index === -2) {
          state.target = null;
          state.targetSource = "declined";
          state.pickerManual = true;
          targetSelect.classList.add("xwph-target-missing");
          renderEvidence();
          // 用户选"不写入"往往就是想换一个框：顺手把候选摊开，点一下就能换。
          // （下拉框里那个「换一个框…」入口已按用户要求删掉，见 renderTarget()。）
          renderPicker();
          debugLog("target declined by user");
          return;
        }

        // 下拉框里现在只有两条：目标本身（"0"）和「不写入」（"-2"）。其余负数一概不认。
        if (index < 0) return;

        var list = state.candidates;
        var pick = list[index];
        if (!pick || !pick.node || !pick.widget) return;

        state.target = Bridge.inspectTarget(pick.node, pick.widget);
        state.targetSource = "manual";
        // 换目标后重新落位，让面板始终贴着想写的那个框。
        moveNearTarget();
        debugLog("target switched", state.target.nodeTitle, state.target.field);
      }

      /** 写入前的最后一道保险：这个目标还在图里吗。 */
      function targetIsGone(target) {
        if (!target) return true;

        if (target.detached || !target.widget) {
          return !Bridge.isElement(target.element) || target.element.isConnected === false;
        }

        var node = target.node;
        var widget = target.widget;
        if (!node || !widget) return true;
        if (Array.isArray(node.widgets) && node.widgets.indexOf(widget) === -1) return true;
        return false;
      }

      // ------------------------------------------------------------ 动作

      /**
       * 2026-10 用户拍板把页脚精简成「清空 / → 负向」：「" 撤销 复制 词库" 去除不要了」。
       * 所以 `doUndo()` / `doCopy()` / `legacyCopy()` 三个动作连同它们的按钮一起删掉了；
       * 后来又按 m0627x 把「粘贴」按钮也删了（原因见下面那段注释）。
       *
       * `history` 这个撤销栈**留着**（`commitText` / `receiveText` 仍然往里压）：
       * 它只占一个数组，而为它去掉两处压栈改动会把"以后想把撤销接回别的地方"变成一次
       * 重构。要恢复撤销，只要再挂一个按钮调 `history.pop()` 就行。
       */

      /**
       * 清空：**面板清空 + 目标框也写成空**。
       *
       * 2026-10 用户拍板（m0627x）：清空 =「面板清空 + 目标框也写成空」。
       * 理由很直白：清空这个动作的意思就是"这个框我不要了"。只清面板等于什么都没做 ——
       * 一按「应用并关闭」又把老内容原样写回去了，用户看到的还是那句提示词。
       *
       * 三种情况要分开说清楚（用户最烦的就是"点了没反应"）：
       *   ① 有目标：面板 + 目标框一起清，报「已清空」；
       *   ② 目标找不到 / 目标跑掉了：只清面板，并如实说"只清了面板"；
       *   ③ 面板和目标框本来就是空的：什么都不做，也不出声。
       *
       * 注意这里**不**清 `state.target`、也**不**动绑定：清的是内容，不是"这个框归谁"。
       * 清完接着按 P 还是写回同一个框（那正是用户要的）。
       */
      function doClear() {
        var hadText = !!textarea.value;
        if (hadText) commitText("");

        var target = state.target;
        if (!target || targetIsGone(target)) {
          if (hadText) toast(t("clearedPanelOnly"), "warn");
          return;
        }

        var boxHadText = !!Bridge.getWidgetValue(target.widget);
        if (!boxHadText) {
          if (hadText) toast(t("cleared"));
          return;
        }

        var result = Bridge.setWidgetText(target, "", { app: app });
        if (!result.verified) {
          debugLog("clear not verified", { steps: result.steps, actual: result.value });
        }
        // 面板内容已经跟着目标框一起没了，草稿再留着就会在下次打开时"复活"这句话。
        state.draftCleared = true;
        clearDraft();
        toast(t("cleared"));
      }

      /**
       * 原来的「粘贴」按钮（`doPaste`）连同 `insertTextAtCursor` 已经删掉。
       *
       * 2026-10 用户拍板（m0627x）：**这个按钮去掉**。原因是它在真机上时灵时不灵
       * —— 浏览器只在"有用户手势"时才给读剪贴板，而面板里的输入框一旦被聚焦/改选区，
       * 那次临时授权就作废。留着这个按钮等于让用户反复撞同一堵墙。
       * 现在只剩两条真正稳的路：
       *   ① 在页面里按 Ctrl + V（浏览器原生粘贴事件，我们只旁听，见 onPasteCapture）；
       *   ② 在别处复制后切回页面 —— 页面重新获得焦点时自动读一次
       *      （见 tryAutoPasteFromClipboard）。
       */

      function doSwap() {
        var value = textarea.value;
        if (!value) {
          toast(t("nothingToApply"), "warn");
          return;
        }
        var other = panels[siblingKind(kind)];
        if (!other) return;

        // 顺序很重要：必须先 show 再 pushText。
        // show() 会按「草稿 > 目标控件内容 > 空」重新预填输入框，
        // 先 push 的话刚送过去的内容会被目标控件的旧值当场顶掉 —— 用户看到的就是
        // 点了「→ 负向」之后对面还是老内容。show 之后 push 才是最终态。
        other.show({ focus: true });
        other.pushText(value);
        // 收起自己，视线自然落到对面。
        hide({ silent: true, restoreFocus: false });
        toast(t("swapped"));
      }

      function doApply(closeAfter) {
        var value = textarea.value;

        if (!value) {
          toast(t("nothingToApply"), "warn");
          return false;
        }

        // 用户在下拉框里明确选了「不写入」：别自作聪明重新找一个目标，
        // 他就是要只编辑不落盘，如实告诉他没写才是对的。
        if (state.targetSource === "declined" && !state.target) {
          toast(t("targetDeclined"), "warn");
          return false;
        }

        if (targetIsGone(state.target)) {
          // 目标没了：重新解析一次，能救就救，救不回来就明确报错，绝不乱写。
          var fresh = resolveTarget(kind);
          state.target = fresh.target;
          state.candidates = fresh.candidates;
          state.targetSource = fresh.source;
          renderTarget();

          if (targetIsGone(state.target)) {
            toast(t("targetGone"), "error");
            return false;
          }
        }

        var result = Bridge.setWidgetText(state.target, value, { app: app });
        if (!result.verified) {
          debugLog("write not verified", { steps: result.steps, actual: result.value });
          toast(t("writeUnverified"), "warn");
          // 校验不过也继续收尾：值多半已经进去了，只是读回来的时机不同。
        }

        // 记住这个目标，下次没有选中任何东西时也能直接写回它。
        // 键里必须带工作流身份，否则换工作流后会写到别人身上（见 resolveFromMemory）。
        if (state.target.node && state.target.widget) {
          var workflowKey = currentWorkflowKey();
          if (workflowKey) {
            storage.setJson("lastTarget." + workflowKey + "." + kind, {
              nodeId: state.target.node.id,
              widgetName: state.target.widget.name,
              at: Date.now(),
            });
          }
          /**
           * 同时定下绑定：这是"以后按 P/N 直接写这儿"的依据。
           *
           * 能走到这一行的目标都不是猜的 —— 要么是绑定本身，要么是线认出来的，
           * 要么是用户点过/选中的框，要么是他刚才在候选里点的那一个。
           * 所以把它记成绑定是安全的，而且这正是用户要的：
           * 选一次，以后从画布任何角落按 P/N 都写到这儿，不用再拖视图。
           */
          setBinding(kind, state.target.node, state.target.widget);
        } else if (state.target.element) {
          lastInteracted.element = state.target.element;
          lastInteracted.time = Date.now();
        }

        var label = state.target.field || state.target.widgetName || "";
        var nodeTitle = state.target.nodeTitle || "";

        clearDraft();
        history.clear();

        if (closeAfter !== false) {
          // 先落位再关，视觉上像“把内容放进去了”。
          moveNearTarget();
          hide({ silent: true });
        }

        if (nodeTitle) toast(t("appliedTo", { node: nodeTitle, field: label }), "ok");
        else toast(t("appliedPlain"), "ok");

        debugLog("applied", value.length, "chars ->", nodeTitle || "(detached element)", label);
        return true;
      }

      // ------------------------------------------------------------ 显隐

      function focusEditor(selectAll) {
        try {
          textarea.focus({ preventScroll: true });
        } catch (err) {
          try {
            textarea.focus();
          } catch (err2) {
            /* ignore */
          }
        }
        if (selectAll) {
          try {
            textarea.select();
          } catch (err) {
            /* ignore */
          }
        }
      }

      function show(showOptions) {
        var o = showOptions || {};

        if (state.visible) {
          if (o.focus !== false) focusEditor();
          return;
        }

        state.visible = true;
        overlay.classList.remove("xwph-hidden");
        // 新一次会话：草稿的「已被应用消费」状态归零。
        state.draftCleared = false;
        // 用户可能在画布上补了连线/删了节点，角色判定不能吃上次的缓存。
        clearRoleCache();
        state.pickerManual = false;

        // 目标：显式传入 > 重新解析。
        if (o.target) {
          state.target = o.target;
          state.candidates = o.candidates && o.candidates.length ? o.candidates : buildCandidates(o.target);
          state.targetSource = o.source || "explicit";
        } else {
          var fresh = resolveTarget(kind);
          state.target = fresh.target;
          state.candidates = fresh.candidates;
          state.targetSource = fresh.source;
        }

        renderTarget();

        if (o.stickToTarget !== false) moveNearTarget();

        /**
         * 内容优先级：未应用的草稿 > 目标控件当前内容 > 空。
         * 草稿必须赢，否则用户上次辛苦粘的一半内容会被控件里的旧值顶掉。
         */
        var draft = storage.getText("draft." + kind, "");
        if (draft) {
          textarea.value = draft;
          if (!state.draftNoticed) {
            toast(t("draftRestored"));
            state.draftNoticed = true;
          }
        } else if (state.target) {
          textarea.value = state.target.value || "";
        } else {
          textarea.value = "";
        }

        state.editorDirty = false;
        state.lastCommitted = textarea.value;
        state.pastedOnce = false;
        state.cursorKnown = false;
        refreshCounter();

        if (o.focus !== false) focusEditor();

        debugLog("shown", kind, "target:", state.target ? state.target.nodeTitle + "/" + state.target.field : "(none)", "source:", state.targetSource);
      }

      function hide(hideOptions) {
        var o = hideOptions || {};
        if (!state.visible) return;

        state.visible = false;
        overlay.classList.add("xwph-hidden");
        closeLibraryMenu();

        // 草稿立刻落盘：用户可能马上就关浏览器。
        flushDraft();

        if (o.restoreFocus !== false) {
          var anchor = state.anchorElement;
          if (Bridge.isElement(anchor) && anchor.isConnected !== false && typeof anchor.focus === "function") {
            try {
              anchor.focus({ preventScroll: true });
            } catch (err) {
              /* ignore */
            }
          }
        }
      }

      function pushText(value) {
        commitText(value);
      }

      /**
       * 外面来的文本（别处复制、别处粘贴 —— 见 manager 的 copy / paste 捕获监听）。
       *
       * 收不收、放哪儿，规则要**可预期**（用户 m05666：「其实最好的效果就是 在其它地方
       * 只要有 复制的命令触发，这边打开的 就自己动 粘帖 进来」）：
       *   1. 输入框里还是"刚打开时预填的那份"（`editorDirty` 为假）→ **整体替换**。
       *      预填的是目标控件里的旧值，那是"待改的东西"，不是用户要保住的东西；
       *      而他复制一段提示词过来，本意就是"这次写这个"。
       *   2. 用户已经打过字了（`editorDirty` 为真）→ **接在后面**，绝不覆盖他打的字。
       * 两种情况都**不动焦点**：他可能还在别处接着复制，抢焦点会打断他。
       *
       * @returns {boolean} 真收下了才回 true（内容一样、或空的就不收）
       */
      function receiveText(text) {
        var value = String(text === null || text === undefined ? "" : text);
        if (!value.trim()) return false;

        var current = textarea.value;
        if (value === current) return false;

        history.push(current);
        if (!state.editorDirty || !current) {
          textarea.value = value;
        } else {
          textarea.value = current + (current.slice(-1) === "\n" ? "" : "\n") + value;
        }
        // 收完仍然是"没动过"的状态：连着复制两次时第二次应当替换第一次，
        // 而不是越接越长（用户改主意换提示词是常事）。
        state.editorDirty = false;
        state.lastCommitted = textarea.value;
        scheduleDraftSave();
        refreshCounter();
        return true;
      }

      // ------------------------------------------------------------ 事件

      applyBtn.addEventListener("click", function (e) {
        swallow(e);
        doApply(true);
      });
      closeFootBtn.addEventListener("click", function (e) {
        swallow(e);
        hide();
      });
      clearBtn.addEventListener("click", function (e) {
        swallow(e);
        doClear();
      });
      autoPasteBox.addEventListener("change", function (e) {
        stopEvent(e);
        setAutoPaste(autoPasteBox.checked);
        toast(t(autoPasteBox.checked ? "autoPasteOn" : "autoPasteOff"), "ok");
      });
      swapBtn.addEventListener("click", function (e) {
        swallow(e);
        doSwap();
      });
      settingsBtn.addEventListener("click", function (e) {
        swallow(e);
        if (opts.onOpenSettings) opts.onOpenSettings();
      });

      // 文字大小：每点一下走一步（0.1 倍），并把新倍数报给用户 —— 不然点了没反馈，
      // 用户会以为按钮没反应（标题栏上那两个按钮以前就吃过这个亏）。
      function nudgeFont(delta) {
        var next = setFontScale(fontScale() + delta * fontStepFor(fontScale()));
        toast(t("fontScaleToast", { percent: Math.round(next * 100) }), "ok");
      }
      fontDownBtn.addEventListener("click", function (e) {
        swallow(e);
        nudgeFont(-1);
      });
      fontUpBtn.addEventListener("click", function (e) {
        swallow(e);
        nudgeFont(1);
      });

      /**
       * 滚轮实时调字号（用户 1.0.4：「里面的文字…比如按滚轮就实时调整字的大小」）。
       *
       * 用户要的是"只放大里面的正文"，所以只有 `.xwph-textarea` 跟着变
       * （见 CSS 里那段注释）。滚轮这边有个必须守住的例外：
       * **输入框里不带 Ctrl 的滚轮要留给滚动** —— 提示词动辄几千字，抢掉滚动就没法读了。
       * 所以：Ctrl/Cmd + 滚轮（在面板任何位置）= 调字号；输入框里光滚 = 滚动；
       * 面板其它地方（标题栏、目标条、页脚）光滚也当调字号 —— 那里本来也没东西可滚。
       */
      dialog.addEventListener(
        "wheel",
        function (e) {
          var node = e.target && typeof e.target.closest === "function" ? e.target : null;
          var scrollable = node && node.closest(".xwph-textarea, .xwph-picker");
          if (!(e.ctrlKey || e.metaKey) && scrollable) return; // 老老实实滚
          swallow(e);
          var dir = (e.deltaY || 0) < 0 ? 1 : -1;
          setFontScale(fontScale() + dir * fontStepFor(fontScale()));
        },
        { passive: false },
      );
      targetSelect.addEventListener("change", function (e) {
        stopEvent(e);
        onTargetChange();
      });

      // 输入：维护撤销栈 + 防抖落盘 + 计数。
      textarea.addEventListener("input", function () {
        // 用户又动手改了：草稿重新变得有意义，解除「已被应用消费」的封锁。
        state.draftCleared = false;
        if (!state.editorDirty) {
          state.editorDirty = true;
          history.push(state.lastCommitted);
        }
        state.lastCommitted = textarea.value;
        scheduleDraftSave();
        refreshCounter();
      });

      textarea.addEventListener("select", function () {
        state.cursorKnown = true;
      });
      textarea.addEventListener("click", function () {
        state.cursorKnown = true;
      });
      textarea.addEventListener("keyup", function () {
        state.cursorKnown = true;
      });

      /**
       * 面板内的键盘处理，全部在捕获阶段吃掉。
       * 画布的 keydown 处理器挂在 document 上，不拦的话用户在这里打字
       * 可能同时触发画布快捷键（删节点、切标签之类）。
       */
      textarea.addEventListener(
        "keydown",
        function (e) {
          stopEvent(e);

          if (e.key === "Escape") {
            preventEvent(e);
            hide();
            return;
          }

          if (e.key !== "Enter") return;

          /**
           * 回车 = 应用并关闭；Shift + 回车 = 换行。
           *
           * 用户的要求（原话）：「Ctrl+S 应用并关闭 没有用，不如直接回车 就行，
           * 在里面要换行 shift + 回车」。所以：
           *   - 光按回车 -> 应用并关闭（提示词里换行是少数情况，提交是多数）
           *   - Shift + 回车 -> 老老实实插一个换行，不提交
           *   - Ctrl/Cmd + 回车 -> 也当应用，照顾已经习惯了的人
           * 输入法组词期间（e.isComposing / keyCode 229）一律不碰，否则中文选词一回车就提交了。
           */
          if (e.isComposing || e.keyCode === 229) return;

          if (e.shiftKey) return; // 留给浏览器插换行

          preventEvent(e);
          doApply(true);
        },
        true
      );

      /**
       * 隔离画布的方式是**阻止冒泡**，而不是在捕获阶段截胡。
       *
       * 这里踩过一个实打实的坑：一开始写的是 overlay.addEventListener(..., true)，
       * 也就是捕获阶段。捕获是从 window 往下走的，overlay 在按钮前面，
       * 于是 overlay 先把click吃掉，按钮自己的 click 监听器**根本不会执行**——
       * 表现就是“点『应用并关闭』毫无反应”，而且因为事件确实被拦住了，
       * 画布那边看起来一切正常，非常难查。
       *
       * 现在改成冒泡阶段：按钮/输入框的处理器先跑完，事件再往上冒到 overlay
       * 被拦住，画布（以及画布那些挂在 document 上的监听器）依然收不到。
       * 用 stopImmediatePropagation 而不是 stopPropagation，是为了连
       * document 上排在同一阶段的其他监听器也一并挡住。
       *
       * 仍然**只**阻止传播、不 preventDefault：preventDefault 会把输入框聚焦、
       * 下拉框展开、文字选中这些默认行为一起掐掉。
       */
      var seal = function (e) {
        if (e && typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        else if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      };
      overlay.addEventListener("pointerdown", seal, false);
      overlay.addEventListener("pointerup", seal, false);
      overlay.addEventListener("click", seal, false);
      overlay.addEventListener(
        "contextmenu",
        function (e) {
          // 输入框内保留右键菜单（用户要用“粘贴”），其他位置屏蔽。
          var tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : "";
          if (tag === "TEXTAREA" || tag === "INPUT") return;
          seal(e);
        },
        false
      );

      // resize 是 window 上的事件，同样不能挂 globalThis。
      var resizeWin = opts.window || (global && globalThis.window);
      if (resizeWin && typeof resizeWin.addEventListener === "function") {
        resizeWin.addEventListener("resize", function () {
          if (!state.visible) return;
          applyGeometry();
        });
      }

      restoreGeometry();

      var panelApi = {
        kind: kind,
        overlay: overlay,
        dialog: dialog,
        textarea: textarea,
        isVisible: function () {
          return state.visible;
        },
        show: show,
        hide: hide,
        pushText: pushText,
        receiveText: receiveText,
        getText: function () {
          return textarea.value;
        },
        setAnchor: function (element) {
          state.anchorElement = element || null;
        },
        focusEditor: focusEditor,
        moveNearTarget: moveNearTarget,
        /**
         * 重新认一次目标并刷新目标条 / 依据行。
         *
         * 给"面板开着时又按了一次同一个快捷键"用（见 onKeydown）：那时用户要的是
         * "把这一种提示词写进去"，不是"把面板关掉"，所以要重新解析一次目标，
         * 但**不动输入框里的内容**（那可能是他打了一半的草稿）。
         */
        refreshTarget: function () {
          var fresh = resolveTarget(kind);
          if (!fresh.target) return;
          state.target = fresh.target;
          state.candidates = fresh.candidates;
          state.targetSource = fresh.source;
          renderTarget();
          moveNearTarget();
        },
        apply: doApply,
        flushDraft: flushDraft,
        getState: function () {
          return state;
        },
      };

      return panelApi;
    }

    // ---------------------------------------------------------------- 词库菜单

    /**
     * 词库下拉。
     *
     * 刻意用绝对定位的原生 div，而不是 primevue 的菜单组件：
     * 那个组件在两个前端版本里路径不同，引进来就等于给自己埋一个“升级即坏”的点。
     * 保存入口也做成内联输入框，不用 window.prompt —— 后者在 Electron / 沙箱 iframe
     * 里会返回 null，功能会直接失效。
     */
    var openLibraryMenuState = { menu: null, closer: null, timer: null };

    function closeLibraryMenu() {
      if (openLibraryMenuState.closer) {
        doc.removeEventListener("pointerdown", openLibraryMenuState.closer, true);
        openLibraryMenuState.closer = null;
      }
      if (openLibraryMenuState.timer) {
        globalThis.clearTimeout(openLibraryMenuState.timer);
        openLibraryMenuState.timer = null;
      }
      var menu = openLibraryMenuState.menu;
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
      openLibraryMenuState.menu = null;
    }

    function openLibraryMenu(anchor, panel) {
      closeLibraryMenu();

      var list = libraryAll();
      var menu = el("div", "xwph-libmenu");

      // ---- 保存当前内容 ----
      var saveRow = el("div", "xwph-libsave");
      var nameInput = doc.createElement("input");
      nameInput.className = "xwph-libinput";
      nameInput.type = "text";
      nameInput.placeholder = t("presetName");
      nameInput.maxLength = 60;
      var saveConfirm = button("xwph-btn-primary", t("save"));

      function commitSave() {
        var value = panel.getText();
        if (!value) {
          toast(t("nothingToApply"), "warn");
          return;
        }
        var name = String(nameInput.value || "").trim();
        if (!name) {
          try {
            nameInput.focus();
          } catch (err) {
            /* ignore */
          }
          return;
        }
        var saved = librarySave(name, value);
        if (saved) toast(t("librarySaved", { name: saved.name }));
        closeLibraryMenu();
      }

      saveConfirm.addEventListener("click", function (e) {
        swallow(e);
        commitSave();
      });
      nameInput.addEventListener("keydown", function (e) {
        stopEvent(e);
        if (e.key === "Enter") {
          preventEvent(e);
          commitSave();
        } else if (e.key === "Escape") {
          preventEvent(e);
          closeLibraryMenu();
        }
      });

      saveRow.appendChild(nameInput);
      saveRow.appendChild(saveConfirm);
      menu.appendChild(el("div", "xwph-libhead", t("saveAsPreset")));
      menu.appendChild(saveRow);

      // ---- 已存词条 ----
      if (!list.length) {
        menu.appendChild(el("div", "xwph-libempty", t("libraryEmpty")));
      } else {
        for (var i = 0; i < list.length; i++) {
          (function (entry) {
            var row = el("div", "xwph-librow");
            var useBtn = button("xwph-libname", entry.name);
            useBtn.title = String(entry.text || "").slice(0, 300);
            var delBtn = iconButton("✕", t("remove"));

            useBtn.addEventListener("click", function (e) {
              swallow(e);
              panel.pushText(entry.text);
              closeLibraryMenu();
            });
            delBtn.addEventListener("click", function (e) {
              swallow(e);
              libraryRemove(entry.name);
              toast(t("libraryRemoved"));
              closeLibraryMenu();
            });

            row.appendChild(useBtn);
            row.appendChild(delBtn);
            menu.appendChild(row);
          })(list[i]);
        }
      }

      (doc.body || doc.documentElement).appendChild(menu);
      openLibraryMenuState.menu = menu;

      // ---- 定位 ----
      var rect = anchor.getBoundingClientRect();
      var vp = viewportSize();
      var menuRect = menu.getBoundingClientRect();
      var x = rect.left;
      var y = rect.bottom + 6;
      if (x + menuRect.width > vp.width - VIEWPORT_MARGIN) x = vp.width - menuRect.width - VIEWPORT_MARGIN;
      if (y + menuRect.height > vp.height - VIEWPORT_MARGIN) y = rect.top - menuRect.height - 6;
      menu.style.left = Math.max(VIEWPORT_MARGIN, x) + "px";
      menu.style.top = Math.max(VIEWPORT_MARGIN, y) + "px";

      // 点外面关闭。延后一拍再挂，否则打开菜单的那次点击会立刻把它关掉。
      openLibraryMenuState.closer = function (e) {
        if (menu.contains(e.target)) return;
        closeLibraryMenu();
      };
      openLibraryMenuState.timer = globalThis.setTimeout(function () {
        openLibraryMenuState.timer = null;
        if (openLibraryMenuState.menu === menu) {
          doc.addEventListener("pointerdown", openLibraryMenuState.closer, true);
        }
      }, 0);

      try {
        nameInput.focus();
      } catch (err) {
        /* ignore */
      }
    }

    // ---------------------------------------------------------------- 快捷键

    function normalizeShortcut(shortcut) {
      if (!shortcut || typeof shortcut !== "object") return null;
      var key = String(shortcut.key || "").trim();
      if (!key) return null;
      return {
        key: key,
        code: shortcut.code ? String(shortcut.code) : null,
        ctrl: !!shortcut.ctrl,
        alt: !!shortcut.alt,
        shift: !!shortcut.shift,
        meta: !!shortcut.meta,
      };
    }

    /**
     * 默认快捷键就是**单个字母** P / N。
     *
     * 为什么不带修饰键也能用：需求就是"按一下 P 就弹出来"，组合键在这里反而是负担。
     * 代价是这两个字母在所有别的文本框里都被我们吃掉了，所以 onKeydown 里对
     * "焦点在别人的输入框"这种情况做了拦截 + 提示（见 shouldOpenFromTypingTarget）。
     * 想改回组合键的话：在 ComfyUI 设置面板里把它改成 Ctrl+Alt+P / Ctrl+Alt+N 即可，
     * 代码这边两种都认。
     */
    function defaultShortcuts() {
      return {
        positive: { key: "p", code: "KeyP", ctrl: false, alt: false, shift: false, meta: false },
        negative: { key: "n", code: "KeyN", ctrl: false, alt: false, shift: false, meta: false },
      };
    }

    function getShortcuts() {
      var defaults = defaultShortcuts();
      var saved = storage.getJson("shortcuts", null);
      var out = { positive: defaults.positive, negative: defaults.negative };

      if (saved && typeof saved === "object") {
        VALID_KINDS.forEach(function (kind) {
          // 存成 null 是**有意义的**：那是"这个键我不要了"（用户按 Delete 关掉它）。
          // 不能把它当成"没存过"而回落到默认值 —— 那样用户永远关不掉这个快捷键。
          if (Object.prototype.hasOwnProperty.call(saved, kind) && saved[kind] === null) {
            out[kind] = null;
            return;
          }
          var normalized = normalizeShortcut(saved[kind]);
          if (normalized) out[kind] = normalized;
        });
      }
      return out;
    }

    function setShortcuts(shortcuts) {
      storage.setJson("shortcuts", shortcuts);
    }

    /**
     * 把用户写/按下的东西变成组合键对象。
     *
     * 支持两种输入：
     *   - 字符串：`"P"`、`"N"`、`"Ctrl+Alt+P"`（原生设置面板里存的就是这种）；
     *   - KeyboardEvent：设置面板的"按键"框回传的事件对象。
     *
     * 单个字母/数字是允许的（用户明确要 P / N 这种），所以这里**不强制**修饰键；
     * 是否抢键留给 matchPanelShortcut 判断。
     */
    var MODIFIER_ALIASES = {
      ctrl: "ctrl", control: "ctrl",
      alt: "alt", option: "alt",
      shift: "shift",
      meta: "meta", cmd: "meta", command: "meta",
    };

    function parseShortcut(input) {
      if (input && typeof input === "object" && typeof input.key === "string") {
        // KeyboardEvent —— 直接按下时走这条路。
        var evKey = String(input.key);
        if (!evKey || MODIFIER_ALIASES[evKey.toLowerCase()]) return null;
        if (evKey === " ") evKey = "space";
        var evPrimary = !!(input.ctrlKey || input.metaKey);
        return {
          key: evKey.toLowerCase(),
          code: input.code ? String(input.code) : null,
          ctrl: evPrimary,
          alt: !!input.altKey,
          shift: !!input.shiftKey,
          meta: !!input.metaKey,
        };
      }

      if (typeof input !== "string") return null;
      var text = input.trim();
      if (!text) return null;

      var parts = text.split("+");
      var key = "";
      var flags = { ctrl: false, alt: false, shift: false, meta: false };

      for (var i = 0; i < parts.length; i += 1) {
        var piece = String(parts[i]).trim();
        if (!piece) continue;
        var mod = MODIFIER_ALIASES[piece.toLowerCase()];
        if (mod) flags[mod] = true;
        else key = piece;
      }

      if (!key) return null;
      if (key === " ") key = "space";
      return {
        key: key.toLowerCase(),
        code: null,
        ctrl: flags.ctrl,
        alt: flags.alt,
        shift: flags.shift,
        meta: flags.meta,
      };
    }

    /** normalizeShortcut 的字符串版：设置面板回传的 "Ctrl+Alt+P" 也能直接吃。 */
    function normalizeShortcutLoose(input) {
      if (typeof input === "string") return parseShortcut(input);
      return normalizeShortcut(input);
    }

    /** 反向：组合键对象 -> "Ctrl+Alt+P" 这种能写进设置项的字符串。 */
    function stringifyShortcut(shortcut) {
      var normalized = normalizeShortcut(shortcut);
      if (!normalized) return "";
      var parts = [];
      if (normalized.ctrl) parts.push("Ctrl");
      if (normalized.meta) parts.push("Meta");
      if (normalized.alt) parts.push("Alt");
      if (normalized.shift) parts.push("Shift");
      var label = String(normalized.key);
      if (label === " ") label = "Space";
      parts.push(label.length === 1 ? label.toUpperCase() : label);
      return parts.join("+");
    }

    function describeShortcut(shortcut) {
      var normalized = normalizeShortcutLoose(shortcut);
      if (!normalized) return t("notSet");
      var parts = [];
      if (normalized.ctrl) parts.push("Ctrl");
      if (normalized.meta) parts.push("Cmd");
      if (normalized.alt) parts.push("Alt");
      if (normalized.shift) parts.push("Shift");
      parts.push(String(normalized.key).length === 1 ? String(normalized.key).toUpperCase() : normalized.key);
      return parts.join(" + ");
    }

    /** 事件是不是正好命中这个组合键。 */
    function comboMatches(shortcut, e) {
      if (!shortcut || !e) return false;

      // Ctrl 与 Cmd 等价：Mac 用户按 Cmd+Alt+P 也应当能用。
      var primary = !!(e.ctrlKey || e.metaKey);
      if (primary !== !!shortcut.ctrl) return false;
      if (!!e.altKey !== !!shortcut.alt) return false;
      if (!!e.shiftKey !== !!shortcut.shift) return false;

      // code 优先：它对应物理键位，不受输入法 / AltGr 影响。
      if (shortcut.code && e.code) return String(e.code) === shortcut.code;
      return String(e.key || "").toLowerCase() === String(shortcut.key || "").toLowerCase();
    }

    /** 这个组合键自己带不带修饰键（决定要不要"抢"文本框里的按键）。 */
    function shortcutIsModified(shortcut) {
      return !!(shortcut && (shortcut.ctrl || shortcut.alt || shortcut.meta));
    }

    /** 命中哪个面板；同时告诉调用方这个按键只是"打字"还是真的触发了快捷键。 */
    function matchPanelShortcut(e, shortcuts) {
      var list = shortcuts || getShortcuts();
      var kind = null;

      if (comboMatches(list.positive, e)) kind = "positive";
      else if (comboMatches(list.negative, e)) kind = "negative";

      if (!kind) return { kind: null, plainTyping: false, shortcut: null };
      var shortcut = list[kind];

      // 不带修饰键的快捷键（默认就是 P / N）：当焦点在**别人的**输入框里时，
      // 用户按这个键的意图几乎一定是"打字"，而不是"打开浮窗"——
      // 全局吃键会让所有含 p/n 的提示词都没法手打。所以这里不抢，只留个提示。
      //
      // 唯一例外：焦点在**画布节点里的大文本框**上（`isGraphPromptBox`）。
      // 那正是用户要写提示词的地方，也是他按 P/N 前最可能先点一下的地方；
      // 在那里不让路，插件就等于没装（参见 `isGraphPromptBox` 的注释）。
      if (!shortcutIsModified(shortcut) && e && e.target) {
        var target = e.target;
        if (isTypingTarget(target) && !isOurPanelElement(target) && !isGraphPromptBox(target)) {
          return { kind: kind, plainTyping: true, shortcut: shortcut };
        }
      }

      return { kind: kind, plainTyping: false, shortcut: shortcut };
    }

    function isTypingTarget(node) {
      if (!Bridge.isElement(node)) return false;
      var tag = (node.tagName || "").toUpperCase();
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
      return !!node.isContentEditable;
    }

    function isOurPanelElement(node) {
      if (!Bridge.isElement(node)) return false;
      return !!(node.closest && node.closest(".xwph-overlay"));
    }

    /**
     * 这个焦点所在元素，是不是**画布上某个节点里的大文本框**。
     *
     * 为什么要单独认它：纯 P / N 单键在"别人的输入框"里一律不抢键（否则提示词里
     * 的 p / n 就没法手打了，见 `matchPanelShortcut`）。但由此产生了一个把整个功能
     * 堵死的后果 —— 用户最自然的起点恰恰就是**先点一下提示词框、再按 P/N**：
     *
     *   - 本意是「P 打开正向面板」，P 却被打成字写进了提示词；
     *   - 更要命的是 `onPointerDownCapture` 把"刚点过这个框"记进了 `lastInteracted`，
     *     于是用户先点框、再按 P 时连面板都不会开 —— 他看到的正是
     *     「完全没效果，为什么这一回你的命中率这么低」。
     *
     * 而画布上这种多行框**本来就是提示词的去处**：单键对它来说不是"打字命令"
     * （用户不会在大文本框里手敲孤零零一个 p），所以它必须放行。
     * 真正的单行小输入框（文件名前缀、种子、连接 ID 之类）仍然让路，
     * 那些地方打 p / n 是正经输入。
     */
    function isGraphPromptBox(node) {
      if (!Bridge.isWidgetElement(node)) return false;
      var tag = (node.tagName || "").toUpperCase();
      if (tag !== "TEXTAREA") return false;
      return !!Bridge.findWidgetByElement(node, app);
    }

    /**
     * 快捷键主处理器。
     *
     * 为什么挂在 document 的**捕获**阶段，而不用前端的 keybindings 注册接口：
     *   - 老前端（canvas 版 LiteGraph）根本没有那个接口；
     *   - 捕获阶段能保证在画布之前拿到事件，也就保证不被别人抢走；
     *   - 配合 stopPropagation，避免画布同时响应同一个按键。
     *
     * 与 ComfyUI 自带快捷键的冲突面为零：它内置的组合里只保留了 Ctrl+P
     * （浏览器打印），Ctrl+Alt+P/N 没有被占用；而 Ctrl+P 本身会因为
     * 我们要求 alt 同时按下而不会被误触发。
     */
    function onKeydown(e) {
      if (!e || e.repeat) return;

      // 正在用输入法组词时，任何按键都不该当成快捷键。
      if (e.isComposing) return;

      var hit = matchPanelShortcut(e);
      var kind = hit.kind;
      if (!kind) return;

      var target = e.target;

      // 焦点在别人的输入框里，而且快捷键本身是单字母：不抢这个按键，
      // 只提示一句。这不是"坏了"，是刻意保住提示词能手打。
      if (hit.plainTyping) {
        toast(t("plainKeyNeedsBlur", { key: describeShortcut(hit.shortcut) }));
        return;
      }

      // 带修饰键的快捷键遇到任何输入框都让路（沿用老行为）。
      if (isTypingTarget(target) && !isOurPanelElement(target)) return;

      swallow(e);

      var panel = panels[kind];
      if (!panel) return;

      /**
       * 已经开着的面板再按同一个键：**把它端到前面来重新定一次目标，不要关掉它**。
       *
       * 这里原来是 `panel.hide(); return;`（同一个键当开关用）。改成现在这样是因为
       * 用户 2026-10 报的那串毛病里，最后一条是"按了 P/N 之后面板莫名其妙就没了"：
       * 关掉面板的动作跟"应用并关闭"长得一模一样，用户根本分不清是自己按的还是插件干的，
       * 而他按 P 的本意永远是"我要写这一种提示词"。
       *
       * 换一个键（开着正向按 N）是**并列**关系，不是互斥：两个面板可以同时开着，
       * 这样用户能把正向和反向摆在一起对照着改（这条是用户早期明确要的，见 tests/run.mjs
       * 「两个面板可以同时开着」那条断言）。所以这里不再顺手把另一个 hide 掉。
       */
      if (panel.isVisible()) {
        // 不顶掉用户正在打的内容：只重新认一次目标、把依据行刷新一遍。
        panel.refreshTarget();
        if (typeof panel.focusEditor === "function") panel.focusEditor();
        return;
      }

      // 关面板时焦点要还回去，所以先记锚点。
      var anchor = Bridge.isWidgetElement(target) ? target : lastInteracted.element;
      panel.setAnchor(anchor);

      var resolved = resolveTarget(kind);
      panel.show({ target: resolved.target, candidates: resolved.candidates, source: resolved.source });
    }

    /**
     * 用 mousedown 的捕获阶段记录“用户点了哪个文本框”。
     *
     * 为什么不用 focusin：新版前端的控件在 mousedown 里就 stopPropagation 了，
     * focus 事件有时到不了 document；而捕获阶段的 mousedown 一定先经过我们。
     */
    function onPointerDownCapture(e) {
      var owner = panelOwning(e.target);
      if (owner) {
        // 在面板里按下的这一下，就把"最后碰过的面板"定成它。
        lastActiveKind = owner.kind;
        return;
      }

      var node = e.target;
      if (!Bridge.isWidgetElement(node)) return;

      var resolved = resolveFromElement(node);
      if (!resolved) return;

      lastInteracted.element = node;
      lastInteracted.time = Date.now();

      VALID_KINDS.forEach(function (kind) {
        if (panels[kind]) panels[kind].setAnchor(node);
      });

      debugLog("interaction recorded:", resolved.nodeTitle || "(detached)", resolved.field || "");
    }

    /** 这个 DOM 节点落在哪个开着的信息面板里（不在任何面板里就回 null）。 */
    function panelOwning(node) {
      for (var i = 0; i < VALID_KINDS.length; i++) {
        var panel = panels[VALID_KINDS[i]];
        if (!panel || !panel.isVisible()) continue;
        var overlay = panel.overlay;
        if (overlay && node && typeof overlay.contains === "function" && overlay.contains(node)) return panel;
      }
      return null;
    }

    // ---------------------------------------------------------------- 剪贴板自动送达

    /**
     * 「在别处按了复制，这边打开的面板自己收下」—— 用户 m05666 点名要的效果：
     * 「其实最好的效果就是 在其它地方只要有 复制的命令触发，这边打开的 就自己动 粘帖 进来。」
     *
     * 为什么绕开 `navigator.clipboard.readText()`：读剪贴板要浏览器放行，不给就失败 ——
     * 这正是他说的「粘帖 没有效果」。而 `copy` / `paste` 事件是**信使自己带着数据来的**，
     * 一个权限都不用要：
     *   - 在页面里选中文字后按 Ctrl+C（别的节点、别的插件的框、网页上的词条）→ copy 事件，
     *     选中内容就在事件上下文的 selection 里，剪贴板动作也是真的发生了（用户没有任何损失）；
     *   - 在别的程序里复制、回到这个页面按 Ctrl+V → paste 事件，clipboardData 就是那份文本。
     * 唯一的死角是"在别的程序里按 Ctrl+C"——那一下根本不会到达这个页面，谁也拦不到；
     * 所以那条路必须靠用户回到页面按一次 Ctrl+V 才成立，提示语里也是这么写的。
     *
     * 送到面板里只做一件事：把文本放进输入框（规则见 `receiveText`）。
     * **不写目标、不关面板、不动焦点**，也**不 preventDefault** —— 用户可能还在别处接着复制，
     * 而且页面原有的粘贴行为（画布粘节点、往节点框里粘）不能被我们改掉。
     */
    function clipboardTextFrom(e) {
      if (!e) return "";
      var data = e.clipboardData || globalThis.clipboardData || null;
      if (data && typeof data.getData === "function") {
        try {
          var text = data.getData("text/plain") || data.getData("text") || "";
          if (text) return String(text);
        } catch (err) {
          /* 换个来源继续找 */
        }
      }
      // 少数环境（含我们的测试桩）把内容直接挂在事件上。
      if (typeof e.detail === "string" && e.detail) return e.detail;
      if (typeof e.text === "string" && e.text) return e.text;
      return "";
    }

    /** 当前选中的文字：先问 Selection API，再退回输入框自己的选区。 */
    function selectedText() {
      var sel = null;
      try {
        if (typeof doc.getSelection === "function") sel = doc.getSelection();
      } catch (err) {
        sel = null;
      }
      if (sel) {
        var text = "";
        try {
          text = String(typeof sel.toString === "function" ? sel.toString() : sel);
        } catch (err2) {
          text = "";
        }
        if (text) return text;
      }

      // textarea / input 里的选区不进 Selection API，得自己从 value 上切。
      var active = doc.activeElement;
      if (active && typeof active.value === "string" && typeof active.selectionStart === "number") {
        var start = active.selectionStart;
        var end = typeof active.selectionEnd === "number" ? active.selectionEnd : start;
        if (end > start) return String(active.value).slice(start, end);
      }
      return "";
    }

    /**
     * 该把这个文本送进哪个面板。
     *
     * 两个面板都开着时送到"最后碰过的那个"（`lastActiveKind`）；只开着一个就送它；
     * 一个都没开就什么也不做 —— 用户说的是"这边打开的 就自己动粘帖进来"，
     * 没开面板时往哪儿塞都是猜。
     */
    function panelForIncomingText() {
      var prefer = lastActiveKind && panels[lastActiveKind];
      if (prefer && prefer.isVisible()) return prefer;

      var visible = [];
      VALID_KINDS.forEach(function (kind) {
        if (panels[kind] && panels[kind].isVisible()) visible.push(panels[kind]);
      });
      return visible.length === 1 ? visible[0] : null;
    }

    function deliverIncomingText(text, origin) {
      var value = String(text === null || text === undefined ? "" : text);
      if (!value.trim()) return false;

      var panel = panelForIncomingText();
      if (!panel) return false;

      var taken = panel.receiveText(value);
      if (taken) {
        // 记下"最后送进去的是哪一份"：自动读取那条路靠它去重（见 tryAutoPasteFromClipboard）。
        lastDeliveredClip = value;
        lastActiveKind = panel.kind;
        toast(t("autoPasted", { count: value.length }), "ok");
        debugLog("clipboard " + origin + " ->", panel.kind, value.length, "chars");
      }
      return taken;
    }

    function onCopyCapture(e) {
      // 面板自己里面的复制是"往外拿"，不拦也不插手。
      if (isOurPanelElement(e.target)) return;
      var text = clipboardTextFrom(e) || selectedText();
      if (!text) return;
      deliverIncomingText(text, "copy");
    }

    function onPasteCapture(e) {
      // 焦点在面板输入框里：浏览器自己会粘，我们插手会粘成两份。
      if (isOurPanelElement(e.target)) return;
      var text = clipboardTextFrom(e);
      if (!text) return;
      deliverIncomingText(text, "paste");
    }

    function onFocusInCapture(e) {
      var owner = panelOwning(e.target);
      if (owner) lastActiveKind = owner.kind;
    }

    // ---------------------------------------------------------------- 文字大小
    //
    // 用户 1.0.4：「打开的对话框里文字太小，加入大小调节」。
    //
    // 面板里所有字号都乘 `--xwph-scale`（CSS 里写成 `calc(Npx * var(--xwph-scale, 1))`），
    // 这里只负责存一个倍数、并把变量写到**根节点**上（变量只被我们自己的 CSS 规则引用，
    // 所以不会影响 ComfyUI 本体）。面板标题栏的 A- / A+ 与设置面板里那一行改的是同一个值。
    var FONT_MIN = 0.7;
    // 用户 1.0.4 追加：「最大 400%」。
    var FONT_MAX = 4;
    var FONT_STEP = 0.1;

    /** 步进：200% 以下 10% 一步，再往上 25% 一步（不然点到 400% 要按三十来下）。 */
    function fontStepFor(value) {
      return Number(value) >= 2 ? 0.25 : FONT_STEP;
    }

    function clampFontScale(value) {
      var n = Number(value);
      if (!isFinite(n) || n <= 0) n = 1;
      // 存两位小数：0.1 累加会出 1.2000000000000002 这种数，写进存储很难看。
      n = Math.round(n * 100) / 100;
      if (n < FONT_MIN) return FONT_MIN;
      if (n > FONT_MAX) return FONT_MAX;
      return n;
    }

    function fontScale() {
      return clampFontScale(storage.getText("fontScale", "1"));
    }

    /** 把当前倍数写到根节点。返回真正生效的倍数。 */
    function applyFontScale() {
      var value = fontScale();
      try {
        var root = doc.documentElement || doc.body;
        if (root && root.style && typeof root.style.setProperty === "function") {
          root.style.setProperty("--xwph-scale", String(value));
        }
      } catch (err) {
        /* 老浏览器/桩没有 setProperty：字号不跟着变，功能不受影响 */
      }
      return value;
    }

    function setFontScale(next) {
      storage.setText("fontScale", String(clampFontScale(next)));
      return applyFontScale();
    }

    // ---------------------------------------------------------------- 自动粘贴开关

    /**
     * 「自动粘贴」开关：面板页脚那个勾选框 = 设置里的那一项 = 同一个开关。
     *
     * 用户 m0627x 的原话是「在界面和设置里都给一个勾选」。所以真相只有一份：
     * 插件自己的 localStorage（键 `autopaste`，默认开）。`prompt_helper.js` 里那条原生
     * 设置项通过 `setAutoPaste` 写同一个键，两边不会打架。
     */
    var autoPasteBoxes = [];

    function autoPasteEnabled() {
      return storage.getText("autopaste", "1") !== "0";
    }

    function registerAutoPasteBox(box) {
      if (!box || autoPasteBoxes.indexOf(box) !== -1) return;
      autoPasteBoxes.push(box);
      box.checked = autoPasteEnabled();
    }

    function syncAutoPasteBoxes() {
      var on = autoPasteEnabled();
      // 面板是开开关关的：把已经被移出文档的勾选框顺手清掉，免得数组越攒越长。
      autoPasteBoxes = autoPasteBoxes.filter(function (box) {
        return box && box.isConnected !== false;
      });
      autoPasteBoxes.forEach(function (box) {
        box.checked = on;
      });
    }

    function getAutoPaste() {
      return autoPasteEnabled();
    }

    function setAutoPaste(on) {
      storage.setText("autopaste", on ? "1" : "0");
      syncAutoPasteBoxes();
      debugLog("autopaste", on ? "on" : "off");
      return autoPasteEnabled();
    }

    /**
     * 「在别的程序里复制 → 切回这个页面」这一下：页面重新拿到焦点时读一次剪贴板。
     *
     * 这是唯一能覆盖"从浏览器外面复制"的办法：那一下 Ctrl+C 根本不会到达这个页面
     * （copy 事件只在页面内触发），只能等用户切回来时自己去读一次。
     *
     * 三条必须守住的纪律：
     *   ① 只在开关打开时读，且两次之间至少隔 AUTO_PASTE_MIN_GAP_MS
     *      （用户 alt-tab 来回切会让 focus 事件连发，不设间隔会连读好几次）；
     *   ② 同一份文本只送一次（`lastDeliveredClip`），否则点一下窗口就多一份；
     *   ③ 读不到就**静默降级**，每种失败只提示一次。Firefox 明确禁止没有用户手势的
     *      `readText()`（用户问过一次「Firefox 为什么不行」）—— 那是浏览器的规矩，
     *      不是插件坏了，所以提示语直接告诉他"按 Ctrl + V 一样管用"，
     *      而不是每次切窗口都弹一句错误。
     */
    var AUTO_PASTE_MIN_GAP_MS = 600;
    var autoPasteState = { lastTry: 0, denied: false, unsupported: false };
    var lastDeliveredClip = "";

    function readClipboardText() {
      var clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      if (!clipboard || typeof clipboard.readText !== "function") return null;
      try {
        var promise = clipboard.readText();
        return promise && typeof promise.then === "function" ? promise : null;
      } catch (err) {
        return null;
      }
    }

    function tryAutoPasteFromClipboard(origin) {
      if (!autoPasteEnabled()) return false;

      var now = Date.now();
      if (now - autoPasteState.lastTry < AUTO_PASTE_MIN_GAP_MS) return false;
      autoPasteState.lastTry = now;

      var promise = readClipboardText();
      if (!promise) {
        if (!autoPasteState.unsupported) {
          autoPasteState.unsupported = true;
          toast(t("autoPasteUnsupported"), "warn");
        }
        return false;
      }

      promise.then(
        function (raw) {
          var value = String(raw === null || raw === undefined ? "" : raw);
          if (!value.trim()) return;
          // 上次送进去的就是这一份：别再送一遍（用户可能只是切出去又切回来）。
          if (value === lastDeliveredClip) return;
          deliverIncomingText(value, origin || "focus");
        },
        function () {
          if (!autoPasteState.denied) {
            autoPasteState.denied = true;
            toast(t("autoPasteDenied"), "warn");
          }
        }
      );
      return true;
    }

    function onWindowFocus() {
      tryAutoPasteFromClipboard("focus");
    }

    function onVisibilityChange() {
      if (doc.hidden) return;
      tryAutoPasteFromClipboard("visible");
    }

    // ---------------------------------------------------------------- 对外接口

    function open(kind, openOptions) {
      var o = openOptions || {};
      if (VALID_KINDS.indexOf(kind) === -1) return null;

      var panel = panels[kind];
      if (!panel) return null;

      lastActiveKind = kind;
      closeLibraryMenu();

      // 锚点：优先当前编辑中的框，其次刚点过的框。
      var anchor = null;
      try {
        if (Bridge.isWidgetElement(doc.activeElement)) anchor = doc.activeElement;
      } catch (err) {
        anchor = null;
      }
      if (!anchor) anchor = lastInteracted.element;
      panel.setAnchor(anchor);

      var resolved = o.target
        ? { target: o.target, candidates: buildCandidates(o.target), source: "explicit" }
        : resolveTarget(kind);

      panel.show({
        target: resolved.target,
        candidates: resolved.candidates,
        source: resolved.source,
        focus: o.focus !== false,
        stickToTarget: o.stickToTarget !== false,
      });

      ensureStyles();
      return panel;
    }

    function closeAll() {
      closeLibraryMenu();
      VALID_KINDS.forEach(function (kind) {
        if (panels[kind]) panels[kind].hide({ silent: true, restoreFocus: false });
      });
    }

    function isAnyVisible() {
      for (var i = 0; i < VALID_KINDS.length; i++) {
        if (panels[VALID_KINDS[i]] && panels[VALID_KINDS[i]].isVisible()) return true;
      }
      return false;
    }

    /** 供画布右键菜单用：在指定节点上挑一个合适的文本框并打开面板。 */
    function openForNode(node, kind) {
      if (!node || !Array.isArray(node.widgets)) return null;

      var widgets = Bridge.listTextWidgets(node);
      if (!widgets.length) return null;

      /**
       * 名称里带 negative 的优先给反向面板，反之亦然 —— 节点作者的命名习惯很统一，
       * 这条规则在 CLIPTextEncode 这类节点上命中率很高。
       * 但只有在用户没先点过具体文本框时才用它（调用方 open() 里会再解析一次）。
       */
      var preferNegative = kind === "negative";
      var picked = null;
      for (var i = 0; i < widgets.length; i++) {
        var name = String(widgets[i].widget.name || "").toLowerCase();
        var looksNegative = name.indexOf("negative") !== -1 || name.indexOf("neg") === 0;
        if (looksNegative === preferNegative) {
          picked = widgets[i].widget;
          break;
        }
      }
      if (!picked) picked = widgets[0].widget;

      return open(kind, { target: Bridge.inspectTarget(node, picked) });
    }

    /** 当前解析出来的目标信息，供设置界面 / 诊断显示。 */
    function describeTarget(kind) {
      var resolved = resolveTarget(kind);
      // 认不出目标时也把候选节点 id 报出来：这是测试**唯一**能看到"候选到底是谁"的口子。
      // 不报的话，测试只能先假设某个 id 就是候选、再逼面板去点它 —— 那样测的是假定，不是候选。
      var ids = [];
      if (!resolved.target && resolved.candidates) {
        for (var i = 0; i < resolved.candidates.length; i++) {
          var box = resolved.candidates[i];
          if (box && box.target) ids.push(box.target.nodeId);
        }
      }
      if (!resolved.target) return { found: false, source: resolved.source, candidates: ids };
      return {
        found: true,
        source: resolved.source,
        nodeId: resolved.target.nodeId,
        nodeTitle: resolved.target.nodeTitle,
        field: resolved.target.field,
        widgetName: resolved.target.widgetName,
        detached: !!resolved.target.detached,
        // 判定依据（"widget" / "link" / "own-port" / "fallback-positive"）：
        // 探针和测试靠它区分"真的认出来了"和"按正向兜底的"，不要再靠猜。
        roleVia: resolved.target.roleVia || "",
        role: roleOfNode(resolved.target.node, resolved.target.widget),
      };
    }

    /**
     * 目标解析走到哪一环、每一环看到了什么。**只读诊断用**（真机探针 / 测试）。
     *
     * 为什么需要它：`describeTarget()` 只回一个结论（`source: "unbound"`），
     * 于是"为什么没认出来"只能靠读代码猜 —— 而这个项目已经因为猜栽过一次
     * （m02910：测试桩自己装了 `__comfy_node`，真机上恒返回 null）。
     * 判据本身（`Bridge.tracePromptRole`）在真机上是对的，断的是它到目标之间某一环，
     * 所以把每一环的中间值摊开：工作流键、候选框的数量/角色/能不能写、独苗命中谁。
     */
    function resolveTrace(kind) {
      var trace = { kind: kind, workflowKey: currentWorkflowKey() };

      var bound = resolveBound(kind);
      trace.step1_bound = bound && bound.target ? { nodeId: bound.target.nodeId, widgetName: bound.target.widgetName } : null;

      var boxes = promptBoxes();
      trace.step2_boxCount = boxes.length;
      trace.step2_boxes = boxes.map(function (b) {
        var boxTrace = roleTraceOf(b.node, b.widget);
        return {
          nodeId: b.target ? b.target.nodeId : null,
          widgetName: b.widget ? b.widget.name : null,
          role: b.role || "",
          roleVia: (boxTrace && boxTrace.via) || "",
          roleStop: (boxTrace && boxTrace.stop) || "",
          label: b.label || "",
          writable: !!b.target,
        };
      });

      var auto = soleCandidateByRole(boxes, kind);
      trace.step2_soleHit = auto && auto.target ? auto.target.nodeId : null;
      trace.step3_lastInteracted = lastInteracted.element ? "有元素" : "没有";
      try {
        trace.step3_activeIsWidget = Bridge.isWidgetElement(doc.activeElement);
      } catch (err) {
        trace.step3_activeIsWidget = "err";
      }
      try {
        trace.step4_selectedNodes = selectedNodes().length;
      } catch (err) {
        trace.step4_selectedNodes = "err";
      }
      trace.step5_memory = resolveFromMemory(kind) ? "有" : "没有";
      // 第 ⑦ 条：认不出角色时只对"正向"生效的兜底 —— 探针要能看出它有没有被用上。
      var unrole = unroleBox();
      trace.step6_unroleBox = unrole && unrole.target ? unrole.target.nodeId : null;
      trace.step6_assumesPositive = !!unrole && kind === "positive";
      return trace;
    }

    // ---------------------------------------------------------------- 样式

    function ensureStyles() {
      var id = "xwph-style";
      var existing = doc.getElementById && doc.getElementById(id);
      if (existing) return existing;

      var link = doc.createElement("link");
      link.id = id;
      link.rel = "stylesheet";

      // 从**本模块自己的 URL** 反推 css 目录：本文件永远是 `<路由>/js/prompt_panel.js`，
      // 所以把 `/js/<文件名>` 换成 `/css/prompt_panel.css` 就一定是同一个路由下的样式表。
      // 目录名被用户改过、插件被装到别的子路径下，这条路都跟着走（1.0.5 就是死在这里）。
      var href = null;
      if (SELF_URL) href = SELF_URL.replace(/\/js\/[^/?#]*$/, "/css/prompt_panel.css");
      if (!href) {
        // 退路：非常规加载方式（例如被内联成普通脚本）时 currentScript 才有值。
        try {
          var current = doc.currentScript && doc.currentScript.src;
          if (current) href = current.replace(/\/js\/[^/]*$/, "/css/prompt_panel.css");
        } catch (err) {
          href = null;
        }
      }
      // 最后的兜底：目录名被改过时这条一定 404，只保证“至少有个地址可以试”。
      if (!href) href = "/extensions/comfyui-xwide-prompt-helper/css/prompt_panel.css";

      link.href = href;
      (doc.head || doc.documentElement).appendChild(link);
      debugLog("stylesheet injected:", href);
      return link;
    }

    // ---------------------------------------------------------------- 组装

    panels.positive = createPanel("positive");
    panels.negative = createPanel("negative");

    var host = doc.body || doc.documentElement;
    host.appendChild(panels.positive.overlay);
    host.appendChild(panels.negative.overlay);

    function init(api) {
      ensureStyles();

      // 先把字号倍数写到根节点上：面板还没建也让它先生效（建面板时会再写一次）。
      applyFontScale();

      // 能拿到真 CLIP tokenizer 就用它数 token（拿不到就一直粗估，不影响功能）。
      var tokenizer = resolveTokenizer(api) || resolveTokenizer(app && app.extensionManager);
      if (tokenizer) clipTokenizer = tokenizer;

      doc.addEventListener("keydown", onKeydown, true);
      doc.addEventListener("pointerdown", onPointerDownCapture, true);
      // 别处一复制/粘贴，打开着的面板自己收下（详见那一节的长注释）。
      doc.addEventListener("copy", onCopyCapture, true);
      doc.addEventListener("paste", onPasteCapture, true);
      doc.addEventListener("focusin", onFocusInCapture, true);

      // 关页面前把草稿落盘（应用过的草稿已在 apply 时清掉）。
      //
      // 挂 window 而不是 globalThis：浏览器里有 beforeunload 的是 window，
      // globalThis 上根本没有这个方法。没 window 就跳过，别为这个炸掉 init。
      var win = opts.window || (global && globalThis.window);
      if (win && typeof win.addEventListener === "function") {
        win.addEventListener("beforeunload", function () {
          VALID_KINDS.forEach(function (kind) {
            if (panels[kind]) panels[kind].flushDraft();
          });
        });

        // 从别的程序复制完切回来这一下（自动粘贴的第二条路，详见那一节）。
        win.addEventListener("focus", onWindowFocus, true);
      }
      doc.addEventListener("visibilitychange", onVisibilityChange, true);

      debugLog("initialized; storage =", storage.kind, "; locale =", t.locale);
    }

    return {
      t: t,
      locale: t.locale,
      init: init,
      open: open,
      closeAll: closeAll,
      isAnyVisible: isAnyVisible,
      openForNode: openForNode,
      describeTarget: describeTarget,
      resolveTrace: resolveTrace,
      ensureStyles: ensureStyles,
      getShortcuts: getShortcuts,
      setShortcuts: setShortcuts,
      defaultShortcuts: defaultShortcuts,
      describeShortcut: describeShortcut,
      parseShortcut: parseShortcut,
      stringifyShortcut: stringifyShortcut,
      normalizeShortcutLoose: normalizeShortcutLoose,
      comboMatches: comboMatches,
      shortcutIsModified: shortcutIsModified,
      matchPanelShortcut: matchPanelShortcut,
      normalizeShortcut: normalizeShortcut,
      onKeydown: onKeydown,
      estimateTokens: estimateTokens,
      toast: toast,
      // 自动粘贴开关：界面上的勾选框和设置里那一项共用这三个（同一个真相）。
      getAutoPaste: getAutoPaste,
      setAutoPaste: setAutoPaste,
      autoPasteEnabled: autoPasteEnabled,
      tryAutoPasteFromClipboard: tryAutoPasteFromClipboard,
      // 文字大小：面板标题栏的 A- / A+ 和设置里那一行共用这几个（同一个真相）。
      fontScale: fontScale,
      setFontScale: setFontScale,
      applyFontScale: applyFontScale,
      // 步进按当前值算：200% 以下 10%，再往上 25%（面板按钮与设置里那行都用它）。
      fontStep: fontStepFor,
      fontRange: function () {
        return { min: FONT_MIN, max: FONT_MAX };
      },
      _panels: panels,
      _storage: storage,
      _lastInteracted: lastInteracted,
      _debug: debugLog,
      _setDebug: function (flag) {
        debugEnabled = !!flag;
        storage.setText("debug", debugEnabled ? "1" : "0");
      },
      _library: { all: libraryAll, save: librarySave, remove: libraryRemove },
    };
  }

  var api = {
    createPanelManager: createPanelManager,
    estimateTokens: estimateTokens,
    DEFAULT_SIZE: DEFAULT_SIZE,
    MIN_SIZE: MIN_SIZE,
    VIEWPORT_MARGIN: VIEWPORT_MARGIN,
    VALID_KINDS: VALID_KINDS,
  };

  // 两个出口都写上（原因见 i18n.js 同一处的注释）。
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.XWidePromptPanel = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
