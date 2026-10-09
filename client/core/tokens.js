// The normalised style-token document (.dftp/tokens.json) and the live
// sample the designer sends to be merged into it. Browser and Node: standard
// JavaScript only.
//
// The format is close to the Design Tokens Community Group format, so token
// files in that format map onto it directly:
//
//   { format: "dftp.tokens", version: 1, generated_at, root: ".",
//     tokens: [{ id, type, value, raw, modes, aliasOf, role, sources, usage, confidence, scoped? }],
//     scales: { spacing: [px...], fontSize: [px...], radius: [px...] },
//     breakpoints: [{ name, min, count? }],
//     components: [{ kind, file, export }],
//     diagnostics: [{ adapter, file?, line?, code }],
//     scan?: { files, skipped, adapters: {id: files}, truncated, ms, classes? },
//     live?: [ sample entries, see validateSample ] }
//
// validate* functions are strict and return {ok, value} with a fresh copy
// holding only known fields, or {ok:false, error}. They are used wherever
// this data crosses a boundary: the file on disk, an HTTP body, a message.

import { isFilePath, isId, isTheme, stripControls, isTokenRef, isComponentName } from "./schema.js";

export const TOKENS_FORMAT = "dftp.tokens";
export const TOKENS_VERSION = 1;

export const TOKEN_TYPES = Object.freeze([
  "color", "gradient", "dimension", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
  "radius", "shadow", "border", "opacity", "zIndex", "duration", "easing", "breakpoint",
]);
const TYPE_SET = new Set(TOKEN_TYPES);

export const ROLES = Object.freeze([
  "primary", "secondary", "accent", "surface", "background", "text", "muted", "border", "danger", "success", "warning",
]);
const ROLE_SET = new Set(ROLES);

// Shared building blocks a project may already have, by the file name of a
// component in one of its library folders.
export const COMPONENT_KINDS = Object.freeze([
  "button", "input", "textarea", "select", "checkbox", "radio", "switch", "label", "card", "badge", "avatar",
  "alert", "dialog", "tabs", "table", "divider", "heading", "text", "image", "link", "container", "grid",
  "tooltip", "popover", "sheet", "toast", "skeleton", "progress", "slider", "accordion", "breadcrumb",
  "pagination", "nav", "form", "icon",
]);
const KIND_SET = new Set(COMPONENT_KINDS);

// Why a file, or part of one, was left out. Codes only: a diagnostic never
// carries text from the file.
export const DIAG_CODES = Object.freeze([
  "parse-skip", "adapter-error", "too-large", "binary", "unreadable", "symlink-skip", "symlink-outside",
  "budget-files", "budget-time", "budget-bytes", "budget-entries", "value-too-long", "too-many-items",
  "too-many-tokens", "json-invalid", "json-too-deep", "alias-cycle", "alias-missing", "alias-depth",
  "redefined", "mode-only", "ignore-rules-capped", "value-invalid", "unsupported-color", "scoped-skip", "budget-build",
]);
const DIAG_SET = new Set(DIAG_CODES);

// Computed-style properties the live sample may report.
export const SAMPLE_PROPS = Object.freeze([
  "color", "background-color", "border-color", "border-width", "border-radius", "font-family", "font-size",
  "font-weight", "line-height", "letter-spacing", "padding", "margin", "gap", "box-shadow", "opacity",
]);
const SAMPLE_PROP_SET = new Set(SAMPLE_PROPS);

export const TOKEN_LIMITS = Object.freeze({
  tokens: 5000,
  sources: 20,
  raw: 300,
  name: 120,
  id: 160,
  modes: 8,
  diagnostics: 500,
  components: 200,
  breakpoints: 20,
  scale: 32,
  stops: 16,
  shadowLayers: 8,
  families: 10,
  family: 80,
  liveSamples: 12,
  sampleValues: 400,
  sampleValue: 200,
  sampleElements: 1500,
  sampleCount: 1000000,
  count: 100000000,
});

