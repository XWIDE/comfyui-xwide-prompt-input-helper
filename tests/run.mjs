/**
 * X-WIDE Prompt Input Helper —— 无浏览器测试 / headless test
 *
 * 跑法：
 *   <electron 可执行文件> tests/run.mjs      （ELECTRON_RUN_AS_NODE=1 时它就是个 node）
 *   或任何 node >= 18：  node tests/run.mjs
 *
 * 为什么值得写这堆桩：插件的核心风险不在语法，而在几个一旦写错就
 * “静默失效”的地方 —— 快捷键被画布抢走、内容写进了控件但没同步到 widget、
 * 目标解析到了错误的节点。这些只有真的把事件喂进去才能验证。
 */

import { createEnv, fileUrl } from "./harness.mjs";
import { buildSamplerChain } from "./fixtures/sampler-chain.mjs";
import { buildUuidReceiver } from "./fixtures/uuid-receiver.mjs";
import { writeFileSync } from "node:fs";

/**
 * 结果同时写文件、也照常打印。
 *
 * 这套测试是拿 Electron 当 node 跑的，某些启动方式下它的 stdout 会被吞掉
 * （GUI 子系统的进程没有可继承的控制台），只靠 console.log 会看到“什么都没发生”。
 * 文件是最可靠的出口，命令行上仍保留输出以便直接阅读。
 */
const REPORT = new URL("./last-run.txt", import.meta.url);
const reportLines = [];
const rawLog = console.log;
console.log = (...args) => {
  reportLines.push(args.join(" "));
  rawLog(...args);
};

/**
 * 测试体里任何一处抛异常，都不能让它悄悄结束。
 *
 * 这个进程的 stdout 经常被吞掉，唯一可靠的出口是报告文件；一旦崩在半路，
 * 文件里留着的还是**上一次**的内容，看上去就像“测试跑到一半停了”，
 * 而真正的原因（异常类型和堆栈）完全看不见 —— 这坑踩过一次。
 */
function dumpFatal(err) {
  const text = (err && (err.stack || err.message)) || String(err);
  reportLines.push("\n!!! 测试中断：", text);
  rawLog("\n!!! 测试中断：", text);
  try {
    writeFileSync(REPORT, reportLines.join("\n") + "\n", "utf8");
  } catch (_err) {
    /* ignore */
  }
  process.exit(2);
}
process.on("uncaughtException", dumpFatal);
process.on("unhandledRejection", dumpFatal);

// app **故意**不在 createEnv 里装好：真实前端是先 await app.setup()（扩展模块
// 就是在这个 setup 内部被 import 的）之后才 window.app = app。以前提前装好，
// 等于把"模块加载时 app 还不存在"这个最要命的场景从测试里抹掉了 ——
// 桩测试全绿、真机上按快捷键毫无反应就是这么来的。
const env = createEnv({ width: 1440, height: 900, locale: "zh-CN" });

// 必须在 import 插件之前把全局装好：插件是普通脚本，靠 globalThis 取 app/document。
globalThis.document.URL = "http://localhost:8188/";

// 加载期必须为真：插件在顶层不能读到 app。
const appAbsentDuringLoad = typeof globalThis.app === "undefined";

const mod = await import(fileUrl("../web/js/prompt_helper.js"));

// 现在模拟前端那一行 window.app = app。插件应当在这一刻完成注册。
env.attachApp();

const mainExt = env.app.extensions["X-WIDE.PromptHelper"];
const nodeMenuExt = env.app.extensions["X-WIDE.PromptHelper.NodeMenu"];

if (!mainExt || !nodeMenuExt) {
  console.error("扩展注册失败：", Object.keys(env.app.extensions));
  writeFileSync(REPORT, "FATAL: 扩展未注册，实际注册到的扩展 = " + Object.keys(env.app.extensions).join(",") + "\n", "utf8");
  process.exit(1);
}

// 模拟前端启动顺序。
mainExt.init();
await mainExt.setup();

const helper = globalThis.XWidePromptHelper;
const manager = helper && helper.__manager ? helper.__manager : null;

