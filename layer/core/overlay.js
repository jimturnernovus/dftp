// The design layer: a module that runs inside the framed page and does
// nothing until the designer window's "init" message arrives (boot.js checks
// where that message may come from).
//
// In Design mode the layer owns the pointer and the keyboard. Hovering draws
// an outline; clicking picks an element (with Shift or Cmd/Ctrl the pick is
// added to, or removed from, a multi-selection; with Option/Alt, or the P
// key, the pick climbs to the enclosing element). Dragging moves, the eight
// grips resize, arrow keys step by 1 px (10 with Shift, or grid line to grid
// line when Snap is on), Delete or Backspace hides the pick, E or Enter opens
// a small text editor (for a text box it edits the placeholder) and a
// double-click breaks a run of text into separately movable words. The
// page's own handlers see none of these events. In Use mode the page behaves
// as usual, with the recorded changes still drawn on it.
//
// Each change is one record per element: an offset, a size, a hidden flag
// or replacement text, plus enough to locate the element again later: the
// "file:line:col" stamp and an occurrence number (several elements can come
// from the same stamped line), or a child-index path below the closest
// stamped ancestor. Everything is drawn with inline styles and text-node
// edits that are recorded so they can be undone exactly (for Before, for a
// route change, for a reset). Source files are never touched from here; the
// window that owns this frame receives the list and stores it.

import { envelope, validateShellMsg, BEFORE_TYPES } from "./protocol.js";
import { coerceChange, isKey, isLoc, splitLoc, newChangeId, LIMITS } from "./schema.js";
import { pageIdentity } from "./devices.js";