const ADAPTER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;
const BP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AT_RE = /^[0-9T:.+Z-]{0,40}$/;
const UNIT_RE = /^(?:|px|rem|em|%|vw|vh|vmin|vmax|dvh|dvw|svh|svw|lvh|lvw|ch|ex|cap|ic|lh|rlh|pt|pc|in|cm|mm|q|cqw|cqh|cqi|cqb|fr)$/;
const FAMILY_RE = /^[\p{L}\p{N} _.&+-]{1,80}$/u;
const STYLE_RE = /^(?:dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
// A gradient's direction, shape or position as css-values.js writes it.
const HEAD_RE = /^[a-z0-9.%+ -]{1,80}$/;
// Names and live values may hold any printable text except characters that
// could close a quote or start markup wherever they are shown later.
// eslint-disable-next-line no-control-regex
const NAME_BAD_RE = /[\u0000-\u001F\u007F-\u009F<>"'\\`]/;
// eslint-disable-next-line no-control-regex
const SAMPLE_BAD_RE = /[\u0000-\u001F\u007F-\u009F<>\\`{};]/;

const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const fail = (error) => ({ ok: false, error });

// Token ids follow the rule in schema.js, where new elements refer to them.
export const isTokenId = isTokenRef;

// The size of a normalised length in px: its px field (set wherever the
// size can be worked out), a px value, or a rem or em counted at 16 px, as
// the scan counts them. null for any other value.
export function pxOf(v) {
  if (!v || typeof v !== "object") return null;
  if (Number.isFinite(v.px)) return v.px;
  if (!Number.isFinite(v.value)) return null;
  if (v.unit === "px") return v.value;
  if (v.unit === "rem" || v.unit === "em") return v.value * 16;
  return null;
}

export function isAdapterId(s) {
  return typeof s === "string" && ADAPTER_RE.test(s);
}

// A mode name ("dark", "high-contrast" ...).
export function isModeName(s) {
  return typeof s === "string" && MODE_RE.test(s);
}

export function isRole(s) {
  return typeof s === "string" && ROLE_SET.has(s);
}

// A source or token name made safe to keep: control characters, quotes,
// angle brackets and backslashes removed, at most 120 characters. "" when
// nothing is left.
export function cleanName(s) {
  if (typeof s !== "string") return "";
  return stripControls(s).replace(/[<>"'\\`]/g, "").trim().slice(0, TOKEN_LIMITS.name);
}

// The raw value as written in the source, kept for display only: control
// characters removed, at most 300 characters.
export function cleanRaw(s) {
  if (typeof s !== "string") return "";
  const t = stripControls(s.replace(/\s+/g, " ")).trim();
  return t.length > TOKEN_LIMITS.raw ? `${t.slice(0, TOKEN_LIMITS.raw - 1)}…` : t;
}

// ---------------------------------------------------------------- values

function checkColor(v) {
  if (!isPlainObject(v)) return null;
  const hex = own(v, "hex");
  const alpha = own(v, "alpha");
  if (typeof hex !== "string" || !HEX_RE.test(hex) || !isNum(alpha, 0, 1)) return null;
  const out = { hex, alpha };
  if (has(v, "clipped")) {
    if (own(v, "clipped") !== true) return null;
    out.clipped = true;
  }
  return out;
}

function checkDim(v, { px = true } = {}) {
  if (!isPlainObject(v)) return null;
  const value = own(v, "value");
  const unit = own(v, "unit");
  if (!isNum(value, -1e6, 1e6) || typeof unit !== "string" || !UNIT_RE.test(unit)) return null;
  const out = { value, unit };
  if (px && has(v, "px")) {
    const p = own(v, "px");
    if (!isNum(p, -1e7, 1e7)) return null;
    out.px = p;
  }
  return out;
}

function checkShadow(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > TOKEN_LIMITS.shadowLayers) return null;
  const out = [];
  for (const l of v) {
    if (!isPlainObject(l)) return null;
    const layer = {};
    for (const k of ["x", "y", "blur", "spread"]) {
      const d = checkDim(own(l, k), { px: false });
      if (!d) return null;
      layer[k] = d;
    }
    const c = own(l, "color");
    if (c === null) layer.color = null;
    else {
      layer.color = checkColor(c);
      if (!layer.color) return null;
    }
    if (typeof own(l, "inset") !== "boolean") return null;
    layer.inset = own(l, "inset");
    out.push(layer);
  }
  return out;
}