// ------------------------------------------------------------------ 测试脚手架

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  \u2717 ${name}${detail ? " — " + detail : ""}`);
  }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------------ 加载期
//
// 这一小节守的是一个真机上踩过的坑：扩展模块被 import 的那一刻，
// window.app 还不存在 —— 前端是先 await app.setup()，而扩展模块正是**在这个
// setup 内部**被 import 的，`window.app = app` 那一行在 setup 之后才执行。
//
// 后果是双重的：
//   1. 插件在顶层拿 app 做前置检查就会直接 return，表现成
//      "文件都在加载、按快捷键却毫无反应"；
//   2. 就算等到 `window.app` 出现再注册也已经太晚 —— 扩展的 init/setup
//      只对加载期那一刻已登记的扩展跑一遍。
// 所以插件必须在 window.app 被赋值的那一刻同步完成注册。
//
// appAbsentDuringLoad 为假就说明测试桩又提前把 app 装好了，
// 那下面这些断言全都失去了意义 —— 直接判失败，别让它悄悄退回去。

section("加载期：window.app 还不存在的时候也必须注册成功");

ok(appAbsentDuringLoad, "插件模块求值时 globalThis.app 是 undefined（与真实前端一致）");
eq(globalThis.app, env.app, "window.app = app 之后插件拿到的就是那个实例");
eq(mainExt.name, "X-WIDE.PromptHelper", "面板扩展已注册");
eq(nodeMenuExt.name, "X-WIDE.PromptHelper.NodeMenu", "节点菜单扩展已注册");

// 拦截器必须在赋值那一刻就退场：它如果留着，window.app 就变成了一个
// 带 getter/setter 的怪东西，同一个页面里的别的插件都会被影响。
const appDescriptor = Object.getOwnPropertyDescriptor(globalThis, "app");
ok(!!appDescriptor, "window.app 有属性描述符");
ok(
  !!appDescriptor && Object.prototype.hasOwnProperty.call(appDescriptor, "value"),
  "赋值之后 window.app 是普通数据属性（不是拦截器留下的访问器）"
);
ok(!appDescriptor || typeof appDescriptor.get !== "function", "window.app 没有被换成 getter");
ok(!appDescriptor || typeof appDescriptor.set !== "function", "window.app 没有被换成 setter");
ok(!!appDescriptor && appDescriptor.writable === true, "window.app 依然可写（别的插件还能覆盖它）");
ok(!!appDescriptor && appDescriptor.configurable === true, "window.app 依然可配置");

// 别人的插件也可能写 window.app，那必须还能正常工作。
const otherApp = { registerExtension() {} };
globalThis.app = otherApp;
eq(globalThis.app, otherApp, "拦截器退场后，别的插件仍能正常读写 window.app");
globalThis.app = env.app;

const byClass = (cls) => env.doc.querySelectorAll("." + cls);

function panelOf(kind) {
  const overlays = env.doc.querySelectorAll(".xwph-overlay");
  for (const o of overlays) {
    if (o.getAttribute("data-xwph-kind") === kind) return o;
  }
  return null;
}

function isPanelOpen(kind) {
  const overlay = panelOf(kind);
  if (!overlay) return false;
  return !overlay.classList.contains("xwph-hidden");
}

function textareaOf(kind) {
  const overlay = panelOf(kind);
  if (!overlay) return null;
  return overlay.querySelector(".xwph-textarea");
}

/**
 * 此刻解析出来的目标控件里的文本。
 *
 * 为什么需要它：面板的预填规则是「草稿 > 目标控件内容 > 空」，而"目标是哪一个"
 * 会随绑定 / 连线 / 点击变化 —— 断言里写死某个节点的内容是错的，
 * 应该断言"预填的正好是这个目标的当前内容"。
 *
 * 注意 describeTarget() 只回 id/标题/字段名，**不回控件对象**（那是刻意的瘦接口），
 * 所以这里按 id + 控件名回到图里把控件找出来 —— id 在单张图内唯一，够用了。
 */
function findWidget(nodeId, widgetName) {
  const roots = [env.graph, env.app && env.app.graph, env.litegraph && env.litegraph.rootGraph];
  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    const queue = [root];
    while (queue.length) {
      const g = queue.shift();
      if (!g || seen.has(g)) continue;
      seen.add(g);
      for (const n of g._nodes || []) {
        if (n.id !== nodeId) continue;
        for (const w of n.widgets || []) {
          if (String(w.name) !== String(widgetName)) continue;
          return w;
        }
      }
      for (const sub of g.subgraphs || []) queue.push(sub);
    }
  }
  return null;
}

function widgetText(nodeId, widgetName) {
  const w = findWidget(nodeId, widgetName);
  if (!w) return null;
  return typeof w.getValue === "function" ? w.getValue() : w.value || "";
}

/**
 * 直接把某个控件里的字改成 text —— 用来模拟"用户之前在画布上填过东西"。
 * 「清空」要清的就是这个框，所以测试得先让它里面有东西。
 */
function setWidgetText(nodeId, widgetName, text) {
  const w = findWidget(nodeId, widgetName);
  if (!w) return false;
  if (typeof w.setValue === "function") w.setValue(text);
  else w.value = text;
  return true;
}

function targetText(kind) {
  const described = helper.describeTarget(kind);
  if (!described || !described.found) return "";
  const text = widgetText(described.nodeId, described.widgetName);
  return text === null ? "" : text;
}

function pressKey(target, init) {
  return env.dispatch(target, "keydown", env.keyEvent(init));
}

/**
 * 在候选列表里找到指向某个节点的那一行。
 *
 * 只认**开头**的标签（"#3 …"），不认"包含"：候选行里还有一行是那个框的内容预览，
 * 用户的内容里完全可能正好写着 "#3 "，用"包含"会把预览当标签、点错行。
 * 标签一定是行首那一块（renderPicker 里 title 是第一个子元素）。
 */
function pickerItemFor(kind, nodeId) {
  const wanted = "#" + nodeId + " ";
  const rows = panelOf(kind) ? panelOf(kind).querySelectorAll(".xwph-picker-item") : [];
  return Array.from(rows).find((row) => String(row.textContent || "").trim().indexOf(wanted) === 0) || null;
}

/**
 * 只清掉「绑定」，留着「上次写入过的目标」那把记忆。
 *
 * 为什么需要它：绑定的优先级在记忆之上，所以"想测记忆"就必须先把绑定拿掉；
 * 但 env.storage.clear() 会把记忆一起清掉，那就什么都测不到了。
 * 真实的键长这样：XWidePromptHelper.bind.<工作流>.<正/反> —— 前缀来自两个地方，
 * 别漏掉命名空间那一层（插件所有键都挂在 SETTINGS_NS 下面）。
 */
const STORAGE_NS = "XWidePromptHelper";
function clearBindingsOnly() {
  // 注意：要用 env.localStorage（它才是那个带 length / key(i) 的 Storage），
  // env.storage 是它背后那张 Map，键名枚举得从 localStorage 走。
  const doomed = [];
  for (let i = 0; i < env.localStorage.length; i++) {
    const key = env.localStorage.key(i);
    // 同时容忍带前缀和不带前缀两种（不带的那种是早期版本的键）。
    if (key && (String(key).indexOf(STORAGE_NS + ".bind.") === 0 || String(key).indexOf("bind.") === 0)) {
      doomed.push(key);
    }
  }
  for (const key of doomed) env.localStorage.removeItem(key);
  return doomed.length;
}

/**
 * 只清掉属于某个工作流的绑定（按工作流键前缀）。
 *
 * 为什么不用 `env.storage.clear()`：测试是**顺序**跑的，前面小节辛苦建立起来的绑定
 * 往往是后面小节的隐含前提（"切回原图绑定还在"那几条就是）。清全部会把它们一起抹掉，
 * 于是红的是一段之后的断言，看着像插件坏了，其实是测试自己把前置条件删了。
 */
function clearBindingsByPrefix(workflowPrefix) {
  const doomed = [];
  for (let i = 0; i < env.localStorage.length; i++) {
    const key = env.localStorage.key(i);
    if (key && String(key).indexOf("bind." + workflowPrefix + ".") >= 0) doomed.push(key);
  }
  for (const key of doomed) env.localStorage.removeItem(key);
  return doomed.length;
}

function typeInto(el, text) {
  el.value = text;
  el.dispatchEvent({ type: "input", target: el, preventDefault() {}, stopPropagation() {} });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 往一个独立的小文件里写“当前走到哪了”。
 *
 * 这个进程的 stdout/stderr 都可能被吞掉，报告文件又是在最后才写的；
 * 万一它静默死在中间，光看报告只会看到上一次的内容，完全不知道死在哪。
 * 每个小节开头调一次 checkpoint()，就能一眼看出最后活着的位置。
 */
const PROGRESS = new URL("./last-progress.txt", import.meta.url);
function checkpoint(label) {
  try {
    writeFileSync(PROGRESS, label + "\n", "utf8");
  } catch (_err) {
    /* ignore */
  }
}

// ------------------------------------------------------------------ 造图

section("准备：构造画布");

// 让第一张图也走一遍"切到这张工作流"的初始化（设 rootGraph / activeWorkflow）。
env.useGraph(env.graph);

const nodeA = env.addNode({
  id: 1,
  type: "CLIPTextEncode",
  title: "CLIP Text Encode (Prompt)",
  widgets: [
    { name: "text", displayName: "text", value: "a photo of a cat" },
    null, // 一个非文本控件，用来验证不会被误判
  ],
});

const nodeB = env.addNode({
  id: 2,
  type: "CLIPTextEncode",
  title: "CLIP Text Encode (Negative)",
  widgets: [{ name: "text", displayName: "text", value: "blurry, lowres" }],
});

// 子图里的节点，用来验证“记住上次目标”会遍历子图。
const subGraph = { _nodes: [], selected_nodes: {}, subgraphs: [] };
const nodeC = env.addNode({
  id: 3,
  type: "Text Multiline",
  title: "Text Multiline",
  widgets: [{ name: "text", value: "subgraph text" }],
});
env.graph._nodes.pop();
subGraph._nodes.push(nodeC);
env.graph.subgraphs.push(subGraph);

eq(env.graph._nodes.length, 2, "主图有 2 个节点");
eq(nodeA.widgets.length, 2, "节点 A 有 2 个控件（1 文本 + 1 非文本）");

const areaA = nodeA._textareas[0];
const areaB = nodeB._textareas[0];
const areaC = nodeC._textareas[0];

// ------------------------------------------------------------------ 目标解析

section("目标解析：三级回落");

// 模拟用户点了一下节点 A 的文本框（前端在 mousedown 捕获阶段就能被我们记录）。
env.dispatch(areaA, "pointerdown", { button: 0 });
const describedA = helper.describeTarget("positive");
ok(describedA.found, "点过文本框后能解析到目标");
eq(describedA.nodeId, 1, "解析到的目标 nodeId 是 1");
eq(describedA.field, "text", "解析到的字段名是 text");
eq(describedA.source, "focus", "解析来源是 focus（刚刚点过的那个框）");

// 没有任何交互、也没有选区时，应当解析不到。
const freshEnv = { found: null };
env.dispatch(env.doc.body, "pointerdown", { button: 0 });
ok(true, "（准备）在空白处点击不改变已记录的目标");

// ------------------------------------------------------------------ 快捷键

section("快捷键：纯 P / 纯 N");

const canvasTarget = env.doc.body;

// 用户明确要求把默认快捷键改成单键（m02067）：组合键按着别扭。
let ev = pressKey(canvasTarget, { key: "p", code: "KeyP" });
ok(isPanelOpen("positive"), "单按 P 打开了正向面板");
ok(ev.defaultPrevented, "正向快捷键调用了 preventDefault");
ok(ev._stopped, "正向快捷键调用了 stopPropagation（画布收不到）");

ev = pressKey(canvasTarget, { key: "n", code: "KeyN" });
ok(isPanelOpen("negative"), "单按 N 打开了反向面板");
ok(isPanelOpen("positive"), "两个面板可以同时开着（方便互相对照）");

const beforeCount = env.eventLog.length;
ev = pressKey(canvasTarget, { key: "p", code: "KeyP", ctrl: true });
eq(env.eventLog.length, beforeCount + 1, "Ctrl+P 只产生了事件本身");
ok(!ev._stopped, "Ctrl+P 没有被我们拦下（留给浏览器打印）");

ev = pressKey(canvasTarget, { key: "p", code: "KeyP", alt: true });
ok(!ev._stopped, "Alt+P 不触发（按下多余的修饰键就不算命中）");

ev = pressKey(canvasTarget, { key: "p", code: "KeyP", shift: true });
ok(!ev._stopped, "Shift+P 不触发（大写 P 是打字，不是快捷键）");

ev = pressKey(canvasTarget, { key: "p", code: "KeyP", repeat: true });
ok(!ev._stopped, "长按产生的重复事件被忽略");

ev = pressKey(canvasTarget, { key: "p", code: "KeyP", isComposing: true });
ok(!ev._stopped, "输入法组词期间不触发快捷键");

section("快捷键：在别的输入框里打字时不抢按键");

// 这一节测的是"焦点在别人的框里时按键不生效"，所以必须**先从关着的状态开始**：
// 上一节结束时两个面板都还开着（那些"不触发"的断言本来就说明它们不会被关掉），
// 不先收干净的话，"没有把面板打开"这条断言测的其实是上一节的残留状态 —— 踩过。
manager.closeAll();
await flush();
ok(!isPanelOpen("positive"), "（准备）先把面板收干净，本节从关闭状态开始");

// 单键快捷键最大的风险就是“把提示词里的 p / n 吃掉”，所以这条是硬约束：
// 焦点在**别人的**输入框里时，按键必须原样留在输入框里，只弹一句提示。
const foreignInput = env.doc.createElement("textarea");
foreignInput.className = "some-other-plugin-textarea";
env.doc.body.appendChild(foreignInput);

ev = pressKey(foreignInput, { key: "p", code: "KeyP" });
ok(!ev._stopped, "焦点在别人的文本框里时，单键 P 不被拦截");
ok(!ev.defaultPrevented, "也没有 preventDefault，p 能正常打进文本框");
ok(!isPanelOpen("positive"), "而且没有把正向面板打开");
const toastHost = env.doc.querySelector(".xwph-toasts");
const toastText = toastHost ? String(toastHost.textContent || "") : "";
ok(toastText.includes("先点一下画布"), "弹了一句「先点一下画布」的提示，而不是静默无视");

// 带修饰键的快捷键沿用老规矩：输入框里一律让路，连提示都不用弹。
ev = pressKey(foreignInput, { key: "n", code: "KeyN", ctrl: true, alt: true });
ok(!ev._stopped, "焦点在非画布控件的文本框里时，组合键也不拦");

section("快捷键：再按一次不关闭，只把它端到前面");

// 上一节在"别人的输入框"里按 P 是**故意不生效**的，所以这里先回到画布上点一下。
pressKey(canvasTarget, { key: "p", code: "KeyP" });
ok(isPanelOpen("positive"), "回到画布上按 P 能打开正向面板");
ev = pressKey(canvasTarget, { key: "p", code: "KeyP" });
ok(isPanelOpen("positive"), "再按一次 P 面板还开着（同一个键不是开关：用户按 P 的意思永远是「我要写正向提示词」）");
ok(
  String(manager._panels.positive.getState().targetSource || "") !== "",
  "而且还重新认了一次目标"
);

// 换一个键是**并列**的（两个面板可以同时开着对照着改），不是"切过去"。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
ok(isPanelOpen("negative"), "按 N 打开了反向面板");
ok(isPanelOpen("positive"), "正向面板还开着（两个面板并列，方便对照）");

// 上面的快捷键小节把两个面板都打开了，这里收干净。
// 标题栏那个 ✕ 已经按用户要求删掉了，页脚的「关闭」按钮才是关面板的正路。
function closeAllPanels() {
  for (const kind of ["positive", "negative"]) {
    const p = panelOf(kind);
    if (!p) continue;
    const closeIcon = p.querySelector(".xwph-btn-close");
    if (closeIcon) env.dispatch(closeIcon, "click", { button: 0 });
  }
}
closeAllPanels();
ok(!isPanelOpen("positive") && !isPanelOpen("negative"), "两个面板都关上了，后续小节从干净状态开始");

// ------------------------------------------------------------------ 写入

section("写入：内容真的落到了控件上");

// 重新打开正向面板（目标仍是刚点过的节点 A）。
pressKey(canvasTarget, { key: "p", code: "KeyP" });
ok(isPanelOpen("positive"), "正向面板重新打开");

const posArea = textareaOf("positive");
ok(!!posArea, "找到正向面板的输入框");
eq(posArea.value, "a photo of a cat", "打开时预填了目标控件当前的内容");

const newText = "masterpiece, best quality, 1girl, solo, 中文提示词";
typeInto(posArea, newText);

// 点「应用并关闭」按钮。
const applyBtn = panelOf("positive").querySelector(".xwph-btn-primary");
ok(!!applyBtn, "找到「应用并关闭」按钮");
manager._setDebug(true);

// 面板自己解析出来的目标才是“应该被写入的那个节点”。测试自己不要去猜：
// 上一节写过一次正向，插件记下了记忆目标，此刻解析出来的可能已经不是 areaA 了。
const resolved = helper.describeTarget("positive");
const writtenNode = env.graph.getNodeById(resolved.nodeId);
const writtenWidget = writtenNode && writtenNode.widgets
  ? writtenNode.widgets.filter((w) => w && w.name === resolved.widgetName)[0]
  : null;

const clickEvt = env.dispatch(applyBtn, "click", { button: 0 });
ok(clickEvt.defaultPrevented, "点按钮时阻止了默认行为（按钮不会触发页面级动作）");
await flush();

eq(writtenWidget && writtenWidget.getValue(), newText, "控件内容被写入（panel 解析出的目标）");
eq(writtenWidget && writtenWidget.value, newText, "widget.value 被同步");
eq(
  writtenWidget && writtenWidget.element && writtenWidget.element.value,
  newText,
  "textarea 的值被写入"
);
eq(areaB.value, "blurry, lowres", "别的节点没有被误写");
ok(!isPanelOpen("positive"), "应用后面板自动关闭");
ok((env.canvas._dirty || 0) > 0, "触发了画布重绘");

section("目标不再瞎猜：没有绑定、线也认不出来时，让用户点一次");

// 为什么这一节存在（用户原话 m03263）：
//   「你现在这个 N 都不知道填到哪里去了」。
// 老版本在"前四级回落全落空"时会**按画布位置左上→右下挑第一个文本框**当默认目标。
// 用户的正向框和反向框都是 CLIP文本编码，于是按 N 就把负向提示词写进了正向框。
// 现在换成：认不出来就**不写**，在面板里摊开候选让用户点一次，点完锁死。
//
// 这里刻意造出"线也认不出来"的情形 —— 上一节那张图里的两个编码器**没有连线资料**
// （它们在测试里是裸节点），所以 role 都是空，谁也不是"唯一那个 negative"。

// 构造「一个显式目标都没有」：清掉绑定、交互记忆、选区、焦点。
// activeElement 也要清 —— 面板打开后焦点在它自己的输入框里，而输入框不在画布节点上，
// 这一级本来就该落空；显式清掉是为了让测试表达"确实没有显式目标"，而不是碰巧没落到。
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.select();
env.clearFocus();

const unboundTarget = helper.describeTarget("negative");
eq(unboundTarget.found, false, "没有绑定、线也认不出来时，解析不到目标（旧版会瞎挑一个）");
eq(unboundTarget.source, "unbound", "解析来源是 unbound（认不出来就说认不出来）");

pressKey(canvasTarget, { key: "n", code: "KeyN" });
ok(isPanelOpen("negative"), "认不出目标时面板照常打开（用户不是被挡在门外）");

const negPanel = panelOf("negative");
const negSelect = negPanel.querySelector(".xwph-target-select");
ok(negSelect.classList.contains("xwph-target-missing"), "目标条标红，用户不可能看漏");
ok(negSelect.disabled, "没有目标时下拉框不可选（下拉框里本来就只有一条「还没定」）");

const pickerRow = negPanel.querySelector(".xwph-picker");
ok(!!pickerRow && !pickerRow.classList.contains("xwph-hidden"), "候选列表摊开了 —— 这是让用户点一次的入口");
const pickerItems = negPanel.querySelectorAll(".xwph-picker-item");
ok(pickerItems.length >= 2, `候选里列出了图里的提示词框（实际 ${pickerItems.length} 个）`);

// 选一个候选：点完就必须定下来，以后不再问。
const chosen = pickerItemFor("negative", 2);
ok(!!chosen, "候选里有指向节点 2 的那一项");
const beforePickText = widgetText(2, "text");
ok(beforePickText !== null, "（准备）节点 2 的控件可读，下面的写入断言才有意义");
env.dispatch(chosen, "click", { button: 0 });
await flush();

const afterPick = helper.describeTarget("negative");
eq(afterPick.nodeId, 2, "点过候选之后目标定了下来（节点 2）");
ok(
  negPanel.querySelector(".xwph-picker").classList.contains("xwph-hidden"),
  "选完候选后列表自动收起（平时不该看见任何列表）"
);

typeInto(textareaOf("negative"), "只写这一个框");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaB.value, "只写这一个框", "写进了用户点的那一个框");
ok(widgetText(1, "text") !== "只写这一个框", "另外那个框一个字符都没被动过");

// 绑定就是这么来的：再开一次面板，不再需要点候选。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();
eq(helper.describeTarget("negative").source, "binding", "第二次打开走的是绑定，不再问用户");
ok(
  negPanel.querySelector(".xwph-target-select").textContent.includes("#2"),
  "目标条上写明了写进哪个框（#2）"
);
closeAllPanels();

// —— 「不写入，只编辑」这条逃生门 ——
// 有了绑定，用户想"只编辑、不要动画布"就必须能明确说出来。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();

const boundSelect = panelOf("negative").querySelector(".xwph-target-select");
ok(!boundSelect.disabled, "有绑定时下拉框可用（里面只有目标本身和「不写入」两条）");
eq(boundSelect.value, "0", "下拉框当前停在绑定上");
eq(boundSelect.options.length, 2, "下拉框就两条：目标本身 + 「不写入，只编辑」（换目标靠点画布上的框）");
ok(
  !Array.from(boundSelect.options).some((o) => o.value === "-3"),
  "「换一个框…」那条已经删掉（用户要求面板上没有可选项）"
);

const dontWrite = Array.from(boundSelect.options).find((o) => o.value === "-2");
ok(!!dontWrite, "下拉框末尾有「不写入，只编辑」这一项");

boundSelect.value = "-2";
env.dispatch(boundSelect, "change", {});
await flush();

ok(isPanelOpen("negative"), "选「不写入」不会关掉面板");
eq(helper.describeTarget("negative").source, "binding", "「不写入」只是这个面板的状态，不改全局解析结果");

typeInto(textareaOf("negative"), "不应该写进去的内容");
const negApply = panelOf("negative").querySelector(".xwph-btn-primary");
const valueABefore = areaA.value;
const valueBBefore = areaB.value;
env.dispatch(negApply, "click", { button: 0 });
await flush();

eq(areaA.value, valueABefore, "明确「不写入」时没有误写到别的节点");
eq(areaB.value, valueBBefore, "明确「不写入」时反向节点也没被动过");
ok(isPanelOpen("negative"), "拒绝写入时面板不关闭（用户的内容不会丢）");
ok(manager._panels.negative.isVisible(), "面板还在，内容还留在输入框里");

// 关掉反向面板，避免影响后续断言。
const negClose = panelOf("negative").querySelector(".xwph-btn-close");
env.dispatch(negClose, "click", { button: 0 });
await flush();
ok(!isPanelOpen("negative"), "页脚「关闭」按钮生效");

// ------------------------------------------------------------------ 选区 / 记忆

section("目标回落：画布选区");

env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.select(nodeB);

// 先主动清掉反向的绑定：上一节末尾它被绑到了节点 2，留着的话这里测的就是"绑定"
// 而不是"选区回落"了 —— 想测哪一级，就得保证它上面那几级都落空。
env.dispatch(areaB, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "n", code: "KeyN" });
const negSelectForDecline = panelOf("negative").querySelector(".xwph-target-select");
negSelectForDecline.value = "-2";
env.dispatch(negSelectForDecline, "change", {});
closeAllPanels();
// 清掉焦点和交互记忆。刚落下的 focus 是"用户刚点过这个框"，优先级比选区高，
// 留着的话测的就是「焦点回落」而不是「选区回落」了（这一节测的是后者）。
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();

const describedSel = helper.describeTarget("negative");
eq(describedSel.nodeId, 2, "没有绑定、没有交互记忆时回落到画布选区（节点 2）");
eq(describedSel.source, "selection", "解析来源是 selection");

pressKey(canvasTarget, { key: "n", code: "KeyN" });
const negArea2 = textareaOf("negative");
// 预填必须是**目标自己的当前内容**。不能写死字符串："目标是谁"这件事
// 会被前面的小节改来改去（本文件按顺序共享同一套 DOM），写死等于把顺序当契约。
eq(negArea2.value, targetText("negative"), "反向面板预填了当前目标（节点 2）的内容");

typeInto(negArea2, "worst quality, lowres");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaB.value, "worst quality, lowres", "写入到了选中的节点 2");
closeAllPanels();

section("目标条：识别错了怎么自己换一个框");

// 用户拍板时明确要的出口（m03294）：
//   「识别错了我自己去点框」「不要列表了，把事情做复杂了」
// 所以这里**没有常驻候选列表**。历史上"换一个框"曾经是下拉框里的一条选项（-3），
// 现在那条已经**按用户要求删掉**（m04545：「列表，那些选择其实是没有用的」）——
// 换目标就只剩一条路：**在画布上直接点要写的那个框**（见上一节的「点哪个框就写哪个框」）。
// 这一节现在钉的就是"下拉框里没有多余选项"这件事本身。
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.select();

// 反向没有绑定、线也认不出来 → 先摊开候选让用户点一次，才有"一个要换掉的目标"。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
const firstPick = pickerItemFor("negative", 2);
ok(!!firstPick, "先随便定一个目标（点节点 2）");
env.dispatch(firstPick, "click", { button: 0 });
await flush();
eq(helper.describeTarget("negative").nodeId, 2, "（准备）现在反向的目标是节点 2");
// 点过候选 = 定下了绑定。下面要测的"换"就是**覆盖这个绑定**，不是找一个新的。
eq(helper.describeTarget("negative").source, "binding", "（准备）点过候选之后就走绑定了");
closeAllPanels();

manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
pressKey(canvasTarget, { key: "n", code: "KeyN" });
ok(isPanelOpen("negative"), "反向面板打开");

const switchSelect = panelOf("negative").querySelector(".xwph-target-select");
eq(switchSelect.value, "0", "下拉框停在绑定上（识别出的目标）");
eq(switchSelect.options.length, 2, "下拉框只有两条：目标本身 + 「不写入，只编辑」（没有多余的入口）");
eq(
  Array.from(switchSelect.options).find((o) => o.value === "-3"),
  undefined,
  "「换一个框…」那条已经不在了（用户要求面板上没有可选项）"
);

// 换目标的正路：在画布上点节点 1 的框。
// 必须先关掉面板再按 —— `show()` 对已经开着的面板是**早退**的，不会重新解析目标，
// 上一次的 target（节点 2）会被原样带进来，`textareaOf` 于是取到旧面板的输入框：
// 断言看上去在测"换目标失败"，其实测的是"面板没重开"。这个坑本节踩过一次。
const areaBBeforeSwitch = String(areaB.value || "");
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
closeAllPanels();
env.dispatch(areaA, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();
eq(helper.describeTarget("negative").nodeId, 1, "在画布上点了节点 1 的框之后，目标就换成节点 1");

typeInto(textareaOf("negative"), "换到节点 1");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaA.value, "换到节点 1", "换过目标之后内容写进了节点 1");
// 证明"目标真的换掉了"：要是还有人以为目标是节点 2，那串字就会落进节点 2。
eq(areaB.value, areaBBeforeSwitch, "节点 2 一个字都没被动（它只是原来那个目标）");
closeAllPanels();

section("目标回落：记住上次写入的节点");

// 用户升级上来时，本地还留着"上次写入过哪个节点"这把老记忆（绑定机制之前存的）。
// 绑定比它优先，所以要先制造出"只有记忆、没有绑定"的局面。
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.select(nodeB);

pressKey(canvasTarget, { key: "n", code: "KeyN" });
const memDescribed = helper.describeTarget("negative");
eq(memDescribed.source, "selection", "（准备）此刻选区仍在起作用");

// 先在节点 2 上真写一次 —— 记忆记的是"上一次 doApply 真的写进去过哪个控件"。
typeInto(textareaOf("negative"), "remembered text");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaB.value, "remembered text", "（准备）建立记忆：这一次真的写进了节点 2");
closeAllPanels();

// 把绑定删掉、选区撤掉、焦点清掉、交互记忆清掉：这时唯一还认得出来的线索就是那把老记忆。
const removedBindings = clearBindingsOnly();
ok(
  removedBindings > 0,
  `（准备）确实删掉了绑定，下面的断言测的才是记忆这一级（storage 现有 ${env.localStorage.length} 项、删了 ${removedBindings} 项、解析来源 ${helper.describeTarget("negative").source}）`
);
env.select();
env.clearFocus();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;

const describedMem = helper.describeTarget("negative");
ok(describedMem.found, "只剩记忆时仍能解析到目标");
eq(describedMem.source, "memory", "解析来源是 memory（老路径仍然兜得住）");
eq(describedMem.nodeId, 2, "记忆里就是上次写进去的那个节点");

// 记忆不是"猜"，是上次真的写进去过的那个控件 —— 这里把它写回去，证明它真的能当目标用。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
const memArea = textareaOf("negative");
ok(!!memArea, "记忆里那个目标能打开面板并预填");
typeInto(memArea, "written through memory");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaB.value, "written through memory", "记忆找回来的目标确实能写进去");
closeAllPanels();

section("目标回落：记忆可以跨越子图");

env.select();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;

// 直接把节点 C（在子图里）的文本框设为交互目标。
env.dispatch(areaC, "pointerdown", { button: 0 });
const describedSub = helper.describeTarget("positive");
eq(describedSub.nodeId, 3, "子图里的节点可以被解析为目标");

// ---------------------------------------------------- 换工作流不能串味

section("认正反的判据是「线落到哪个口」：同一个节点上有两个同名入口时不许认错");

// 这一节是给一个**真机上抓到的 bug** 立的桩（2026-10）。那个 bug 的性质和 m02910 的
// `__comfy_node` 一模一样：桩里全绿、真机全错，而且错得很安静。
//
// 真实工作流长这样：两个 CLIP 文本编码，一条线进 KSampler 的 `positive`，另一条进它的
// `negative`。老写法是"走到一个节点上，就把这个节点的所有入口名扫一遍，谁的名字里带
// positive/negative 就算谁的" —— 于是在真机上，**正向框和反向框都落到了第一个匹配到的
// `positive`（slot 1）**，两个提示词框认成了同一个角色。用户按 N 写反向，写进去的是正向框。
//
// 之所以以前没被测出来：上面那几节用的图里，两个编码器是**裸节点**（没有连线资料），
// 而这一节的判据（"落到哪个口"）从来没有被单独测过。所以这里刻意造一块"和真机同形"的样板：
// 一个采样器，两个口都接上线，两个编码器同名同类型 —— 只有"线落在哪个口"能区分它们。
//
// 注意**位置**：这一段会临时把当前工作流换成样板图，而紧后面那一节（换工作流）依赖
// "现在这张图还是原来那张、里面的绑定还在"。所以：
//   ① 样板图造好之后**立刻**给它一个不撞车的工作流身份，然后马上把当前工作流交还原图
//      （做法和原因见下面那三行）；
//   ② 断言全部放到"换工作流"那一节结束之后再回来做 —— 顺序本身是这份测试的隐含前提，
//      这里把前提写在明处，免得以后有人把这个 section 挪到上面去又踩一遍。
const chainPositiveGraph = env.graph;
const chain = buildSamplerChain(env);
// ★ 样板图造好之后**立刻**给它一个只属于它的工作流身份 —— 这里就必须做，不能等到
// 断言那一节：紧后面的"换工作流"一节依赖"当前工作流还是原图、原图的绑定还在"，
// 而样板图如果和工作流键撞车，那一节会直接红（原图 `w:wf-0` / 样板图 `w:wf-1`
// 那种撞车最难查：两条断言看着都在测插件，其实测的是测试自己把前置状态搞乱了）。
// 身份优先取 `activeWorkflow.key`，所以改完 id 必须再调一次 useGraph() 让它重新生成。
chain.graph.id = 90000 + (chainPositiveGraph.id || 0);
env.useGraph(chain.graph);
// 记下样板图自己的键，断言结束时用它把这一节留下的绑定清干净（不碰原图的键）。
const chainWorkflowPrefix = "w:wf-" + chain.graph.id;
// 当前工作流马上交还给原图：样板图已经拿到身份了，后面的小节照旧在原图上跑。
env.useGraph(chainPositiveGraph);
closeAllPanels();

// ------------------------------------------------------------------
// 「选中节点就认得出正反」（用户 m04569 原话）：
//   「有的人他没有把这种节点连出来…同样选择某个节点，它也会有正负提示词，
//     也是要被 P 和 N 这两个键识别，这样的话，用到通用性就会增加」；
//   「这里面有个少量的情况会出现，就是它并不会在框里面写正提示词和负提示词，
//     但它两个框是分出来的，我估计它的节点内部应该是会区分的」。
//
// 说的是**节点靠控件名自己分正反**的情形：一个节点上并排两个框，名字一个
// `positive_prompt`、一个 `negative_prompt`（也可能反过来写成 `正面`/`负面`）。
// 那时候根本没有线可顺着走，只能按名字认。
//
// 这一节刻意**不造任何连线**：断掉"靠线认"这条后路，测的就是"选中节点 + 按名字认"。
// `recentlySelectedNodeForKind` 的实现见 web/js/prompt_panel.js，
// 判据复用 `Bridge.roleFromPortName`（跟"线落到哪个入口"同一份词表）。
section("选中节点：节点自己带两个提示词框时，按 P / N 各认各的");

env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();

const nodeDual = env.addNode({
  id: 41,
  type: "SomePromptNode",
  title: "双框提示词节点",
  widgets: [
    { name: "negative_prompt", displayName: "negative_prompt", value: "节点自带的负面" },
    { name: "positive_prompt", displayName: "positive_prompt", value: "节点自带的正面" },
  ],
});
const dualPositiveArea = nodeDual._textareas[1];
const dualNegativeArea = nodeDual._textareas[0];
// 选中它（`env.select` 的 map 顺序就是"最后点选的排最后"，插件取第一个命中的）。
env.select(nodeDual);

eq(helper.describeTarget("positive").source, "auto", "P：选中节点就解析出目标（不用点框，没有连线也认得出）");
eq(helper.describeTarget("positive").nodeId, 41, "P：目标就是这个选中的节点");
eq(helper.describeTarget("positive").widgetName, "positive_prompt", "P：认的是名字带 positive 的那个框");
eq(helper.describeTarget("negative").widgetName, "negative_prompt", "N：认的是名字带 negative 的那个框");

// 真的写一遍，确认内容落进各自那个框 —— nodeId 相同，只有控件名能区分，所以必须验值。
closeAllPanels();
pressKey(canvasTarget, { key: "p", code: "KeyP" });
await flush();
textareaOf("positive").value = "选中节点写的正面";
env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(dualPositiveArea.value, "选中节点写的正面", "P 写进了 positive_prompt 那个框");
eq(dualNegativeArea.value, "节点自带的负面", "negative_prompt 那个框一个字没动");

closeAllPanels();
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();
textareaOf("negative").value = "选中节点写的负面";
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(dualNegativeArea.value, "选中节点写的负面", "N 写进了 negative_prompt 那个框");
eq(dualPositiveArea.value, "选中节点写的正面", "positive_prompt 那个框一个字没动");

// 收尾：把造出来的节点摘掉，别把后面的小节（都假定原图是 3 个节点）搞乱。
env.graph._nodes.pop();
env.select();
closeAllPanels();
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;

section("换工作流：记忆不许跨图乱写");

// 先在第一张图里建立记忆：节点 3（子图里的那个正向框）刚被写过。
// 必须先关掉面板：show() 对已经开着的面板是**早退**的，不会重新解析目标，
// 上一节留下的 state.target = null 会被带进来，apply 时就变成了"目标没了"。
closeAllPanels();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.dispatch(areaC, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "p", code: "KeyP" });
typeInto(textareaOf("positive"), "工作流 A 的提示词");
env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(areaC.value, "工作流 A 的提示词", "在 A 图里写进了节点 3");

// 切到另一张工作流，并且那边**也有** id=3 的节点 —— 这正是最容易出错的情形：
// 只比对 id 的话，插件会以为这是上次那个目标，把内容悄悄写进用户没碰过的节点。
const otherGraph = env.newGraph();
// 注意：A 图的 subgraphs 数组里还挂着承载节点 3 的那张子图。只要它不在**当前图**下，
// 插件就遍历不到节点 3；真正切图之前先摘掉，切回来时原样装回去。
const subGraphsOfA = env.graph.subgraphs.splice(0, env.graph.subgraphs.length);
env.useGraph(otherGraph);
const nodeOther3 = env.addNode({
  graph: otherGraph,
  id: 3,
  title: "另一张图的另一个 CLIP 节点",
  widgets: [{ name: "text", value: "工作流 B 原本的内容" }],
});
const otherArea = nodeOther3.widgets[0].element;

manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();

const describedOther = helper.describeTarget("positive");
// 关键保证：换图之后不能命中上一张图的记忆（那会把内容写进 B 图里同 id 的节点）。
ok(describedOther.source !== "memory", "换图之后命中的不是 memory（记忆不跨图）");
// 而且**不能**因为"B 图里恰好也有个 id=3 的节点"就自作主张认下来 —— B 图里那条线根本没接，
// 插件认不出来就该说认不出来，然后让用户点一次。
eq(describedOther.source, "unbound", "换图之后没有绑定、线也认不出来（不把同 id 当同一个人）");
eq(describedOther.found, false, "换图后没有目标可用");
ok(
  Array.isArray(describedOther.candidates) && describedOther.candidates.indexOf(3) >= 0,
  "候选里报了本图（B 图）的节点 3 —— 换图后看的必须是本图的框"
);

// 注意：这里**不能**断言"面板输入框是空的"。面板的编辑器是复用的，关掉时里面留着
// 上一次的内容（那是草稿语义，不是"目标内容"），拿它当"目标解析的对错"会测错东西。
// 「目标解析得对不对」由上面的 source/candidates 断言负责；下面负责的是"写的时候落到谁身上"。

pressKey(canvasTarget, { key: "p", code: "KeyP" });
await flush();
const otherPicker = panelOf("positive").querySelector(".xwph-picker");
ok(!otherPicker.classList.contains("xwph-hidden"), "B 图里认不出目标，摊开候选让用户点一次");
const bGraphItem = pickerItemFor("positive", 3);
ok(!!bGraphItem, "候选里有 B 图的节点 3");
env.dispatch(bGraphItem, "click", { button: 0 });
await flush();

// 点过候选 = 这次面板的目标定了。面板不重新预填（用户可能已经打了一半字），
// 但**写进去的内容**必须属于本图这个节点，所以下面断言的是写完之后那个框里的值。
typeInto(textareaOf("positive"), "工作流 B 里新写的内容");
env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(otherArea.value, "工作流 B 里新写的内容", "在 B 图里写进了 B 图自己的节点");
eq(areaC.value, "工作流 A 的提示词", "B 图的写入没有串到 A 图去");
closeAllPanels();

// 在 B 图里建立属于 B 的记忆，然后来回切：两张图各自的记忆必须互不干扰。
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.dispatch(otherArea, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "p", code: "KeyP" });
typeInto(textareaOf("positive"), "工作流 B 的提示词");
env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(otherArea.value, "工作流 B 的提示词", "在 B 图里写进了 B 的节点 3");
closeAllPanels();

// 切回第一张图：绑定同样不许跨图 —— A 图里之前定下的绑定还在，用户没换工作流时体验不变。
for (const g of subGraphsOfA) env.graph.subgraphs.push(g);
env.useGraph(env.graph);
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();
const describedBack = helper.describeTarget("positive");
eq(describedBack.found, true, "切回原图后目标又能用了（绑定按工作流分开存）");
eq(describedBack.source, "binding", "切回原图后来源是 binding（不是把 B 图的记忆带回来）");

// ------------------------------------------------------------------ 同名入口

// 上一节（换工作流）跑完了，现在才轮到这里 —— 原因见上面造样板图那段的注释。
closeAllPanels();

// 样板图的工作流身份在造它的时候就换好了（见上面 `chainWorkflowPrefix` 那段）。
// 这里只需把当前工作流切回样板图、把状态清干净。**清绑定要按前缀清** ——
// 直接 `env.storage.clear()` 会把原图的绑定一起抹掉，那是"切回原图"那几条断言
// 赖以成立的东西（这个坑真踩过一次：症状是那 4 条断言全红、但插件本身没问题）。
env.useGraph(chain.graph);
clearBindingsByPrefix(chainWorkflowPrefix);
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();

section("认正反的判据是「线落到哪个口」：同一个节点上有两个同名入口时不许认错");

// 先直接问"角色判定"本身。为什么不用 describeTarget() 的 source 当唯一证据：
// `describeTarget()` 会**顺手把正反两个绑定都写下来**（"绑一个顺手绑上另一个"，
// 是为了省用户一次选择），所以第二次问同一个角色时会走绑定 —— 那是设计如此，
// 不是"认错了"。真正要证明的是"判据是线落到哪个口"，那就直接问这个判据。
const roleOfNegativeNode = globalThis.XWidePromptBridge.tracePromptRole(chain.negative, { app: env.app });
eq(roleOfNegativeNode.role, "negative", "反向编码器的角色来自线落到 negative 口（不是撞上同名入口）");
eq(roleOfNegativeNode.stop, "port", "角色是从端口名定下来的（走到了对面节点的入口）");
eq(Number(roleOfNegativeNode.hops[0].id), 70, "对面节点就是那个采样器");
eq(roleOfNegativeNode.hops[0].port, "negative", "落点是 negative 口，不是先撞上的 positive 口");

const roleOfPositiveNode = globalThis.XWidePromptBridge.tracePromptRole(chain.positive, { app: env.app });
eq(roleOfPositiveNode.role, "positive", "正向编码器的角色来自线落到 positive 口");

const chainPositive = helper.describeTarget("positive");
const chainNegative = helper.describeTarget("negative");

eq(chainPositive.source, "auto", "正向：靠线认出来了（不需要用户点）");
eq(chainPositive.nodeId, 67, "正向落在接了 positive 口的那个编码器上");
// 这里不断言 `chainNegative.source === "auto"`：上面问 positive 的时候，插件已经把
// 正反两个绑定都顺手写下了（省用户一次选择），所以再问 negative 走的是绑定。
// 关键结论用 nodeId 断言 —— 它才是"按 N 写进去的是哪个框"这件事本身。
eq(chainNegative.nodeId, 71, "反向落在接了 negative 口的那个编码器上（不是先撞上的 positive）");
ok(chainPositive.nodeId !== chainNegative.nodeId, "正反指向的是两个不同的框（同名入口不该被认成同一个）");

// 用户报的那个错，直接按原样重演一遍：按 N → 打字 → 应用，看落进哪个框。
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();
ok(isPanelOpen("negative"), "按 N 打开的是反向面板");
typeInto(textareaOf("negative"), "CHAIN-NEG-ONLY");
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();

eq(chain.negativeArea.value, "CHAIN-NEG-ONLY", "反向内容写进了反向框");
eq(chain.positiveArea.value, "", "正向框一个字符都没被动过");

// 认出来之后就该稳住：再开一次还是同一个框，不会漂。
//
// 「应用并关闭」把面板关掉了，所以这一轮 pressKey 确实是"开"，不是"再按一次"。
closeAllPanels();
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();
ok(isPanelOpen("negative"), "面板又开出来了");
//
// 注意这里**不走绑定**：当前画布上"线唯一指明本种"的那个框优先级比绑定高（第 ① 条），
// 而它是每次现算的 —— 所以第二次问依然是 "auto"，落点依然是 71。
// 绑定退到第 ③ 条是用户 2026-10 拍板的：他那台机器上留着一条指向 `mode=4` 已停用节点的
// 旧绑定（#520），老顺序里绑定在 ① 前面，于是"画布上明明有正确的框"却永远写旧目标。
// 绑定并没有被废掉 —— 它是**认不出线的时候**才用的那条路（跟"点过的框"配合，
// 定义死了"写哪个框"就一路写它，不会再被别的东西顶掉）。
eq(helper.describeTarget("negative").source, "auto", "第二次打开仍然按画布自己说的算（现算的，不看绑定）");
eq(helper.describeTarget("negative").nodeId, 71, "第二次打开还是落在反向那个框上（没漂）");
closeAllPanels();

// ------------------------------------------------------------------
// 绑定定死之后，用户**在画布上点另一个框**必须能改去向（用户原话 m04455：
// 「弹了框之后，应用没有到我要去的节点里面」）。
//
// 老顺序里绑定是第 ① 条、命中即 return，于是"点另一个框再按 P/N"只改了面板
// 停靠位置（锚点），写入目标仍是老绑定 —— 点框改不了去向，用户**纠不回来**。
// 这一节就是把那个改动钉住：**刚点过的框（且线认得出它是本种）优先级最高**。
//
// 做法：先手动把 negative 的绑定改成"错"的（指向 67 那个**正向**框），
// 再模拟用户在画布上点 71 那个**反向**框，然后按 N —— 必须写到 71。
//
// 这里刻意**不**断言"绑定写进去之后描述出来就是 67"：按现在的优先级，绑定根本轮不到
// 上场（当前画布上线唯一指明 negative 的框是 71，第 ① 条直接命中），所以描述出来仍是 71。
// 那正是这一节要的结果 —— 旧绑定没有能力把目标拽走。绑定有没有被读，靠下面
// "点过的框压过一切"那两条断言来证明。
manager._storage.setJson("bind." + chainWorkflowPrefix + ".negative", { nodeId: 67, widgetName: "text", at: Date.now() });
eq(helper.describeTarget("negative").nodeId, 71, "（准备）旧绑定改不了目标：线认出来的 71 仍然赢");

manager._lastInteracted.element = chain.negativeArea;
manager._lastInteracted.time = Date.now();
env.dispatch(chain.negativeArea, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "n", code: "KeyN" });
await flush();

const clickedTarget = helper.describeTarget("negative");
eq(clickedTarget.nodeId, 71, "画布上刚点过的那个框，压过了旧绑定（点哪个框就写哪个框）");
eq(clickedTarget.source, "focus", "来源是「用户点过的框」，不是绑定");

// 真的应用一次，确认内容落进刚点的那个框。
const positiveBeforeClickTest = String(chain.positiveArea.value || "");
textareaOf("negative").value = "CLICKED-TARGET";
env.dispatch(panelOf("negative").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(chain.negativeArea.value, "CLICKED-TARGET", "内容写进了刚点的那个框");
eq(chain.positiveArea.value, positiveBeforeClickTest, "原来绑定的那个框一个字都没被动");
closeAllPanels();

// 把当前工作流还原成原图 —— 后面的小节（草稿 / 右键菜单 / 稳健性）都还要用它。
// 样板图自己带着绑定了，留着反而会让下面几节的前置状态变得看运气。
env.useGraph(chainPositiveGraph);
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();

// ------------------------------------------------------------------ 真机同形（UUID 接收节点）

// 这一节给**第二个**「桩里全绿、真机全错」立桩（2026-10）。用户报的是：
//   「正 反 提示词会认错，写到正有的时候会填到反里面，写到反，有的时候会填到正里面，
//     有的时候结果又是正确的」。
//
// 上面「线落到哪个口」那一节用的是 KSampler + CLIPTextEncode（入口真名就叫 positive/negative）。
// 真机上用户那两个自造节点完全不是这样：接收节点类型是 UUID、入口真名是 `prompt`、
// 写着正反的 `positive_prompt` 藏在 `label` 里，上游是 "Prompt" 这种类型名里没有关键词的节点。
// 于是老插件两步都断：读 `name` 认不出正反，按类型名判断"这条链值不值得追"直接 `off-chain`。
// 结果就是"有时对有时错" —— 对的时候是别的档（点过的框 / 绑定）碰巧赢了。
section("真机同形：接收节点类型是 UUID、正反藏在入口的显示名 label 上");

const uuid = buildUuidReceiver(env, { positiveValue: "", negativeValue: "老的反向内容" });
// 跟上面样板图同样的规矩：造好立刻给一个不撞车的工作流身份，再重新 useGraph 让它生效。
uuid.graph.id = 93000 + (chainPositiveGraph.id || 0);
env.useGraph(uuid.graph);
const uuidWorkflowPrefix = "w:wf-" + uuid.graph.id;
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();

// 先把"判据本身"钉死，再谈目标解析 —— 否则红的时候分不清是判据错还是优先级错。
eq(
  globalThis.XWidePromptBridge.roleFromPortName("prompt"),
  "",
  "（对照）只看入口真名 prompt 是认不出来的 —— 这就是老版本认错的原因",
);
eq(
  globalThis.XWidePromptBridge.roleFromPortName("positive_prompt"),
  "positive",
  "（对照）用户屏幕上看到的 positive_prompt 认得出来（它在 label 上）",
);

const uuidPosTrace = globalThis.XWidePromptBridge.traceRoleForBox(uuid.positive, null, { app: env.app });
eq(uuidPosTrace.role, "positive", "正向框：角色来自线落在接收节点的 positive_prompt 入口上");
eq(uuidPosTrace.via, "link", "依据是线，不是控件名（真机上这两个框的控件都叫 value）");
eq(uuidPosTrace.stop, "port", "走到了对面节点的入口上（老版本在这里就是 off-chain 了）");
eq(Number(uuidPosTrace.hops[0].id), 90, "落点就是那个 UUID 类型的接收节点");
eq(uuidPosTrace.hops[0].port, "positive_prompt", "给用户看的是他屏幕上的名字（label），不是真名 prompt");

const uuidNegTrace = globalThis.XWidePromptBridge.traceRoleForBox(uuid.negative, null, { app: env.app });
eq(uuidNegTrace.role, "negative", "反向框：同一份判据认得出 negative_prompt");

// 用户报的那个错，按原样重演一遍：**一条指错了边的旧绑定**（正向绑在反向框上）
// ＋ **用户刚在画布上点过反向框**。这两样在老版本里都能把目标拽到反向框上：
// 老顺序里绑定是第 ① 档、命中即 return，而"点过的框"更是直接赢。
manager._storage.setJson("bind." + uuidWorkflowPrefix + ".positive", { nodeId: 92, widgetName: "value", at: Date.now() });
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();
env.dispatch(uuid.negativeArea, "pointerdown", { button: 0 });

const wrongSide = helper.describeTarget("positive");
eq(wrongSide.found, true, "按 P 仍然解析得到目标（不是干脆放弃）");
ok(wrongSide.nodeId !== 92, "按 P 绝不落在反向框上 —— 哪怕旧绑定和刚点过的框都指着它");
eq(wrongSide.nodeId, 91, "落点就是那个正向框");

// 再真的走一遍完整动作：按 P → 打字 → 应用。写入的必须只有正向框。
pressKey(canvasTarget, { key: "p", code: "KeyP" });
await flush();
ok(isPanelOpen("positive"), "按 P 打开的是正向面板");
typeInto(textareaOf("positive"), "UUID-POS-ONLY");
env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();
eq(uuid.positiveArea.value, "UUID-POS-ONLY", "正向内容写进了正向框");
eq(uuid.negativeArea.value, "老的反向内容", "反向框一个字符都没被动过");
closeAllPanels();

// 反过来：**点着反向框按 P** —— 用户要的是"这一对的另一边"，不是"随便哪个"。
// 这一条钉的是第 ⓪ 档的配对分支（source 必须是 "pair"：第 ① 档也会给出同一个框，
// 但它会说 "auto"，那就证明不了"配对"这条路径真的在起作用）。
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();
env.dispatch(uuid.negativeArea, "pointerdown", { button: 0 });

const pairedTarget = helper.describeTarget("positive");
eq(pairedTarget.source, "pair", "点着反向框按 P：走的是「配对」这一档");
eq(pairedTarget.nodeId, 91, "配对给出的是跟它连在同一个接收节点上的那个正向框");

// 反向那一侧同理：点着正向框按 N，也要给出配对的另一半。
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();
env.dispatch(uuid.positiveArea, "pointerdown", { button: 0 });
const pairedNegative = helper.describeTarget("negative");
eq(pairedNegative.source, "pair", "点着正向框按 N：同样走配对");
eq(pairedNegative.nodeId, 92, "配对给出的是反向框");

// 指错边的旧绑定必须**自己烂掉**，不能留着下次继续毒。
// 这一段刻意只造反向那一个框：正向框不存在，于是 ①②③ 都无从下手，
// 目标只能靠 ④ 绑定 —— 而那条绑定指着的是角色明确为 negative 的框。
// 老版本会照用不误（把正向内容写进反向框），新版本认得出它是污染，删掉并继续往下找。
const onlyNeg = buildUuidReceiver(env, { positive: null, negativeValue: "只剩反向框" });
onlyNeg.graph.id = 94000 + (chainPositiveGraph.id || 0);
env.useGraph(onlyNeg.graph);
const onlyNegPrefix = "w:wf-" + onlyNeg.graph.id;
env.storage.clear();
manager._storage.setJson("bind." + onlyNegPrefix + ".positive", { nodeId: 92, widgetName: "value", at: Date.now() });
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();
env.dispatch(onlyNeg.negativeArea, "pointerdown", { button: 0 });

const poisoned = helper.describeTarget("positive");
ok(poisoned.nodeId !== 92, "被污染的绑定不会把正向写到反向框上");
const poisonedKey = "bind." + onlyNegPrefix + ".positive";
ok(
  !Array.from(env.storage.keys()).some((k) => String(k).includes(poisonedKey)),
  "这条指错边的绑定已经被删掉了（不会留着下次继续毒）",
);

// 收尾：把当前工作流交还原图，并把这一节留下的绑定清干净。
// 原图的绑定在上面的样板图小节里已经清过了（`env.storage.clear()`），这里照旧要还回去。
env.useGraph(chainPositiveGraph);
env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.clearFocus();
env.select();

// ------------------------------------------------------------------ 草稿

section("草稿：关掉面板不丢内容");

env.storage.clear();
manager._lastInteracted.element = null;
manager._lastInteracted.time = 0;
env.select();

pressKey(canvasTarget, { key: "p", code: "KeyP" });
const draftArea = textareaOf("positive");
// 没有草稿时预填的就是目标当前的内容（可能有默认目标，也可能是空）。
eq(draftArea.value, targetText("positive"), "没有草稿时预填目标当前内容，而不是凭空造内容");

typeInto(draftArea, "还没应用的一段草稿");
// 让防抖落盘跑完。
await new Promise((r) => setTimeout(r, 320));

// 按 Escape 关闭。
pressKey(draftArea, { key: "Escape" });
await flush();
ok(!isPanelOpen("positive"), "Escape 关闭面板");

const draftKey = Array.from(env.storage.keys()).find((k) => k.endsWith(".draft.positive"));
ok(!!draftKey, "草稿被写进了存储");
eq(env.storage.get(draftKey), "还没应用的一段草稿", "草稿内容正确");

// 再打开，草稿应当被恢复。
pressKey(canvasTarget, { key: "p", code: "KeyP" });
eq(textareaOf("positive").value, "还没应用的一段草稿", "重新打开时恢复了草稿");

section("草稿：应用成功后清掉");

manager._lastInteracted.element = 0;
env.dispatch(areaA, "pointerdown", { button: 0 });
helper.describeTarget("positive");
// 像真实用户那样把草稿改成这一次要写进去的内容 —— 不改的话，应用后清掉草稿，
// 下次打开面板又会把同一段内容拿回来，测试就分不清“草稿没清”和“草稿又回来了”。
const applyArea = textareaOf("positive");
typeInto(applyArea, "这一次真的要写进去");
await new Promise((r) => setTimeout(r, 320));

env.dispatch(panelOf("positive").querySelector(".xwph-btn-primary"), "click", { button: 0 });
await flush();

eq(areaA.value, "这一次真的要写进去", "草稿被写进了节点 1");
const draftKey2 = Array.from(env.storage.keys()).find((k) => k.endsWith(".draft.positive"));
ok(!draftKey2, "应用成功后草稿被清掉");

// 再打开一次：不能又冒出旧草稿（hide 时无条件落盘就会这样）。
pressKey(canvasTarget, { key: "p", code: "KeyP" });
eq(textareaOf("positive").value, "这一次真的要写进去", "重新打开时显示的是节点里的内容，不是复活的旧草稿");
closeAllPanels();

// ------------------------------------------------------------------ 按钮功能

section("按钮：清空，以及已经去掉的那三个");

env.dispatch(areaA, "pointerdown", { button: 0 });
pressKey(canvasTarget, { key: "p", code: "KeyP" });
const btnPanel = panelOf("positive");
const area2 = textareaOf("positive");

const buttons = btnPanel.querySelectorAll(".xwph-btn");
const clearBtn = buttons.find((b) => b.textContent === "清空");
ok(!!clearBtn, "找到清空按钮");

// 用户 m05666：「" 撤销 复制  词库"  去除不要了」—— 三个按钮都得真的从面板上消失。
// 这条断言同时是"别再加回来"的守门人：真要加回来，改的是这里 + CHANGELOG，
// 而不是某天悄悄冒出来一个按钮。
ok(!buttons.some((b) => b.textContent === "撤销"), "「撤销」按钮已经不在了");
ok(!buttons.some((b) => b.textContent === "复制"), "「复制」按钮已经不在了");
ok(!buttons.some((b) => b.textContent === "词库"), "「词库」按钮已经不在了");

// 撤销栈本身**留着**（`commitText` / `receiveText` 照旧往里压，以后想接回别的地方随时能接），
// 所以这里只验"清空"这一半 —— 撤销那半现在没有入口了，上面那条"按钮不在了"就是它的契约。
typeInto(area2, "按钮测试内容");
await flush();

// 用户后来追加的要求：「有时要清空负面词」→ 他拍板的是**双清**：
// 面板清空，写入目标那个框也一起写成空（"这个框我不要了"）。
const clearTarget = helper.describeTarget("positive");
ok(clearTarget && clearTarget.found, "（准备）清空前解析得到写入目标");
ok(
  setWidgetText(clearTarget.nodeId, clearTarget.widgetName, "画布上不想要的内容"),
  "（准备）目标框里先放上内容",
);

env.dispatch(clearBtn, "click", { button: 0 });
await flush();
eq(area2.value, "", "清空按钮清掉了面板内容");
eq(targetText("positive"), "", "写入目标那个框也被一起清空了（双清）");

const clearAgain = helper.describeTarget("positive");
eq(clearAgain.nodeId, clearTarget.nodeId, "清空只清内容，不会把写入目标换掉");

// 下两节（送去对面 / 自动粘贴）都要接着用这段内容。
typeInto(area2, "按钮测试内容");
await flush();

await new Promise((r) => setTimeout(r, 320));

section("按钮：送去对面");

const swapBtn = buttons.find((b) => b.textContent === "→ 负向");
ok(!!swapBtn, "找到「送去对面」按钮");
env.dispatch(swapBtn, "click", { button: 0 });
await flush();

ok(isPanelOpen("negative"), "对面（反向）面板被打开");
eq(textareaOf("negative").value, "按钮测试内容", "内容被送了过去");
ok(!isPanelOpen("positive"), "自己这边收了起来");

// 复制按钮整块撤掉了（用户 m05666），"把内容写进剪贴板"这件事的断言也就不再有了。
// 取而代之的是**别处复制 → 面板自动收下**那条路，见下面「粘贴：别处复制的内容自己进面板」。

section("自动粘贴：回到页面时自己读一次剪贴板");

// 用户：「粘帖 没有效果 … 其实最好的效果就是 在其它地方只要有 复制的命令触发，
// 这边打开的 就自己动 粘帖 进来」。
// 面板上那个「粘贴」按钮按他的要求**去掉了**，换成：窗口重新获得焦点时自动读一次剪贴板
// （Chrome / Edge 允许无手势读；Firefox 禁止，会走"只提示一次"的降级路，见下面那条断言）。
env.clipboard.text = "从剪贴板来的内容";
ok(manager.getAutoPaste(), "自动粘贴默认是开的");

// 面板先清干净，这样"收下了什么"看得最清楚（上一节送去对面的内容还在这儿）。
typeInto(textareaOf("negative"), "");
await flush();

await manager.tryAutoPasteFromClipboard("test");
eq(textareaOf("negative").value, "从剪贴板来的内容", "回到页面时剪贴板内容自己进了面板");

// 间隔保护：切窗口时 focus/visibilitychange 会连着来好几下，不能每次都去读剪贴板。
env.clipboard.text = "紧接着改掉的剪贴板";
await manager.tryAutoPasteFromClipboard("test");
ok(!textareaOf("negative").value.includes("紧接着改掉的剪贴板"), "短间隔内不会连着读第二次");

await new Promise((r) => setTimeout(r, 700));
await manager.tryAutoPasteFromClipboard("test");
ok(textareaOf("negative").value.includes("紧接着改掉的剪贴板"), "过了间隔就能再收一段新的");

// 同一段内容只收一次：否则每次切窗口回来都会把同样一段字再接一遍。
const duped = textareaOf("negative").value.split("紧接着改掉的剪贴板").length - 1;
await new Promise((r) => setTimeout(r, 700));
await manager.tryAutoPasteFromClipboard("test");
eq(
  textareaOf("negative").value.split("紧接着改掉的剪贴板").length - 1,
  duped,
  "剪贴板里没变过，就不会把同一段字重复收进来",
);

section("自动粘贴：勾选框（面板 + 设置里各一个）");

const autoBox = panelOf("negative").querySelector(".xwph-check-box");
ok(!!autoBox, "面板页脚有「自动粘贴」勾选框");
ok(autoBox.checked === true, "默认是勾上的");

autoBox.checked = false;
env.dispatch(autoBox, "change", {});
await flush();
eq(manager.getAutoPaste(), false, "取消勾选写进了插件的存储");

// 另一个面板的勾选框跟的是**同一个**真相，不能各说各话。
helper.open("positive");
await flush();
const posBox = panelOf("positive").querySelector(".xwph-check-box");
eq(posBox.checked, false, "另一个面板的勾选框会同步成关");

env.clipboard.text = "关掉之后不许收";
await new Promise((r) => setTimeout(r, 700));
await manager.tryAutoPasteFromClipboard("test");
ok(!textareaOf("positive").value.includes("关掉之后不许收"), "关掉之后一次都不读剪贴板");

posBox.checked = true;
env.dispatch(posBox, "change", {});
await flush();
eq(manager.getAutoPaste(), true, "勾回去也写进存储");

const autoStored = Array.from(env.storage.entries()).find(([k]) => k.endsWith(".autopaste"));
ok(!!autoStored, "开关状态落在插件的存储里（唯一真相）");

section("文字大小：面板标题栏能调，设置里也能调");

// 用户 1.0.4：「打开的对话框里文字太小，加入大小调节」。
// 做法：面板里所有字号都乘 `--xwph-scale`（CSS 里 calc(Npx * var(--xwph-scale, 1))），
// 面板标题栏的 A- / A+ 和设置里那一行改的是同一个存储值（fontScale）。
const scaleVar = () => String(env.doc.documentElement.style.getPropertyValue("--xwph-scale"));
eq(scaleVar(), "1", "默认倍数写成了 1（CSS 变量挂在根节点上）");

closeAllPanels();
helper.open("positive");
await flush();
const fontPanel = panelOf("positive");
const fontDownBtn = fontPanel.querySelector(".xwph-font-down");
const fontUpBtn = fontPanel.querySelector(".xwph-font-up");
ok(!!fontDownBtn && !!fontUpBtn, "面板标题栏上有 A- / A+ 两个按钮");

env.dispatch(fontUpBtn, "click", { button: 0 });
await flush();
eq(scaleVar(), "1.1", "点 A+ 之后倍数变成 1.1");
env.dispatch(fontUpBtn, "click", { button: 0 });
await flush();
eq(scaleVar(), "1.2", "再点一下是 1.2");
env.dispatch(fontDownBtn, "click", { button: 0 });
await flush();
eq(scaleVar(), "1.1", "A- 能调回来");

// 存进插件存储：刷新页面/换面板都还记得
const fontRaw = Array.from(env.storage.entries()).find(([k]) => k.endsWith(".fontScale"));
ok(!!fontRaw, "倍数落在插件的存储里");
ok(String(fontRaw[1]).indexOf("1.1") >= 0, "存的就是 1.1");

// 设置里那一行：同一个值，百分比跟着变
// （这里自己重新找一遍：下面「设置」小节里那个 fontItem 是 const，在这一行之前还没初始化。）
const fontSettingItem = env.app.registeredSettings.find((i) => i.id === "XWidePromptHelper.fontScale");
ok(!!fontSettingItem, "文字大小也注册进了原生设置");
const fontEditor = fontSettingItem.type();
eq(typeof fontSettingItem.type, "function", "文字大小用函数型 type 渲染自定义 DOM");
eq(fontEditor.querySelector(".xwph-font-value").textContent, "110%", "设置行里的百分比跟面板是同一个值");
env.dispatch(fontEditor.querySelector(".xwph-font-reset"), "click", { button: 0 });
await flush();
eq(scaleVar(), "1", "设置里的「恢复默认大小」把倍数调回 1");
eq(fontEditor.querySelector(".xwph-font-value").textContent, "100%", "百分比跟着刷新");

// 上下限：放不满也缩不没
for (let i = 0; i < 20; i += 1) env.dispatch(fontEditor.querySelector(".xwph-font-up"), "click", { button: 0 });
await flush();
eq(scaleVar(), "4", "放大会停在 400%（用户要的上限）");
for (let i = 0; i < 30; i += 1) env.dispatch(fontEditor.querySelector(".xwph-font-down"), "click", { button: 0 });
await flush();
eq(scaleVar(), "0.7", "缩小会停在 70%");
env.dispatch(fontEditor.querySelector(".xwph-font-reset"), "click", { button: 0 });
await flush();
eq(scaleVar(), "1", "恢复默认之后回到 100%（后面的小节不受影响）");

// Ctrl + 滚轮实时调（用户 1.0.4：「里面的文字…比如按滚轮就实时调整字的大小」）。
const wheelArea = fontPanel.querySelector(".xwph-textarea");
env.dispatch(wheelArea, "wheel", { ctrlKey: true, deltaY: -100 });
await flush();
eq(scaleVar(), "1.1", "输入框里 Ctrl + 滚轮往上 = 放大");
env.dispatch(wheelArea, "wheel", { ctrlKey: true, deltaY: 100 });
await flush();
eq(scaleVar(), "1", "Ctrl + 滚轮往下 = 缩小");

// 输入框里**不带 Ctrl** 的滚轮必须留给滚动本身：提示词动辄几千字，抢掉滚动就没法读了。
const plainWheel = env.dispatch(wheelArea, "wheel", { deltaY: -100 });
await flush();
eq(scaleVar(), "1", "输入框里光滚轮不改字号（那是滚提示词用的）");
ok(!plainWheel.defaultPrevented, "光滚轮没有被我们拦掉（浏览器照常滚动）");

// 面板其它地方（那里本来没东西可滚）光滚也当调字号。
env.dispatch(fontPanel.querySelector(".xwph-header"), "wheel", { deltaY: -100 });
await flush();
eq(scaleVar(), "1.1", "标题栏上光滚也能调字号");
env.dispatch(fontPanel.querySelector(".xwph-header"), "wheel", { deltaY: 100 });
await flush();
eq(scaleVar(), "1", "再滚回来");

section("粘贴：别处复制的内容自己进面板");

// 用户 m05666 的原话：「其实最好的效果就是 在其它地方只要有 复制的命令触发，这边打开的
// 就自己动 粘帖 进来」。做法是监听**页面级**的 copy / paste 捕获事件（不抢默认行为，
// 也从不 preventDefault），把文本交给当前那个面板的 receiveText()。
//
// 这里刻意用 `env.doc.body` 当目标：真实浏览器里用户在别的插件面板里按 Ctrl+C，
// 事件也是从那个元素冒到 document 上的 —— 桩里的 dispatch 会照真实事件流走一遍捕获链。
helper.open("positive");
const autoArea = textareaOf("positive");
typeInto(autoArea, ""); // 清干净，好看出"收下了哪些字"
await flush();

const copyEvent = env.dispatch(env.doc.body, "copy", {
  clipboardData: { getData: (type) => (type === "text/plain" ? "别处复制来的提示词" : "") },
});
ok(!copyEvent.defaultPrevented, "页面上别人触发的复制，我们只是听着，不拦");

ok(autoArea.value.includes("别处复制来的提示词"), "复制的内容被面板自动收下了");

// 用户亲手改过内容之后（editorDirty），后续复制来的内容**接在后面**而不是把
// 他写的东西顶掉 —— 自动收下不能变成"偷偷替换用户正在写的东西"。
typeInto(autoArea, "我自己写的开头");
await flush();
env.dispatch(env.doc.body, "copy", {
  clipboardData: { getData: () => "接在后面的内容" },
});
ok(autoArea.value.includes("我自己写的开头"), "用户自己写的内容还在");
ok(autoArea.value.includes("接在后面的内容"), "复制来的内容接在了后面");

// 面板里自己按 Ctrl+C 不该被当成"别处复制"（那会把面板内容自己喂给自己，翻倍）。
const beforeInnerCopy = String(autoArea.value || "");
env.dispatch(autoArea, "copy", {
  clipboardData: { getData: () => "面板内部复制" },
});
eq(String(autoArea.value || ""), beforeInnerCopy, "面板内部触发的复制不进面板（内容不会自己翻倍）");

// 页面里的 Ctrl+V 也要管用：那正是浏览器不给脚本读剪贴板时用户唯一的办法。
env.dispatch(env.doc.body, "paste", {
  clipboardData: { getData: () => "从页面粘贴进来的" },
});
ok(autoArea.value.includes("从页面粘贴进来的"), "页面里的粘贴（Ctrl+V）也能送进面板");

const autoToast = String((env.doc.querySelector(".xwph-toasts") || {}).textContent || "");
ok(autoToast.includes("自动收下"), "收下之后弹了一句提示，用户知道发生了什么");

// 下一节（面板内打字不会漏给画布）用的是**反向**面板，这里把它开回来 ——
// 显式开一次，别依赖上一节留下的打开状态（那样两节之间就有了看不见的耦合）。
closeAllPanels();
helper.open("negative");
await flush();

section("面板内打字不会漏给画布");

const innerArea = textareaOf("negative");
const keyEv = pressKey(innerArea, { key: "a" });
ok(keyEv._stopped, "面板输入框里的按键被拦下（不会触发画布快捷键）");

const escEv = pressKey(innerArea, { key: "Escape" });
ok(escEv.defaultPrevented, "Escape 被面板消费");
await flush();

section("词库：面板上的入口撤掉了，存储接口还在");

// 用户 m05666：「" 撤销 复制  词库"  去除不要了」—— 词库按钮跟着一起撤了。
// 但**存储层刻意留着**（`libraryAll` / `librarySave` / `libraryRemove`）：它是纯存储，
// 删掉以后想加回来就得重写一遍；而且老用户的词条不能因为"按钮没了"就凭空消失。
// 这里守两件事：① 面板上确实没有入口了；② 接口本身还能存能读能删。
helper.open("positive");
const libPanel = panelOf("positive");

const libBtn = libPanel.querySelectorAll(".xwph-btn").find((b) => b.textContent === "词库");
ok(!libBtn, "面板上找不到词库入口了（用户要求去掉）");
ok(!byClass("xwph-libmenu").length, "词库菜单也不会自己冒出来");

const savedEntry = manager._library.save("我的风格", "词库测试内容");
ok(!!savedEntry, "存储接口仍然能存词条");

const libRaw = Array.from(env.storage.entries()).find(([k]) => k.endsWith(".library"));
ok(!!libRaw, "词库写进了存储");
ok(String(libRaw[1]).includes("我的风格"), "词库存下了词条名");
ok(String(libRaw[1]).includes("词库测试内容"), "词库存下了词条内容");

ok(
  manager._library.all().some((e) => e.name === "我的风格"),
  "词条读得回来（老用户的词条不会因为按钮撤掉就没了）",
);
manager._library.remove("我的风格");
ok(!manager._library.all().some((e) => e.name === "我的风格"), "词条删得掉");

section("设置：注册进 ComfyUI 原生设置面板（只有两行）");

// 两个来源的事实：① 用户 m02067 的回答「放到本有的设置里，就是左下角那个」——
// 不要自造设置弹窗；② 用户 1.0.4 发的真机截图：「就是图1，就是我的排板有问题的地方」。
// 那一眼看出的毛病是重复与噪音：两行**文字**快捷键设置跟新编辑器说的是同一件事、
// 却常常显示得不一样（截图里编辑器是 P，下面那行还写着 Ctrl+S），"关于"那一行更是被
// 前端渲染成一个装着版本号的可编辑文本框。所以现在**只留两行**：改快捷键、开关自动粘贴。
const settingsItems = env.app.registeredSettings;
eq(settingsItems.length, 4, "设置面板里四行（插件信息 / 快捷键 / 自动粘贴 / 文字大小）");

const infoItem = settingsItems.find((i) => i.id === "XWidePromptHelper.info");
const checkItem = settingsItems.find((i) => i.id === "XWidePromptHelper.shortcutCheck");
const autoItem = settingsItems.find((i) => i.id === "XWidePromptHelper.autopaste");
const fontItem = settingsItems.find((i) => i.id === "XWidePromptHelper.fontScale");
ok(!!infoItem, "插件信息那一行的 id 是 XWidePromptHelper.info");
ok(!!checkItem, "快捷键那一行的 id 是 XWidePromptHelper.shortcutCheck");
ok(!!autoItem, "自动粘贴那一行的 id 是 XWidePromptHelper.autopaste");
ok(!!fontItem, "文字大小那一行的 id 是 XWidePromptHelper.fontScale");
ok(!settingsItems.some((i) => /^XWidePromptHelper\.shortcut\./.test(String(i.id))), "两行文字快捷键设置已经删掉");
ok(!settingsItems.some((i) => i.id === "XWidePromptHelper.about"), "那条会被渲染成文本框的「关于」行已经删掉");
ok(!settingsItems.some((i) => i.type === "text"), "设置面板里不再有会被渲染成文本框的展示行");

// 用户用红箭头指着设置面板左边那一条说「这个页面排版还没改」，参考图是
// X-WIDE_plugin_model_manager：品牌区打头 + 卡片分区。所以那一页右边那一列现在是
// 「品牌区 + 作者与链接 + 用法」三张卡片（后面几行也各自是一张卡片）。
const infoBlock = infoItem.type();
ok(String(infoBlock.className).includes("xwph-page"), "插件信息那一行渲染成一张「页面」");
ok(!!infoBlock.querySelector(".xwph-about-brand"), "页面打头是品牌区（logo + 标题 + 副标题 + 徽章）");
ok(!!infoBlock.querySelector(".xwph-about-logo"), "品牌区里有 logo");
ok(!!infoBlock.querySelector(".xwph-about-lic"), "有协议徽章");
eq(infoBlock.querySelectorAll(".xwph-linkbtn").length, 2, "「作者与链接」里只有两个入口");
ok(String(infoBlock.querySelector(".xwph-about-text").textContent).includes("清空"), "「用法」卡片里有那几条说明");

// 函数型 type：原生面板会把我们返回的 DOM 直接挂进这一行（X-WIDE 别的插件也这么干）。
eq(typeof checkItem.type, "function", "快捷键行用函数型 type 渲染自定义 DOM");
eq(checkItem.name, "快捷键", "快捷键行的名字很短（不再是那一长串）");
ok(String(checkItem.tooltip || "").length < 60, "它的 tooltip 只有一句话（长提示会挂在那儿不消失）");
ok(Array.isArray(checkItem.category) && checkItem.category.length >= 1, "设置项有分类（决定显示在原生面板哪个分组）");

eq(typeof autoItem.type, "function", "自动粘贴那一行也渲染成卡片（这样整页才能居中排版）");
ok(!!autoItem.type().querySelector(".xwph-check-box"), "卡片里有勾选框");
ok(String(autoItem.tooltip || "").length < 60, "自动粘贴的 tooltip 也只有一句话");
ok(String(autoItem.name || "").length > 0, "卡片行的名字还在（设置面板的搜索按名字过滤）");

// 前端 settingStore 的建树坑：同一条 category 路径的最后一段会被标成 leaf，
// 两行共用就只剩一行。所以这两行的分类末段必须不同。
ok(
  checkItem.category[checkItem.category.length - 1] !== autoItem.category[autoItem.category.length - 1],
  "两行的分类末段不同（否则前端建树会把一行吃掉）",
);

// 面板 header 上的齿轮按钮要打开 ComfyUI 自己的设置面板，而不是我们造的窗口。
helper.openSettings();
await flush();
ok(
  env.app.executedCommands.includes("Comfy.ShowSettingsDialog"),
  "点设置会去执行 Comfy.ShowSettingsDialog 命令"
);

const before = helper.shortcuts().positive;
eq(before.key.toLowerCase(), "p", "（准备）改之前正向快捷键还是 P");

// 改快捷键：文字行没了，改的入口是编辑器（下面单独一节）与存储接口本身。
manager.setShortcuts({ positive: manager.parseShortcut("J"), negative: helper.shortcuts().negative });
await flush();
eq(helper.shortcuts().positive.key.toLowerCase(), "j", "改完之后快捷键立刻变成 J");
eq(helper.shortcuts().positive.ctrl, false, "单键 J 不带修饰键");

manager.closeAll();
await flush();

let evJ = pressKey(canvasTarget, { key: "j", code: "KeyJ" });
ok(evJ._stopped, "新快捷键 J 生效");
ok(isPanelOpen("positive"), "新快捷键打开了正向面板");
manager.closeAll();

const evP = pressKey(canvasTarget, { key: "p", code: "KeyP" });
ok(!evP._stopped, "旧的 P 已失效");

// 组合键也要能设：老用户可能更习惯带修饰键。
manager.setShortcuts({ positive: manager.parseShortcut("Ctrl+Alt+P"), negative: helper.shortcuts().negative });
await flush();
eq(helper.shortcuts().positive.key.toLowerCase(), "p", "组合键字符串解析出了 p");
eq(helper.shortcuts().positive.ctrl, true, "组合键字符串解析出了 ctrl");
eq(helper.shortcuts().positive.alt, true, "组合键字符串解析出了 alt");

manager.closeAll();
await flush();
evJ = pressKey(canvasTarget, { key: "p", code: "KeyP", ctrl: true, alt: true });
ok(evJ._stopped, "改回 Ctrl+Alt+P 之后组合键生效");
manager.closeAll();
await flush();

// 改回默认，免得影响后面的小节。
manager.setShortcuts(manager.defaultShortcuts());
await flush();
eq(helper.shortcuts().positive.key.toLowerCase(), "p", "改回默认的 P");
eq(helper.shortcuts().positive.ctrl, false, "改回默认后不带修饰键");

section("快捷键：自己改 + 冲突提示");

// 用户要的：「在设置里面，快捷键 也可以自己定义 ，并提示有没有 冲突的快捷键」。
// 函数型设置项的返回值就是挂在原生面板那一行下面的 DOM，所以测试可以直接驱动它。
const editorRoot = checkItem.type();
ok(!!editorRoot, "函数型设置项返回了 DOM");
ok(String(editorRoot.className || "").includes("xwph-card"), "快捷键那一行渲染成一张卡片");
ok(!!editorRoot.querySelector(".xwph-shortcut-editor"), "卡片里是快捷键编辑器");

const caps = editorRoot.querySelectorAll(".xwph-keycap");
eq(caps.length, 2, "两个键各有一个按键框");
const statusLines = editorRoot.querySelectorAll(".xwph-shortcut-status");
eq(statusLines.length, 2, "每个键各有一条**独立**的状态行（一个键可用不代表另一个也可用）");

// 默认是 P / N 这种单键：不该说"可用"，要说清风险。
ok(statusLines[0].className.includes("xwph-warn"), "默认单键 P 的状态是「提醒」而不是「可用」");
ok(String(statusLines[0].textContent).includes("Ctrl"), "提醒里说清了为什么（缺修饰键）");
eq(caps[0].textContent.trim(), "P", "按键框里显示当前是 P");

// 点一下按键框 → 进入"等按键"；接着按 Ctrl+S → 必须报"和 ComfyUI 冲突"。
env.dispatch(caps[0], "pointerdown", { button: 0 });
await flush();
ok(caps[0].className.includes("xwph-keycap-capturing"), "点一下进入「等按键」状态");
ok(String(caps[0].textContent).includes("按下"), "框里提示用户按键");
eq(statusLines[0].className.trim(), "xwph-shortcut-status xwph-warn", "等着的时候状态行不被当成错误");

env.dispatch(env.win, "keydown", env.keyEvent({ key: "s", code: "KeyS", ctrl: true }));
await flush();
eq(helper.shortcuts().positive.ctrl, true, "捕获到了 Ctrl");
eq(helper.shortcuts().positive.key.toLowerCase(), "s", "捕获到了 S");
ok(!caps[0].className.includes("xwph-keycap-capturing"), "捕获完就退出等待状态");
ok(statusLines[0].className.includes("xwph-bad"), "Ctrl+S 被判成冲突（红）");
ok(String(statusLines[0].textContent).includes("ComfyUI"), "文案说明是跟 ComfyUI 自带的快捷键撞了");

// 真机上发现的一条：改完快捷键，**原生那两行文字设置也得跟着变**。
// 1.0.4 把那两行文字设置整行删掉了（它们和新编辑器重复、还会互相矛盾），
// 所以这里只守"自动粘贴那一个开关两边一致" —— 面板页脚改也要同步到原生那一行。
manager.setAutoPaste(false);
await flush();
eq(
  env.app.extensionManager.setting.get("XWidePromptHelper.autopaste"),
  false,
  "面板页脚关掉自动粘贴，原生设置那一行也跟着变（两边是同一个开关）",
);
manager.setAutoPaste(true);
await flush();
eq(env.app.extensionManager.setting.get("XWidePromptHelper.autopaste"), true, "勾回去同样同步");

// 换一个没人用的组合 → 绿。
env.dispatch(caps[0], "pointerdown", { button: 0 });
await flush();
env.dispatch(env.win, "keydown", env.keyEvent({ key: "j", code: "KeyJ", ctrl: true, alt: true }));
await flush();
eq(helper.shortcuts().positive.alt, true, "组合键里的 Alt 也捕获到了");
ok(statusLines[0].className.includes("xwph-ok"), "没人用的组合报「可用」（绿）");

// 两个键设成同一个：得说清会互相抢。
env.dispatch(caps[1], "pointerdown", { button: 0 });
await flush();
env.dispatch(env.win, "keydown", env.keyEvent({ key: "j", code: "KeyJ", ctrl: true, alt: true }));
await flush();
ok(statusLines[1].className.includes("xwph-bad"), "两个键撞在一起会被指出来（红）");

// Esc 取消 + Delete 关掉这个键。
env.dispatch(caps[0], "pointerdown", { button: 0 });
await flush();
env.dispatch(env.win, "keydown", env.keyEvent({ key: "Escape", code: "Escape" }));
await flush();
eq(helper.shortcuts().positive.key.toLowerCase(), "j", "Esc 只是取消，不改键");

env.dispatch(caps[0], "pointerdown", { button: 0 });
await flush();
env.dispatch(env.win, "keydown", env.keyEvent({ key: "Delete", code: "Delete" }));
await flush();
ok(!helper.shortcuts().positive, "Delete 把正向这个键关掉了");
ok(statusLines[0].className.includes("xwph-warn"), "关掉之后状态行提醒它现在是关着的");

// "恢复默认按键"要能一次复原。
const resetBtn = editorRoot.querySelectorAll(".xwph-btn").find((b) => b.textContent.includes("恢复默认"));
ok(!!resetBtn, "编辑器里有「恢复默认按键」按钮");
env.dispatch(resetBtn, "click", { button: 0 });
await flush();
eq(helper.shortcuts().positive.key.toLowerCase(), "p", "恢复默认后正向回到 P");
eq(helper.shortcuts().negative.key.toLowerCase(), "n", "恢复默认后反向回到 N");
ok(statusLines[0].className.includes("xwph-warn"), "恢复默认后状态行跟着刷新");

// 真机实测的另一条：ComfyUI 自己也有 P / N（P = 画布上的"钉住选中节点"、
// N = 切换节点库侧栏）。这**不算冲突** —— 插件的监听在捕获相、命中就吃掉事件，
// 真机验过按 P / N 只出浮窗，节点没被钉住、侧栏也没动。报成红灯就是误报。
env.app.extensionManager.command.commands = [
  {
    id: "Comfy.Canvas.ToggleSelected.Pin",
    title: "Pin/Unpin Selected Items",
    get keybinding() {
      return { combo: { toString: () => "P" } };
    },
  },
];
const liveEditor = checkItem.type();
const liveCaps = liveEditor.querySelectorAll(".xwph-keycap");
const liveStatus = liveEditor.querySelectorAll(".xwph-shortcut-status")[0];
env.dispatch(liveCaps[0], "pointerdown", { button: 0 });
await flush();
env.dispatch(env.win, "keydown", env.keyEvent({ key: "p", code: "KeyP" }));
await flush();
ok(!liveStatus.className.includes("xwph-bad"), "ComfyUI 也有这个键时不报红灯（默认键不该被当成冲突）");
ok(liveStatus.className.includes("xwph-warn"), "只报「提醒」（黄）");
ok(String(liveStatus.textContent).includes("Pin/Unpin Selected Items"), "提醒里说清了是哪条命令占着");
env.app.extensionManager.command.commands = undefined;

section("信息页（关于）：logo / 版本 / 协议 / 作者与链接 / 用法");

// 用户 1.0.4 的要求：插件信息**不要**做在设置面板里，照 X-WIDE_plugin_model_manager
// 的信息页做；协议换成 GPL-3.0；「作者与链接」只留 GitHub 仓库与 B 站两个。
helper.openAbout();
await flush();
const aboutBox = env.doc.querySelector(".xwph-settings-backdrop");
ok(!!aboutBox, "关于窗口打开了");
ok(!!aboutBox.querySelector(".xwph-about-brand"), "有品牌区（logo + 标题 + 副标题 + 徽章）");

const aboutLogo = aboutBox.querySelector(".xwph-about-logo");
ok(!!aboutLogo, "品牌区里有 logo");
ok(
  String(aboutLogo && aboutLogo.src).includes("extensions/comfyui-xwide-prompt-helper/logo_xwide.png"),
  "logo 走的是扩展自己的静态目录（/extensions/<包名>/logo_xwide.png）"
);
ok(String(aboutBox.querySelector(".xwph-about-sub").textContent).length > 0, "有一句副标题");

const aboutMeta = String(aboutBox.querySelector(".xwph-about-meta").textContent || "");
ok(aboutMeta.includes("1.0.4"), "徽章里写着版本号 1.0.4");
eq(helper.version, "1.0.4", "插件对外报的版本号也是 1.0.4");
ok(aboutMeta.includes("GPL-3.0"), "徽章里写着协议 GPL-3.0");
const licenseLink = aboutBox.querySelector(".xwph-about-lic");
ok(!!licenseLink, "协议是个可点的徽章");
eq(
  String(licenseLink && licenseLink.href),
  "https://github.com/XWIDE/comfyui-xwide-prompt-helper/blob/main/LICENSE",
  "协议徽章指向仓库里的 LICENSE"
);
ok(!!aboutBox.querySelector(".xwph-about-disc"), "有免责声明那一行");
ok(!!aboutBox.querySelector(".xwph-card"), "有内容卡片（作者与链接 / 用法 / 快捷键）");

const aboutLinks = aboutBox.querySelectorAll(".xwph-linkbtn").map((a) => a.href);
eq(aboutLinks.length, 2, "「作者与链接」只留两个入口");
ok(aboutLinks.some((h) => h === "https://github.com/XWIDE/comfyui-xwide-prompt-helper"), "有 GitHub 仓库链接");
ok(aboutLinks.some((h) => h === "https://space.bilibili.com/374064919"), "有 B 站链接");

// 用法那几段长文从设置行 tooltip 搬到了这里（tooltip 会挂在那儿不消失）。
ok(String(aboutBox.textContent).includes("清空"), "「用法」里写着清空的行为");
ok(String(aboutBox.textContent).includes("Ctrl"), "「用法」里写着快捷键那几条");
helper.closeAbout ? helper.closeAbout() : null;
env.dispatch(env.doc, "keydown", env.keyEvent({ key: "Escape", code: "Escape" }));
await flush();

section("右键菜单注入");

// 画布菜单：即使原型上没有 getMenuOptions，也应当能拿到我们的子菜单。
const fakeCanvas = new env.litegraph.LGraphCanvas();
const canvasMenu = fakeCanvas.getCanvasMenuOptions();
const groupItem = canvasMenu.find((i) => i && i.has_submenu && i.content === "提示词插件");
ok(!!groupItem, "画布菜单里有「提示词插件」子菜单");

const submenu = typeof groupItem.callback === "function" ? groupItem.callback() : groupItem.callback;
ok(Array.isArray(submenu) && submenu.length >= 2, "子菜单有内容");
ok(submenu.some((i) => i && i.content === "打开正向提示词框"), "子菜单含正向入口");
ok(submenu.some((i) => i && i.content === "打开反向提示词框"), "子菜单含反向入口");

// 节点菜单：只有带文本控件的节点才会被加菜单项。
// 注意这里用的是 helper.__nodeMenuExtension，而不是去 app.extensions 里那一个：
// beforeRegisterNodeDef 只在注册那一刻触发，测试无法回到那个时刻，
// 所以要拿到扩展对象自己再喂一个假的 nodeType 进去。
const FakeNodeType = function FakeNodeType() {};
FakeNodeType.prototype.getExtraMenuOptions = function () {
  return undefined;
};
await helper.__nodeMenuExtension.beforeRegisterNodeDef(FakeNodeType);

const nodeWithText = Object.create(FakeNodeType.prototype);
nodeWithText.id = 99;
nodeWithText.title = "CLIPTextEncode";
nodeWithText.widgets = nodeA.widgets;

const nodeOptions = [];
nodeWithText.getExtraMenuOptions({}, nodeOptions);
ok(nodeOptions.some((i) => i && i.content === "打开正向提示词框"), "带文本控件的节点菜单里有正向入口");

const nodeNoText = Object.create(FakeNodeType.prototype);
nodeNoText.id = 100;
nodeNoText.widgets = [{ name: "seed", type: "number", value: 1, options: {} }];

const emptyOptions = [];
nodeNoText.getExtraMenuOptions({}, emptyOptions);
ok(!emptyOptions.some((i) => i && i.content && i.content.indexOf("提示词") !== -1), "没有文本控件的节点不加菜单项（不污染菜单）");

section("稳健性：坏掉的前端不该把插件弄崩");

// 模拟一个没有 widgets 数组的节点。
const weirdNode = { id: 200, title: "Weird" };
const weirdOptions = [];
const weirdCtx = Object.create(FakeNodeType.prototype);
weirdCtx.id = 200;
weirdCtx.widgets = undefined;
let threw = false;
try {
  weirdCtx.getExtraMenuOptions({}, weirdOptions);
} catch (err) {
  threw = true;
}
ok(!threw, "widgets 缺失时节点菜单不抛异常");
ok(weirdOptions.length === 0, "widgets 缺失时不注入菜单项");

// 模拟 localStorage 抛异常（隐私模式）。
const realSetItem = env.localStorage.setItem;
env.localStorage.setItem = () => {
  throw new Error("QuotaExceededError");
};
let storageThrew = false;
try {
  const mgr = globalThis.XWidePromptPanel.createPanelManager({
    app: env.app,
    document: env.doc,
    namespace: "TestQuota",
    locale: "zh-CN",
  });
  mgr.init();
  mgr.open("positive");
  const p = env.doc.querySelectorAll(".xwph-overlay");
  ok(p.length > 2, "localStorage 不可用时仍然能建出面板");
} catch (err) {
  storageThrew = true;
  console.log("    （异常：" + err.message + "）");
}
ok(!storageThrew, "localStorage 不可用时不抛异常（退化成内存）");
env.localStorage.setItem = realSetItem;

// ------------------------------------------------------------------ 结果

console.log(`\n${"=".repeat(60)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log("  - " + f);
}
console.log("=".repeat(60));

try {
  writeFileSync(REPORT, reportLines.join("\n") + "\n", "utf8");
} catch (_err) {
  /* 写不了就算了，命令行输出还在 */
}

env.cleanup();
process.exit(failed ? 1 : 0);
