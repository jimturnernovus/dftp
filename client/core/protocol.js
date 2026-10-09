// Messages between the designer window (the shell) and the layer running
// inside the framed page. Every message is a plain object:
//
//   { [ns]: 1, n: <nonce>, type: "<type>", ...fields }
//
// `ns` is the namespace field (here "dftp"), `n` the per-load nonce the shell
// hands the frame through the iframe's name. Receivers must also check
// event.origin and event.source before calling the validators below; the
// validators check shape only and return a fresh object holding nothing but
// known fields, or null.
//
// Browser and Node.

import {
  isKey, isLoc, isFilePath, isSha, isTheme, isId, validateChange, validateList, stripControls, LIMITS,
  INSERT_ELEMENTS, checkInsertStyles, isComponentName, checkObjectRef,
} from "./schema.js";
import { validateSample } from "./tokens.js";

export const NONCE_RE = /^[0-9a-f]{32}$/;

// Layer -> shell.
export const FRAME_TYPES = Object.freeze([
  "hello", // a layer with no nonce (the page loaded again by itself), with its path; the shell reopens the page
  "ready",
  "changes", // the list; init: the first after "init"; relocated: keys were renamed; view: only which changes are found on the page differs (never saved)
  "selection",
  "navigate",
  "toast",
  "save-now",
  "mode-request",
  "grid-toggle",
  "view-toggle",
  "drawer-toggle",
  "need-code",
  "flushed", // answer to "flush": any open text edit has been committed
  "style-sample", // the page's computed styles, counted (after the page settles, and on "sample-styles")
]);

// Shell -> layer.
export const SHELL_TYPES = Object.freeze([
  "init",
  "scale",
  "mode",
  "view",
  "grid",
  "theme",
  "code",
  "undo",
  "redo",
  "reset",
  "show",
  "select",
  "reattach",
  "key",
  "edit",
  "flush", // commit an open text edit now (sent before Before, and before a reload)
  "sample-styles", // count the page's computed styles now; answered with "style-sample"
  "insert", // blank pages: add a new element (dropped at a point, or into the selected box)
  "insert-hint", // blank pages: show where a dragged element would land (at: null hides it)
  "reload-tokens", // blank pages: load the token style sheet again (the style scan changed)
]);

// While Before is shown the layer acts on these and nothing else
// (and on "mode" only when it asks for "use").
export const BEFORE_TYPES = Object.freeze(["view", "scale", "grid", "theme", "code", "mode", "reload-tokens"]);

// Keys the shell may forward to the layer.
export const KEY_ALLOW = Object.freeze([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Delete", "Backspace", "Escape", "Enter",
  "p", "P", "r", "R", "z", "Z", "y", "Y", "e", "E",
]);

// The layer reports problems as codes; the shell owns the wording.
export const TOAST_CODES = Object.freeze([
  "reattach-held",   // the element picked is already claimed by a change that is currently unresolved
  "nothing-selected",
  "no-text",         // the element has no editable text, or holds private or editable content
  "split-failed",    // no text node under the pointer to break into words
  "split-held",      // a word inside the element carries its own change, so the whole text cannot be replaced
  "split-edited",    // the text carries a text edit, so it cannot be broken into words
  "not-on-page",     // no element on the page matches that change at the moment
  "undo-empty",
  "redo-empty",
  "limit",           // the change list or the element's key is over a size limit
  "scaffold-fixed",  // the main container of a blank page is not moved, sized, hidden or re-worded
  "insert-attach",   // a change cannot move onto a new element, nor a new element's change elsewhere
]);

export const MODES = Object.freeze(["design", "use"]);
export const VIEWS = Object.freeze(["after", "before"]);
export const GRID_LIMITS = Object.freeze({ min: 2, max: 200 });
export const SCALE_LIMITS = Object.freeze({ min: 0.05, max: 8 });
const MAX_PATH = 2000;
const MAX_CRUMBS = 12;
const MAX_CODE = 400;

const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBool = (v) => typeof v === "boolean";
const optBool = (v) => (v === undefined ? false : v);
const finite = (v, lim) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim;

export function makeNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function windowName(ns, nonce) {
  return `${ns}:${nonce}`;
}

