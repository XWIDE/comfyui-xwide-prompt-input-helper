/* ===================================================================
 * X-WIDE Prompt Input Helper —— 诊断脚本（只读，不改任何东西）
 *
 * 用法：
 *   1. 在 ComfyUI 页面里打开你那张工作流，等它完全加载好
 *   2. 按 F12 → 切到「控制台 / Console」标签
 *   3. 把本文件**全部内容**粘进控制台，回车
 *   4. 把打印出来的结果整段发给我
 *
 * 它只读画布信息，不会写入、不会排队、不会跑图。
 * =================================================================== */
(function () {
  var out = [];
  var log = function (s) {
    out.push(s);
  };

  var app = window.app;
  if (!app) {
    console.log("❌ window.app 还没出现，等页面完全加载好再试");
    return;
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  log("========== X-WIDE 提示词插件 · 诊断 ==========");
  log("插件版本: " + safe(function () { return window.XWidePromptHelper.version; }, "未加载"));
  log("插件已启动: " + safe(function () { return !!window.__xwidePromptHelperBooted; }, false));
  log("当前快捷键: " + safe(function () { return JSON.stringify(window.XWidePromptHelper.shortcuts()); }, "?"));
  log("");

  // ---------- 收集所有图（根图 + 子图） ----------
  var graphs = [];
  function collect(g, path) {
    if (!g || graphs.indexOf(g) !== -1) return;
    graphs.push(g);
    safe(function () {
      (g.subgraphs || []).forEach(function (sg) {
        collect(sg, path + "/sub");
      });
    });
  }
  collect(app.graph, "root");
  safe(function () { collect(window.LiteGraph && window.LiteGraph.rootGraph, "rootGraph"); });

  var total = 0;
  var textNodes = [];

  graphs.forEach(function (g, gi) {
    var nodes = safe(function () { return g._nodes || []; }, []);
    total += nodes.length;
    nodes.forEach(function (n) {
      var ws = n.widgets || [];
      var textish = ws.filter(function (w) {
        var t = String(w.type || "").toLowerCase();
        return (
          t === "text" ||
          t === "string" ||
          t === "customtext" ||
          t === "textarea" ||
          !!(w.element && w.element.tagName)
        );
      });
      if (!textish.length) return;
      textNodes.push({ graph: gi, node: n, widgets: textish });
    });
  });

  log("图数量: " + graphs.length + "，节点总数: " + total);
  log("带文本控件的节点: " + textNodes.length + " 个");
  log("");

  textNodes.forEach(function (item) {
    var n = item.node;
    var title = String(n.title || n.type || "");
    var flag = title === "连接" || /prompt/i.test(title) || /prompt/i.test(String(n.type || "")) ? "  <<<<<< 你截图里的" : "";
    log("──────────────────────────────────────────");
    log("节点 #" + n.id + "  「" + title + "」" + flag);
    log("  类型 type     = " + n.type);
    log("  comfyClass    = " + safe(function () { return n.comfyClass; }, "?"));
    log("  所在图        = " + (item.graph === 0 ? "根图" : "子图#" + item.graph));
    log("  位置/尺寸     = " + safe(function () { return Math.round(n.pos[0]) + "," + Math.round(n.pos[1]) + "  " + Math.round(n.size[0]) + "x" + Math.round(n.size[1]); }, "?"));
    log("  全部控件      = " + ws2str(n));

    item.widgets.forEach(function (w) {
      var el = w.element || w.inputEl || null;
      var tag = el && el.tagName ? el.tagName : "-";
      var cls = el && typeof el.className === "string" ? el.className : "-";
      var val = safe(function () { return typeof w.value === "string" ? w.value : String(w.value); }, "");
      log("    ▸ 控件「" + (w.name || "?") + "」 type=" + w.type);
      log("       构造函数      = " + safe(function () { return w.constructor && w.constructor.name; }, "?"));
      log("       有 element 吗 = " + (w.element ? "有" : "❌ 没有") + "   tag=" + tag);
      log("       元素 class    = " + cls);
      log("       setValue 可用 = " + (typeof w.setValue === "function") + "   getValue 可用 = " + (typeof w.getValue === "function"));
      log("       value 长度    = " + val.length + "   display_name=" + safe(function () { return w.options && w.options.display_name; }, "-"));
      log("       __comfy_node  = " + (el ? String(!!el.__comfy_node) : "(无元素)") + "   .node = " + (el ? String(!!el.node) : "-"));
      log("       是否连到输入  = " + safe(function () { return !!(n.inputs || []).some(function (i) { return i.widget && i.widget.name === w.name && i.link != null; }); }, "?"));
      log("       值预览        = " + JSON.stringify(val.slice(0, 50)));
    });
  });

  function ws2str(n) {
    return safe(function () {
      return (n.widgets || []).map(function (w) {
        return (w.name || "?") + ":" + (w.type || "?");
      }).join(", ");
    }, "?");
  }

  // ---------- 面板现在的目标解析结果 ----------
  log("");
  log("========== 插件当前的目标解析 ==========");
  ["positive", "negative"].forEach(function (kind) {
    var d = safe(function () { return window.XWidePromptHelper.describeTarget(kind); }, null);
    log(kind + " -> " + JSON.stringify(d));
  });

  var ov = document.querySelector('.xwph-overlay[data-xwph-kind="positive"]');
  if (ov) {
    var sel = ov.querySelector(".xwph-target-select");
    log("正向面板标题栏文案: " + safe(function () { return ov.querySelector(".xwph-target-label").textContent; }, "?"));
    log("下拉框当前值: " + (sel ? sel.value : "(没有下拉框)"));
    log("下拉框候选项: " + safe(function () {
      return Array.prototype.map.call(sel.options, function (o) { return o.textContent; }).join(" | ") || "(空 —— 说明当时没选中任何节点)";
    }, "?"));
  } else {
    log("(面板还没被创建过)");
  }

  log("");
  log("========== 诊断结束，把以上内容整段发我 ==========");

  var text = out.join("\n");
  console.log(text);
  // 方便直接右键复制
  try {
    window.__xwphDiagText = text;
  } catch (e) {}
  return text;
})();
