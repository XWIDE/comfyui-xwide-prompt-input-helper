/**
 * 极简 DOM 桩 / minimal DOM stub
 *
 * 为什么自己写而不是装 jsdom：
 *   这个仓库是直接塞进 ComfyUI 的 custom_nodes 的，不该带 node_modules。
 *   测试只需要跑通插件用到的那一小撮 API，自己写反而更可控、更好读懂。
 *
 * 支持的 API 对应插件里的实际调用点，见每个方法上的注释。
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _list() {
    return String(this.el._class || "")
      .split(/\s+/)
      .filter(Boolean);
  }
  _write(list) {
    this.el._class = list.join(" ");
  }
  add(...names) {
    const list = this._list();
    for (const n of names) if (n && !list.includes(n)) list.push(n);
    this._write(list);
  }
  remove(...names) {
    this._write(this._list().filter((c) => !names.includes(c)));
  }
  contains(name) {
    return this._list().includes(name);
  }
  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : !!force;
    if (want) this.add(name);
    else this.remove(name);
    return want;
  }
  get value() {
    return this._list().join(" ");
  }
}

class NodeBase {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = Object.create(null);
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  get isConnected() {
    let cursor = this;
    while (cursor) {
      if (cursor === this.ownerDocument || cursor === this.ownerDocument.documentElement) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get childElementCount() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE).length;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx < 0) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    if (child) child.parentNode = null;
    return child;
  }

  contains(node) {
    let cursor = node;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  /**
   * 监听器一律存成 `{ fn, capture }`。
   *
   * 这一点是踩过坑的：harness 的 dispatch 要按“捕获 / 冒泡”两相分别派发，
   * 而事件对象（`{capture:true}`）或者 `useCapture` 布尔这两种调用形式都得认。
   * 以前这里只存裸函数，harness 分不出相，结果**冒泡阶段注册的监听器
   * 被当成捕获阶段跑了** —— 表现为 overlay 的 seal 在按钮自己的处理器
   * 之前就把 click 吃掉，「应用并关闭」点下去毫无反应。
   */
  addEventListener(type, fn, options) {
    if (!fn) return;
    const capture = typeof options === "boolean" ? options : !!(options && options.capture);
    (this._listeners[type] || (this._listeners[type] = [])).push({ fn, capture });
  }

  removeEventListener(type, fn, options) {
    const list = this._listeners[type];
    if (!list) return;
    const capture = typeof options === "boolean" ? options : !!(options && options.capture);
    const idx = list.findIndex((entry) => {
      if (typeof entry === "function") return entry === fn;
      return entry.fn === fn && entry.capture === capture;
    });
    if (idx >= 0) list.splice(idx, 1);
  }

  /** 只是为了让测试代码能触发一次事件，不模拟完整的事件流。 */
  dispatchEvent(event) {
    event.target = event.target || this;
    const list = this._listeners[event.type] || [];
    for (const entry of list.slice()) {
      const fn = typeof entry === "function" ? entry : entry.fn;
      fn.call(this, event);
    }
    return true;
  }
}

class TextNode extends NodeBase {
  constructor(doc, text) {
    super(doc, TEXT_NODE, "#text");
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class Element extends NodeBase {
  constructor(doc, tagName) {
    super(doc, ELEMENT_NODE, String(tagName).toUpperCase());
    this.tagName = String(tagName).toUpperCase();
    this.attributes = Object.create(null);
    this.style = makeStyle();
    this._class = "";
    this.classList = new ClassList(this);
    this._value = "";
    this.dataset = Object.create(null);
    // 焦点用 ownerDocument.activeElement 统一管理。
    this.isContentEditable = false;
    // 测试可以覆写这两个，用来模拟面板定位。
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get className() {
    return this._class;
  }
  set className(v) {
    this._class = String(v == null ? "" : v);
  }

  get id() {
    return this.attributes.id || "";
  }
  set id(v) {
    this.attributes.id = String(v);
  }

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v == null ? "" : v);
    // 真实 <select> 里给 value 赋值会同步选中项；插件正是用
    // `targetSelect.value = String(index)` 来选中候选目标的。
    if (this.tagName === "SELECT") {
      const list = this.options;
      for (let i = 0; i < list.length; i++) {
        if (list[i].value === this._value) this._selectedIndex = i;
      }
    }
  }

  /**
   * <select> 的 options 集合。
   *
   * 插件的目标下拉框会读 `targetSelect.options.length` 来决定选中项，
   * 没有这个属性的话会在 renderTarget 里直接抛 TypeError。
   * 只取直接子节点里的 <option>，跟真实 DOM 的语义一致，够用。
   */
  get options() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE && n.tagName === "OPTION");
  }

  get selectedIndex() {
    if (this.tagName !== "SELECT") return -1;
    if (typeof this._selectedIndex === "number") return this._selectedIndex;
    const list = this.options;
    const idx = list.findIndex((o) => o.hasAttribute("selected"));
    return idx;
  }
  set selectedIndex(v) {
    const n = parseInt(v, 10);
    this._selectedIndex = isNaN(n) ? -1 : n;
    const list = this.options;
    if (this._selectedIndex >= 0 && this._selectedIndex < list.length) {
      this._value = list[this._selectedIndex].value;
    }
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== "" && v != null) this.appendChild(new TextNode(this.ownerDocument, v));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = value;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  /** 只实现插件用到的那几个选择器，够用就行。 */
  closest(selector) {
    let cursor = this;
    while (cursor && cursor.nodeType === ELEMENT_NODE) {
      if (matches(cursor, selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  focus() {
    this.ownerDocument._setActive(this);
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument._setActive(this.ownerDocument.body);
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
    this.ownerDocument._setActive(this);
  }
  click() {
    this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} });
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return this._rect;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }
}