export function nonceFromName(ns, name) {
  const prefix = `${ns}:`;
  if (typeof name !== "string" || !name.startsWith(prefix)) return null;
  const n = name.slice(prefix.length);
  return NONCE_RE.test(n) ? n : null;
}

export function envelope(ns, nonce, type, fields = {}) {
  const m = { [ns]: 1, type };
  if (nonce) m.n = nonce;
  for (const k of Object.keys(fields)) if (k !== ns && k !== "n" && k !== "type") m[k] = fields[k];
  return m;
}

function header(data, ns, nonce, types, allowNoNonce) {
  if (!isObj(data) || own(data, ns) !== 1) return null;
  const type = own(data, "type");
  if (typeof type !== "string" || !types.includes(type)) return null;
  if (allowNoNonce && type === "hello") return type;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce) || own(data, "n") !== nonce) return null;
  return type;
}

function cleanPath(v) {
  if (typeof v !== "string") return null;
  const s = stripControls(v);
  return s.length <= MAX_PATH ? s : null;
}

function checkRect(r) {
  if (!isObj(r)) return null;
  const out = {};
  for (const k of ["x", "y", "w", "h"]) {
    const v = own(r, k);
    if (!finite(v, LIMITS.rect)) return null;
    out[k] = v;
  }
  return out;
}

function checkCode(map) {
  if (!isObj(map)) return null;
  const keys = Object.keys(map);
  if (keys.length > MAX_CODE) return null;
  const out = Object.create(null);
  for (const k of keys) {
    const v = map[k];
    if (!isFilePath(k) || !(v === null || isSha(v))) return null;
    out[k] = v;
  }
  return out;
}

function checkGrid(g) {
  if (!isObj(g)) return null;
  const on = own(g, "on");
  const size = own(g, "size");
  const snap = own(g, "snap");
  if (!isBool(on) || !isBool(snap)) return null;
  if (!Number.isInteger(size) || size < GRID_LIMITS.min || size > GRID_LIMITS.max) return null;
  return { on, size, snap };
}

function checkHintLoose(h) {
  // Selection hints are shown, never saved; the change carries the saved copy.
  const r = validateChange({ id: "aaaaaaaa", key: "k", hint: h });
  return r.ok ? r.value.hint : null;
}

function checkSelection(info) {
  if (info === null) return null;
  if (!isObj(info)) return undefined;
  const count = own(info, "count");
  const key = own(info, "key");
  const loc = own(info, "loc") ?? "";
  const usedIn = own(info, "used_in") ?? "";
  const tag = own(info, "tag");
  const path = own(info, "path") ?? "";
  const text = own(info, "text") ?? "";
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.changes) return undefined;
  if (!isKey(key) || !isLoc(loc) || !isLoc(usedIn)) return undefined;
  if (typeof tag !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(tag)) return undefined;
  if (typeof path !== "string" || !/^[0-9.~>]{0,200}$/.test(path)) return undefined;
  if (typeof text !== "string") return undefined;
  const cleanText = stripControls(text).slice(0, LIMITS.text);
  const rect = checkRect(own(info, "rect"));
  if (!rect) return undefined;
  for (const f of ["part", "piece"]) if (own(info, f) !== undefined && !isBool(own(info, f))) return undefined;
  let change = null;
  if (own(info, "change") !== undefined && own(info, "change") !== null) {
    const r = validateChange(own(info, "change"));
    if (!r.ok) return undefined;
    change = r.value;
  }
  const crumbsIn = own(info, "crumbs") ?? [];
  if (!Array.isArray(crumbsIn) || crumbsIn.length > MAX_CRUMBS) return undefined;
  const crumbs = [];
  for (const c of crumbsIn) {
    if (!isObj(c)) return undefined;
    const ck = own(c, "key");
    const ct = own(c, "tag");
    const cl = own(c, "loc") ?? "";
    const cx = own(c, "text") ?? "";
    if (!isKey(ck) || typeof ct !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(ct) || !isLoc(cl) || typeof cx !== "string") return undefined;
    crumbs.push({ key: ck, tag: ct, loc: cl, text: stripControls(cx).slice(0, 80) });
  }
  const out = {
    count, key, loc, used_in: usedIn, tag, path, text: cleanText, rect,
    part: optBool(own(info, "part")), piece: optBool(own(info, "piece")),
    change, crumbs,
  };
  if (own(info, "hint") !== undefined) {
    const h = checkHintLoose(own(info, "hint"));
    if (!h) return undefined;
    out.hint = h;
  }
  return out;
}

