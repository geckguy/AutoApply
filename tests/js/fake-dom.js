'use strict';

/**
 * Minimal, dependency-free DOM for running the extension's content scripts
 * (lib/utils.js, content/filler.js, content/scraper.js) under `vm`.
 *
 * It models only what those scripts touch:
 *   - an element tree with attributes and the reflected IDL properties
 *     (id/name/type/value/checked/required/accept/placeholder/...);
 *   - a small CSS selector engine for the compound selectors the scripts use
 *     (tag, .class, #id, [attr], [attr="v"], [attr*="v"], :not(...), comma
 *     groups);
 *   - label/name/id lookups, closest(), contains(), cloneNode(), remove();
 *   - and, deliberately, the browser's *value sanitisation* for typed inputs:
 *     `input[type=number]` rejects a non-numeric string and `input[type=date]`
 *     rejects anything but YYYY-MM-DD, exactly as the IDL value setter does.
 *     fillTextInput()'s post-condition check only means something against a
 *     DOM that drops the value the page would drop.
 *
 * Geometry is modelled the way the browser reports it: a `position: fixed`
 * element has `offsetParent === null` but still has client rects, which is the
 * distinction the navigation guard depends on.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function text(value) {
  return { nodeType: TEXT_NODE, textContent: String(value) };
}

/** Element factory: el('input', { id: 'x' }, 'text', childEl). */
function el(tagName, attributes, ...children) {
  return new FakeElement(tagName, attributes, children);
}

// --- innerHTML parsing -------------------------------------------------------

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Parse an HTML fragment into nodes. Deliberately small: it models the shapes
 * the overlay builds (nested block elements with quoted attributes, style
 * blocks, self-closing SVG). It exists so an innerHTML assignment produces a
 * queryable tree instead of an opaque string.
 */
function parseHTML(html) {
  const root = new FakeElement('div');
  const stack = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
  let lastIndex = 0;
  let match;
  const appendText = (chunk) => {
    if (chunk) stack[stack.length - 1].appendChild(text(decodeEntities(chunk)));
  };
  while ((match = tokenPattern.exec(html))) {
    appendText(html.slice(lastIndex, match.index));
    lastIndex = tokenPattern.lastIndex;
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;

    const close = /^<\s*\/\s*([\w:-]+)/.exec(token);
    if (close) {
      const name = close[1].toUpperCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tagName === name) { stack.length = depth; break; }
      }
      continue;
    }

    const open = /^<\s*([\w:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>$/.exec(token);
    if (!open) continue;
    const tagName = open[1];
    const element = new FakeElement(tagName, parseAttributes(open[2] || ''));
    stack[stack.length - 1].appendChild(element);
    if (open[3] === '/' || VOID_ELEMENTS.has(tagName.toLowerCase())) continue;

    if (tagName.toLowerCase() === 'style' || tagName.toLowerCase() === 'script') {
      const rawUntil = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = html.slice(lastIndex);
      const closing = rawUntil.exec(rest);
      element.ownText = closing ? rest.slice(0, closing.index) : rest;
      tokenPattern.lastIndex = closing ? lastIndex + closing.index + closing[0].length : html.length;
      continue;
    }
    stack.push(element);
  }
  appendText(html.slice(lastIndex));
  return root.children.slice();
}

// --- CSS selector engine -----------------------------------------------------