// One normalised value of a token of `type`. Returns a fresh copy or null.
export function checkValue(type, v) {
  switch (type) {
    case "color": return checkColor(v);
    case "gradient": {
      if (!isPlainObject(v)) return null;
      const kind = own(v, "kind");
      const stops = own(v, "stops");
      if (!["linear", "radial", "conic"].includes(kind) || typeof own(v, "repeating") !== "boolean") return null;
      if (!Array.isArray(stops) || stops.length < 2 || stops.length > TOKEN_LIMITS.stops) return null;
      const out = [];
      for (const s of stops) {
        if (!isPlainObject(s)) return null;
        const color = checkColor(own(s, "color"));
        const at = own(s, "at");
        if (!color || !(at === null || isNum(at, -1e4, 1e4))) return null;
        out.push({ color, at });
      }
      const g = { kind, repeating: own(v, "repeating") };
      if (has(v, "head")) {
        const head = own(v, "head");
        if (typeof head !== "string" || !HEAD_RE.test(head) || head !== head.trim()) return null;
        g.head = head;
      }
      g.stops = out;
      return g;
    }
    case "fontFamily": {
      if (!isPlainObject(v)) return null;
      const f = own(v, "families");
      if (!Array.isArray(f) || f.length === 0 || f.length > TOKEN_LIMITS.families) return null;
      if (!f.every((n) => typeof n === "string" && FAMILY_RE.test(n))) return null;
      return { families: f.slice() };
    }
    case "fontWeight": {
      if (!isPlainObject(v) || !isNum(own(v, "value"), 1, 1000)) return null;
      return { value: own(v, "value") };
    }
    case "opacity": {
      if (!isPlainObject(v) || !isNum(own(v, "value"), 0, 1)) return null;
      return { value: own(v, "value") };
    }
    case "zIndex": {
      if (!isPlainObject(v) || !isInt(own(v, "value"), -2147483648, 2147483647)) return null;
      return { value: own(v, "value") };
    }
    case "duration": {
      if (!isPlainObject(v) || !isNum(own(v, "ms"), 0, 3.6e6)) return null;
      return { ms: own(v, "ms") };
    }
    case "easing": {
      if (!isPlainObject(v)) return null;
      const b = own(v, "bezier");
      if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => isNum(n, -1e3, 1e3))) return null;
      return { bezier: b.slice() };
    }
    case "shadow": return checkShadow(v);
    case "border": {
      if (!isPlainObject(v)) return null;
      const out = { width: null, style: null, color: null };
      const w = own(v, "width");
      if (w !== null) {
        out.width = checkDim(w);
        if (!out.width) return null;
      }
      const s = own(v, "style");
      if (s !== null) {
        if (typeof s !== "string" || !STYLE_RE.test(s)) return null;
        out.style = s;
      }
      const c = own(v, "color");
      if (c !== null) {
        out.color = checkColor(c);
        if (!out.color) return null;
      }
      return out;
    }
    case "dimension":
    case "fontSize":
    case "lineHeight":
    case "letterSpacing":
    case "radius":
    case "breakpoint":
      return checkDim(v);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- pieces

function checkSource(s) {
  if (!isPlainObject(s)) return null;
  const adapter = own(s, "adapter");
  if (!isAdapterId(adapter)) return null;
  const out = { adapter };
  if (has(s, "file")) {
    if (!isFilePath(own(s, "file"))) return null;
    out.file = own(s, "file");
  }
  if (has(s, "line")) {
    if (!isInt(own(s, "line"), 1, 10000000)) return null;
    out.line = own(s, "line");
  }
  if (has(s, "name")) {
    const n = own(s, "name");
    if (typeof n !== "string" || n.length === 0 || n.length > TOKEN_LIMITS.name || NAME_BAD_RE.test(n)) return null;
    out.name = n;
  }
  for (const k of ["page", "device"]) {
    if (!has(s, k)) continue;
    if (!isId(own(s, k))) return null;
    out[k] = own(s, k);
  }
  return out;
}

function checkToken(t) {
  if (!isPlainObject(t)) return fail("must be an object");
  const id = own(t, "id");
  if (!isTokenId(id)) return fail("id: invalid");
  const type = own(t, "type");
  if (!TYPE_SET.has(type)) return fail("type: unknown");
  const out = { id, type };
  const v = own(t, "value");
  if (v === null) out.value = null;
  else {
    out.value = checkValue(type, v);
    if (out.value === null) return fail("value: invalid for its type");
  }
  const raw = own(t, "raw");
  if (typeof raw !== "string" || raw.length > TOKEN_LIMITS.raw || raw !== stripControls(raw)) return fail("raw: invalid");
  out.raw = raw;
  const modes = own(t, "modes");
  if (!isPlainObject(modes)) return fail("modes: must be an object");
  const mk = Object.keys(modes);
  if (mk.length > TOKEN_LIMITS.modes) return fail("modes: too many");
  out.modes = {};
  for (const k of mk) {
    if (!isModeName(k)) return fail("modes: invalid name");
    const mv = checkValue(type, modes[k]);
    if (mv === null) return fail("modes: invalid value");
    out.modes[k] = mv;
  }
  const alias = own(t, "aliasOf");
  if (!(alias === null || isTokenId(alias))) return fail("aliasOf: invalid");
  out.aliasOf = alias;
  const role = own(t, "role");
  if (!(role === null || isRole(role))) return fail("role: invalid");
  out.role = role;
  const sources = own(t, "sources");
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > TOKEN_LIMITS.sources) return fail("sources: invalid");
  out.sources = [];
  for (const s of sources) {
    const c = checkSource(s);
    if (!c) return fail("sources: invalid entry");
    out.sources.push(c);
  }
  const usage = own(t, "usage");
  if (!isPlainObject(usage) || !isInt(own(usage, "count"), 0, TOKEN_LIMITS.count) || typeof own(usage, "seenLive") !== "boolean") {
    return fail("usage: invalid");
  }
  out.usage = { count: own(usage, "count"), seenLive: own(usage, "seenLive") };
  if (has(usage, "live")) {
    if (!isInt(own(usage, "live"), 0, TOKEN_LIMITS.count)) return fail("usage.live: invalid");
    out.usage.live = own(usage, "live");
  }
  const conf = own(t, "confidence");
  if (!isNum(conf, 0, 1)) return fail("confidence: invalid");
  out.confidence = conf;
  if (has(t, "scoped")) {
    if (own(t, "scoped") !== true) return fail("scoped: invalid");
    out.scoped = true;
  }
  return { ok: true, value: out };
}

