/*!
 * X-WIDE Prompt Input Helper —— 画布桥接层 / canvas bridge
 *
 * 这个文件的唯一职责：在「浮层里的纯文本」和「画布上某个节点控件的值」之间搬运数据，
 * 并且**只通过公开的控件对象读写**，绝不包装 ComfyWidgets、不包装节点原型、
 * 不动任何现有节点的注册流程。
 *
 * 之所以要这么小心，是因为 ComfyUI 前端的文本控件有三种形态，必须全都兜住：
 *
 *   1. 多行文本（multiline STRING）
 *      由 addMultilineWidget() 创建，本质是 addDOMWidget + 一个真实 <textarea>，
 *      widget.element 指向那个 textarea（老版本叫 widget.inputEl，仍可用但会打印弃用警告）。
 *      widget.getValue/setValue 的两个闭包才是真正的数据源。
 *
 *   2. 单行文本
 *      addWidget("text", ...)，纯 canvas 绘制，没有 DOM 元素。
 *      只能写 widget.value，然后靠 markDirty 让画布重绘。
 *
 *   3. 已被本插件或别的插件“穿透”过的 DOM 控件
 *      表现为 widget.element 是元素、widget.value 也能读写。
 *
 * 写入顺序固定为：官方 setValue 闭包 -> widget.value -> 直接写元素。
 * 三条都走完再校验一次，校验不过就把实际值原样返回，让上层决定怎么提示。
 */