function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of String(selector)) {
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const compoundCache = new Map();

function parseCompound(selector) {
  const cached = compoundCache.get(selector);
  if (cached) return cached;

  const spec = { tag: null, id: null, classes: [], attributes: [], not: [] };
  let rest = selector.trim();

  const tagMatch = rest.match(/^([a-zA-Z][\w-]*|\*)/);
  if (tagMatch) {
    spec.tag = tagMatch[1] === '*' ? null : tagMatch[1].toUpperCase();
    rest = rest.slice(tagMatch[1].length);
  }

  while (rest.length) {
    let match;
    if ((match = rest.match(/^#([\w-]+)/))) {
      spec.id = match[1];
    } else if ((match = rest.match(/^\.([\w-]+)/))) {
      spec.classes.push(match[1]);
    } else if (
      (match = rest.match(/^\[([\w-]+)(?:([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/))
    ) {
      spec.attributes.push({
        name: match[1].toLowerCase(),
        operator: match[2] || null,
        value: match[3] ?? match[4] ?? (match[5] !== undefined ? match[5] : null),
      });
    } else if ((match = rest.match(/^:not\(([^)]*)\)/))) {
      spec.not.push(parseCompound(match[1]));
    } else if ((match = rest.match(/^::?[\w-]+(?:\([^)]*\))?/))) {
      // Ignore pseudo-classes/elements we do not model.
    } else {
      break;
    }
    rest = rest.slice(match[0].length);
  }

  compoundCache.set(selector, spec);
  return spec;
}

function matchCompound(element, spec) {
  if (element.nodeType !== ELEMENT_NODE) return false;
  if (spec.tag && element.tagName !== spec.tag) return false;
  if (spec.id && element.attributes.id !== spec.id) return false;
  for (const className of spec.classes) {
    if (!element.classList.contains(className)) return false;
  }
  for (const attribute of spec.attributes) {
    const actual = element.getAttribute(attribute.name);
    if (actual === null) return false;
    if (attribute.operator === '=' && actual !== attribute.value) return false;
    if (attribute.operator === '*=' && !actual.includes(attribute.value)) return false;
    if (attribute.operator === '^=' && !actual.startsWith(attribute.value)) return false;
    if (attribute.operator === '$=' && !actual.endsWith(attribute.value)) return false;
    if (attribute.operator === '~=' && !actual.split(/\s+/).includes(attribute.value)) return false;
  }
  for (const negative of spec.not) {
    if (matchCompound(element, negative)) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  return splitSelectors(selector).some((compound) => matchCompound(element, parseCompound(compound)));
}

// --- DOM ---------------------------------------------------------------------

function parseStyle(declaration) {
  const style = {};
  for (const chunk of String(declaration).split(';')) {
    const separator = chunk.indexOf(':');
    if (separator === -1) continue;
    style[chunk.slice(0, separator).trim()] = chunk.slice(separator + 1).trim();
  }
  return style;
}

/** The typed-input value sanitisation the IDL setter applies. */
function sanitiseInputValue(element, raw) {
  const value = String(raw);
  if (element.type === 'number') {
    return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim()) ? String(Number(value.trim())) : '';
  }
  if (element.type === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : '';
  }
  return value;
}

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.style = {};
    this.ownText = '';
    this.listeners = {};
    this.clickCount = 0;
    this._value = null;
    this._checked = null;
    this._fixed = false;
    this._innerHTML = undefined;
    this.dataset = {};
    this.shadowRoot = null;

    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === null || value === false) continue;
      this.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      this.appendChild(child);
    }
  }

  // -- attributes ------------------------------------------------------------

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const stringValue = String(value);
    this.attributes[key] = stringValue;
    if (key === 'style') {
      this.style = parseStyle(stringValue);
      if (this.style.position === 'fixed') this._fixed = true;
    }
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attributes, String(name).toLowerCase());
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    delete this.attributes[key];
    if (key === 'style') this.style = {};
  }

  get id() { return this.attributes.id || ''; }
  set id(value) { this.setAttribute('id', value); }

  get name() { return this.attributes.name || ''; }
  set name(value) { this.setAttribute('name', value); }

  get className() { return this.attributes.class || ''; }
  set className(value) { this.setAttribute('class', value); }

  get type() {
    if (this.attributes.type !== undefined) return this.attributes.type.toLowerCase();
    if (this.tagName === 'BUTTON') return 'submit'; // the browser's default
    if (this.tagName === 'INPUT') return 'text';
    return undefined;
  }
  set type(value) { this.setAttribute('type', value); }

  get placeholder() { return this.attributes.placeholder || ''; }
  get accept() { return this.attributes.accept || ''; }
  get content() { return this.attributes.content ?? ''; }
  get maxLength() { return this.attributes.maxlength === undefined ? -1 : Number(this.attributes.maxlength); }
  get required() { return this.hasAttribute('required'); }
  set required(value) { if (value) this.setAttribute('required', ''); else this.removeAttribute('required'); }
  get disabled() { return this.hasAttribute('disabled'); }
  get hidden() { return this.hasAttribute('hidden'); }

  get form() {
    for (let node = this.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'FORM') return node;
    }
    return null;
  }

  /** A fixed-position element has no offsetParent — that is the trap. */
  get offsetParent() { return this._fixed ? null : this.parentElement; }

  get visible() {
    if (this.hidden) return false;
    return this.style.display !== 'none'
      && this.style.visibility !== 'hidden'
      && this.style.opacity !== '0';
  }

  get classList() {
    const classes = () => (this.attributes.class || '').split(/\s+/).filter(Boolean);
    return {
      contains: (name) => classes().includes(name),
      add: (name) => { if (!classes().includes(name)) this.setAttribute('class', [...classes(), name].join(' ')); },
      remove: (name) => this.setAttribute('class', classes().filter((c) => c !== name).join(' ')),
      toggle: (name, force) => {
        const present = classes().includes(name);
        const next = force === undefined ? !present : Boolean(force);
        if (next && !present) this.setAttribute('class', [...classes(), name].join(' '));
        else if (!next && present) this.setAttribute('class', classes().filter((c) => c !== name).join(' '));
        return next;
      },
    };
  }

  get options() {
    return this.children.filter((child) => child.nodeType === ELEMENT_NODE && child.tagName === 'OPTION');
  }

  get checked() { return this._checked === null ? this.hasAttribute('checked') : this._checked; }
  set checked(value) { this._checked = Boolean(value); }

  get value() {
    if (this._value !== null) return this._value;
    if (this.tagName === 'OPTION') {
      return this.attributes.value !== undefined ? this.attributes.value : this.ownText;
    }
    if (this.tagName === 'SELECT') {
      const selected = this.options.find((option) => option.hasAttribute('selected')) || this.options[0];
      return selected ? selected.value : '';
    }
    if (this.attributes.value !== undefined) return this.attributes.value;
    return '';
  }
  set value(newValue) { this._value = String(newValue); }

  // -- text ------------------------------------------------------------------

  get textContent() {
    if (this.children.length === 0) return this.ownText;
    let output = this.ownText;
    for (const child of this.children) output += child.textContent || '';
    return output;
  }
  set textContent(newValue) {
    this.children = [];
    this.ownText = String(newValue);
  }

  get innerText() { return this.textContent; }
  set innerText(newValue) { this.textContent = newValue; }

  /** Assigning innerHTML parses a small HTML subset into real child elements. */
  get innerHTML() {
    return this._innerHTML !== undefined ? this._innerHTML : this.textContent;
  }
  set innerHTML(newValue) {
    this._innerHTML = String(newValue);
    this.children = [];
    this.ownText = '';
    for (const node of parseHTML(this._innerHTML)) this.appendChild(node);
  }

  /** Create a fake shadow root so the overlay's host->root->container chain works. */
  attachShadow() {
    const root = new FakeElement('shadow-root');
    root.host = this;
    root.ownerDocument = this.ownerDocument;
    this.shadowRoot = root;
    return root;
  }

  /** A rendered box; tests can override it to model an iframe's size. */
  getBoundingClientRect() {
    const width = Number.parseFloat(this.style.width) || 400;
    const height = Number.parseFloat(this.style.height) || 300;
    return { left: 0, top: 0, right: width, bottom: height, width, height };
  }

  get isConnected() {
    for (let node = this; node; node = node.parentElement) {
      if (node.tagName === 'HTML') return true;
      if (node.tagName === 'SHADOW-ROOT') return Boolean(node.host?.parentElement) || node.host?.isConnected === true;
    }
    return false;
  }

  // -- tree ------------------------------------------------------------------

  appendChild(child) {
    const node = typeof child === 'string' ? text(child) : child;
    node.parentElement = this;
    if (node.nodeType === ELEMENT_NODE && !node.ownerDocument) node.ownerDocument = this.ownerDocument;
    this.children.push(node);
    return node;
  }

  append(...nodes) { for (const node of nodes.flat(Infinity)) this.appendChild(node); }

  insertBefore(node, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) return this.appendChild(node);
    const inserted = typeof node === 'string' ? text(node) : node;
    inserted.parentElement = this;
    if (inserted.nodeType === ELEMENT_NODE && !inserted.ownerDocument) inserted.ownerDocument = this.ownerDocument;
    this.children.splice(index, 0, inserted);
    return inserted;
  }

  descendants() {
    const output = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        output.push(child);
        walk(child);
      }
    };
    walk(this);
    return output;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matchesSelector(element, selector));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  matches(selector) { return matchesSelector(this, selector); }

  closest(selector) {
    for (let node = this; node && node.nodeType === ELEMENT_NODE; node = node.parentElement) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  cloneNode(deep) {
    const copy = new FakeElement(this.tagName);
    copy.attributes = { ...this.attributes };
    copy.style = { ...this.style };
    copy.ownText = this.ownText;
    copy._value = this._value;
    copy._checked = this._checked;
    copy._fixed = this._fixed;
    copy.ownerDocument = this.ownerDocument;
    if (deep) {
      for (const child of this.children) {
        copy.appendChild(child.nodeType === TEXT_NODE ? text(child.textContent) : child.cloneNode(true));
      }
    }
    return copy;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const sibling = this.parentElement.children[cursor];
      if (sibling.nodeType === ELEMENT_NODE) return sibling;
    }
    return null;
  }

  // -- events / geometry -----------------------------------------------------

  getClientRects() { return this.visible ? [{}] : []; }

  addEventListener(type, listener) {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((candidate) => candidate !== listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners[event.type] || []) listener.call(this, event);
    return true;
  }

  click() {
    this.clickCount += 1;
    this.dispatchEvent({ type: 'click', target: this });
  }

  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