function checkScales(v) {
  if (!isPlainObject(v)) return null;
  const out = {};
  for (const k of ["spacing", "fontSize", "radius"]) {
    const list = own(v, k);
    if (!Array.isArray(list) || list.length > TOKEN_LIMITS.scale || !list.every((n) => isNum(n, 0, 1e5))) return null;
    out[k] = list.slice();
  }
  return out;
}

function checkBreakpoint(b) {
  if (!isPlainObject(b)) return null;
  const name = own(b, "name");
  const min = own(b, "min");
  if (typeof name !== "string" || !BP_NAME_RE.test(name) || !isNum(min, 0, 1e5)) return null;
  const out = { name, min };
  if (has(b, "count")) {
    if (!isInt(own(b, "count"), 0, TOKEN_LIMITS.count)) return null;
    out.count = own(b, "count");
  }
  return out;
}

function checkComponent(c) {
  if (!isPlainObject(c)) return null;
  const kind = own(c, "kind");
  const file = own(c, "file");
  const exp = own(c, "export");
  if (!KIND_SET.has(kind) || !isFilePath(file) || !isComponentName(exp)) return null;
  return { kind, file, export: exp };
}

function checkDiagnostic(d) {
  if (!isPlainObject(d)) return null;
  const adapter = own(d, "adapter");
  const code = own(d, "code");
  if (!(adapter === "scan" || isAdapterId(adapter)) || !DIAG_SET.has(code)) return null;
  const out = { adapter, code };
  if (has(d, "file")) {
    if (!isFilePath(own(d, "file"))) return null;
    out.file = own(d, "file");
  }
  if (has(d, "line")) {
    if (!isInt(own(d, "line"), 1, 10000000)) return null;
    out.line = own(d, "line");
  }
  return out;
}

function checkScan(s) {
  if (!isPlainObject(s)) return null;
  const out = {};
  for (const k of ["files", "skipped", "ms"]) {
    if (!isInt(own(s, k), 0, 1e9)) return null;
    out[k] = own(s, k);
  }
  if (typeof own(s, "truncated") !== "boolean") return null;
  out.truncated = own(s, "truncated");
  if (has(s, "classes")) {
    if (!isInt(own(s, "classes"), 0, 1e9)) return null;
    out.classes = own(s, "classes");
  }
  const a = own(s, "adapters");
  if (!isPlainObject(a) || Object.keys(a).length > 64) return null;
  out.adapters = {};
  for (const k of Object.keys(a)) {
    if (!isAdapterId(k) || !isInt(a[k], 0, 1e9)) return null;
    out.adapters[k] = a[k];
  }
  return out;
}