(function (global) {
  "use strict";

  /** 判定用：这些 widget.type 才是文本输入控件。 */
  var TEXT_WIDGET_TYPES = ["text", "string", "customtext", "textarea"];

  /** 这几个 class 说明这个元素是 ComfyUI 画布上的控件，而不是别处的输入框。 */
  var WIDGET_ELEMENT_CLASSES = [
    "comfy-multiline-input",
    "comfy-multiline-widget",
    "comfy-text-input",
  ];

  function isElement(node) {
    return !!node && typeof node === "object" && node.nodeType === 1;
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      return fallback;
    }
  }

  /**
   * 从 widget 上找它背后的真实 DOM 文本元素。
   * 用 duck-typing 而不是 instanceof：插件运行在浏览器里，
   * HTMLTextAreaElement 在极端情况下未必能拿到构造器。
   */
  function getWidgetElement(widget) {
    if (!widget) return null;

    // element 是当前版本的正确字段；inputEl 是弃用别名，保留是为了兼容稍老的前端。
    var candidates = [widget.element, widget.inputEl];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isElement(el)) continue;
      var tag = (el.tagName || "").toUpperCase();
      if (tag === "TEXTAREA" || tag === "INPUT") return el;
    }
    return null;
  }

  /**
   * 这个元素是不是 ComfyUI 画布上的文本控件？
   * 特意不看父节点——因为控件外面套几层 div 是前端自由，
   * 而 class 名从引入 MultilineWidget 起就没变过。
   */
  function isWidgetElement(el) {
    if (!isElement(el)) return false;
    var tag = (el.tagName || "").toUpperCase();
    if (tag !== "TEXTAREA" && tag !== "INPUT") return false;

    var cls = typeof el.className === "string" ? el.className : "";
    for (var i = 0; i < WIDGET_ELEMENT_CLASSES.length; i++) {
      if (cls.indexOf(WIDGET_ELEMENT_CLASSES[i]) !== -1) return true;
    }

    // 兜底：老版前端的控件没有任何可识别 class，
    // 但它是画布容器的后代，而画布容器有固定 id。
    var inCanvas = safe(function () {
      return !!(el.closest && el.closest("#graph-canvas-container, .graph-canvas-container, .litegraph"));
    }, false);
    if (inCanvas) return true;

    // 再兜底：新版前端把控件画在 canvas 上层的 DOM 层里，靠 data-capture-wheel 标记过。
    if (el.getAttribute && el.getAttribute("data-capture-wheel") === "true") return true;

    return false;
  }

  /** 这个 widget 能不能用来装提示词。 */
  function isTextWidget(widget) {
    if (!widget) return false;
    var type = String(widget.type || "").toLowerCase();
    if (TEXT_WIDGET_TYPES.indexOf(type) !== -1) return true;
    // 有些插件自造类型（比如 "customtext"）没写进白名单时，用有没有元素来兜底。
    return !!getWidgetElement(widget);
  }

  /** widget 当前的值，统一转成字符串。 */
  function getWidgetValue(widget) {
    if (!widget) return "";
    var value = safe(function () {
      return typeof widget.getValue === "function" ? widget.getValue() : widget.value;
    }, widget.value);

    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : String(value);
  }

  /** 建议的控件名；options.display_name 是节点作者给的人类可读名。 */
  function widgetLabel(widget) {
    if (!widget) return "";
    return String((widget.options && widget.options.display_name) || widget.label || widget.name || "");
  }

  /** 一次拿到 (node, widget) 对以及对应的文本框。 */
  function inspectTarget(node, widget) {
    if (!node || !widget) return null;
    var element = getWidgetElement(widget);
    return {
      node: node,
      widget: widget,
      element: element,
      // 节点 id 在子图里可能重复，所以带上 graph 指针，方便上层判断“还在不在”。
      graph: safe(function () {
        return node.graph || null;
      }, null),
      nodeId: node.id,
      nodeTitle: String(node.title || node.type || ("#" + node.id)),
      field: widgetLabel(widget) || String(widget.name || ""),
      widgetName: String(widget.name || ""),
      value: getWidgetValue(widget),
    };
  }

  /**
   * 列出这个节点里所有能装提示词的控件。
   * multiline 的排在前面：绝大多数提示词框都是多行的，先给用户最可能的那个。
   */
  function listTextWidgets(node) {
    if (!node || !Array.isArray(node.widgets)) return [];
    var out = [];
    for (var i = 0; i < node.widgets.length; i++) {
      var widget = node.widgets[i];
      if (!isTextWidget(widget)) continue;
      out.push({ widget: widget, multiline: !!getWidgetElement(widget), index: i });
    }
    // 多行优先，其余保持原有顺序（稳定排序在 ES2019+ 是标准保证的）。
    out.sort(function (a, b) {
      return (b.multiline ? 1 : 0) - (a.multiline ? 1 : 0);
    });
    return out;
  }

  /** 从任意 DOM 元素往上找到它所属的 node（用于 mousedown 捕获）。 */
  function findNodeByElement(el) {
    if (!isElement(el)) return null;
    var cursor = el;
    // 控件外面可能包了好几层 div，最多爬 8 层就够，避免长链路卡顿。
    for (var depth = 0; cursor && depth < 8; depth++) {
      if (cursor.__comfy_node) return cursor.__comfy_node;
      if (cursor.node && typeof cursor.node === "object" && Array.isArray(cursor.node.widgets)) return cursor.node;
      cursor = cursor.parentElement;
    }
    return null;
  }

  /**
   * 让画布重绘。新版前端用 canvas.setDirty()，老版 LiteGraph 用 node.setDirtyCanvas()，
   * 两个都调一次最稳（和本仓库另一个插件 xwide_image.js 里的做法保持一致）。
   */
  function markDirty(node, app) {
    safe(function () {
      var canvas = app && app.canvas;
      if (canvas && typeof canvas.setDirty === "function") canvas.setDirty(true, true);
    });
    safe(function () {
      if (node && typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    });
  }

  /**
   * 把文本写进目标控件。
   *
   * 返回 {ok, value, verified, steps}：
   *   ok       —— 三条写入路径里至少成功了一条，且最终值等于要写的内容；
   *   value    —— 写完后再读回来的实际值（不相等时上层可以据此报错）；
   *   verified —— 读回来的值是否严格等于写入值；
   *   steps    —— 每条路径的结果，仅用于调试。
   */
  function setWidgetText(target, text, options) {
    var opts = options || {};
    var app = opts.app || globalThis.app;
    var node = target && target.node;
    var widget = target && target.widget;
    var steps = [];

    var desired = text === null || text === undefined ? "" : String(text);

    /**
     * 兜底：只拿到了元素、没认出它属于哪个控件。
     *
     * 必须留着这条路 —— 认不出控件的原因可能只是前端换了内部结构，
     * 但"把字写进那个 textarea 并派发 input"在 DOM 层面永远成立，
     * 前端自己的 v-model 会把值同步回去。以前这里直接返回 no-target，
     * 结果是**面板一关，字却没进去**，用户看到的就是"填不进去"。
     * 宁可写进去并如实报告"没验证到控件层"，也不要静默失败。
     */
    if (!widget) {
      var lonely = target && target.element;
      if (!isElement(lonely)) {
        return { ok: false, value: "", verified: false, steps: steps, reason: "no-target" };
      }
      try {
        lonely.value = desired;
        lonely.dispatchEvent(new Event("input", { bubbles: true }));
        steps.push("element-only:ok");
      } catch (err) {
        steps.push("element-only:throw:" + (err && err.message ? err.message : err));
      }
      var lonelyActual = String(lonely.value == null ? "" : lonely.value);
      return {
        ok: lonelyActual === desired,
        value: lonelyActual,
        verified: lonelyActual === desired,
        steps: steps,
        reason: "element-only",
      };
    }

    // ---- 路径 1：官方 setValue 闭包。多行控件只有这一条能真正改到数据源。 ----
    try {
      if (typeof widget.setValue === "function") {
        widget.setValue(desired);
        steps.push("setValue:ok");
      } else {
        steps.push("setValue:absent");
      }
    } catch (err) {
      steps.push("setValue:throw:" + (err && err.message ? err.message : err));
    }

    // ---- 路径 2：直接写 widget.value。单行 canvas 控件靠这条。 ----
    try {
      widget.value = desired;
      steps.push("value:ok");
    } catch (err) {
      steps.push("value:throw:" + (err && err.message ? err.message : err));
    }

    // ---- 路径 3：直接写真实元素。兜住那些没实现 setValue 的第三方控件。 ----
    var element = getWidgetElement(widget);
    if (element) {
      try {
        if (element.value !== desired) {
          element.value = desired;
          // 必须派发 input 事件：Vue 那层靠它同步模型，工作流草稿的自动保存也挂在这上面。
          element.dispatchEvent(new Event("input", { bubbles: true }));
          steps.push("element:ok");
        } else {
          steps.push("element:already");
        }
      } catch (err) {
        steps.push("element:throw:" + (err && err.message ? err.message : err));
      }
    } else {
      steps.push("element:absent");
    }

    // ---- 通知：让控件自身的回调、画布重绘都跑起来。 ----
    safe(function () {
      if (typeof widget.callback === "function") widget.callback(desired, app && app.canvas, node, [0, 0], null);
    });
    markDirty(node, app);

    // ---- 校验：写完再读一遍。读不回来就说明有别的插件在中途拦截。 ----
    var actual = getWidgetValue(widget);
    var verified = actual === desired;

    return {
      ok: verified,
      value: actual,
      verified: verified,
      steps: steps,
    };
  }

  /**
   * 从文本框反查 (node, widget)。
   *
   * 这是本插件最关键的一环，因为"点一下文本框再按快捷键"是最常用的用法，
   * 而**真实前端的 textarea 上并没有任何指回节点/控件的属性**：
   * 实测（ComfyUI 前端 1.53.6）`el.__comfy_node` 和 `el.node` 都是 undefined，
   * 打包后的前端代码里 "comfy_node" 这个字符串一次都没出现过。
   * 所以老办法（顺着 DOM 往上爬）在真机上永远返回 null。
   *
   * 可靠的做法是反过来找：遍历图上所有节点的所有控件，
   * 比对 `getWidgetElement(widget) === el` —— 元素是同一个对象，
   * 认控件就不可能认错，也不依赖前端内部实现。
   * 控件数量是"节点数 × 每节点几个"，几十个的量级，一次遍历毫无压力。
   */
  function findWidgetByElement(element, app) {
    if (!isElement(element)) return null;

    var graphs = [];
    var seenGraphs = [];
    var seenNodes = [];

    function addGraph(graph) {
      if (!graph || seenGraphs.indexOf(graph) !== -1) return;
      seenGraphs.push(graph);
      graphs.push(graph);
    }

    safe(function () {
      var root = app && app.graph;
      addGraph(root);
      // 子图也要找：提示词框经常被塞进子图里。
      var queue = [root];
      for (var qi = 0; qi < queue.length && qi < 32; qi++) {
        var subgraphs = queue[qi] && queue[qi].subgraphs;
        if (!Array.isArray(subgraphs)) continue;
        for (var si = 0; si < subgraphs.length; si++) {
          addGraph(subgraphs[si]);
          queue.push(subgraphs[si]);
        }
      }
      addGraph(globalThis.LiteGraph && globalThis.LiteGraph.rootGraph);
    });

    for (var gi = 0; gi < graphs.length; gi++) {
      var nodes = safe(function () {
        return graphs[gi]._nodes || [];
      }, []);
      for (var ni = 0; ni < nodes.length; ni++) {
        var node = nodes[ni];
        if (!node || seenNodes.indexOf(node) !== -1) continue;
        seenNodes.push(node);
        var widgets = node.widgets;
        if (!Array.isArray(widgets)) continue;
        for (var wi = 0; wi < widgets.length; wi++) {
          if (getWidgetElement(widgets[wi]) === element) {
            return { node: node, widget: widgets[wi], graph: graphs[gi] };
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------ 顺着线认正反

  /**
   * 为什么要有这一段（2026-08 用户定的方案）：
   *
   * 正向提示词框和反向提示词框**长得一模一样**（都是 CLIP文本编码 的多行文本框），
   * 靠标题、靠内容、靠位置都分不出来。用户一句话点破了真正的判据：
   * 「我连的那条线是正的，它便就是正的提示词」—— 也就是**线落到对面哪个入口**。
   * 实测（ComfyUI 前端 1.53.6 / KSampler）：
   *   #67 CLIP文本编码 ──link 76──▶ #70 K采样器 第 1 号入口 inputName="positive"
   *   #71 CLIP文本编码 ──link 82──▶ #70 K采样器 第 2 号入口 inputName="negative"
   * 入口名是纯英文（界面上的中文是前端翻译出来的），所以中英文词都要列上。
   *
   * ⚠️ **入口/控件的"显示名"不在 `name` 里**（2026-10 从用户真实工作流 JSON 上取证，
   * 见 roleNamesOf 的注释）。这里只保留词表，取名字的逻辑统一走 roleNamesOf。
   */

  /** 入口名/控件名里出现这些词 → 正向。 */
  var POSITIVE_HINTS = ["positive", "pos_", "正", "正面", "正向"];

  /**
   * 入口名/控件名里出现这些词 → 反向。
   *
   * 刻意**不**把 `system_prompt` 放进正类词表：真机上 6466 个节点类型里有几十个 LLM
   * 类节点带 `system_prompt`（那是"系统指令"，不是正向提示词），放进去会误认一大批。
   * 需要它在"一条链上只有它一个入口"时才当正向用 —— 那个判断在 roleFromNames 里。
   */
  var NEGATIVE_HINTS = ["negative", "neg_", "负", "负面", "反向"];


  /**
   * 线怎么走算是"这条路还在同一条语义链上"。
   * 只有在走到这些节点时，才继续顺着它的输出往下找正/反入口；
   * 碰到别的节点（比如某个把提示词存盘的插件），就当这条路认不出来。
   */
  var CHAIN_NODE_RE =
    /(sampler|guider|conditioning|encode|prompt|text|string|concat|combine|merge|join|basic_?scheduler|cfg|flux|sd3|wan|hunyuan|qwen)/i;

  /** 起点顺着这条线往下走时，最多允许穿过几个节点。 */
  var MAX_CHAIN_HOPS = 8;

  function textOf(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function containsAny(text, needles) {
    var hay = text.toLowerCase();
    for (var i = 0; i < needles.length; i++) {
      if (hay.indexOf(String(needles[i]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  /** 入口名 → "positive" / "negative" / ""。 */
  function roleFromPortName(name) {
    var text = textOf(name);
    if (!text) return "";
    if (containsAny(text, POSITIVE_HINTS)) return "positive";
    if (containsAny(text, NEGATIVE_HINTS)) return "negative";
    return "";
  }

  /**
   * 一个入口 / 一个控件身上**所有可能代表它名字的字符串**。
   *
   * 为什么必须一次全取（这是 2026-10 从用户真实工作流 JSON 里挖出来的关键事实）：
   * 新版前端把「节点作者/用户给的显示名」写进 `label`，而 `name` 保持原始名：
   *     {"label":"positive_prompt","localized_name":"prompt","name":"prompt","widget":{"name":"prompt"}}
   *   —— 用户在节点上看到的是 `positive_prompt`，入口真名却是 `prompt`！
   * 同理 `clip` 的 label 是 `pe`、图片口 `images.image_1` 的 label 是 `image_1`。
   * 只读 `name` 会把这些全认不出来（旧版本就是这么栽的）。
   *
   * 顺带把**控件自己的**名字也放进来（控件名 === 入口名时就是同一个提示词口），
   * 这样 `positive_prompt` / `negative_prompt` / `正向提示词` 这类写成控件名的节点也能直接认。
   */
  function roleNamesOf(thing) {
    var out = [];
    if (!thing || typeof thing !== "object") return out;

    function add(value) {
      if (typeof value !== "string") return;
      var text = value.replace(/\s+/g, " ").trim();
      if (!text || out.indexOf(text) !== -1) return;
      out.push(text);
    }

    var keys = ["label", "localized_name", "localizedName", "display_name", "displayName", "name", "title", "tooltip"];
    for (var i = 0; i < keys.length; i++) add(thing[keys[i]]);

    // 控件挂在入口上（`input.widget`）时，控件自己的名字与入口同源，一并看。
    var widget = thing.widget;
    if (widget && typeof widget === "object") {
      for (var wi = 0; wi < keys.length; wi++) add(widget[keys[wi]]);
    }
    // 少数节点把显示名放在 options.display_name 上。
    var options = thing.options;
    if (options && typeof options === "object") add(options.display_name);

    return out;
  }

  /**
   * 从"所有可能的名字"里判角色。
   *
   * `fallbackToPositive`（默认 false）是给**某个具体入口**用的兜底：当这个入口后面
   * 只有一个能走的口、且那个口叫 system_prompt 这类"没有正反字样"的名字时，
   * 按用户 2026-10 的明确要求「就当读不到正反时，只用正向向里填」认成正向。
   *
   * 注意这不是全局兜底 —— 全局的"认不出就填正向"在 prompt_panel 的 resolveTarget 里，
   * 这里只负责"这个名字是不是正/反"。
   */
  function roleFromNames(names, fallbackToPositive) {
    var list = names && names.length ? names : [];
    for (var i = 0; i < list.length; i++) {
      var role = roleFromPortName(list[i]);
      if (role) return role;
    }
    if (fallbackToPositive) {
      // 没有任何正反字样时：只要名字里出现"提示词 / 条件 / 文本"这类明确的提示词入口词，
      // 就算正向；`system_prompt` 这类只有 prompt 的也算（用户的节点就是这种）。
      for (var j = 0; j < list.length; j++) {
        if (/(prompt|text|string|conditioning|提示词|条件|文本)/i.test(String(list[j]))) return "positive";
      }
    }
    return "";
  }

  /** 把 graph.links（可能是数组、对象、Map）统一成函数取。 */
  function linksLookup(graph) {
    var table = graph && graph.links;
    if (!table) return function () { return null; };
    return function (id) {
      return safe(function () {
        if (typeof table.get === "function") return table.get(id) || null;
        return table[id] || null;
      }, null);
    };
  }

  /**
   * 一条 output.links 里的 link 可能是三种东西，全都要兜住：
   *   1. 数字 id        —— 真机实测就是这种（老式 LiteGraph）
   *   2. {target_id, target_slot} 对象 —— 新式前端
   *   3. [targetId, slot] 数组       —— 个别版本
   * 返回 {targetId, slot}。
   */
  function readLink(entry, lookup) {
    if (entry === null || entry === undefined) return null;

    if (typeof entry === "number" || typeof entry === "string") {
      var record = lookup(entry);
      if (!record) return null;
      var tid = record.target_id !== undefined ? record.target_id : record.targetId;
      var tslot = record.target_slot !== undefined ? record.target_slot : record.targetSlot;
      if (tid === undefined || tid === null) return null;
      return { targetId: tid, slot: tslot };
    }

    if (typeof entry === "object") {
      if (Array.isArray(entry)) {
        if (entry.length < 1) return null;
        return { targetId: entry[0], slot: entry[1] };
      }
      var id = entry.target_id !== undefined ? entry.target_id : entry.targetId;
      var slot = entry.target_slot !== undefined ? entry.target_slot : entry.targetSlot;
      if (id === undefined || id === null) return null;
      return { targetId: id, slot: slot };
    }

    return null;
  }

  /** 在若干张图里按 id 找节点。 */
  function findNodeInGraphs(graphs, id) {
    for (var gi = 0; gi < graphs.length; gi++) {
      var nodes = safe(function () {
        return graphs[gi]._nodes || graphs[gi].nodes || [];
      }, []);
      for (var ni = 0; ni < nodes.length; ni++) {
        if (String(nodes[ni] && nodes[ni].id) === String(id)) return nodes[ni];
      }
    }
    return null;
  }

  /** 收集和 findWidgetByElement 一样的那几张图（根图 + 子图）。 */
  function collectGraphs(app) {
    var graphs = [];
    var seen = [];

    function add(graph) {
      if (!graph || seen.indexOf(graph) !== -1) return;
      seen.push(graph);
      graphs.push(graph);
    }

    safe(function () {
      var root = (app && app.graph) || (globalThis.LiteGraph && globalThis.LiteGraph.rootGraph) || null;
      add(root);
      var queue = [root];
      for (var qi = 0; qi < queue.length && qi < 32; qi++) {
        var subs = queue[qi] && queue[qi].subgraphs;
        if (!subs) continue;
        var list = typeof subs.values === "function" ? Array.from(subs.values()) : subs;
        if (!Array.isArray(list)) continue;
        for (var si = 0; si < list.length; si++) {
          add(list[si]);
          queue.push(list[si]);
        }
      }
      add(globalThis.LiteGraph && globalThis.LiteGraph.rootGraph);
    });

    return graphs;
  }

  /** 这个节点的各个入口名字（用来在链路上判断"这节点是不是纯粹在传条件"）。 */
  function inputNamesOf(node) {
    var out = [];
    var inputs = (node && node.inputs) || [];
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i] && inputs[i].name) out.push(String(inputs[i].name));
    }
    return out;
  }

  /** 一个 link 记录到底属于谁的哪个输出口（兼容 origin_id/originNodeId 两种字段名）。 */
  function linkOrigin(record) {
    if (!record) return null;
    var id = record.origin_id !== undefined ? record.origin_id : record.originNodeId;
    if (id === undefined || id === null) return null;
    var slot = record.origin_slot !== undefined ? record.origin_slot : record.originSlot;
    return { id: id, slot: slot === undefined ? 0 : slot };
  }

  /**
   * **真机的连线不写在 `outputs[i].links` 里。**
   *
   * 这是花了大代价才查清的一件事（2026-10）：在真实前端上，给一个 CLIPTextEncode 连到
   * KSampler 的 positive 口之后，实测
   *     `node.outputs[0].links === []`（空的）
   *     `graph.links.get(linkId)` → `{ origin_id, origin_slot, target_id, target_slot }`（有）
   *     `sampler.inputs[1].link === 83`（有）
   * 也就是说：**只有入口那一端（`inputs[i].link`）和 graph 的 links 表是可靠的，
   * 出口那一端是空的。**（我们自己的测试桩以前两边都写，所以桩里全绿、真机上
   * 顺着出口走永远是 dead-end —— 又一个"桩和真机不一致"的坑，见 m02910 的 __comfy_node。）
   *
   * 所以这里同时看两处，并把两边的 link id 合起来去重：
   *   ① `node.outputs[slot].links`（桩里是它，某些 LiteGraph 版本也维护它）
   *   ② `graph.links` 里 `origin_id === node.id && origin_slot === slot` 的记录（真机靠它）
   *
   * 参数是一张 [graph, ...] 的图清单（`collectGraphs` 的产物），因为节点属于哪张图
   * 不一定能直接从节点对象上拿到。返回 `[{id, record, from}]`。
   *
   * `slot` 传 **-1** 表示"这个节点出去的线，不管从哪个输出口"（有些节点把输出口
   * 声明得不全，或者干脆用子图那种动态口）。
   */
  function outboundLinks(graphs, node, slot) {
    var found = [];
    var seenIds = [];
    var wanted = node && node.id !== undefined && node.id !== null ? String(node.id) : null;
    var anySlot = Number(slot) < 0;

    function push(id, record, from) {
      var key = id === undefined || id === null ? null : String(id);
      if (key !== null && seenIds.indexOf(key) !== -1) return;
      if (key !== null) seenIds.push(key);
      found.push({ id: id, record: record || null, from: from });
    }

    // ① 出口端口自己记着的（真机实测就是这条，元素是数字 link id）
    safe(function () {
      var outputs = (node && node.outputs) || [];
      var slots = anySlot ? Object.keys(outputs).map(Number) : [Number(slot)];
      for (var si = 0; si < slots.length; si++) {
        var entry = outputs[slots[si]];
        var links = entry && entry.links;
        if (!links) continue;

        if (typeof links.values === "function") {
          Array.from(links.values()).forEach(function (item) {
            if (item && typeof item === "object") {
              push(item.id !== undefined ? item.id : null, item, "output.links(Map)");
            } else {
              push(item, null, "output.links");
            }
          });
          continue;
        }

        if (!links.length) continue;
        for (var i = 0; i < links.length; i++) {
          var item = links[i];
          if (item && typeof item === "object") {
            push(item.id !== undefined ? item.id : null, item, "output.links(obj)");
          } else {
            push(item, null, "output.links");
          }
        }
      }
    });

    // ② graph 的连线表（多一层保险：万一某个前端版本不维护 outputs[].links）
    if (wanted !== null) {
      for (var gi = 0; gi < graphs.length; gi++) {
        var table = safe(function () {
          return graphs[gi] && graphs[gi].links;
        }, null);
        if (!table) continue;
        var records = safe(function () {
          if (typeof table.values === "function") return Array.from(table.values());
          return Object.keys(table).map(function (k) {
            return table[k];
          });
        }, []);
        for (var ri = 0; ri < records.length; ri++) {
          var record = records[ri];
          var origin = linkOrigin(record);
          if (!origin || String(origin.id) !== wanted) continue;
          if (!anySlot && Number(origin.slot) !== Number(slot)) continue;
          push(record.id, record, "graph.links");
        }
      }
    }

    return found;
  }

  /**
   * 从某个节点出发，顺着输出连线一路往下，看这条线最后落在**哪个入口**上，
   * 用那个入口的名字（positive / negative）来定它是正向还是反向。
   *
   * 判据只有一个：**线落到谁身上**。这一点是用户定的（m03277/m03295）：
   * 「就是这两条线连在的上一个节点，它应该是有节点的编号的，通过那个编号来锁就完了嘛」。
   *
   * ⚠️ 这里曾经写错过，而且是"桩里全绿、真机全错"的那种错（2026-10，见 m03903）：
   * 老写法是"走到一个节点上，就把这个节点**所有**入口名扫一遍，谁的名字里带
   * positive/negative 就算谁的"。在真实工作流里 KSampler 同时有 `positive` 和
   * `negative` 两个入口，于是**正向框和反向框都落到了第一个匹配到的 `positive`（slot 1）**
   * —— 两个提示词框认成了同一个角色。桩里之所以没露，是因为测试夹具的采样器
   * （`tests/fixtures/sampler-chain.mjs`）那两条线只连了本种入口，扫名字和看落点碰巧一致。
   * 改法：走线的时候就把"落在哪个 slot"记下来，只认那一个口，其它口一概不看。
   *
   * 返回 { role, kind, hops, confidence, stop, via }：
   *   role       —— "positive" / "negative" / ""（认不出来）
   *   confidence —— 1 = 一条线直接落在正/反入口上；2 = 穿过了一串纯传递节点后落上的
   *   hops       —— 走过的每一段：[{id, title, port, slot}]，用来给用户看"凭什么这么认"
   *   stop       —— 为什么停下（"port" / "dead-end" / "off-chain" / "cycle" / "too-deep" / "no-node"）
   *   via        —— 线是从哪读出来的（真机是 "output.links"，见 outboundLinks 的注释）
   */
  function tracePromptRole(node, options) {
    var opts = options || {};
    var graphs = collectGraphs(opts.app || globalThis.app);
    var result = { role: "", kind: "", hops: [], confidence: 0, stop: "" };

    if (!node) {
      result.stop = "no-node";
      return result;
    }

    var seen = {};
    var cursor = node;
    var depth = 0;

    // 起点自己不算"落在某个入口上"（它是出发的那个框），但起点如果**就是**采样器这种
    // 本身就带正/反入口的节点，也允许直接看它自己的口 —— 这条留给"选中采样器按 P"的情况。
    if (!isChainableCursor(cursor)) {
      var own = firstRolePortOf(cursor);
      if (own) {
        result.role = own.role;
        result.confidence = 2;
        result.via = "own-port";
        result.hops.push({ id: cursor.id, title: titleOf(cursor), port: own.name, slot: own.slot });
        result.stop = "port";
        return result;
      }
      result.stop = "off-chain";
      return result;
    }

    while (cursor && depth < MAX_CHAIN_HOPS) {
      var nodeKey = String(cursor.id) + "@" + String(cursor.type || "");
      if (seen[nodeKey]) {
        result.stop = "cycle";
        return result;
      }
      seen[nodeKey] = true;

      // 往下走一条输出线（提示词编码器只有一个输出，多个也只看第一个有连线的）。
      var outCount = ((cursor.outputs || []).length) || 0;
      var chosen = null;
      for (var oi = 0; oi < outCount && !chosen; oi++) {
        var outbound = outboundLinks(graphs, cursor, oi);
        if (outbound.length) chosen = outbound;
      }
      // 有些节点把输出口声明得不全（子图、动态节点），这时退一步：不问端口号，
      // 直接问"这张图里从这个节点出去的线一共有哪些"。
      if (!chosen) {
        var loose = outboundLinks(graphs, cursor, -1);
        if (loose.length) chosen = loose;
      }
      if (!chosen) {
        result.stop = "dead-end";
        return result;
      }
      result.via = chosen[0].from;

      var lookup = linksLookup(safe(function () {
        return cursor.graph;
      }, null) || (graphs[0] || null));

      var next = null;
      var landingSlot = null;
      for (var li = 0; li < chosen.length && !next; li++) {
        var entry = chosen[li];
        // graph.links 那条记录本身就已经写明了落到谁身上，不必再查一次；端口数组里
        // 放的只是 link id，得走 graph.links 查。
        var parsed = entry.record ? readLink(entry.record, lookup) : readLink(entry.id, lookup);
        if (!parsed) continue;
        var foundNode = findNodeInGraphs(graphs, parsed.targetId);
        if (foundNode) {
          next = foundNode;
          landingSlot = parsed.slot;
        }
      }
      if (!next) {
        result.stop = "dead-end";
        return result;
      }

      depth++;
      cursor = next;

      // **只认线落到的那个口**。落上的口不是正/反，就看这个节点值不值得继续往下追
      // （按结构判断，UUID 类型的自定义节点也算 —— 见 isChainableCursor）。
      var port = portOf(next, landingSlot);
      var roleHere = port ? roleFromNames(port.names) : "";
      if (roleHere) {
        result.role = roleHere;
        result.confidence = depth === 1 ? 1 : 2;
        result.via = "link";
        result.hops.push({
          id: next.id,
          title: titleOf(next),
          // 给用户看的是他**在节点上看到的名字**：有 label 就用 label，
          // 否则退回 localized_name / 真名（真机上 positive_prompt 就藏在 label 里）。
          port: port.label || port.localizedName || port.name,
          portRealName: port.name,
          slot: landingSlot,
        });
        result.stop = "port";
        return result;
      }

      if (!isChainableCursor(next)) {
        result.stop = "off-chain";
        return result;
      }
    }

    result.stop = cursor ? "too-deep" : "dead-end";
    return result;
  }

  /** 节点的显示名（给用户看的 hop 里用它）。 */
  function titleOf(node) {
    return String((node && (node.title || node.type)) || "");
  }

  /** 第 slot 个入口本身（线落在哪个口就用它）。 */
  function portOf(node, slot) {
    if (slot === null || slot === undefined) return null;
    var inputs = (node && node.inputs) || [];
    var entry = inputs[Number(slot)];
    if (!entry || !entry.name) return null;
    return {
      name: String(entry.name),
      label: typeof entry.label === "string" ? entry.label : "",
      localizedName: typeof entry.localized_name === "string" ? entry.localized_name : "",
      slot: Number(slot),
      names: roleNamesOf(entry),
    };
  }

  /**
   * 这个节点自己带的第一个正/反入口（不看线，只看它有没有这个口）。
   *
   * 这里也走 roleNamesOf：用户在节点上看到的 `positive_prompt` 其实在 `label` 上，
   * 只比 `name` 会漏掉一大类自定义节点（真机取证见 roleNamesOf 注释）。
   */
  function firstRolePortOf(node) {
    var inputs = (node && node.inputs) || [];
    for (var i = 0; i < inputs.length; i++) {
      var entry = inputs[i];
      if (!entry || !entry.name) continue;
      var role = roleFromNames(roleNamesOf(entry));
      if (role) {
        return {
          name: hasRoleName(entry) ? String(entry.label || entry.localized_name || entry.name) : String(entry.name),
          slot: i,
          role: role,
        };
      }
    }
    return null;
  }

  /** 这个入口的名字里有没有正反字样（用来决定提示用户时显示哪个名字）。 */
  function hasRoleName(entry) {
    var names = roleNamesOf(entry);
    for (var i = 0; i < names.length; i++) {
      if (roleFromPortName(names[i])) return true;
    }
    return false;
  }

  /**
   * 这个节点类型值不值得沿着它的输出继续往下追。
   *
   * 老版本只按**类型名**放行（`CHAIN_NODE_RE`），结果用户在 2026-10 反馈的
   * 「选择了正向，弹出来的却是反向」就是因为他的接收节点是自己造的插件节点、
   * 类型名是一串 UUID（`ae6b6fa6-bcc6-494c-a8e0-d79c9b933ac9`），
   * 类型名里一个关键词都没有 → 顺着线走的第一步就被白名单掐断了。
   *
   * 现在改成**按结构**判断，两种都算"值得往下追"：
   *   ① 类型名命中了老词表（保持老行为，兼容内置节点）；
   *   ② 这个节点**自己声明的入口里有 STRING 类型、且带着 widget 的口** ——
   *      这正是"提示词入口"的结构特征（真机上 `prompt` / `negative_prompt` /
   *      `system_prompt` 这些口都带 `"widget":{"name":...}`），跟它叫什么类型无关。
   */
  function isChainableCursor(node) {
    if (!node) return false;
    if (CHAIN_NODE_RE.test(String(node.type || ""))) return true;
    return hasPromptPort(node);
  }

  /**
   * 这个节点自己有没有"提示词入口"（STRING 且带 widget 的口）。
   *
   * 宽松度是**刻意**的：`entry.widget` 只要存在就算（真机上自造节点的提示词口
   * 一律带 `"widget":{"name":...}`），类型字段拿不到时也放行。宁可多走两跳，
   * 也不要在"UUID 类型节点"这种新写法上直接放弃 —— 用户 2026-10 那张图栽的就是这个。
   * 走线的深度上限（MAX_CHAIN_HOPS = 8）和"只认线落到的那个口"两条闸门还在，
   * 所以放宽这里不会把无关的线也当成提示词链。
   */
  function hasPromptPort(node) {
    var inputs = (node && node.inputs) || [];
    for (var i = 0; i < inputs.length; i++) {
      var entry = inputs[i];
      if (!entry) continue;
      if (entry.widget) return true;
      var type = entry.type === undefined || entry.type === null ? "" : String(entry.type).toUpperCase();
      if ((type === "" || type === "STRING") && typeof entry.name === "string" && entry.name) return true;
    }
    return false;
  }

  /**
   * 一个提示词框（节点 + 控件）到底是什么角色 —— 统一入口，面板只该调这一个。
   *
   * 判定的顺序就是用户 2026-10 拍板的那套（m04922）：
   *   ① **控件自己的名字**（`positive_prompt` / `negative_prompt` / `正向提示词` …）
   *      —— 有些节点直接把正反写在自己控件的名字/显示名上；
   *   ② **顺线看线落在接收节点的哪个入口上**，读那个入口自己声明的
   *      `label` / `localized_name` / `name`（用户在节点上看到的名字就是它）；
   *   ③ 都不行时，看这个节点（它是"框"所在的节点）自己有没有唯一的正反入口。
   *
   * 返回 {role, kind, via, hops, confidence, stop}：
   *   via —— "widget"（控件名）/ "link"（顺线落到入口）/ "own-port"（节点自己的口）/ ""
   *          面板的自检提示直接把它显示给用户，省得以后再靠猜。
   */
  function traceRoleForBox(node, widget, options) {
    var opts = options || {};
    var out = { role: "", kind: "", via: "", hops: [], confidence: 0, stop: "" };

    if (!node) {
      out.stop = "no-node";
      return out;
    }

    // ① 控件自己的声明
    var widgetNames = roleNamesOf(widget);
    var byWidget = roleFromNames(widgetNames);
    if (byWidget) {
      out.role = byWidget;
      out.via = "widget";
      out.confidence = 3;
      out.stop = "widget";
      out.names = widgetNames;
      return out;
    }

    // ② 顺线看落点
    var traced = tracePromptRole(node, opts);
    if (traced && traced.role) {
      traced.via = traced.via || "link";
      return traced;
    }

    // ③ 节点自己的唯一正反入口
    var own = firstRolePortOf(node);
    if (own) {
      out.role = own.role;
      out.via = "own-port";
      out.confidence = 1;
      out.stop = "own-port";
      out.hops = [{ id: node.id, title: titleOf(node), port: own.name, slot: own.slot }];
      return out;
    }

    out.stop = (traced && traced.stop) || "no-role";
    out.traced = traced || null;
    return out;
  }

  /**
   * 把整张图（含子图）里"能装提示词、又有真实文本框"的控件全找出来，
   * 每一条带上它认出来的正反角色。
   *
   * 只收**有真实元素**的（多行大文本框）：单行的文件名、种子这类不算提示词框，
   * 收进来只会让用户选错。
   */
  function listPromptBoxes(app) {
    var graphs = collectGraphs(app);
    var out = [];

    for (var gi = 0; gi < graphs.length; gi++) {
      var nodes = safe(function () {
        return graphs[gi]._nodes || graphs[gi].nodes || [];
      }, []);
      for (var ni = 0; ni < nodes.length; ni++) {
        var node = nodes[ni];
        if (!node || !Array.isArray(node.widgets)) continue;
        var widgets = listTextWidgets(node);
        for (var wi = 0; wi < widgets.length; wi++) {
          if (!widgets[wi].multiline) continue;
          out.push({
            node: node,
            widget: widgets[wi].widget,
            graph: graphs[gi],
            role: traceRoleForBox(node, widgets[wi].widget, { app: app }).role,
          });
        }
      }
    }

    return out;
  }

  /** 一条连线的中文说法，给目标条和候选列表用。 */
  function formatTargetLabel(target) {
    if (!target) return "";
    var base = "#" + textOf(target.nodeId) + " " + textOf(target.nodeTitle);
    if (target.field) base += " · " + target.field;
    if (target.linkLabel) base += "  →  " + target.linkLabel;
    return base;
  }

  var api = {
    TEXT_WIDGET_TYPES: TEXT_WIDGET_TYPES,
    isElement: isElement,
    getWidgetElement: getWidgetElement,
    isWidgetElement: isWidgetElement,
    isTextWidget: isTextWidget,
    getWidgetValue: getWidgetValue,
    widgetLabel: widgetLabel,
    inspectTarget: inspectTarget,
    listTextWidgets: listTextWidgets,
    findNodeByElement: findNodeByElement,
    findWidgetByElement: findWidgetByElement,
    markDirty: markDirty,
    setWidgetText: setWidgetText,
    roleFromPortName: roleFromPortName,
    roleNamesOf: roleNamesOf,
    roleFromNames: roleFromNames,
    traceRoleForBox: traceRoleForBox,
    firstRolePortOf: firstRolePortOf,
    hasPromptPort: hasPromptPort,
    tracePromptRole: tracePromptRole,
    outboundLinks: outboundLinks,
    readLink: readLink,
    collectGraphs: collectGraphs,
    listPromptBoxes: listPromptBoxes,
    formatTargetLabel: formatTargetLabel,
  };

  // 两个出口都写上（原因见 i18n.js 同一处的注释）。
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.XWidePromptBridge = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