const GRIPS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const PROPS = ["translate", "width", "min-width", "max-width", "flex", "height", "min-height", "max-height", "box-sizing", "display", "position", "z-index"];
const UNDO_MAX = 200;
const NUDGE_MERGE_MS = 700;
const DRAG_START_PX = 3;
const SETTLE_QUIET_MS = 700;
const SETTLE_MAX_MS = 5000;
const MUTATION_DELAY_MS = 30;
const MAX_CRUMBS = 12;
const TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PIECE_RE = /^\d{1,5}\.\d{1,5}$/;
const PATH_RE = /^[0-9.~>]{0,200}$/;
const HOST_TAG = "dftp-layer";
const MARK = "data-dftp";
const PIECE = "data-dftp-piece";
const DESIGN_CLASS = "dftp-design";
// Fields whose text is never recorded: passwords, hidden values, card fields
// and anything the page marks private.
const PRIVATE_SEL = "input[type=\"password\" i], input[type=\"hidden\" i], [autocomplete^=\"cc-\" i], [data-dftp-private]";
// Text inside these is not a label: code, styles, icon titles, typed content.
const NO_TEXT_SEL = "script, style, noscript, template, title, desc, textarea, [data-dftp-private], [contenteditable=\"\"], [contenteditable=\"true\" i], [contenteditable=\"plaintext-only\" i]";
const NO_EDIT_TAGS = new Set(["img", "svg", "video", "audio", "canvas", "iframe", "object", "embed", "br", "hr", "select", "picture", "meter", "progress"]);
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number"]);
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function startLayer(opts) {
  const ns = opts.ns;
  const nonce = opts.nonce;
  const shellOrigin = opts.shellOrigin;
  const ATTR = /^data-[a-z0-9-]{1,30}$/.test(String(opts.locAttr || "")) ? opts.locAttr : "data-loc";
  const libPrefixes = Array.isArray(opts.libraryPrefixes) ? opts.libraryPrefixes.filter((p) => typeof p === "string" && p !== "") : [];
  const captureText = opts.captureText !== false;
  const themeCfg = opts.theme && typeof opts.theme === "object" ? opts.theme : null;
  const layerBase = typeof opts.layerBase === "string" ? opts.layerBase : "/__dftp/";

  const S = {
    active: false,
    mode: "use",
    view: "after",
    away: false,
    settled: false,
    changes: new Map(),
    sel: null,
    selKey: null,
    selText: "",
    extra: [],
    op: null,
    undo: [],
    redo: [],
    lastNudge: 0,
    grid: { on: false, size: 12, snap: false },
    scale: 1,
    code: Object.create(null),
    page: { id: "", path: "/", keep: [] },
    baseline: "",
  };

  // Element state kept out of the page's reach.
  const saved = new WeakMap();      // el -> original inline styles and computed shape
  const appliedKey = new WeakMap(); // el -> key of the change shown on it
  const pieces = new WeakMap();     // el -> Map(text index -> {tn, spans})
  const textSaved = new WeakMap();  // el -> [[text node, original value], ...]
  const phSaved = new WeakMap();    // el -> {value: original placeholder or null}
  // What the layer itself wrote, so the page's own text can always be told
  // apart from a drawn text edit: text node -> {orig, value}; text box ->
  // drawn placeholder. Recognising elements by the page's own text keeps a
  // drawn edit from making its element (or an ancestor) look like a stranger.
  const drawnNodes = new WeakMap();
  const drawnPh = new WeakMap();
  const clipSaved = new WeakMap();  // el -> [overflow value, priority]
  const wrapSaved = new WeakMap();  // el -> {holder, value, prio}: white-space set so line breaks show
  let unclipped = [];

  const post = (type, fields) => {
    try {
      window.parent.postMessage(envelope(ns, nonce, type, fields), shellOrigin);
    } catch {
      // the designer window is gone
    }
  };
  const toast = (code) => post("toast", { code });
  const now = () => new Date().toISOString();
  const clampMove = (v) => Math.max(-LIMITS.move, Math.min(LIMITS.move, v));
  const clampSize = (v) => Math.max(LIMITS.sizeMin, Math.min(LIMITS.sizeMax, v));
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const inside = (b, x, y) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

  // ---------------------------------------------------------------- the layer's own DOM

  let host = null;
  let wrap = null;
  let hoverBox = null;
  let selBox = null;
  let label = null;
  let gridEl = null;
  let editor = null;
  let ta = null;
  let handles = [];
  const extraBoxes = [];

  const div = (cls) => {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  };
  const hide = (n) => {
    if (n) n.style.display = "none";
  };
  const place = (n, r) => {
    n.style.display = "block";
    n.style.left = `${r.left}px`;
    n.style.top = `${r.top}px`;
    n.style.width = `${r.width}px`;
    n.style.height = `${r.height}px`;
  };
  const styleLink = () => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = `${layerBase}layer.css`;
    return l;
  };

  function buildLayer() {
    if (host) {
      if (!host.isConnected) document.documentElement.appendChild(host);
      return;
    }
    host = document.createElement(HOST_TAG);
    const fixed = [
      ["position", "fixed"], ["inset", "0"], ["display", "block"], ["pointer-events", "none"], ["z-index", "2147483646"],
      ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "none"], ["transform", "none"],
      ["filter", "none"], ["opacity", "1"], ["visibility", "visible"], ["contain", "none"],
    ];
    for (const [p, v] of fixed) host.style.setProperty(p, v, "important");
    const shadow = host.attachShadow({ mode: "closed" });
    wrap = div("dftp-layer");
    gridEl = div("dftp-grid");
    hoverBox = div("dftp-box dftp-hover");
    selBox = div("dftp-box dftp-sel");
    label = div("dftp-label");
    wrap.append(gridEl, hoverBox, selBox, label);
    handles = GRIPS.map((dir) => {
      const h = div("dftp-h");
      h.dataset.dir = dir;
      h.addEventListener("pointerdown", (e) => startResize(e, h));
      wrap.appendChild(h);
      return h;
    });
    editor = div("dftp-editor");
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-label", "Text editor");
    ta = document.createElement("textarea");
    ta.className = "dftp-ta";
    ta.maxLength = LIMITS.textTo;
    ta.rows = 3;
    ta.spellcheck = true;
    const row = div("dftp-row");
    const tip = document.createElement("span");
    tip.className = "dftp-tip";
    tip.textContent = "Return to save, Shift+Return for a new line, Esc to cancel";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dftp-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "dftp-btn dftp-save";
    ok.textContent = "Save";
    row.append(tip, cancel, ok);
    editor.append(ta, row);
    wrap.appendChild(editor);
    shadow.append(styleLink(), wrap);
    [hoverBox, selBox, label, editor, gridEl, ...handles].forEach(hide);
    cancel.addEventListener("click", () => closeEditor());
    ok.addEventListener("click", () => saveEditor());
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveEditor();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeEditor();
      }
    });
    document.documentElement.appendChild(host);
    // The marker outline and design-mode cursor rules live in the same file;
    // a <link> from this origin is allowed by a page CSP of 'self'.
    const pageCss = styleLink();
    pageCss.setAttribute("data-dftp-css", "");
    (document.head || document.documentElement).appendChild(pageCss);
    applyScale();
  }

  function applyScale() {
    if (host) host.style.setProperty("--dftp-k", String(1 / (S.scale || 1)));
  }

  const extraBox = (i) => {
    if (!extraBoxes[i]) {
      const b = div("dftp-box dftp-extra");
      wrap.insertBefore(b, label);
      extraBoxes[i] = b;
    }
    return extraBoxes[i];
  };

  // ---------------------------------------------------------------- grid

  const gridSize = () => Math.max(2, Number(S.grid.size) || 12);
  const snapOn = () => S.grid.on && S.grid.snap;
  // Positions are snapped as whole pixels: the page draws moves rounded to
  // the pixel, so snapping a fractional edge would leave it short of the line.
  const snapTo = (v) => Math.round(Math.round(v) / gridSize()) * gridSize();
  // The first grid line beyond the (rounded) position v, going in direction
  // dir (+1 or -1). Never v itself, so every snapped step moves.
  const nextLine = (v, dir) => {
    const n = gridSize();
    const p = Math.round(v);
    return dir > 0 ? Math.floor(p / n) * n + n : Math.ceil(p / n) * n - n;
  };

  function drawGrid() {
    if (!gridEl) return;
    const n = gridSize();
    const major = n * 4;
    gridEl.style.display = S.grid.on && S.mode === "design" ? "block" : "none";
    // Scale the line width up as the frame is shrunk, so a line never drops
    // below one device pixel on screen.
    const t = `${Math.max(1, Math.ceil(1 / (S.scale || 1)))}px`;
    const line = (dir, rgba) => `linear-gradient(${dir}, ${rgba} ${t}, transparent ${t})`;
    gridEl.style.backgroundImage = [
      line("90deg", "rgba(234, 88, 12, .26)"),
      line("180deg", "rgba(234, 88, 12, .26)"),
      line("90deg", "rgba(13, 148, 136, .15)"),
      line("180deg", "rgba(13, 148, 136, .15)"),
    ].join(", ");
    gridEl.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${n}px ${n}px, ${n}px ${n}px`;
  }

  // ---------------------------------------------------------------- naming elements

  const tagOf = (el) => {
    const t = String(el.localName || el.tagName || "").toLowerCase();
    return TAG_RE.test(t) ? t : "element";
  };
  const locOf = (el) => {
    const v = el && el.nodeType === 1 ? el.getAttribute(ATTR) : null;
    return v && isLoc(v) ? v : "";
  };
  const pieceOf = (el) => {
    const v = el && el.nodeType === 1 ? el.getAttribute(PIECE) : null;
    return v && PIECE_RE.test(v) ? v : "";
  };
  const fileOf = (loc) => {
    const m = splitLoc(loc);
    return m ? m.file : "";
  };
  const lineOf = (loc) => {
    const m = splitLoc(loc);
    return m ? m.line : 0;
  };
  const isLib = (loc) => {
    const f = fileOf(loc);
    return !!f && libPrefixes.some((p) => f.startsWith(p));
  };

  let rootCache = null;
  function rootEl() {
    if (rootCache && rootCache.isConnected) return rootCache;
    let found = null;
    if (opts.rootSelector) {
      try {
        found = document.querySelector(opts.rootSelector);
      } catch {
        found = null;
      }
    } else {
      for (const s of ["#root", "#app", "#__next"]) {
        found = document.querySelector(s);
        if (found) break;
      }
    }
    if (found && document.body && found !== document.body && document.body.contains(found)) {
      rootCache = found;
      return found;
    }
    return document.body;
  }

  const isPage = (el) => !!el && el.nodeType === 1 && el !== document.body && el !== document.documentElement &&
    el !== host && el !== rootEl() && !!document.body && document.body.contains(el);

  const anchorOf = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (locOf(p)) return p;
    return null;
  };

  // Elements stamped from a library file (one of libPrefixes, such as a
  // button component) are drawn in many places, so a change to one of them
  // also records the closest enclosing stamp that comes from an ordinary
  // file. That is the containing element, not the component's call site.
  function usedInOf(el) {
    let first = null;
    for (let p = el; p; p = p.parentElement) {
      const loc = locOf(p);
      if (!loc) continue;
      if (!first) first = p;
      if (!isLib(loc)) return p === first ? "" : loc;
    }
    return "";
  }
  const scopeOf = (el, loc) => (isLib(loc) ? usedInOf(el) : "");
  const sameLoc = (loc) => (loc && isLoc(loc) ? [...document.querySelectorAll(`[${ATTR}="${CSS.escape(loc)}"]`)] : []);
  const sameScope = (loc, scope) => sameLoc(loc).filter((x) => usedInOf(x) === scope);
  const inFile = (file) => (file ? [...document.querySelectorAll(`[${ATTR}^="${CSS.escape(file)}:"]`)].filter((x) => fileOf(locOf(x)) === file) : []);
  const kids = (n) => [...n.children].filter((c) => !pieceOf(c) && c !== host);
  const LOC_HEAD_RE = /^([^:]+:\d+:\d+)(?:@([^:]+:\d+:\d+))?$/;

  // Key formats (n counts from 0):
  //   loc#n           occurrence n among elements stamped with loc
  //   loc@used#n      a library element: occurrence n among those stamped with
  //                   loc whose enclosing page stamp is "used"
  //   anchor>i.j      child-index path under a stamped ancestor ("root" or
  //                   "body" stand in when no ancestor is stamped)
  //   key>~t.w        word w of direct text node t of the element at key
  function keyOf(el) {
    const pc = pieceOf(el);
    if (pc && el.parentElement) return `${keyOf(el.parentElement)}>~${pc}`;
    const loc = locOf(el);
    if (loc) {
      const sc = scopeOf(el, loc);
      return sc ? `${loc}@${sc}#${sameScope(loc, sc).indexOf(el)}` : `${loc}#${sameLoc(loc).indexOf(el)}`;
    }
    const a = anchorOf(el);
    const root = rootEl();
    const useRoot = !a && root !== document.body && root.contains(el);
    const top = a || (useRoot ? root : document.body);
    const path = [];
    for (let n = el; n && n !== top && n.parentElement; n = n.parentElement) path.unshift(kids(n.parentElement).indexOf(n));
    return `${a ? keyOf(a) : useRoot ? "root" : "body"}>${path.join(".")}`;
  }

  function findEl(key) {
    if (typeof key !== "string" || !key) return null;
    const tilde = key.lastIndexOf(">~");
    if (tilde >= 0) {
      const m = /^(\d+)\.(\d+)$/.exec(key.slice(tilde + 2));
      const parent = m ? findEl(key.slice(0, tilde)) : null;
      if (!parent || pieceOf(parent)) return null;
      const spans = splitText(parent, Number(m[1]));
      return spans ? spans[Number(m[2])] || null : null;
    }
    const gt = key.indexOf(">");
    if (gt < 0) {
      const i = key.lastIndexOf("#");
      if (i < 0) return null;
      const m = LOC_HEAD_RE.exec(key.slice(0, i));
      const n = Number(key.slice(i + 1));
      if (!m || !Number.isInteger(n) || n < 0) return null;
      return (m[2] ? sameScope(m[1], m[2]) : sameLoc(m[1]))[n] || null;
    }
    const base = key.slice(0, gt);
    let n;
    if (base === "root") n = rootEl() !== document.body ? rootEl() : null;
    else if (base === "body") n = document.body;
    else n = findEl(base);
    for (const part of key.slice(gt + 1).split(".")) {
      if (!n) return null;
      const i = Number(part);
      if (part === "" || !Number.isInteger(i) || i < 0) return null;
      n = kids(n)[i];
    }
    return n || null;
  }

  // Which change an element on screen is drawing. Normally that is the key
  // computed from the element; after a relocation the change may still be
  // filed under its old key, and that key wins as long as it is in the list.
  const keyFor = (el) => {
    const k = appliedKey.get(el);
    return k && S.changes.has(k) ? k : keyOf(el);
  };
  const elOfKey = (key) => [...document.querySelectorAll(`[${MARK}]`)].find((x) => appliedKey.get(x) === key) || findEl(key);

  // ---------------------------------------------------------------- split words

  const directTexts = (el) => [...el.childNodes].filter((n) => n.nodeType === 3);

  // Break the ti-th direct text node of `parent` into word spans inserted in
  // front of it. The original node is kept (with an empty value) because a
  // framework may still hold a reference to it and write into it later; when
  // that happens the spans are rebuilt from the new text.
  // True when a text edit holds this text: on the element or an ancestor
  // (drawn already, or recorded and about to be drawn). Its text nodes are the
  // edit's to write, so they are never broken into words: splitting them made
  // the text show twice and redraw without end.
  function textHeld(el) {
    const recorded = new Set();
    for (const ch of S.changes.values()) if (hasText(ch) && !ch.key.includes(">~")) recorded.add(ch.key);
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      if (textSaved.has(a)) return true;
      if (recorded.size && !pieceOf(a) && recorded.has(appliedKey.get(a) || keyOf(a))) return true;
    }
    return false;
  }

  function splitText(parent, ti) {
    if (textHeld(parent)) return null;
    let byIndex = pieces.get(parent);
    if (!byIndex) {
      byIndex = new Map();
      pieces.set(parent, byIndex);
    }
    const have = byIndex.get(ti);
    if (have && have.tn.parentNode === parent && have.tn.nodeValue === "" && have.spans.every((sp) => sp.parentNode === parent)) {
      return have.spans;
    }
    if (have) for (const sp of have.spans) sp.remove();
    const tn = directTexts(parent)[ti];
    if (!tn || !tn.nodeValue.trim()) {
      byIndex.delete(ti);
      return null;
    }
    const words = tn.nodeValue.split(/(?<=\s)(?=\S)/);
    const spans = words.map((w, j) => {
      const sp = document.createElement("span");
      sp.setAttribute(PIECE, `${ti}.${j}`);
      sp.textContent = w;
      parent.insertBefore(sp, tn);
      return sp;
    });
    tn.nodeValue = "";
    byIndex.set(ti, { tn, spans });
    return spans;
  }

  function caretNode(x, y) {
    try {
      if (typeof document.caretRangeFromPoint === "function") {
        const r = document.caretRangeFromPoint(x, y);
        if (r && r.startContainer) return r.startContainer;
      }
      if (typeof document.caretPositionFromPoint === "function") {
        const p = document.caretPositionFromPoint(x, y);
        if (p && p.offsetNode) return p.offsetNode;
      }
    } catch {
      // fall through to the box test below
    }
    return null;
  }

  // The text node under a point: the caret position when the browser gives
  // one, otherwise the direct text of the element there whose boxes hold it.
  function textNodeAt(x, y) {
    const tn = caretNode(x, y);
    if (tn && tn.nodeType === 3 && tn.nodeValue.trim()) {
      const r = document.createRange();
      r.selectNodeContents(tn);
      if ([...r.getClientRects()].some((b) => inside(b, x, y))) return tn;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    for (const n of directTexts(el)) {
      if (!n.nodeValue.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if ([...r.getClientRects()].some((b) => inside(b, x, y))) return n;
    }
    return tn && tn.nodeType === 3 && tn.nodeValue.trim() ? tn : null;
  }

  function splitAt(x, y) {
    const tn = textNodeAt(x, y);
    const parent = tn && tn.parentElement;
    if (!parent) return null;
    if (pieceOf(parent)) return parent;
    if (!isPage(parent) || isPrivate(parent) || parent.closest(NO_TEXT_SEL)) return null;
    if (textHeld(parent)) return "held";
    const ti = directTexts(parent).indexOf(tn);
    const spans = splitText(parent, ti);
    if (!spans) return null;
    return spans.find((sp) => inside(sp.getBoundingClientRect(), x, y)) || spans[0];
  }

  // ---------------------------------------------------------------- what an element is

  function pick(target) {
    let el = target && target.nodeType === 1 ? target : target && target.parentElement;
    if (!el) return null;
    if (el.ownerSVGElement) {
      let svg = el.ownerSVGElement;
      while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
      el = svg;
    }
    return isPage(el) ? el : null;
  }
  const parentOf = (el) => {
    const p = el && el.parentElement;
    return isPage(p) ? p : null;
  };

  function isPrivate(el) {
    try {
      return el.matches(PRIVATE_SEL) || !!el.closest("[data-dftp-private]");
    } catch {
      return true;
    }
  }

  // A short label for an element: its own visible words, else its accessible
  // name, placeholder, title or alt text. Never a form value, never private text.
  // A text node's value as the page wrote it (a value the layer drew reads
  // as the original it replaced).
  const nodeText = (n) => {
    const d = drawnNodes.get(n);
    return d && n.nodeValue === d.value ? d.orig : n.nodeValue;
  };
  const placeholderOf = (el) => {
    const v = el.getAttribute("placeholder");
    return drawnPh.has(el) && v === drawnPh.get(el) && phSaved.has(el) ? phSaved.get(el).value || "" : v || "";
  };

  // The element's label: its words, else its accessible name, placeholder,
  // title or alt. With `page`, the page's own words: anything the layer drew
  // (a text edit on it or on a word inside it) reads as what it replaced.
  function textOf(el, { page = false } = {}) {
    if (!captureText || !el || el.nodeType !== 1 || isPrivate(el)) return "";
    let out = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && out.length < 400; n = w.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(NO_TEXT_SEL)) continue;
      out += ` ${page ? nodeText(n) : n.nodeValue}`;
    }
    let t = norm(out);
    if (!t) t = norm(el.getAttribute("aria-label") || (page ? placeholderOf(el) : el.getAttribute("placeholder")) || el.getAttribute("title") || el.getAttribute("alt") || "");
    return t.slice(0, 80);
  }
  const pageTextOf = (el) => textOf(el, { page: true });

  function describe(el) {
    const key = keyOf(el);
    const pc = pieceOf(el);
    if (pc && el.parentElement) {
      const parentInfo = describe(el.parentElement);
      const prefix = parentInfo.path ? `${parentInfo.path}>` : "";
      return { key, loc: parentInfo.loc, occ: parentInfo.occ, path: `${prefix}~${pc}`, part: true, piece: true };
    }
    const loc = locOf(el);
    if (loc) return { key, loc, occ: Math.max(0, Number(key.slice(key.lastIndexOf("#") + 1)) || 0), path: "", part: false, piece: false };
    const a = anchorOf(el);
    const gt = key.indexOf(">");
    const base = key.slice(0, gt);
    return {
      key,
      loc: a ? locOf(a) : "",
      occ: a ? Math.max(0, Number(base.slice(base.lastIndexOf("#") + 1)) || 0) : 0,
      path: key.slice(gt + 1),
      part: true,
      piece: false,
    };
  }

  const HINT_OK = /^[^\u0000-\u0020\u007F-\u009F<>"'\\`]+$/; // eslint-disable-line no-control-regex

  // How to find the element in source without a location: id, classes, a
  // structural selector, role and label.
  function hintOf(el) {
    const target = pieceOf(el) && el.parentElement ? el.parentElement : el;
    const h = {};
    const id = target.getAttribute("id");
    if (id && id.length <= LIMITS.hintId && HINT_OK.test(id)) h.id = id;
    const classes = [...target.classList].filter((c) => c.length <= LIMITS.hintClass && HINT_OK.test(c) && !c.startsWith("dftp-")).slice(0, LIMITS.hintClasses);
    if (classes.length) h.classes = classes;
    const sel = selectorOf(target);
    if (sel) h.selector = sel;
    const role = target.getAttribute("role");
    if (role && /^[a-z-]{1,32}$/.test(role)) h.role = role;
    if (captureText && !isPrivate(target)) {
      const aria = norm(target.getAttribute("aria-label") || "").replace(/[<>"'\\`]/g, "").slice(0, LIMITS.hintAria);
      if (aria) h.aria = aria;
    }
    return h;
  }

  function selectorOf(el) {
    const steps = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (pieceOf(n)) continue;
      const tag = n.localName;
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return "";
      if (n === document.body) {
        steps.unshift("body");
        break;
      }
      const id = n.getAttribute("id");
      if (id && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && document.querySelectorAll(`#${id}`).length === 1) {
        steps.unshift(`#${id}`);
        break;
      }
      const p = n.parentElement;
      const same = p ? [...p.children].filter((s) => s.localName === n.localName && !pieceOf(s) && s !== host) : [n];
      steps.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    while (steps.length > 1 && steps.join(" > ").length > LIMITS.hintSelector) steps.shift();
    const s = steps.join(" > ");
    return s.length <= LIMITS.hintSelector ? s : "";
  }

  const word = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z-]/g, "").slice(0, 20);
  const cap = (n, hi) => Math.max(0, Math.min(hi, Math.round(n)));

  // How the element sits among its siblings, and where a move took it.
  function contextOf(el, c) {
    if (pieceOf(el)) return null;
    const st = saved.get(el);
    const cs = st ? null : getComputedStyle(el);
    const ctx = { display: word(st ? st.display0 : cs.display), position: word(st ? st.position0 : cs.position) };
    const p = el.parentElement;
    if (!p || p === document.documentElement) return ctx;
    const ps = getComputedStyle(p);
    const parent = { display: word(ps.display) };
    const flex = ps.display.includes("flex");
    if (flex) {
      parent.dir = word(ps.flexDirection);
      parent.wrap = word(ps.flexWrap);
    }
    if (ps.display.includes("grid")) {
      const cols = String(ps.gridTemplateColumns || "").trim();
      if (cols && cols !== "none") parent.grid_cols = cap(cols.split(/\s+(?![^(]*\))/).length, LIMITS.ctxCols);
    }
    const gap = parseFloat(flex && String(ps.flexDirection).startsWith("column") ? ps.rowGap : ps.columnGap);
    if (Number.isFinite(gap) && gap > 0) parent.gap_px = Math.min(LIMITS.ctxGap, Math.round(gap));
    ctx.parent = parent;
    const sibs = kids(p);
    const index = sibs.indexOf(el);
    if (index < 0) return ctx;
    ctx.index = cap(index, LIMITS.ctxCount);
    ctx.count = cap(sibs.length, LIMITS.ctxCount);
    if (c.dx || c.dy) ctx.slot = { before_index: slotOf(el, sibs, ps) };
    return ctx;
  }

  // The first sibling (in source order) that the moved element's centre now
  // comes before, along the parent's flow; null when it comes after them all.
  function slotOf(el, sibs, ps) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const flex = ps.display.includes("flex");
    const dir = String(ps.flexDirection || "row");
    const axis = flex ? (dir.startsWith("column") ? "y" : "x") : "flow";
    const rev = flex && dir.endsWith("reverse");
    for (let i = 0; i < sibs.length; i++) {
      const s = sibs[i];
      if (s === el) continue;
      const b = s.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      let before;
      if (axis === "x") before = rev ? cx > bx : cx < bx;
      else if (axis === "y") before = rev ? cy > by : cy < by;
      else before = cy < b.top || (cy <= b.bottom && cx < bx);
      if (before) return cap(i, LIMITS.ctxCount);
    }
    return null;
  }

  // ---------------------------------------------------------------- showing a change

  function applyTo(el, c) {
    let st = saved.get(el);
    if (!c) {
      if (st) {
        for (const p of PROPS) {
          const [v, prio] = st.props[p];
          if (v) el.style.setProperty(p, v, prio);
          else el.style.removeProperty(p);
        }
        saved.delete(el);
      }
      el.removeAttribute(MARK);
      return;
    }
    if (!st) {
      const cs = getComputedStyle(el);
      st = {
        props: Object.fromEntries(PROPS.map((p) => [p, [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]])),
        wasStatic: cs.position === "static",
        wasInline: cs.display === "inline",
        display0: cs.display,
        position0: cs.position,
      };
      saved.set(el, st);
    }
    const set = (p, v) => {
      if (v === null) {
        const [ov, op] = st.props[p];
        if (ov) el.style.setProperty(p, ov, op);
        else el.style.removeProperty(p);
      } else {
        el.style.setProperty(p, v, "important");
      }
    };
    const moved = !!(c.dx || c.dy);
    const hasW = c.w !== undefined && c.w !== null;
    const hasH = c.h !== undefined && c.h !== null;
    set("translate", moved ? `${Math.round(c.dx || 0)}px ${Math.round(c.dy || 0)}px` : null);
    set("width", hasW ? `${Math.round(c.w)}px` : null);
    set("min-width", hasW ? "0px" : null);
    set("max-width", hasW ? "none" : null);
    set("flex", hasW ? "0 0 auto" : null);
    set("height", hasH ? `${Math.round(c.h)}px` : null);
    set("min-height", hasH ? "0px" : null);
    set("max-height", hasH ? "none" : null);
    // A recorded size is the outer (border-box) size the user saw while
    // dragging, whatever box model the page uses.
    set("box-sizing", hasW || hasH ? "border-box" : null);
    // translate and width have no effect on a plain inline box, so such an
    // element is drawn as inline-block while it carries one of them.
    set("display", c.hidden ? "none" : (moved || hasW || hasH) && st.wasInline ? "inline-block" : null);
    // Lift a moved element over its siblings so the drop position is visible.
    set("position", moved && st.wasStatic ? "relative" : null);
    set("z-index", moved ? "40" : null);
    // Written only when it changes, so a redraw does not disturb the page
    // (an attribute write is a DOM mutation even with the same value).
    if (moved || hasW || hasH || c.hidden || (c.text_to !== undefined && c.text_to !== null)) {
      if (el.getAttribute(MARK) !== "1") el.setAttribute(MARK, "1");
    } else if (el.hasAttribute(MARK)) el.removeAttribute(MARK);
  }

  const isBox = (el) => el.localName === "textarea" || (el.localName === "input" && TEXT_INPUT_TYPES.has(String(el.getAttribute("type") || "").toLowerCase()));
  // Text nodes a text edit may read and replace. The same filter as textOf:
  // nothing inside private, editable or non-label containers is ever read,
  // recorded or blanked.
  function textNodesOf(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (!n.nodeValue.trim() || !p) continue;
      let skip;
      try {
        skip = !!p.closest(NO_TEXT_SEL) || !!p.closest(PRIVATE_SEL);
      } catch {
        skip = true;
      }
      if (!skip) out.push(n);
    }
    return out;
  }
  const currentText = (el) => (isBox(el) ? el.getAttribute("placeholder") || "" : norm(textNodesOf(el).map((n) => n.nodeValue).join("")));
  // The element's text as the page drew it, before any edit shown here.
  const originalText = (el) => {
    if (isBox(el)) {
      const ph = phSaved.get(el);
      return ph ? ph.value || "" : el.getAttribute("placeholder") || "";
    }
    const t = textSaved.get(el);
    return t ? norm(t.map(([, v]) => v).join("")) : currentText(el);
  };
  const textCount = (el) => (textSaved.has(el) ? textSaved.get(el).length : textNodesOf(el).length);

  function applyText(el, c) {
    const has = !!c && c.text_to !== undefined && c.text_to !== null;
    if (isBox(el)) {
      if (has) {
        if (!phSaved.has(el)) phSaved.set(el, { value: el.getAttribute("placeholder") });
        if (el.getAttribute("placeholder") !== c.text_to) el.setAttribute("placeholder", c.text_to);
        drawnPh.set(el, c.text_to);
      } else if (phSaved.has(el)) {
        const { value } = phSaved.get(el);
        if (value === null) el.removeAttribute("placeholder");
        else el.setAttribute("placeholder", value);
        phSaved.delete(el);
        drawnPh.delete(el);
      }
      return;
    }
    if (has) {
      if (!textSaved.has(el)) {
        let list = textNodesOf(el).map((n) => [n, n.nodeValue]);
        if (!list.length) {
          const t = document.createTextNode("");
          el.appendChild(t);
          list = [[t, ""]];
        }
        textSaved.set(el, list);
      }
      // A word piece carries the space that followed the word in the text;
      // keep it after the new words, or the next word would run into them.
      const saved = textSaved.get(el);
      let tail = pieceOf(el) && !/\s$/.test(c.text_to) ? (saved.map(([, v]) => v).join("").match(/\s+$/) || [""])[0] : "";
      // Typed line breaks show through white-space: pre-line, which would also
      // show a line break in that space; where the page collapses white space
      // anyway, a single space is what it drew.
      if (tail && c.text_to.includes("\n") && el.parentElement && /^(normal|nowrap)$/.test(getComputedStyle(el.parentElement).whiteSpace)) tail = " ";
      saved.forEach(([n, orig], i) => {
        const v = i === 0 ? c.text_to + tail : "";
        if (n.nodeValue !== v) n.nodeValue = v;
        drawnNodes.set(n, { orig, value: v });
      });
      showBreaks(el, c.text_to.includes("\n"));
    } else if (textSaved.has(el)) {
      for (const [n, v] of textSaved.get(el)) {
        if (n.nodeValue !== v) n.nodeValue = v;
        drawnNodes.delete(n);
      }
      textSaved.delete(el);
      showBreaks(el, false);
    }
  }

  // Line breaks typed in the editor (Shift+Return) only show with a
  // white-space value that keeps them. It is set on the element that now holds
  // the text, and only when that element has no source-formatting newlines of
  // its own between children, which would then show up as blank lines.
  function showBreaks(el, on) {
    const had = wrapSaved.get(el);
    const list = textSaved.get(el);
    const holder = on && list && list.length ? list[0][0].parentElement : null;
    const fits = !!holder && ![...holder.childNodes].some((n) => n.nodeType === 3 && !n.nodeValue.trim() && n.nodeValue.includes("\n") && !list.some(([t]) => t === n));
    if (had && (!fits || had.holder !== holder)) {
      if (had.value) had.holder.style.setProperty("white-space", had.value, had.prio);
      else had.holder.style.removeProperty("white-space");
      wrapSaved.delete(el);
    }
    if (!fits) return;
    if (!wrapSaved.has(el)) {
      wrapSaved.set(el, { holder, value: holder.style.getPropertyValue("white-space"), prio: holder.style.getPropertyPriority("white-space") });
    }
    if (holder.style.getPropertyValue("white-space") !== "pre-line") holder.style.setProperty("white-space", "pre-line", "important");
  }

  // Whether the change is inline, a placeholder edit, or a label spread over
  // several text nodes. Returns true when any of that changed.
  function markShape(el, c) {
    const was = JSON.stringify([c.inline, c.text_attr, c.text_multi]);
    const st = saved.get(el);
    c.inline = st ? st.wasInline : getComputedStyle(el).display === "inline";
    if (c.text_to !== undefined && c.text_to !== null) {
      if (isBox(el)) c.text_attr = "placeholder";
      else delete c.text_attr;
      if (!isBox(el) && textCount(el) > 1) c.text_multi = true;
      else delete c.text_multi;
    } else {
      delete c.text_attr;
      delete c.text_multi;
    }
    return JSON.stringify([c.inline, c.text_attr, c.text_multi]) !== was;
  }

  // A box that clips its content would cut off an element dragged out of it,
  // so clipping ancestors show their overflow while a move is shown.
  function unclipFor(el) {
    const root = rootEl();
    for (let p = el.parentElement; p && p !== root && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (![cs.overflowX, cs.overflowY].some((v) => v === "hidden" || v === "clip")) continue;
      if (!clipSaved.has(p)) {
        clipSaved.set(p, [p.style.getPropertyValue("overflow"), p.style.getPropertyPriority("overflow")]);
        unclipped.push(p);
      }
      p.style.setProperty("overflow", "visible", "important");
    }
  }
  function restoreClips() {
    for (const p of unclipped) {
      const s = clipSaved.get(p);
      if (s && s[0]) p.style.setProperty("overflow", s[0], s[1]);
      else p.style.removeProperty("overflow");
      clipSaved.delete(p);
    }
    unclipped = [];
  }

  // Undo all drawing on the page (inline styles, text, clipping). The
  // records in S.changes stay as they are.
  function takeOffAll() {
    restoreClips();
    for (const el of document.querySelectorAll(`[${MARK}]`)) {
      applyTo(el, null);
      applyText(el, null);
      appliedKey.delete(el);
    }
  }

  // ---------------------------------------------------------------- finding a change's element again

  const codeOf = (loc) => {
    const f = fileOf(loc);
    return f && typeof S.code[f] === "string" ? S.code[f] : "";
  };
  const isLibChange = (c) => isLib(c.loc) && !!c.used_in;
  // True while the source the change was made on is unchanged.
  const codeSame = (c) => !!c.src && codeOf(c.loc) === c.src && (!isLibChange(c) || (!!c.src_used && codeOf(c.used_in) === c.src_used));

  const askedCode = new Set();
  const pendingCode = new Set();
  let codeTimer = null;
  function requestCode(files) {
    for (const f of files) {
      if (f && !(f in S.code) && !askedCode.has(f)) {
        askedCode.add(f);
        pendingCode.add(f);
      }
    }
    if (!pendingCode.size || codeTimer) return;
    codeTimer = setTimeout(() => {
      codeTimer = null;
      const batch = [...pendingCode].slice(0, LIMITS.files);
      for (const f of batch) pendingCode.delete(f);
      if (batch.length) post("need-code", { files: batch });
      if (pendingCode.size) requestCode([]);
    }, 0);
  }

  // Fingerprints of the change's source files as they were when the change
  // was last edited. They are filled in once the server reports them, and
  // replaced only when the user edits the change again (fresh). Relocating a
  // change after its file was edited keeps them, so CHANGES.md can still warn
  // that the file differs from the one the change was made against.
  // Returns true when that altered what is saved.
  function stampCode(c, fresh = false) {
    if (S.view === "before" || S.away) return false;
    const was = `${c.src || ""}|${c.src_used || ""}`;
    const ask = [];
    const stamp = (file, field) => {
      if (!file) {
        delete c[field];
        return;
      }
      if (c[field] && !fresh) return;
      if (!(file in S.code)) {
        if (fresh) delete c[field];
        ask.push(file);
        return;
      }
      if (S.code[file]) c[field] = S.code[file];
      else delete c[field];
    };
    stamp(fileOf(c.loc), "src");
    stamp(isLibChange(c) ? fileOf(c.used_in) : "", "src_used");
    if (ask.length) requestCode(ask);
    return `${c.src || ""}|${c.src_used || ""}` !== was;
  }

  function textMatches(el, c) {
    if (!captureText) return true;
    const cur = norm(pageTextOf(el));
    const want = [c.text, c.text_to].filter((t) => typeof t === "string" && t !== "").map((t) => norm(t).slice(0, 80));
    return !want.length || want.some((t) => cur === t || (t.length >= 12 && cur.startsWith(t.slice(0, 40))));
  }
  const tagOk = (el, c) => !c.tag || tagOf(el) === c.tag;
  const sameThing = (el, c) => !!el && tagOk(el, c) && textMatches(el, c);
  const nearest = (els, line) => els.sort((a, b) => Math.abs(lineOf(locOf(a)) - line) - Math.abs(lineOf(locOf(b)) - line))[0] || null;
  const headLoc = (key) => {
    const base = key.split(">")[0];
    const i = base.lastIndexOf("#");
    const m = LOC_HEAD_RE.exec(i >= 0 ? base.slice(0, i) : base);
    return m ? m[1] : "";
  };

  // Finds the element a change applies to on the current page.
  //  - Source fingerprint unchanged: only elements stamped with the change's
  //    own location are candidates. If its element is absent (a closed menu,
  //    a filtered list) the change waits; it must not hop onto a sibling.
  //  - Fingerprint changed (the file was edited): search the whole file for
  //    an element with the same tag and words, preferring the closest line.
  function resolve(c) {
    const exact = findEl(c.key);
    const lib = isLibChange(c);
    const inScope = (el) => !lib || fileOf(usedInOf(el)) === fileOf(c.used_in);
    const byUse = (els) => els.sort((x, y) => Math.abs(lineOf(usedInOf(x)) - lineOf(c.used_in)) - Math.abs(lineOf(usedInOf(y)) - lineOf(c.used_in)))[0] || null;
    const same = codeSame(c);
    const tilde = c.key.lastIndexOf(">~");
    if (tilde >= 0) {
      const w = norm(c.text);
      // A word piece is recognised by the word the page drew, not by what it
      // shows now: once its own text edit is drawn it reads text_to, and
      // comparing that to the recorded word made the change drop off and come
      // back on every redraw (the word flickered between the two texts).
      const wordOf = (sp) => norm(originalText(sp));
      if (exact && (!w || !captureText || wordOf(exact) === w)) return exact;
      if (!w) return null;
      const ti = Number(c.key.slice(tilde + 2).split(".")[0]);
      const holds = (el) => {
        const have = pieces.get(el) && pieces.get(el).get(ti);
        if (have) return have.spans.some((sp) => wordOf(sp) === w);
        const tn = directTexts(el)[ti];
        return !!tn && norm(tn.nodeValue).split(" ").includes(w);
      };
      const anchorLoc = headLoc(c.key.slice(0, tilde));
      if (!anchorLoc || c.key.slice(0, tilde).includes(">")) return null;
      let cands = (same ? (lib ? sameScope(anchorLoc, c.used_in) : sameLoc(anchorLoc)) : inFile(fileOf(anchorLoc))).filter(holds);
      if (lib) cands = cands.filter((el) => fileOf(usedInOf(el)) === fileOf(c.used_in));
      const parent = lib ? byUse(cands) : nearest(cands, lineOf(anchorLoc));
      const spans = parent ? splitText(parent, ti) : null;
      return (spans && spans.find((sp) => wordOf(sp) === w)) || null;
    }
    if (c.key.includes(">")) {
      // Child-path keys depend on their ancestor's stamp; a library anchor
      // must also still sit in the same enclosing page file.
      if (!exact || !tagOk(exact, c)) return null;
      return !lib || inScope(exact) ? exact : null;
    }
    if (exact && sameThing(exact, c) && inScope(exact)) return exact;
    if (same) {
      const all = lib ? sameScope(c.loc, c.used_in) : sameLoc(c.loc);
      const pool = all.filter((el) => sameThing(el, c));
      const occ = c.occ || 0;
      if (pool.length) return pool.sort((x, y) => Math.abs(all.indexOf(x) - occ) - Math.abs(all.indexOf(y) - occ))[0];
      // A lone candidate with the right tag is accepted only when there are
      // no recorded words to compare; otherwise a filtered list would hand
      // the change to whichever row happens to be left.
      return all.length === 1 && tagOk(all[0], c) && !hasCapturedWords(c) ? all[0] : null;
    }
    const pool = inFile(fileOf(c.loc)).filter((el) => sameThing(el, c) && inScope(el));
    const found = lib ? byUse(pool) : nearest(pool, lineOf(c.loc));
    if (found) return found;
    // Same key, different words: the label is data-driven (a counter, a
    // timestamp), so the element at the recorded position is still it.
    return exact && tagOk(exact, c) && (!lib || usedInOf(exact) === c.used_in) ? exact : null;
  }
  const hasCapturedWords = (c) => captureText && [c.text, c.text_to].some((t) => typeof t === "string" && t.trim() !== "");

  // ---------------------------------------------------------------- putting changes back

  // Draws every change on the element resolve() finds for it.
  // Until the page settles (no DOM churn for a short spell) nothing is renamed: a
  // change found under a different key is only drawn. Once the page has been
  // quiet, such a change adopts the new key and the list is saved again.
  // An element can carry one change at most; when two claim it, the one
  // whose key already names that element wins and the other is marked
  // missing until its own element shows up.
  function reapplyAll() {
    if (!S.active || S.away || S.view === "before") return;
    restoreClips();
    const order = [...S.changes.values()];
    const found = order.map((c) => {
      let el = resolve(c);
      const k = el ? keyOf(el) : null;
      // A move to another key is only trusted when the words still agree.
      if (el && k !== c.key && !c.key.includes(">~") && !textMatches(el, c)) el = null;
      return { c, el, k: el ? k : null };
    });
    const taken = new Set();
    const ownFirst = [...found].sort((x, y) => (x.k === x.c.key ? 0 : 1) - (y.k === y.c.key ? 0 : 1));
    for (const f of ownFirst) {
      if (!f.el || taken.has(f.el)) {
        f.el = null;
        continue;
      }
      taken.add(f.el);
    }
    for (const el of document.querySelectorAll(`[${MARK}]`)) {
      if (taken.has(el)) continue;
      applyTo(el, null);
      applyText(el, null);
      appliedKey.delete(el);
    }
    let moved = false;
    let shown = false;
    for (const f of found) {
      if (!!f.c.missing === !f.el) continue;
      shown = true;
      if (f.el) delete f.c.missing;
      else f.c.missing = true;
    }
    if (S.settled) {
      const blocked = new Set(found.filter((f) => !f.el).map((f) => f.c.key));
      for (let again = true; again;) {
        again = false;
        const used = new Set(order.map((c) => c.key));
        for (const f of found) {
          if (!f.el || f.k === f.c.key || blocked.has(f.k) || used.has(f.k) || !isKey(f.k)) continue;
          used.delete(f.c.key);
          used.add(f.k);
          const d = describe(f.el);
          if (!f.c.was_loc) f.c.was_loc = f.c.loc || "";
          f.c.key = f.k;
          f.c.loc = d.loc;
          f.c.occ = d.occ;
          if (d.part) {
            f.c.part = true;
            f.c.path = d.path;
          } else {
            delete f.c.part;
            delete f.c.path;
          }
          if (d.piece) f.c.piece = true;
          else delete f.c.piece;
          const u = usedInOf(f.el);
          if (u) f.c.used_in = u;
          else delete f.c.used_in;
          moved = true;
          again = true;
        }
      }
    }
    for (const { c, el } of found) {
      if (!el) continue;
      if (S.settled && stampCode(c)) moved = true;
      if (markShape(el, c)) moved = true;
      appliedKey.set(el, c.key);
      applyTo(el, c);
      applyText(el, c);
      if (c.dx || c.dy) unclipFor(el);
    }
    S.changes = new Map(order.map((c) => [c.key, c]));
    if (moved && S.settled) post("changes", { list: list(), canUndo: S.undo.length > 0, canRedo: S.redo.length > 0, relocated: true });
    // Only presence flags moved (content rendered late, a panel toggled):
    // the window redraws its list but must not store this.
    else if (shown) post("changes", { list: list(), canUndo: S.undo.length > 0, canRedo: S.redo.length > 0, view: true });
    draw();
  }

  let lastMutation = 0;
  let initAt = 0;
  function settleCheck() {
    if (S.settled || !S.active || S.away) return;
    const t = Date.now();
    if (t - lastMutation >= SETTLE_QUIET_MS || t - initAt >= SETTLE_MAX_MS) {
      S.settled = true;
      reapplyAll();
    } else {
      setTimeout(settleCheck, 150);
    }
  }

  // ---------------------------------------------------------------- the change list

  const hasText = (c) => c.text_to !== undefined && c.text_to !== null;
  const isEmpty = (c) => !c.dx && !c.dy && (c.w === undefined || c.w === null) && (c.h === undefined || c.h === null) && !c.hidden && !hasText(c);

  function changeFor(el) {
    const key = keyFor(el);
    let c = S.changes.get(key);
    if (c) return c;
    if (S.changes.size >= LIMITS.changes || !isKey(key)) {
      toast("limit");
      return null;
    }
    const d = describe(el);
    const r = el.getBoundingClientRect();
    const ids = new Set([...S.changes.values()].map((x) => x.id));
    let id = newChangeId();
    while (ids.has(id)) id = newChangeId();
    c = {
      id,
      key: d.key,
      loc: d.loc,
      occ: d.occ,
      tag: tagOf(el),
      text: pageTextOf(el),
      dx: 0,
      dy: 0,
      w: null,
      h: null,
      hidden: false,
      base: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hint: hintOf(el),
    };
    const u = usedInOf(el);
    if (u) c.used_in = u;
    if (d.part && PATH_RE.test(d.path)) {
      c.part = true;
      c.path = d.path;
    }
    if (d.piece) c.piece = true;
    markShape(el, c);
    stampCode(c);
    S.changes.set(key, c);
    appliedKey.set(el, key);
    return c;
  }

  // Recorded when an edit ends: the time, the layout context, and the
  // fingerprints of the code the edit was made against.
  function touch(el, c) {
    c.at = now();
    const ctx = contextOf(el, c);
    if (ctx) c.ctx = ctx;
    stampCode(c, true);
  }

  function list() {
    const out = [];
    for (const c of S.changes.values()) {
      if (isEmpty(c)) continue;
      const x = coerceChange({ ...c, at: c.at || now(), missing: c.missing ? true : undefined });
      if (x) out.push(x);
    }
    return out;
  }
  const snapshot = () => JSON.stringify(list());
  function loadSnapshot(json) {
    let arr;
    try {
      arr = JSON.parse(json);
    } catch {
      arr = [];
    }
    S.changes = new Map((Array.isArray(arr) ? arr : []).map((c) => [c.key, c]));
    reapplyAll();
  }
  // One undo step; the oldest is dropped past the cap.
  function pushUndo(snap = snapshot()) {
    S.undo.push(snap);
    while (S.undo.length > UNDO_MAX) S.undo.shift();
    S.redo = [];
  }

  function commit() {
    if (!S.active || S.away || S.view === "before") return;
    for (const [k, c] of S.changes) if (isEmpty(c)) S.changes.delete(k);
    post("changes", { list: list(), canUndo: S.undo.length > 0, canRedo: S.redo.length > 0 });
    sendSelection();
  }

  // ---------------------------------------------------------------- drawing

  let hoverEl = null;

  function draw() {
    if (!host) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (editing) placeEditor();
    const design = S.active && S.mode === "design";
    if (design && hoverEl && hoverEl !== S.sel && hoverEl.isConnected) place(hoverBox, hoverEl.getBoundingClientRect());
    else hide(hoverBox);
    if (S.sel && !S.sel.isConnected) {
      S.sel = S.selKey ? findEl(S.selKey) : null;
      if (S.sel) S.selText = labelOf(S.sel);
    }
    S.extra = S.extra.filter((x) => x.isConnected && x !== S.sel);
    extraBoxes.forEach((b, i) => {
      if (!(design && S.extra[i])) hide(b);
    });
    if (!design || !S.sel) {
      hide(selBox);
      hide(label);
      handles.forEach(hide);
      return;
    }
    S.extra.forEach((x, i) => place(extraBox(i), x.getBoundingClientRect()));
    const r = S.sel.getBoundingClientRect();
    place(selBox, r);
    label.textContent = S.extra.length
      ? `${S.extra.length + 1} selected, drag one to move them together`
      : `${S.selText} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    const k = 1 / (S.scale || 1);
    label.style.display = "block";
    label.style.left = `${Math.max(2, r.left)}px`;
    label.style.top = `${r.top > 22 * k ? r.top - 20 * k : r.bottom + 4 * k}px`;
    const pts = {
      n: [r.left + r.width / 2, r.top], s: [r.left + r.width / 2, r.bottom],
      e: [r.right, r.top + r.height / 2], w: [r.left, r.top + r.height / 2],
      ne: [r.right, r.top], nw: [r.left, r.top], se: [r.right, r.bottom], sw: [r.left, r.bottom],
    };
    for (const h of handles) {
      if (S.extra.length) {
        hide(h);
        continue;
      }
      const [x, y] = pts[h.dataset.dir];
      h.style.display = "block";
      h.style.left = `${x}px`;
      h.style.top = `${y}px`;
    }
  }

  function labelOf(el) {
    const d = describe(el);
    const m = splitLoc(d.loc);
    const where = m ? ` · ${d.part ? "inside " : ""}${m.file.split("/").pop()}:${m.line}` : "";
    return `${tagOf(el)}${where}`;
  }

  function sendSelection() {
    if (!S.active) return;
    if (!S.sel || !S.sel.isConnected) {
      post("selection", { info: null });
      return;
    }
    const el = S.sel;
    const key = keyFor(el);
    if (!isKey(key)) {
      post("selection", { info: null });
      toast("limit");
      return;
    }
    const r = el.getBoundingClientRect();
    const d = describe(el);
    const crumbs = [];
    for (let p = parentOf(el); p && crumbs.length < MAX_CRUMBS; p = parentOf(p)) {
      const k = keyOf(p);
      if (!isKey(k)) break;
      crumbs.push({ key: k, tag: tagOf(p), text: textOf(p).slice(0, 30), loc: describe(p).loc });
    }
    const c = S.changes.get(key);
    post("selection", {
      info: {
        count: Math.min(LIMITS.changes, 1 + S.extra.length),
        key,
        loc: d.loc,
        used_in: usedInOf(el),
        tag: tagOf(el),
        path: PATH_RE.test(d.path) ? d.path : "",
        text: textOf(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        part: !!d.part,
        piece: !!d.piece,
        change: c && !isEmpty(c) ? coerceChange({ ...c, at: c.at || now() }) : null,
        crumbs,
      },
    });
  }

  function select(el) {
    S.sel = el || null;
    S.selKey = el ? keyOf(el) : null;
    S.selText = el ? labelOf(el) : "";
    S.extra = [];
    draw();
    sendSelection();
  }
  const selected = () => (S.sel ? [S.sel, ...S.extra] : []).filter((x) => x && x.isConnected);

  // Multi-select: el joins the group, or leaves it if it was already in.
  // Nested picks are ignored, since moving a parent already moves its child.
  function toggle(el) {
    if (!S.sel) {
      select(el);
      return;
    }
    if (el === S.sel) {
      const next = S.extra.shift() || null;
      S.sel = next;
      S.selKey = next ? keyOf(next) : null;
      S.selText = next ? labelOf(next) : "";
    } else if (S.extra.includes(el)) {
      S.extra = S.extra.filter((x) => x !== el);
    } else if (!S.sel.contains(el) && !el.contains(S.sel) && !S.extra.some((x) => x.contains(el) || el.contains(x))) {
      S.extra.push(el);
    }
    draw();
    sendSelection();
  }

  // ---------------------------------------------------------------- the text editor

  let editing = null;

  // A whole-element edit replaces every text node inside the element, so a
  // container that holds a private field or an editable region is refused
  // outright; its ordinary children can still be edited one by one.
  const SENSITIVE_INSIDE = `${PRIVATE_SEL}, [contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]`;

  function canEditText(el) {
    if (isPrivate(el) || NO_EDIT_TAGS.has(el.localName)) return false;
    if (el.localName === "input" || el.localName === "textarea") return isBox(el);
    try {
      if (el.closest(NO_TEXT_SEL) || el.querySelector(SENSITIVE_INSIDE)) return false;
    } catch {
      return false;
    }
    return textNodesOf(el).length > 0 || el.children.length === 0;
  }

  // Word spans inside el (from a double-click split). A whole-element edit
  // replaces the text they hold, so they are merged back first; if one of
  // them carries its own change the edit is refused instead.
  function unsplitInside(el) {
    const parents = new Set();
    for (const sp of el.querySelectorAll(`[${PIECE}]`)) if (sp.parentElement) parents.add(sp.parentElement);
    for (const p of parents) {
      const byIndex = pieces.get(p);
      if (!byIndex) continue;
      for (const { spans } of byIndex.values()) {
        if (spans.some((sp) => S.changes.has(keyFor(sp)) && !isEmpty(S.changes.get(keyFor(sp))))) return false;
      }
    }
    for (const p of parents) {
      const byIndex = pieces.get(p);
      if (!byIndex) continue;
      for (const { tn, spans } of byIndex.values()) {
        if (tn.parentNode === p) tn.nodeValue = spans.map((sp) => sp.textContent).join("");
        for (const sp of spans) sp.remove();
      }
      pieces.delete(p);
    }
    return true;
  }

  function placeEditor() {
    if (!editing || !editing.el.isConnected) return;
    const k = 1 / (S.scale || 1);
    const r = editing.el.getBoundingClientRect();
    const w = Math.max(240 * k, Math.min(480 * k, r.width));
    editor.style.display = "block";
    editor.style.width = `${w}px`;
    editor.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`;
    editor.style.top = `${r.bottom + 6 + 130 * k < innerHeight ? r.bottom + 6 : Math.max(4, r.top - 136 * k)}px`;
  }

  function openEditor() {
    if (!S.sel) {
      toast("nothing-selected");
      return;
    }
    let el = S.sel;
    if (!canEditText(el)) {
      toast("no-text");
      return;
    }
    if (!unsplitInside(el)) {
      toast("split-held");
      return;
    }
    if (!el.isConnected) {
      el = S.selKey ? findEl(S.selKey) : null;
      if (!el) return;
      select(el);
    }
    const c = S.changes.get(keyFor(el));
    editing = { el, from: originalText(el) };
    ta.value = c && hasText(c) ? c.text_to : currentText(el);
    placeEditor();
    ta.focus();
    ta.select();
  }
  function closeEditor() {
    editing = null;
    hide(editor);
  }
  function saveEditor() {
    if (!editing) return;
    const { el, from } = editing;
    const to = String(ta.value).slice(0, LIMITS.textTo);
    closeEditor();
    if (!el.isConnected || S.view === "before" || S.away) return;
    pushUndo();
    const c = changeFor(el);
    if (!c) return;
    if (to === from) {
      delete c.text_to;
      delete c.text_from;
    } else {
      if (captureText) c.text_from = from.slice(0, LIMITS.textFrom);
      else delete c.text_from;
      c.text_to = to;
    }
    markShape(el, c);
    touch(el, c);
    applyTo(el, c);
    applyText(el, c);
    draw();
    commit();
  }

  // ---------------------------------------------------------------- input

  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const designing = () => S.active && S.mode === "design" && S.view !== "before" && !S.away;

  for (const type of ["click", "dblclick", "mousedown", "mouseup", "auxclick", "contextmenu", "submit", "dragstart", "touchstart", "focusin"]) {
    window.addEventListener(type, (e) => {
      if (!designing() || e.target === host) return;
      if (type === "focusin") {
        const t = e.target;
        if (t && t.nodeType === 1 && t !== document.body && typeof t.blur === "function") t.blur();
      }
      swallow(e);
      if (type === "dblclick") {
        const piece = splitAt(e.clientX, e.clientY);
        if (piece === "held") toast("split-edited");
        else if (piece) select(piece);
        else toast("split-failed");
      }
    }, { capture: true, passive: false });
  }

  const snapOfChange = (c) => (c ? { dx: c.dx || 0, dy: c.dy || 0 } : { dx: 0, dy: 0 });

  window.addEventListener("pointerdown", (e) => {
    if (!designing() || e.button !== 0 || e.target === host) return;
    if (editing) saveEditor();
    swallow(e);
    // Cancelling the press also cancels the focus move it would cause, so a
    // toolbar control in the designer window would keep the keyboard (and
    // Return would press it again). Take the focus into this frame instead.
    try {
      window.focus();
    } catch {
      // focus is best effort
    }
    const el = pick(e.target);
    if (!el) {
      select(null);
      return;
    }
    let clickPick = null;
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggle(el);
    else if (e.altKey) {
      // Each Option/Alt-click climbs one level from the current selection;
      // at the outermost selectable element it stays there.
      const climbing = S.sel && (S.sel === el || S.sel.contains(el));
      select(climbing ? parentOf(S.sel) || S.sel : parentOf(el) || el);
    } else {
      // A press inside the current selection does not reselect yet, so the
      // whole selection can be dragged. A press that ends without any drag
      // then picks the innermost element that was hit.
      const holder = selected().find((x) => x === el || x.contains(el));
      if (holder) clickPick = el;
      else select(el);
    }
    if (!S.sel) return;
    const items = selected().map((x) => ({ el: x, c0: snapOfChange(S.changes.get(keyFor(x))) }));
    if (!items.length) return;
    S.op = { kind: "move", items, r0: S.sel.getBoundingClientRect(), x: e.clientX, y: e.clientY, snap: snapshot(), moved: false, clickPick };
  }, true);

  // The smallest outer size an element can be drawn at: its padding and
  // borders (with border-box sizing a smaller width still renders this wide).
  function minBox(el) {
    const cs = getComputedStyle(el);
    const n = (v) => parseFloat(v) || 0;
    return {
      w: Math.ceil(n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth)),
      h: Math.ceil(n(cs.paddingTop) + n(cs.paddingBottom) + n(cs.borderTopWidth) + n(cs.borderBottomWidth)),
    };
  }

  function startResize(e, h) {
    if (!designing() || e.button !== 0 || !S.sel || S.extra.length) return;
    e.preventDefault();
    e.stopPropagation();
    const snap = snapshot();
    const c = changeFor(S.sel);
    if (!c) return;
    S.op = { kind: "resize", dir: h.dataset.dir, el: S.sel, x: e.clientX, y: e.clientY, r: S.sel.getBoundingClientRect(), min: minBox(S.sel), c0: { ...c }, snap, moved: false };
    try {
      h.setPointerCapture(e.pointerId);
    } catch {
      // capture is a convenience only
    }
  }

  window.addEventListener("pointermove", (e) => {
    if (!designing()) return;
    if (!S.op) {
      const el = pick(document.elementFromPoint(e.clientX, e.clientY));
      if (el !== hoverEl) {
        hoverEl = el;
        draw();
      }
      return;
    }
    let ddx = e.clientX - S.op.x;
    let ddy = e.clientY - S.op.y;
    if (!S.op.moved && Math.abs(ddx) < DRAG_START_PX && Math.abs(ddy) < DRAG_START_PX) return;
    if (!S.op.moved) {
      S.op.moved = true;
      pushUndo(S.op.snap);
    }
    if (S.op.kind === "move") {
      if (e.shiftKey) {
        if (Math.abs(ddx) > Math.abs(ddy)) ddy = 0;
        else ddx = 0;
      }
      // With Snap the dragged element (the main selection) lands with its
      // top-left corner on a grid line; every other selected element gets
      // the same offset, so the group keeps its shape.
      if (snapOn()) {
        const r0 = S.op.r0;
        ddx = snapTo(r0.left + ddx) - Math.round(r0.left);
        ddy = snapTo(r0.top + ddy) - Math.round(r0.top);
      }
      for (const it of S.op.items) {
        const c = changeFor(it.el);
        if (!c) continue;
        c.dx = clampMove(Math.round(it.c0.dx + ddx));
        c.dy = clampMove(Math.round(it.c0.dy + ddy));
        applyTo(it.el, c);
      }
    } else {
      const { dir, r, c0, el, min } = S.op;
      const c = changeFor(el);
      if (!c) return;
      const left = Math.round(r.left);
      const top = Math.round(r.top);
      const width = Math.round(r.width);
      const height = Math.round(r.height);
      if (snapOn()) {
        if (dir.includes("e")) ddx = snapTo(left + width + ddx) - (left + width);
        if (dir.includes("w")) ddx = snapTo(left + ddx) - left;
        if (dir.includes("s")) ddy = snapTo(top + height + ddy) - (top + height);
        if (dir.includes("n")) ddy = snapTo(top + ddy) - top;
      }
      // The size never goes below what the element can actually be drawn at,
      // so the recorded number matches the box on screen. A west or north
      // grip moves the element by however much the size really changed, which
      // keeps the opposite edge where it was.
      const floorW = Math.max(LIMITS.sizeMin, min.w);
      const floorH = Math.max(LIMITS.sizeMin, min.h);
      if (dir.includes("e") || dir.includes("w")) {
        const w = clampSize(Math.max(floorW, Math.round(dir.includes("e") ? width + ddx : width - ddx)));
        c.w = w;
        c.dx = clampMove(Math.round((c0.dx || 0) + (dir.includes("w") ? width - w : 0)));
      }
      if (dir.includes("n") || dir.includes("s")) {
        const h = clampSize(Math.max(floorH, Math.round(dir.includes("s") ? height + ddy : height - ddy)));
        c.h = h;
        c.dy = clampMove(Math.round((c0.dy || 0) + (dir.includes("n") ? height - h : 0)));
      }
      applyTo(el, c);
    }
    draw();
  }, true);

  window.addEventListener("pointerup", () => {
    if (!S.op) return;
    const op = S.op;
    S.op = null;
    if (op.moved) {
      const els = op.kind === "move" ? op.items.map((it) => it.el) : [op.el];
      for (const el of els) {
        const c = S.changes.get(keyFor(el));
        if (c) touch(el, c);
      }
      for (const el of els) if (el.isConnected && (S.changes.get(keyFor(el)) || {}).dx) unclipFor(el);
      commit();
      draw();
    } else if (op.clickPick && !(op.clickPick === S.sel && !S.extra.length)) {
      select(op.clickPick);
    } else {
      if (op.kind === "resize") for (const [k, c] of S.changes) if (isEmpty(c)) S.changes.delete(k);
      sendSelection();
    }
  }, true);

  window.addEventListener("pointercancel", () => {
    if (!S.op) return;
    const op = S.op;
    S.op = null;
    if (op.moved) {
      S.undo.pop();
      loadSnapshot(op.snap);
    }
  }, true);

  // Design-mode keys. Returns true when the key was used.
  function onKey(e, forwarded) {
    if (!designing() || editing) return false;
    if (!forwarded && e.target === host) return false;
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (k === "z" || k === "Z")) {
      if (e.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod && (k === "y" || k === "Y")) {
      redo();
      return true;
    }
    if (mod && (k === "s" || k === "S")) {
      post("save-now");
      return true;
    }
    if (mod) return false;
    if (k === "Escape") {
      select(null);
      return true;
    }
    const arrow = ARROWS[k];
    const acts = arrow || ["Delete", "Backspace", "p", "P", "r", "R", "e", "E", "Enter"].includes(k);
    if (!acts) return false;
    if (!S.sel) {
      if (forwarded) toast("nothing-selected");
      return forwarded;
    }
    if (arrow) {
      nudge(arrow, e.shiftKey);
      return true;
    }
    if (k === "Delete" || k === "Backspace") {
      pushUndo();
      for (const x of selected()) {
        const c = changeFor(x);
        if (!c) continue;
        c.hidden = true;
        touch(x, c);
        applyTo(x, c);
      }
      select(null);
      commit();
      return true;
    }
    if (k === "p" || k === "P") {
      const p = parentOf(S.sel);
      if (p) select(p);
      return true;
    }
    if (k === "r" || k === "R") {
      resetKeys(selected().map(keyFor));
      return true;
    }
    openEditor();
    return true;
  }

  function nudge(arrow, big) {
    const items = selected();
    if (!items.length) return;
    let ddx;
    let ddy;
    if (snapOn()) {
      const r = S.sel.getBoundingClientRect();
      ddx = arrow[0] ? nextLine(r.left, arrow[0]) - Math.round(r.left) : 0;
      ddy = arrow[1] ? nextLine(r.top, arrow[1]) - Math.round(r.top) : 0;
    } else {
      const step = big ? 10 : 1;
      ddx = arrow[0] * step;
      ddy = arrow[1] * step;
    }
    // Quick repeats are one undo step.
    if (Date.now() - S.lastNudge > NUDGE_MERGE_MS) pushUndo();
    S.lastNudge = Date.now();
    for (const x of items) {
      const c = changeFor(x);
      if (!c) continue;
      c.dx = clampMove(Math.round((c.dx || 0) + ddx));
      c.dy = clampMove(Math.round((c.dy || 0) + ddy));
      applyTo(x, c);
      touch(x, c);
      if (c.dx || c.dy) unclipFor(x);
    }
    draw();
    commit();
  }

  window.addEventListener("keydown", (e) => {
    if (onKey(e, false)) swallow(e);
  }, true);

  // Keys that belong to the designer window rather than to editing, so they
  // work in Design and in Use mode alike (focus is often inside the page in
  // Use mode): B, the backslash, D, G and Cmd/Ctrl+S. They are left to the page while
  // the user types into one of its fields or into the text editor.
  const WINDOW_KEYS = { b: "view-toggle", "\\": "drawer-toggle", d: "mode-request", g: "grid-toggle" };
  window.addEventListener("keydown", (e) => {
    if (!S.active || editing || e.target === host || e.altKey || e.isComposing) return;
    const t = e.target;
    if (t && t.nodeType === 1 && (/^(input|select|textarea)$/.test(t.localName) || t.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      if ((e.key === "s" || e.key === "S") && !e.shiftKey) {
        swallow(e);
        post("save-now");
      }
      return;
    }
    const type = WINDOW_KEYS[String(e.key).toLowerCase()];
    if (!type) return;
    swallow(e);
    if (type === "mode-request") post(type, { mode: S.mode === "design" ? "use" : "design" });
    else post(type);
  }, true);

  window.addEventListener("scroll", () => {
    if (S.active) draw();
  }, { capture: true, passive: true });
  window.addEventListener("resize", () => {
    if (S.active) draw();
  });

  // ---------------------------------------------------------------- edits from the designer window

  function undo() {
    if (!S.undo.length) {
      toast("undo-empty");
      return;
    }
    S.redo.push(snapshot());
    loadSnapshot(S.undo.pop());
    commit();
  }
  function redo() {
    if (!S.redo.length) {
      toast("redo-empty");
      return;
    }
    S.undo.push(snapshot());
    while (S.undo.length > UNDO_MAX) S.undo.shift();
    loadSnapshot(S.redo.pop());
    commit();
  }
  function resetKeys(keys) {
    const ks = keys.filter((k) => S.changes.has(k));
    if (!ks.length) return;
    pushUndo();
    for (const k of ks) {
      const el = elOfKey(k);
      S.changes.delete(k);
      if (el) {
        applyTo(el, null);
        applyText(el, null);
        appliedKey.delete(el);
      }
    }
    reapplyAll();
    commit();
  }
  function resetAll() {
    if (!S.changes.size) return;
    pushUndo();
    S.changes.clear();
    takeOffAll();
    commit();
    draw();
  }
  function show(key) {
    const c = S.changes.get(key);
    if (!c || !c.hidden) return;
    pushUndo();
    c.hidden = false;
    c.at = now();
    reapplyAll();
    commit();
  }
  // Put a change whose element is gone onto the element now selected.
  function reattach(key) {
    const c = S.changes.get(key);
    const el = S.sel;
    if (!c) return;
    if (!el) {
      toast("nothing-selected");
      return;
    }
    const k = keyOf(el);
    const holder = S.changes.get(k);
    if (holder && holder !== c && holder.missing) {
      toast("reattach-held");
      return;
    }
    if (!isKey(k)) {
      toast("limit");
      return;
    }
    pushUndo();
    const d = describe(el);
    S.changes.delete(key);
    S.changes.delete(k);
    S.changes.delete(keyFor(el));
    if (!c.was_loc) c.was_loc = c.loc || "";
    Object.assign(c, { key: k, loc: d.loc, occ: d.occ, tag: tagOf(el), text: pageTextOf(el), hint: hintOf(el) });
    if (d.part && PATH_RE.test(d.path)) {
      c.part = true;
      c.path = d.path;
    } else {
      delete c.part;
      delete c.path;
    }
    if (d.piece) c.piece = true;
    else delete c.piece;
    const u = usedInOf(el);
    if (u) c.used_in = u;
    else delete c.used_in;
    delete c.missing;
    stampCode(c, true);
    S.changes.set(k, c);
    reapplyAll();
    commit();
  }

  function setMode(m) {
    S.mode = m === "design" && S.active && !S.away && S.view !== "before" ? "design" : "use";
    document.documentElement.classList.toggle(DESIGN_CLASS, S.mode === "design");
    if (S.mode !== "design") {
      hoverEl = null;
      if (editing) closeEditor();
      S.op = null;
    }
    drawGrid();
    draw();
  }

  function setView(v) {
    if (v === "before" && S.view !== "before") {
      // The designer window asks for a flush first, so an open editor here
      // was opened after that; it is closed without saving.
      if (editing) closeEditor();
      S.view = "before";
      S.op = null;
      hoverEl = null;
      select(null);
      takeOffAll();
      setMode("use");
    } else if (v === "after" && S.view === "before") {
      S.view = "after";
      reapplyAll();
      draw();
    }
  }

  function applyTheme(theme) {
    if (!themeCfg) return;
    let el;
    try {
      el = document.querySelector(themeCfg.selector || "html");
    } catch {
      return;
    }
    if (!el) return;
    if (themeCfg.darkClass) el.classList.toggle(themeCfg.darkClass, theme === "dark");
    else if (themeCfg.attribute) el.setAttribute(themeCfg.attribute, theme === "dark" ? themeCfg.dark : themeCfg.light);
  }

  function onCode(code) {
    for (const f of Object.keys(code)) S.code[f] = code[f];
    if (S.view === "before" || S.away) return;
    let changed = false;
    for (const c of S.changes.values()) {
      if ((!c.src && fileOf(c.loc) in S.code) || (isLibChange(c) && !c.src_used && fileOf(c.used_in) in S.code)) {
        if (stampCode(c)) changed = true;
      }
    }
    if (changed) post("changes", { list: list(), canUndo: S.undo.length > 0, canRedo: S.redo.length > 0 });
  }

  const identityNow = () => pageIdentity(location.pathname, location.search, S.page.keep);
  let lastIdentity = "";

  function onInit(m) {
    if (S.active) takeOffAll();
    S.page = m.page;
    S.code = Object.create(null);
    for (const f of Object.keys(m.code)) S.code[f] = m.code[f];
    askedCode.clear();
    S.grid = { ...m.grid };
    S.scale = m.scale;
    S.changes = new Map();
    for (const c of m.list) {
      const x = { ...c };
      delete x.missing;
      S.changes.set(x.key, x);
    }
    S.undo = [];
    S.redo = [];
    S.sel = null;
    S.selKey = null;
    S.extra = [];
    S.op = null;
    S.away = false;
    S.view = m.view;
    S.active = true;
    S.settled = false;
    initAt = Date.now();
    lastMutation = initAt;
    S.baseline = identityNow();
    lastIdentity = S.baseline;
    buildLayer();
    applyScale();
    applyTheme(m.theme);
    setMode(m.mode);
    if (S.view === "after") reapplyAll();
    else draw();
    post("changes", { list: list(), canUndo: false, canRedo: false, init: true });
    startObserving();
    setTimeout(settleCheck, 150);
  }

  function handle(m) {
    if (m.type === "init") {
      onInit(m);
      return;
    }
    if (!S.active) return;
    if (m.type === "view") {
      setView(m.view);
      return;
    }
    if (m.type === "flush") {
      if (editing && S.view !== "before" && !S.away) saveEditor();
      post("flushed");
      return;
    }
    // Before / After and a page that was left: nothing is edited.
    if (S.view === "before" || S.away) {
      if (!BEFORE_TYPES.includes(m.type)) return;
      if (m.type === "mode" && m.mode !== "use") return;
    }
    switch (m.type) {
      case "scale":
        S.scale = m.scale;
        applyScale();
        drawGrid();
        draw();
        break;
      case "mode":
        setMode(m.mode);
        break;
      case "grid":
        S.grid = { ...m.grid };
        drawGrid();
        draw();
        break;
      case "theme":
        applyTheme(m.theme);
        draw();
        break;
      case "code":
        onCode(m.code);
        break;
      case "undo":
        undo();
        break;
      case "redo":
        redo();
        break;
      case "reset":
        if (m.key) resetKeys([m.key]);
        else resetAll();
        break;
      case "show":
        show(m.key);
        break;
      case "reattach":
        reattach(m.key);
        break;
      case "select": {
        const el = m.real ? findEl(m.key) : elOfKey(m.key);
        if (!el || !isPage(el)) {
          toast("not-on-page");
          break;
        }
        select(el);
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch {
          // older browsers: no options
        }
        break;
      }
      case "key":
        onKey({
          key: m.init.key, shiftKey: m.init.shift, altKey: m.init.alt, metaKey: m.init.meta, ctrlKey: m.init.ctrl, target: null,
        }, true);
        break;
      case "edit":
        if (S.mode === "design") openEditor();
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== shellOrigin) return;
    const m = validateShellMsg(e.data, { ns, nonce });
    if (m) handle(m);
  });

  // ---------------------------------------------------------------- page changes

  // Re-render detection: when the page replaces or edits nodes, every change
  // is resolved and drawn again shortly after. setTimeout is used because
  // requestAnimationFrame stops firing while the tab is hidden.
  let queued = false;
  let observing = false;
  const observer = new MutationObserver(() => {
    lastMutation = Date.now();
    if (queued || !S.active || S.away || S.view === "before") return;
    queued = true;
    setTimeout(() => {
      queued = false;
      if (S.active && !S.away && S.view !== "before") reapplyAll();
    }, MUTATION_DELAY_MS);
  });
  function startObserving() {
    if (observing) return;
    observing = true;
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  // The app changed its route without a page load (history API, hash). The
  // changes belong to the page the designer opened, so they are taken off,
  // editing stops, and the designer window gets the new address.
  function leave(path) {
    if (editing) closeEditor();
    S.away = true;
    S.op = null;
    hoverEl = null;
    select(null);
    takeOffAll();
    setMode("use");
    post("navigate", { path: String(path || "").slice(0, 2000), to: null });
  }

  function checkRoute() {
    if (!S.active) return;
    const id = identityNow();
    if (id === lastIdentity) return;
    lastIdentity = id;
    const path = location.pathname + location.search;
    if (!S.away) {
      if (id !== S.baseline) leave(path);
    } else {
      post("navigate", { path: path.slice(0, 2000), to: null });
    }
  }
  for (const name of ["pushState", "replaceState"]) {
    const orig = history[name];
    if (typeof orig !== "function") continue;
    history[name] = function wrappedHistory(...args) {
      const r = orig.apply(this, args);
      queueMicrotask(checkRoute);
      return r;
    };
  }
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigatesuccess", checkRoute);
  }

  if (opts.debug === true) {
    Object.defineProperty(window, "__dftp", {
      value: Object.freeze({ S, reapplyAll, findEl, keyOf, list, editorRect: () => (editing ? editor.getBoundingClientRect().toJSON() : null) }),
      configurable: true,
    });
  }

  post("ready", { path: (location.pathname + location.search).slice(0, 2000) });
  return { navigated: leave };
}