/** 支持 "a, b"、"#id"、".cls"、"tag" 这几种组合；也支持带空格的祖先选择器串。 */
function matches(el, selector) {
  const parts = String(selector)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const chain = part.split(/\s+/).filter(Boolean);
    if (chain.length === 0) continue;
    if (!matchesSimple(el, chain[chain.length - 1])) continue;

    // 处理 "xwph-overlay .xwph-btn" 这类祖先约束：从右往左爬。
    let cursor = el.parentElement;
    let ok = true;
    for (let i = chain.length - 2; i >= 0; i--) {
      let found = false;
      while (cursor) {
        if (matchesSimple(cursor, chain[i])) {
          found = true;
          cursor = cursor.parentElement;
          break;
        }
        cursor = cursor.parentElement;
      }
      if (!found) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function matchesSimple(el, simple) {
  if (!el || el.nodeType !== ELEMENT_NODE) return false;
  if (simple.startsWith("#")) return el.id === simple.slice(1);

  if (simple.startsWith(".")) {
    const cls = simple.slice(1);
    return el.classList.contains(cls);
  }

  // 支持 tag 后面跟 .class，例如 textarea.xwph-textarea
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(simple);
  if (!m) return false;

  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[2]) {
    for (const cls of m[2].split(".").filter(Boolean)) {
      if (!el.classList.contains(cls)) return false;
    }
  }
  return true;
}

function makeStyle() {
  const store = Object.create(null);
  const style = new Proxy(store, {
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop in target) return target[prop];
      // 真实 DOM 上这几个是方法，插件（和 ComfyUI 自己）都会用它们设自定义属性，
      // 比如 `style.setProperty("--xwph-scale", "1.2")` 调字号。
      if (prop === "setProperty") {
        return (name, value) => {
          target[name] = String(value);
        };
      }
      if (prop === "getPropertyValue") {
        return (name) => (name in target ? String(target[name]) : "");
      }
      if (prop === "removeProperty") {
        return (name) => {
          delete target[name];
        };
      }
      // 未设置的样式属性在真实 DOM 里返回空字符串。
      return "";
    },
  });
  return style;
}

export function createDocument(options = {}) {
  const doc = new NodeBase(null, 9, "#document");
  doc.ownerDocument = doc;
  doc.createElement = (tag) => new Element(doc, tag);
  doc.createTextNode = (text) => new TextNode(doc, text);

  const html = new Element(doc, "html");
  const head = new Element(doc, "head");
  const body = new Element(doc, "body");
  html.appendChild(head);
  html.appendChild(body);
  doc.appendChild(html);

  doc.documentElement = html;
  doc.head = head;
  doc.body = body;
  doc.currentScript = null;
  // 真实浏览器里 document.baseURI 永远有值（相对 URL 全靠它解析）。
  // 插件用它拼 logo 的地址，所以桩也得有。
  doc.baseURI = options.baseURI || "http://localhost:8188/";
  doc.URL = doc.baseURI;
  doc.documentElement.clientWidth = options.width || 1440;
  doc.documentElement.clientHeight = options.height || 900;

  doc.getElementById = (id) => {
    const found = doc.querySelectorAll("#" + id);
    return found[0] || null;
  };
  doc.querySelector = (sel) => html.querySelector(sel);
  doc.querySelectorAll = (sel) => html.querySelectorAll(sel);

  doc._setActive = (el) => {
    doc.activeElement = el;
  };
  doc.activeElement = body;

  doc.execCommand = () => true;

  return doc;
}

export { Element, TextNode };