function list(v, max, check, field) {
  if (!Array.isArray(v) || v.length > max) return fail(`${field}: invalid`);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const c = check(v[i]);
    if (!c) return fail(`${field}[${i}]: invalid`);
    out.push(c);
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- live sample

// One sample of computed styles from a page, as the designer sends it:
//
//   { page, device, theme: "light"|"dark", elements: 0-1500,
//     values: [{ prop, value, count }] }       at most 400 values
//
// prop is one of SAMPLE_PROPS; value is the computed value as the browser
// gives it (at most 200 printable characters, no < > \ ` { } ;); count is how
// many visited elements had it (1-1000000). Pairs repeat at most once.
export function validateSample(body) {
  if (!isPlainObject(body)) return fail("body: must be an object");
  const page = own(body, "page");
  const device = own(body, "device");
  if (!isId(page)) return fail("page: invalid");
  if (!isId(device)) return fail("device: invalid");
  const theme = has(body, "theme") ? own(body, "theme") : "light";
  if (!isTheme(theme)) return fail("theme: invalid");
  const elements = own(body, "elements");
  if (!isInt(elements, 0, TOKEN_LIMITS.sampleElements)) return fail("elements: invalid");
  const values = own(body, "values");
  if (!Array.isArray(values) || values.length > TOKEN_LIMITS.sampleValues) return fail("values: invalid");
  const out = [];
  const seen = new Set();
  for (let i = 0; i < values.length; i++) {
    const e = values[i];
    if (!isPlainObject(e)) return fail(`values[${i}]: must be an object`);
    const prop = own(e, "prop");
    const value = own(e, "value");
    const count = own(e, "count");
    if (!SAMPLE_PROP_SET.has(prop)) return fail(`values[${i}].prop: unknown`);
    if (typeof value !== "string" || value.length === 0 || value.length > TOKEN_LIMITS.sampleValue || SAMPLE_BAD_RE.test(value)) {
      return fail(`values[${i}].value: invalid`);
    }
    if (!isInt(count, 1, TOKEN_LIMITS.sampleCount)) return fail(`values[${i}].count: invalid`);
    const k = `${prop}\u0000${value}`;
    if (seen.has(k)) return fail(`values[${i}]: duplicate`);
    seen.add(k);
    out.push({ prop, value, count });
  }
  return { ok: true, value: { page, device, theme, elements, values: out } };
}

function checkLive(entry) {
  if (!isPlainObject(entry)) return null;
  const at = own(entry, "sampled_at");
  if (typeof at !== "string" || !AT_RE.test(at)) return null;
  const r = validateSample(entry);
  return r.ok ? { ...r.value, sampled_at: at } : null;
}

// ---------------------------------------------------------------- document

export function validateTokensDoc(doc) {
  if (!isPlainObject(doc)) return fail("doc: must be an object");
  if (own(doc, "format") !== TOKENS_FORMAT) return fail("format: unknown");
  if (own(doc, "version") !== TOKENS_VERSION) return fail("version: unsupported");
  const at = own(doc, "generated_at");
  if (typeof at !== "string" || !AT_RE.test(at)) return fail("generated_at: invalid");
  if (own(doc, "root") !== ".") return fail("root: must be \".\"");
  const tokens = own(doc, "tokens");
  if (!Array.isArray(tokens) || tokens.length > TOKEN_LIMITS.tokens) return fail("tokens: invalid");
  const outTokens = [];
  const ids = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const r = checkToken(tokens[i]);
    if (!r.ok) return fail(`tokens[${i}].${r.error}`);
    if (ids.has(r.value.id)) return fail(`tokens[${i}].id: duplicate`);
    ids.add(r.value.id);
    outTokens.push(r.value);
  }
  for (let i = 0; i < outTokens.length; i++) {
    const a = outTokens[i].aliasOf;
    if (a !== null && (!ids.has(a) || a === outTokens[i].id)) return fail(`tokens[${i}].aliasOf: unknown token`);
  }
  const scales = checkScales(own(doc, "scales"));
  if (!scales) return fail("scales: invalid");
  const bps = list(own(doc, "breakpoints"), TOKEN_LIMITS.breakpoints, checkBreakpoint, "breakpoints");
  if (!bps.ok) return bps;
  const comps = list(own(doc, "components"), TOKEN_LIMITS.components, checkComponent, "components");
  if (!comps.ok) return comps;
  const diags = list(own(doc, "diagnostics"), TOKEN_LIMITS.diagnostics, checkDiagnostic, "diagnostics");
  if (!diags.ok) return diags;
  const out = {
    format: TOKENS_FORMAT,
    version: TOKENS_VERSION,
    generated_at: at,
    root: ".",
    tokens: outTokens,
    scales,
    breakpoints: bps.value,
    components: comps.value,
    diagnostics: diags.value,
  };
  if (has(doc, "scan")) {
    out.scan = checkScan(own(doc, "scan"));
    if (!out.scan) return fail("scan: invalid");
  }
  if (has(doc, "live")) {
    const l = list(own(doc, "live"), TOKEN_LIMITS.liveSamples, checkLive, "live");
    if (!l.ok) return l;
    out.live = l.value;
  }
  return { ok: true, value: out };
}