class HTMLInputElement extends FakeElement {}
class HTMLTextAreaElement extends FakeElement {}

// The native value setter runs sanitisation; the harness replicates it so
// fillTextInput()'s post-condition check has something real to check.
Object.defineProperty(HTMLInputElement.prototype, 'value', {
  configurable: true,
  get() {
    if (this._value !== null) return this._value;
    return this.attributes.value !== undefined ? this.attributes.value : '';
  },
  set(newValue) { this._value = sanitiseInputValue(this, newValue); },
});

Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
  configurable: true,
  get() { return this._value !== null ? this._value : this.ownText; },
  set(newValue) { this._value = String(newValue); },
});

function computedStyleOf(element) {
  return {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    ...element.style,
  };
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    for (const node of [this.documentElement, this.head, this.body]) node.ownerDocument = this;
    this.activeElement = null;
    this.title = '';
    this.listeners = {};
  }

  createElement(tagName) { return new FakeElement(tagName); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) {
    return this.documentElement.descendants().find((element) => element.attributes.id === id) || null;
  }
  getElementsByName(name) {
    return this.documentElement.descendants().filter((element) => element.attributes.name === name);
  }
  addEventListener(type, listener) {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((candidate) => candidate !== listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners[event.type] || []) listener.call(this, event);
    return true;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    for (const [key, value] of Object.entries(init)) this[key] = value;
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.disconnected = false;
    this.taken = [];
  }
  observe(target) {
    this.target = target;
    this.disconnected = false;
  }
  disconnect() { this.disconnected = true; }
  takeRecords() {
    const records = this.taken;
    this.taken = [];
    return records;
  }
  /** Deliver a mutation batch the way the browser would call the callback. */
  trigger(records = [{}]) {
    if (this.disconnected) return;
    this.taken.push(...records);
    const batch = this.takeRecords();
    this.callback(batch, this);
  }
}