// ---------------------------------------------------------------- layer -> shell

export function validateFrameMsg(data, { ns, nonce }) {
  const type = header(data, ns, nonce, FRAME_TYPES, true);
  if (!type) return null;
  switch (type) {
    case "hello": {
      // The address helps the designer tell a reload from a move to
      // another page; it is optional.
      const p = own(data, "path");
      if (p === undefined) return { type };
      const path = cleanPath(p);
      return path === null ? null : { type, path };
    }
    case "save-now":
    case "grid-toggle":
    case "view-toggle":
    case "drawer-toggle":
    case "flushed":
      return { type };
    case "ready": {
      const p = own(data, "path");
      if (p === undefined) return { type, path: "" };
      const path = cleanPath(p);
      return path === null ? null : { type, path };
    }
    case "changes": {
      const r = validateList(own(data, "list"));
      if (!r.ok) return null;
      const out = { type, list: r.value };
      for (const f of ["canUndo", "canRedo", "init", "relocated", "view"]) {
        const v = own(data, f);
        if (v !== undefined && !isBool(v)) return null;
        out[f] = optBool(v);
      }
      return out;
    }
    case "selection": {
      const info = checkSelection(own(data, "info") ?? null);
      return info === undefined ? null : { type, info };
    }
    case "navigate": {
      const path = cleanPath(own(data, "path") ?? "");
      const toIn = own(data, "to");
      const to = toIn === undefined || toIn === null ? null : cleanPath(toIn);
      if (path === null || (toIn !== undefined && toIn !== null && to === null)) return null;
      return { type, path, to };
    }
    case "toast": {
      const code = own(data, "code");
      return TOAST_CODES.includes(code) ? { type, code } : null;
    }
    case "mode-request": {
      const mode = own(data, "mode");
      return MODES.includes(mode) ? { type, mode } : null;
    }
    case "need-code": {
      const files = own(data, "files");
      if (!Array.isArray(files) || files.length > LIMITS.files || !files.every(isFilePath)) return null;
      return { type, files: [...new Set(files)] };
    }
    case "style-sample": {
      // {elements, values: [{prop, value, count}], objects?}: the shape of
      // a live sample (tokens.js validateSample) without the page, device
      // and theme, which the designer window adds from its own state.
      const body = { page: "frame", device: "frame", elements: own(data, "elements"), values: own(data, "values") };
      if (own(data, "objects") !== undefined) body.objects = own(data, "objects");
      const r = validateSample(body);
      if (!r.ok) return null;
      const out = { type, elements: r.value.elements, values: r.value.values };
      if (r.value.objects) out.objects = r.value.objects;
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- shell -> layer

export function validateShellMsg(data, { ns, nonce }) {
  const type = header(data, ns, nonce, SHELL_TYPES, false);
  if (!type) return null;
  switch (type) {
    case "undo":
    case "redo":
    case "edit":
    case "flush":
      return { type };
    case "init": {
      const r = validateList(own(data, "list"));
      if (!r.ok) return null;
      const mode = own(data, "mode");
      const view = own(data, "view") ?? "after";
      const theme = own(data, "theme") ?? "light";
      const grid = checkGrid(own(data, "grid"));
      const code = checkCode(own(data, "code") ?? {});
      const scale = own(data, "scale") ?? 1;
      const page = own(data, "page");
      const device = own(data, "device");
      if (!MODES.includes(mode) || !VIEWS.includes(view) || !isTheme(theme) || !grid || !code) return null;
      if (!finite(scale, SCALE_LIMITS.max) || scale < SCALE_LIMITS.min) return null;
      if (!isObj(page) || !isId(own(page, "id"))) return null;
      const pagePath = cleanPath(own(page, "path"));
      const keep = own(page, "keep") ?? [];
      if (pagePath === null || !Array.isArray(keep) || keep.length > 20 || !keep.every((k) => typeof k === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(k))) return null;
      if (!isObj(device) || !isId(own(device, "id"))) return null;
      const dw = own(device, "width");
      const dh = own(device, "height");
      if (!Number.isInteger(dw) || !Number.isInteger(dh) || dw < 1 || dh < 1 || dw > 100000 || dh > 100000) return null;
      return {
        type, list: r.value, mode, view, theme, grid, code, scale,
        page: { id: page.id, path: pagePath, keep: keep.slice(), ...(own(page, "blank") === true ? { blank: true } : {}) },
        device: { id: device.id, width: dw, height: dh },
      };
    }
    case "scale": {
      const s = own(data, "scale");
      return finite(s, SCALE_LIMITS.max) && s >= SCALE_LIMITS.min ? { type, scale: s } : null;
    }
    case "mode": {
      const mode = own(data, "mode");
      return MODES.includes(mode) ? { type, mode } : null;
    }
    case "view": {
      const view = own(data, "view");
      return VIEWS.includes(view) ? { type, view } : null;
    }
    case "theme": {
      const theme = own(data, "theme");
      return isTheme(theme) ? { type, theme } : null;
    }
    case "grid": {
      const grid = checkGrid(own(data, "grid"));
      return grid ? { type, grid } : null;
    }
    case "code": {
      const code = checkCode(own(data, "code"));
      return code ? { type, code } : null;
    }
    case "reset": {
      const key = own(data, "key");
      if (key === undefined || key === null) return { type, key: null };
      return isKey(key) ? { type, key } : null;
    }
    case "show":
    case "reattach": {
      const key = own(data, "key");
      return isKey(key) ? { type, key } : null;
    }
    case "select": {
      const key = own(data, "key");
      const real = own(data, "real");
      if (!isKey(key) || (real !== undefined && !isBool(real))) return null;
      return { type, key, real: optBool(real) };
    }
    case "key": {
      const init = own(data, "init");
      if (!isObj(init)) return null;
      const key = own(init, "key");
      if (!KEY_ALLOW.includes(key)) return null;
      const out = { key };
      for (const f of ["shift", "alt", "meta", "ctrl"]) {
        const v = own(init, f);
        if (v !== undefined && !isBool(v)) return null;
        out[f] = optBool(v);
      }
      return { type, init: out };
    }
    case "sample-styles":
    case "reload-tokens":
      return { type };
    case "insert":
      return checkInsertMsg(data);
    case "insert-hint": {
      const at = own(data, "at");
      if (at === undefined || at === null) return { type, at: null };
      const p = checkPoint(at);
      return p ? { type, at: p } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- new elements (blank pages)

// A point in the frame's own CSS pixels.
function checkPoint(v) {
  if (!isObj(v)) return null;
  const x = own(v, "x");
  const y = own(v, "y");
  return finite(x, LIMITS.rect) && finite(y, LIMITS.rect) ? { x, y } : null;
}

// "insert": {element, styles: {property: token id}, component?, component_file?,
// object?: {kind, variant, source}, at?: {x, y}}. Without `at` the element
// goes into the selected box (or after the selected new element, or at the
// end of the page).
function checkInsertMsg(data) {
  const element = own(data, "element");
  if (!INSERT_ELEMENTS.includes(element)) return null;
  const st = checkInsertStyles(own(data, "styles") ?? {});
  if (st.error) return null;
  const out = { type: "insert", element, styles: st.value, at: null };
  const comp = own(data, "component");
  const file = own(data, "component_file");
  if (comp !== undefined) {
    if (!isComponentName(comp)) return null;
    out.component = comp;
    if (file !== undefined) {
      if (!isFilePath(file)) return null;
      out.component_file = file;
    }
  } else if (file !== undefined) return null;
  const obj = own(data, "object");
  if (obj !== undefined && obj !== null) {
    out.object = checkObjectRef(obj);
    if (!out.object) return null;
  }
  const at = own(data, "at");
  if (at !== undefined && at !== null) {
    out.at = checkPoint(at);
    if (!out.at) return null;
  }
  return out;
}
