/**
 * ComfyUI 前端桩 / fake ComfyUI environment
 *
 * 目标：让 tests 目录下的测试能用**真实未改动的**插件 JS 跑起来，
 * 从而验证「按快捷键 -> 打开浮层 -> 写回控件」这条主链路，
 * 而不是只做语法检查。
 *
 * 这里刻意模拟的是前端 1.53.6 的**实际结构**（从 comfyui_frontend_package
 * 的 bundle 里读出来的），关键几点：
 *   - 多行文本控件是 addDOMWidget，widget.element 指向真实 <textarea>；
 *   - widget.getValue / widget.setValue 才是真正的数据源，直接写 .value 不可靠；
 *   - 画布菜单挂在 LGraphCanvas.prototype.getCanvasMenuOptions 上；
 *   - 扩展通过 app.registerExtension({name, init, setup, beforeRegisterNodeDef}) 注册。
 */

import { createDocument, Element } from "./dom.mjs";

/** 记录所有派发到 document / window 的事件，方便断言“有没有被拦下来”。 */
export function createEnv(options = {}) {
  const doc = createDocument({ width: options.width || 1440, height: options.height || 900 });

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => {
      storage.set(String(k), String(v));
    },
    removeItem: (k) => {
      storage.delete(String(k));
    },
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i) => Array.from(storage.keys())[i] ?? null,
  };

  const clipboard = {
    text: options.clipboardText ?? "CLIPBOARD-CONTENT",
    fail: !!options.clipboardFails,
    writeText(v) {
      if (this.fail) return Promise.reject(new Error("NotAllowedError"));
      this.text = String(v);
      return Promise.resolve();
    },
    readText() {
      if (this.fail) return Promise.reject(new Error("NotAllowedError"));
      return Promise.resolve(this.text);
    },
  };

  const timers = new Set();

  const win = {
    // 真实浏览器里 window 是事件链最外层的那个节点。桩把 window 上的监听器
    // 记在 win._listeners 里，这样 `env.dispatch(env.win, ...)`、以及任何
    // 以 document/元素为目标的事件（捕获阶段都会先经过 window）都能命中它。
    // 另外仍往 doc 的 "__win__<type>" 上转发一份：那是桩早先的写法，
    // 留着免得破坏既有测试。
    _listeners: Object.create(null),
    addEventListener(type, fn, options) {
      if (!fn) return;
      const capture = typeof options === "boolean" ? options : !!(options && options.capture);
      (win._listeners[type] || (win._listeners[type] = [])).push({ fn, capture });
      doc.addEventListener("__win__" + type, fn, options);
    },
    removeEventListener(type, fn, options) {
      const list = win._listeners[type];
      if (list) {
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const idx = list.findIndex((entry) =>
          typeof entry === "function" ? entry === fn : entry.fn === fn && entry.capture === capture
        );
        if (idx >= 0) list.splice(idx, 1);
      }
      doc.removeEventListener("__win__" + type, fn, options);
    },
    innerWidth: options.width || 1440,
    innerHeight: options.height || 900,
    setTimeout: (...args) => {
      const id = setTimeout(...args);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      clearTimeout(id);
    },
    focus() {},
    prompt: () => {
      throw new Error("window.prompt must not be used (it is null in Electron/sandboxed iframes)");
    },
  };

  // ---------------------------------------------------------------- 画布 / 节点

  const graph = {
    id: 0,
    _nodes: [],
    selected_nodes: {},
    subgraphs: [],
    // 真机的连线表：link id -> { origin_id, origin_slot, target_id, target_slot }。
    links: {},
    getNodeById(id) {
      return graph._nodes.find((n) => String(n.id) === String(id)) || null;
    },
  };

  let nextNodeId = 1;
  let nextGraphId = 1;
  let nextLinkId = 1;

  /**
   * 接一条线：源节点的输出 → 目标节点的入口。
   *
   * 真机上的连线数据是**单向**的：源节点的 `outputs[fromSlot].links` 里放着 link id，
   * 而 `graph.links[id]` 那条记录写着它落到谁的哪个入口（`target_id` / `target_slot`）。
   * 所以造线必须两边都写，只写 `inputs[slot].link` 的话插件根本走不动
   * （插件是先看源节点有没有输出线，再顺着 link id 去连线表里查它落到哪儿）。
   *
   * 返回 link id。
   */
  function addLink(ownerGraph, fromId, fromSlot, toId, toSlot) {
    const linkId = nextLinkId++;
    const target = ownerGraph._nodes.find((n) => String(n.id) === String(toId));
    if (target) {
      target.inputs[toSlot] = target.inputs[toSlot] || {};
      target.inputs[toSlot].link = linkId;
    }
    ownerGraph.links[linkId] = {
      id: linkId,
      origin_id: fromId,
      origin_slot: fromSlot,
      target_id: toId,
      target_slot: toSlot,
    };
    const source = ownerGraph._nodes.find((n) => String(n.id) === String(fromId));
    if (source && source.outputs[fromSlot]) source.outputs[fromSlot].links.push(linkId);
    return linkId;
  }

  /**
   * 造一个节点。widgets 里每一项要么给 { name, value, multiline }，
   * 要么给 null 表示这个控件不是文本控件（用来验证我们不会误判）。
   */
  function addNode(spec = {}) {
    // spec.graph 用来把节点造到"另一张图"里，模拟切工作流。
    const ownerGraph = spec.graph || graph;
    const node = {
      id: spec.id ?? nextNodeId++,
      type: spec.type || "CLIPTextEncode",
      title: spec.title || spec.type || "CLIPTextEncode",
      widgets: [],
      graph: ownerGraph,
      // 真机的节点永远有这两个数组（哪怕为空）。插件顺着线找正反入口时读的就是它们，
      // 少了它们插件只能走 "dead-end" 分支 —— 那才是假的"认不出来"。
      inputs: spec.inputs ? spec.inputs.map((i) => ({ ...i })) : [],
      outputs: spec.outputs ? spec.outputs.map((o) => ({ ...o, links: [] })) : [],
      setDirtyCanvas() {
        node._dirtyCalls = (node._dirtyCalls || 0) + 1;
      },
    };

    /**
     * 真机上的连线数据是**单向**的：源节点的 `outputs[i].links` 里放着 link id，
     * 而 `graph.links[id]` 那条记录写着它落到谁的哪个入口（`target_id` / `target_slot`）。
     * 所以造线必须两边都写，只写 inputs[].link 的话插件根本走不动。
     */
    for (const link of spec.inLinks || []) {
      addLink(ownerGraph, link.from, link.fromSlot ?? 0, node.id, link.slot);
    }

    for (const w of spec.widgets || []) {
      if (!w) {
        // 非文本控件：如果没有 isTextWidget 的白名单/元素兜底，它不该被选中。
        node.widgets.push({
          name: "seed",
          type: "number",
          value: 12345,
          options: {},
          callback() {},
        });
        continue;
      }

      if (w.multiline === false) {
        // 单行文本：没有 DOM 元素，只能靠 widget.value 读写。
        node.widgets.push({
          name: w.name,
          type: "text",
          value: w.value ?? "",
          options: { display_name: w.displayName },
          getValue() {
            return this.value;
          },
          setValue(v) {
            this.value = v;
          },
          callback() {},
        });
        continue;
      }

      // 多行文本：模拟 addDOMWidget + createMultilineInputElement 的真实结构。
      const host = new Element(doc, "div");
      host.className = "lg-node-widget-host";

      const textarea = new Element(doc, "textarea");
      textarea.className = "comfy-multiline-input";
      textarea.value = w.value ?? "";
      textarea.setAttribute("data-capture-wheel", "true");
      // 前端会把控件挂到节点上，插件正是靠这个属性反查节点。
      textarea.__comfy_node = node;
      host.appendChild(textarea);

      if (spec.mount !== false) doc.body.appendChild(host);

      const widget = {
        name: w.name,
        type: "customtext",
        value: w.value ?? "",
        element: textarea,
        options: { display_name: w.displayName },
        callback() {},
        getValue() {
          return textarea.value;
        },
        setValue(v) {
          textarea.value = String(v);
        },
      };

      textarea.addEventListener("input", () => {
        widget.value = textarea.value;
      });

      // 给个能看的定位信息，便于断言面板会挪到目标旁边。
      textarea._rect = {
        left: 200 + node.id * 10,
        top: 120 + node.id * 8,
        right: 480 + node.id * 10,
        bottom: 260 + node.id * 8,
        width: 280,
        height: 140,
      };

      node.widgets.push(widget);
      node._textareas = node._textareas || [];
      node._textareas.push(textarea);
    }

    ownerGraph._nodes.push(node);
    return node;
  }

  const canvas = {
    graph,
    selected_nodes: {},
    setDirty() {
      canvas._dirty = (canvas._dirty || 0) + 1;
    },
  };

  /**
   * 扩展 API 对象（前端传给 registerExtension 的第二个参数）。
   *
   * 真机上它就是 `{settings: {addSetting}, keybindings, commands, ...}` 那一坨，
   * 设置项只能从这里注册 —— `app.extensionManager.setting` 上没有 addSetting。
   * 这里记下 addSetting 收到的每一项，测试据此断言设置真的注册进去了。
   */
  const registeredSettings = [];
  const extensionApi = {
    settings: {
      addSetting(item) {
        if (!item || !item.id) throw new Error("Settings must have an ID");
        registeredSettings.push(item);
        return item;
      },
    },
  };

  const app = {
    canvas,
    graph,
    extensions: {},
    registeredSettings,
    executedCommands: [],
    registerExtension(ext, api) {
      if (!ext || !ext.name) throw new Error("extension needs a name");
      if (app.extensions[ext.name]) throw new Error(`Extension named '${ext.name}' already registered.`);
      app.extensions[ext.name] = ext;
      // 真前端 registerExtension 里就是 `n.settings?.forEach(c)`（c = addSetting）：
      // 写在扩展对象上的设置项在注册那一刻就被登记，不需要等 setup。
      if (Array.isArray(ext.settings)) {
        for (const item of ext.settings) extensionApi.settings.addSetting(item);
      }
      // 第二个参数是前端递过来的 API 对象；真前端会把它转交给 setup。
      if (api) app.extensionApi = api;
      return ext;
    },
    ui: { dialog: { show: () => {} } },
    // 真实前端在 app.extensionManager 上暴露工作流信息；插件会优先拿它的 key 当身份。
    extensionManager: {
      workflow: { activeWorkflow: null },
      /**
       * 原生设置面板真正读写设置项的地方。
       *
       * 为什么桩里必须有它：真机上 `setup(app, api)` **从来没被调用过**（插件是自己初始化的），
       * 所以扩展 API 上的 `settings.get/set` 根本拿不到 —— 插件实际走的是
       * `app.extensionManager.setting.get/set`。桩里要是没有这一条，那条路就永远测不到，
       * 而它恰恰是"改完快捷键、上面那两行文字设置跟不跟着变"的关键。
       */
      setting: {
        _values: Object.create(null),
        get(id) {
          return this._values[id];
        },
        set(id, value) {
          this._values[id] = value;
          // 真前端 set 完会回调 onChange，这里照做，才能暴露"自己写自己触发"的来回。
          const item = registeredSettings.find((i) => i.id === id);
          if (item && typeof item.onChange === "function") item.onChange(value);
          return value;
        },
      },
      // 「打开原生设置面板」走的就是这个命令（真机上的 id 是 Comfy.ShowSettingsDialog）。
      command: {
        execute(id) {
          app.executedCommands.push(id);
          return true;
        },
      },
      extensionStore: {
        isExtensionInstalled(name) {
          return !!app.extensions[name];
        },
      },
    },
  };

  /**
   * 模拟"用户切到了另一个工作流"：换掉 app.graph / app.canvas.graph。
   *
   * 这是验证「记忆不能跨工作流串味」的关键手段 —— 两张图里可以有**相同 id** 的
   * 节点，只有真的换掉图对象才能暴露"只看 id 就认目标"的 bug。
   */
  function newGraph() {
    const g = {
      // 真实 LiteGraph 里每张图都有唯一自增 id；插件优先拿它当工作流身份。
      id: nextGraphId++,
      _nodes: [],
      selected_nodes: {},
      subgraphs: [],
      links: {},
      getNodeById(id) {
        return g._nodes.find((n) => String(n.id) === String(id)) || null;
      },
    };
    return g;
  }

  function useGraph(g) {
    app.graph = g;
    canvas.graph = g;
    canvas.selected_nodes = {};
    g.selected_nodes = {};
    // 真实前端里 LiteGraph.rootGraph 也指向当前工作流的根图。
    litegraph.rootGraph = g;
    // 前端自己的 workflow key：跟图一起换，模拟“每个标签页一个 key”。
    app.extensionManager.workflow.activeWorkflow = { key: "wf-" + g.id, path: "workflows/wf-" + g.id + ".json" };
    return g;
  }

  // ---------------------------------------------------------------- LiteGraph

  const litegraph = {
    LGraphCanvas: function LGraphCanvas() {},
    ContextMenu: function ContextMenu() {},
  };
  litegraph.LGraphCanvas.prototype.getCanvasMenuOptions = function () {
    this._coreMenuCalls = (this._coreMenuCalls || 0) + 1;
    return [{ content: "Add Node" }, { content: "Add Group" }, { content: "Paste" }];
  };

  // ---------------------------------------------------------------- 装载全局

  const eventLog = [];

  const previous = {};
  const previousHad = {};
  const globalKeys = [
    "document",
    "window",
    "navigator",
    "localStorage",
    "app",
    "LiteGraph",
    "ComfyWidgets",
    "Event",
    "TextEncoder",
    "requestAnimationFrame",
    "prompt",
  ];
  for (const k of globalKeys) previous[k] = globalThis[k];

  /**
   * 用 defineProperty 装全局，而不是直接赋值。
   *
   * Node 21+ 把 globalThis.navigator 定义成了只有 getter 的访问器，
   * 直接 `globalThis.navigator = x` 在非严格模式下会**静默失败**
   * （严格模式下才抛 TypeError），插件于是读到真实的 Node navigator，
   * 语言探测就废了。这里统一定义成可写、可配置的属性，卸载时再还原。
   */
  function install(key, value) {
    previousHad[key] = Object.prototype.hasOwnProperty.call(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  install("document", doc);
  install("window", win);
  install("navigator", {
    language: options.locale || "zh-CN",
    languages: [options.locale || "zh-CN"],
    clipboard,
    userAgent: "harness",
  });
  install("localStorage", localStorage);
  /**
   * 关键：默认**不**在这里装 app。
   *
   * 真实前端的顺序是 `await app.setup()`（扩展模块就是在这个 setup 内部被
   * import 的）之后才 `window.app = app`。也就是说插件模块被求值的那一刻，
   * globalThis.app 一定是 undefined。以前这里提前把 app 装好，
   * 等于把"模块加载时 app 还不存在"这个最要命的场景从测试里抹掉了 ——
   * 桩测试全绿、真机上按快捷键毫无反应，就是这么来的。
   *
   * 想让测试更省事（不测加载期）可以传 appAlreadyPresent: true，
   * 那时还是老的顺序：先有 app，再加载插件。
   */
  const appIsPresent = options.appAlreadyPresent === true;
  if (appIsPresent) install("app", app);
  install("LiteGraph", litegraph);
  install("requestAnimationFrame", (fn) => setTimeout(fn, 0));
  install("prompt", win.prompt);

  /**
   * 自己的 Event 实现，同时装到 globalThis.Event 上。
   *
   * 不能直接用 Node 的 Event：它的 target / defaultPrevented 都是只读的
   * 访问器（`event.target = x` 会抛 “which has only a getter”），
   * 而插件的按键处理恰恰要看 target。既然这个全局只服务于本测试
   * （Electron-as-node 里导航器那套本来也是假的），就直接换成我们能写的实现，
   * 顺带保证 bridge.js 里的 `instanceof Event` 判断依然成立。
   */
  class HarnessEvent {
    constructor(type, init) {
      const o = init || {};
      this.type = type;
      this.bubbles = o.bubbles !== false;
      this.cancelable = true;
      this.defaultPrevented = false;
      this.target = o.target || null;
      this.currentTarget = null;
      this._stopped = false;
      this._stoppedImmediate = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      this._stopped = true;
    }
    stopImmediatePropagation() {
      this._stopped = true;
      this._stoppedImmediate = true;
    }
    /** 前端有些地方会调 composedPath()，给个最小实现。 */
    composedPath() {
      const path = [];
      let cursor = this.target;
      while (cursor) {
        path.push(cursor);
        cursor = cursor.parentNode;
      }
      return path;
    }
  }

  install("Event", HarnessEvent);

  /**
   * 触发一次事件。
   *
   * 真实浏览器是捕获阶段从 window -> document -> ... -> target 走一遍，
   * 这里按同样的顺序调用监听器，并且**当某一层调用了 stopPropagation
   * 就不再往下走**，这样才能真实验证“面板把画布挡住了”。
   */
  function dispatch(target, type, init = {}) {
    const event = new HarnessEvent(type, { bubbles: true, ...init });
    for (const [k, v] of Object.entries(init)) {
      if (k === "bubbles") continue;
      event[k] = v;
    }
    event.target = target;
    event.defaultPrevented = false;
    event._stopped = false;

    eventLog.push({ type, target, event });

    // 捕获链：window -> document -> ... -> target 的祖先 -> target
    const chain = [];
    let cursor = target;
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentNode;
    }

    // 严格按 DOM 事件流的三段走：
    //   捕获（window -> ... -> target.parentNode）
    //   target 阶段（该元素上的捕获监听器 + 冒泡监听器都跑，真实 DOM 就是这个顺序）
    //   冒泡（target.parentNode -> ... -> 顶层，bubbles 为假就跳过）
    const run = (node, capturePhase, args) => {
      for (const fn of args) {
        fn.call(node, event);
        if (event._stopped) return;
      }
    };

    const listenerArgs = (node, capturePhase) => {
      const raw = (node._listeners && node._listeners[type]) || [];
      // 监听器可能是裸函数（老式存档），也可能是 { fn, capture }；
      // 只有显式声明 capture 的才算捕获阶段，其余都算冒泡。
      return raw
        .filter((entry) => (typeof entry === "function" ? capturePhase === false : entry.capture === capturePhase))
        .map((entry) => (typeof entry === "function" ? entry : entry.fn));
    };

    // ① 捕获：window、document、以及 target 的所有祖先（不含 target）
    const ancestors = chain.slice(0, -1);
    for (const node of [win, ...ancestors]) {
      if (event._stopped) break;
      run(node, true, listenerArgs(node, true));
    }

    // ② target 阶段：先捕获监听器，再冒泡监听器
    if (!event._stopped) {
      run(target, true, listenerArgs(target, true));
      run(target, false, listenerArgs(target, false));
    }

    // ③ 冒泡：从 target 的父级一路往上（window 收尾）
    if (!event._stopped && event.bubbles) {
      for (const node of ancestors.slice().reverse()) {
        if (event._stopped) break;
        run(node, false, listenerArgs(node, false));
      }
      if (!event._stopped) run(win, false, listenerArgs(win, false));
    }

    return event;
  }

  /** 构造一个按键事件对象。 */
  function keyEvent(init) {
    return {
      key: init.key,
      code: init.code || null,
      ctrlKey: !!init.ctrl,
      metaKey: !!init.meta,
      altKey: !!init.alt,
      shiftKey: !!init.shift,
      repeat: !!init.repeat,
      isComposing: !!init.isComposing,
      bubbles: true,
    };
  }

  function cleanup() {
    for (const k of globalKeys) {
      if (!previousHad[k]) {
        try {
          delete globalThis[k];
        } catch (_err) {
          /* 删不掉就算了，反正进程要退了 */
        }
      } else {
        install(k, previous[k]);
      }
    }
    for (const id of timers) clearTimeout(id);
  }

  return {
    doc,
    win,
    app,
    canvas,
    graph,
    litegraph,
    storage,
    localStorage,
    clipboard,
    eventLog,
    addNode,
    addLink,
    dispatch,
    keyEvent,
    cleanup,
    /** 把 flatted 的选中状态同步到 app.canvas / graph 两处，模拟真实前端的做法。 */
    select(...nodes) {
      const map = {};
      for (const n of nodes) map[n.id] = n;
      graph.selected_nodes = map;
      canvas.selected_nodes = map;
    },
    /**
     * 把“插件能看到的画布目标”清成零：交互记忆、选区、焦点、记忆目标全清。
     *
     * 测试里要验证“没有目标时拒绝写入”，就必须真的制造出零目标 ——
     * 否则插件回落到某一级（比如面板自己的输入框所在的焦点）是**正确行为**，
     * 断言却会写成“必须失败”，于是测试假装发现了 bug。
     */
    clearFocus() {
      doc._setActive(doc.body);
    },

    /**
     * 换工作流：造一张新图并切过去（旧图的节点还在，但已经不属于当前图）。
     * 返回新图对象，可以用 env.addNode({ graph: g, ... }) 往里加节点。
     */
    newGraph,
    useGraph,

    /**
     * 模拟前端那一行 `window.app = app`。
     *
     * 真实前端就是这么干的（而且是**扩展模块加载完之后**才赋值），
     * 插件正是靠这一刻完成注册。测试里必须显式触发，否则什么都不会注册。
     *
     * 注意这里必须用**普通赋值**而不是 install()（那是 defineProperty）：
     * 定义属性**不会**触发已有的 setter，用 defineProperty 等于把插件的
     * 拦截器直接抹掉，测试就永远看不到"注册成功"，而真机上是好的。
     */
    attachApp() {
      globalThis.app = app;
      return app;
    },
  };
}

/** 从文件 URL 里取出路径，供 import 用。 */
export function fileUrl(relative) {
  return new URL(relative, import.meta.url);
}