/** Build a `vm` context whose globals the content scripts expect. */
function createContext({ href = 'https://jobs.example.com/apply/42' } = {}) {
  const document = new FakeDocument();
  const observers = [];
  const windowListeners = {};
  const window = {
    location: { href },
    document,
    HTMLInputElement,
    HTMLTextAreaElement,
    getComputedStyle: computedStyleOf,
    URL,
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    frames: [],
    addEventListener(type, listener) {
      (windowListeners[type] = windowListeners[type] || []).push(listener);
    },
    removeEventListener(type, listener) {
      windowListeners[type] = (windowListeners[type] || []).filter((candidate) => candidate !== listener);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners[event.type] || []) listener.call(window, event);
      return true;
    },
  };
  window.top = window;
  window.parent = window;
  const MutationObserver = class extends FakeMutationObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const context = vm.createContext({
    window,
    document,
    console: { log() {}, warn() {}, error() {} },
    CSS: { escape: (value) => String(value).replace(/([^\w-])/g, '\\$1') },
    getComputedStyle: computedStyleOf,
    MutationObserver,
    HTMLInputElement,
    HTMLTextAreaElement,
    FocusEvent: FakeEvent,
    InputEvent: FakeEvent,
    MouseEvent: FakeEvent,
    Event: FakeEvent,
    URL,
    setTimeout,
    clearTimeout,
  });
  return { context, document, window, observers };
}

/** Run the given extension-relative files, in order, inside one context. */
function loadScripts(context, root, relativeFiles) {
  for (const relativeFile of relativeFiles) {
    const source = fs.readFileSync(path.join(root, relativeFile), 'utf8');
    vm.runInContext(source, context, { filename: relativeFile });
  }
}

module.exports = {
  createContext,
  el,
  loadScripts,
  text,
};
