// Validation rules for change data. This file runs unchanged in the browser
// (shell and layer) and in Node (server and CLI), so it uses only standard
// JavaScript: no DOM, no Node built-ins.
//
// Two flavours:
//   validate*  strict. Any rule broken gives {ok:false, error}. Used wherever
//              data crosses a trust boundary (HTTP body, file on disk, message).
//   coerce*    lenient. Trims and drops optional fields that do not fit, so
//              the layer can build a change from whatever the page holds and
//              be sure the strict check will accept it.

export const FORMAT_ID = "dftp.changes";
export const FORMAT_VERSION = 1;

export const LIMITS = Object.freeze({
  changes: 2000,
  key: 512,
  text: 500,
  textFrom: 500,
  textTo: 2000,
  filePath: 300,
  partPath: 200,
  move: 20000,
  sizeMin: 4,
  sizeMax: 20000,
  rect: 1000000,
  occ: 10000,
  writer: 80,
  at: 40,
  files: 200,
  hintId: 64,
  hintClasses: 8,
  hintClass: 64,
  hintSelector: 300,
  hintRole: 32,
  hintAria: 80,
  ctxCount: 10000,
  ctxGap: 10000,
  ctxCols: 1000,
});

// Page and device ids: lower-case slug, and never a name Windows reserves for
// a device file (a file called "con.json" cannot be created there).
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RESERVED_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export const CHANGE_ID_RE = /^[a-z0-9]{8}$/;
const KEY_RE = /^[\x20-\x7E]{1,512}$/;
const FILE_CHARS_RE = /^[A-Za-z0-9_@$./+()[\]-]{1,300}$/;
const LOC_RE = /^([^:]{1,300}):(\d{1,6}):(\d{1,5})$/;
const PART_PATH_RE = /^[0-9.~>]{0,200}$/;
const TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^(?:[0-9a-f]{12})?$/;
const SHA_STRICT_RE = /^[0-9a-f]{12}$/;
const AT_RE = /^[0-9T:.+Z-]{0,40}$/;
const CTX_WORD_RE = /^[a-z-]{0,20}$/;
const WRITER_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
// Hint strings may hold any printable text except characters that could
// close a quote or start markup in whatever reads them later.
// eslint-disable-next-line no-control-regex
const HINT_BAD_RE = /[\u0000-\u001F\u007F-\u009F<>"'\\`]/;
// A selector may use the ">" child combinator; nothing else changes.
// eslint-disable-next-line no-control-regex
const SELECTOR_BAD_RE = /[\u0000-\u001F\u007F-\u009F<"'\\`]/;
// eslint-disable-next-line no-control-regex
const HINT_BAD_ALL_RE = /[\u0000-\u001F\u007F-\u009F<>"'\\`]/g;

// Control characters, bidirectional overrides and line separators are removed
// from every string. A newline survives only where keepNewline is set.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const NEWLINE_RE = /\n/g;

const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isFiniteIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function stripControls(s, keepNewline = false) {
  const out = String(s).replace(CONTROL_RE, "");
  return keepNewline ? out : out.replace(NEWLINE_RE, "");
}

export function isId(s) {
  return typeof s === "string" && ID_RE.test(s) && !RESERVED_ID_RE.test(s);
}

export function isChangeId(s) {
  return typeof s === "string" && CHANGE_ID_RE.test(s);
}

export function isKey(s) {
  return typeof s === "string" && KEY_RE.test(s);
}

export function isSha(s) {
  return typeof s === "string" && SHA_STRICT_RE.test(s);
}

// A project-relative POSIX path: no leading slash, no "..", no empty segment,
// no backslash, no drive letter, no "~". The character class already keeps
// out ":" "\" and "~"; the checks below cover the rest.
export function isFilePath(p) {
  if (typeof p !== "string" || !FILE_CHARS_RE.test(p)) return false;
  if (p.startsWith("/")) return false;
  for (const seg of p.split("/")) if (seg === "" || seg === ".." || seg === ".") return false;
  return true;
}

// "file:line:col" with a valid file path, or "" for "no location".
export function isLoc(s) {
  if (s === "") return true;
  if (typeof s !== "string") return false;
  const m = LOC_RE.exec(s);
  return !!m && isFilePath(m[1]);
}

export function splitLoc(s) {
  if (typeof s !== "string" || s === "") return null;
  const m = LOC_RE.exec(s);
  if (!m || !isFilePath(m[1])) return null;
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) };
}

export function newChangeId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % 36];
  return out;
}

// JSON.parse that refuses keys able to reach an object prototype. Throws.
export function safeParse(text) {
  return JSON.parse(text, (k, v) => {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      throw new SyntaxError("forbidden key");
    }
    return v;
  });
}

// ---------------------------------------------------------------- pieces

function cleanString(v, max, keepNewline, field) {
  if (typeof v !== "string") return { error: `${field}: must be a string` };
  const s = stripControls(v, keepNewline);
  if (s.length > max) return { error: `${field}: longer than ${max}` };
  return { value: s };
}

function checkRect(v, field) {
  if (!isPlainObject(v)) return { error: `${field}: must be an object` };
  const out = {};
  for (const k of ["x", "y", "w", "h"]) {
    const n = own(v, k);
    if (!isFiniteIn(n, -LIMITS.rect, LIMITS.rect)) return { error: `${field}.${k}: must be a finite number` };
    out[k] = n;
  }
  if (out.w < 0 || out.h < 0) return { error: `${field}: negative size` };
  return { value: out };
}

function checkHint(v) {
  if (!isPlainObject(v)) return { error: "hint: must be an object" };
  const out = {};
  const str = (k, max) => {
    if (!has(v, k)) return null;
    const s = own(v, k);
    const bad = k === "selector" ? SELECTOR_BAD_RE : HINT_BAD_RE;
    if (typeof s !== "string" || s.length > max || bad.test(s)) return `hint.${k}: invalid`;
    out[k] = s;
    return null;
  };
  const e1 = str("id", LIMITS.hintId) || str("selector", LIMITS.hintSelector) ||
    str("role", LIMITS.hintRole) || str("aria", LIMITS.hintAria);
  if (e1) return { error: e1 };
  if (has(v, "classes")) {
    const c = own(v, "classes");
    if (!Array.isArray(c) || c.length > LIMITS.hintClasses) return { error: "hint.classes: invalid" };
    for (const s of c) {
      if (typeof s !== "string" || s.length === 0 || s.length > LIMITS.hintClass || HINT_BAD_RE.test(s) || /\s/.test(s)) {
        return { error: "hint.classes: invalid" };
      }
    }
    out.classes = c.slice();
  }
  return { value: out };
}

function checkCtx(v) {
  if (!isPlainObject(v)) return { error: "ctx: must be an object" };
  const out = {};
  const word = (src, k, dst) => {
    if (!has(src, k)) return null;
    const s = own(src, k);
    if (typeof s !== "string" || !CTX_WORD_RE.test(s)) return `ctx.${k}: invalid`;
    dst[k] = s;
    return null;
  };
  const int = (src, k, hi, dst) => {
    if (!has(src, k)) return null;
    const n = own(src, k);
    if (!isInt(n, 0, hi)) return `ctx.${k}: invalid`;
    dst[k] = n;
    return null;
  };
  let e = word(v, "display", out) || word(v, "position", out) ||
    int(v, "index", LIMITS.ctxCount, out) || int(v, "count", LIMITS.ctxCount, out);
  if (e) return { error: e };
  if (has(v, "parent")) {
    const p = own(v, "parent");
    if (!isPlainObject(p)) return { error: "ctx.parent: invalid" };
    const po = {};
    e = word(p, "display", po) || word(p, "dir", po) || word(p, "wrap", po) || int(p, "grid_cols", LIMITS.ctxCols, po);
    if (e) return { error: e };
    if (has(p, "gap_px")) {
      const g = own(p, "gap_px");
      if (!isFiniteIn(g, 0, LIMITS.ctxGap)) return { error: "ctx.gap_px: invalid" };
      po.gap_px = g;
    }
    out.parent = po;
  }
  if (has(v, "slot")) {
    const s = own(v, "slot");
    if (s === null) out.slot = null;
    else {
      if (!isPlainObject(s)) return { error: "ctx.slot: invalid" };
      const b = own(s, "before_index");
      if (!(b === null || b === undefined || isInt(b, 0, LIMITS.ctxCount))) return { error: "ctx.slot: invalid" };
      out.slot = { before_index: b === undefined ? null : b };
    }
  }
  return { value: out };
}

// ---------------------------------------------------------------- change

const BOOL_FIELDS = ["part", "piece", "hidden", "missing", "inline", "text_multi"];

export function validateChange(c) {
  if (!isPlainObject(c)) return { ok: false, error: "change: must be an object" };
  const out = {};
  const fail = (error) => ({ ok: false, error });

  const id = own(c, "id");
  if (!isChangeId(id)) return fail("id: must be 8 lower-case letters or digits");
  out.id = id;
  const key = own(c, "key");
  if (!isKey(key)) return fail("key: must be 1-512 printable ASCII characters");
  out.key = key;

  for (const f of ["loc", "used_in", "was_loc"]) {
    if (!has(c, f)) continue;
    const v = own(c, f);
    if (!isLoc(v)) return fail(`${f}: not a valid file:line:col`);
    out[f] = v;
  }
  if (has(c, "occ")) {
    const v = own(c, "occ");
    if (!isInt(v, 0, LIMITS.occ)) return fail("occ: must be an integer 0-10000");
    out.occ = v;
  }
  for (const f of BOOL_FIELDS) {
    if (!has(c, f)) continue;
    const v = own(c, f);
    if (typeof v !== "boolean") return fail(`${f}: must be true or false`);
    out[f] = v;
  }
  if (has(c, "path")) {
    const v = own(c, "path");
    if (typeof v !== "string" || !PART_PATH_RE.test(v)) return fail("path: invalid");
    out.path = v;
  }
  if (has(c, "tag")) {
    const v = own(c, "tag");
    if (typeof v !== "string" || !TAG_RE.test(v)) return fail("tag: invalid");
    out.tag = v;
  }
  if (has(c, "text")) {
    const r = cleanString(own(c, "text"), LIMITS.text, false, "text");
    if (r.error) return fail(r.error);
    out.text = r.value;
  }
  for (const f of ["dx", "dy"]) {
    if (!has(c, f)) continue;
    const v = own(c, f);
    if (v === null) continue;
    if (!isFiniteIn(v, -LIMITS.move, LIMITS.move)) return fail(`${f}: must be a finite number within ±20000`);
    out[f] = v;
  }
  for (const f of ["w", "h"]) {
    if (!has(c, f)) continue;
    const v = own(c, f);
    if (v === null) { out[f] = null; continue; }
    if (!isFiniteIn(v, LIMITS.sizeMin, LIMITS.sizeMax)) return fail(`${f}: must be null or 4-20000`);
    out[f] = v;
  }
  if (has(c, "base")) {
    const r = checkRect(own(c, "base"), "base");
    if (r.error) return fail(r.error);
    out.base = r.value;
  }
  if (has(c, "text_from")) {
    const r = cleanString(own(c, "text_from"), LIMITS.textFrom, false, "text_from");
    if (r.error) return fail(r.error);
    out.text_from = r.value;
  }
  if (has(c, "text_to")) {
    const v = own(c, "text_to");
    if (v === null) out.text_to = null;
    else {
      const r = cleanString(v, LIMITS.textTo, true, "text_to");
      if (r.error) return fail(r.error);
      out.text_to = r.value;
    }
  }
  if (has(c, "text_attr")) {
    const v = own(c, "text_attr");
    if (v !== null && v !== "placeholder") return fail("text_attr: must be null or \"placeholder\"");
    out.text_attr = v;
  }
  if (has(c, "hint")) {
    const r = checkHint(own(c, "hint"));
    if (r.error) return fail(r.error);
    out.hint = r.value;
  }
  if (has(c, "ctx")) {
    const r = checkCtx(own(c, "ctx"));
    if (r.error) return fail(r.error);
    out.ctx = r.value;
  }
  for (const f of ["src", "src_used"]) {
    if (!has(c, f)) continue;
    const v = own(c, f);
    if (typeof v !== "string" || !SHA_RE.test(v)) return fail(`${f}: must be 12 hex characters or ""`);
    out[f] = v;
  }
  if (has(c, "at")) {
    const v = own(c, "at");
    if (typeof v !== "string" || !AT_RE.test(v)) return fail("at: must be a timestamp");
    out.at = v;
  }
  return { ok: true, value: out };
}

export function validateList(list) {
  if (!Array.isArray(list)) return { ok: false, error: "list: must be an array" };
  if (list.length > LIMITS.changes) return { ok: false, error: `list: more than ${LIMITS.changes} changes` };
  const out = [];
  const ids = new Set();
  const keys = new Set();
  for (let i = 0; i < list.length; i++) {
    const r = validateChange(list[i]);
    if (!r.ok) return { ok: false, error: `list[${i}].${r.error}` };
    if (ids.has(r.value.id)) return { ok: false, error: `list[${i}].id: duplicate` };
    if (keys.has(r.value.key)) return { ok: false, error: `list[${i}].key: duplicate` };
    ids.add(r.value.id);
    keys.add(r.value.key);
    out.push(r.value);
  }
  return { ok: true, value: out };
}

export function isTheme(v) {
  return v === "light" || v === "dark";
}

export function isWriter(v) {
  return typeof v === "string" && WRITER_RE.test(v);
}

// A whole change document as stored on disk.
export function validateDoc(doc, expect = {}) {
  if (!isPlainObject(doc)) return { ok: false, error: "doc: must be an object" };
  if (own(doc, "format") !== FORMAT_ID) return { ok: false, error: "format: unknown" };
  if (own(doc, "version") !== FORMAT_VERSION) return { ok: false, error: "version: unsupported" };
  const page = own(doc, "page");
  const device = own(doc, "device");
  if (!isId(page)) return { ok: false, error: "page: invalid" };
  if (!isId(device)) return { ok: false, error: "device: invalid" };
  if (expect.page !== undefined && page !== expect.page) return { ok: false, error: "page: does not match file" };
  if (expect.device !== undefined && device !== expect.device) return { ok: false, error: "device: does not match file" };
  const vp = own(doc, "viewport");
  if (!isPlainObject(vp) || !isInt(own(vp, "width"), 1, 100000) || !isInt(own(vp, "height"), 1, 100000)) {
    return { ok: false, error: "viewport: invalid" };
  }
  const theme = own(doc, "theme");
  if (!isTheme(theme)) return { ok: false, error: "theme: invalid" };
  const savedAt = own(doc, "saved_at");
  if (typeof savedAt !== "string" || !AT_RE.test(savedAt)) return { ok: false, error: "saved_at: invalid" };
  const rev = own(doc, "rev");
  if (!isInt(rev, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "rev: invalid" };
  const writer = own(doc, "writer");
  if (!(writer === "" || isWriter(writer))) return { ok: false, error: "writer: invalid" };
  const seq = own(doc, "seq");
  if (!isInt(seq, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "seq: invalid" };
  const r = validateList(own(doc, "list"));
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      format: FORMAT_ID,
      version: FORMAT_VERSION,
      page,
      device,
      viewport: { width: own(vp, "width"), height: own(vp, "height") },
      theme,
      saved_at: savedAt,
      rev,
      writer,
      seq,
      list: r.value,
    },
  };
}

// The body of a save request. Whether page and device are configured is the
// caller's check; this one is about shape only. A missing "tab" is allowed
// here so the caller can answer it with the "legacy client" reply.
export function validateSave(body) {
  if (!isPlainObject(body)) return { ok: false, error: "body: must be an object" };
  const page = own(body, "page");
  const device = own(body, "device");
  if (!isId(page)) return { ok: false, error: "page: invalid" };
  if (!isId(device)) return { ok: false, error: "device: invalid" };
  const theme = has(body, "theme") ? own(body, "theme") : "light";
  if (!isTheme(theme)) return { ok: false, error: "theme: invalid" };
  const tab = own(body, "tab");
  if (tab !== undefined && tab !== null && !isWriter(tab)) return { ok: false, error: "tab: invalid" };
  const seq = own(body, "seq");
  if (!isInt(seq, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "seq: invalid" };
  const base = own(body, "base");
  if (!isInt(base, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "base: invalid" };
  const r = validateList(own(body, "list"));
  if (!r.ok) return r;
  return { ok: true, value: { page, device, theme, tab: tab || null, seq, base, list: r.value } };
}

// A list of project-relative files, as sent to ask for fingerprints.
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > LIMITS.files) return { ok: false, error: "files: invalid" };
  const seen = new Set();
  for (const f of files) {
    if (!isFilePath(f)) return { ok: false, error: "files: invalid path" };
    seen.add(f);
  }
  return { ok: true, value: [...seen] };
}

// ---------------------------------------------------------------- lenient

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const trimTo = (s, max, keepNewline) => stripControls(s, keepNewline).slice(0, max);

// Build a change the strict check accepts, dropping what does not fit.
// Returns null when the change cannot be saved at all (no id or no key).
export function coerceChange(c) {
  if (!isPlainObject(c) || !isChangeId(own(c, "id")) || !isKey(own(c, "key"))) return null;
  const out = { id: c.id, key: c.key };
  for (const f of ["loc", "used_in", "was_loc"]) if (has(c, f)) out[f] = isLoc(c[f]) ? c[f] : "";
  if (has(c, "occ") && Number.isInteger(c.occ)) out.occ = clamp(c.occ, 0, LIMITS.occ);
  for (const f of BOOL_FIELDS) if (has(c, f) && c[f] !== undefined) out[f] = !!c[f];
  if (typeof c.path === "string" && PART_PATH_RE.test(c.path)) out.path = c.path;
  if (typeof c.tag === "string") {
    const t = c.tag.toLowerCase();
    if (TAG_RE.test(t)) out.tag = t;
  }
  if (typeof c.text === "string") out.text = trimTo(c.text, LIMITS.text, false);
  for (const f of ["dx", "dy"]) {
    if (typeof c[f] === "number" && Number.isFinite(c[f])) out[f] = clamp(c[f], -LIMITS.move, LIMITS.move);
  }
  for (const f of ["w", "h"]) {
    if (c[f] === null) out[f] = null;
    else if (typeof c[f] === "number" && Number.isFinite(c[f])) out[f] = clamp(c[f], LIMITS.sizeMin, LIMITS.sizeMax);
  }
  if (isPlainObject(c.base)) {
    const r = checkRect(c.base, "base");
    if (!r.error) out.base = r.value;
  }
  if (typeof c.text_from === "string") out.text_from = trimTo(c.text_from, LIMITS.textFrom, false);
  if (c.text_to === null) out.text_to = null;
  else if (typeof c.text_to === "string") out.text_to = trimTo(c.text_to, LIMITS.textTo, true);
  if (c.text_attr === null || c.text_attr === "placeholder") out.text_attr = c.text_attr;
  if (isPlainObject(c.hint)) {
    const h = {};
    const put = (k, max) => {
      if (typeof c.hint[k] !== "string") return;
      const clean = stripControls(c.hint[k]).replace(HINT_BAD_ALL_RE, (ch) => (k === "selector" && ch === ">" ? ch : ""));
      h[k] = clean.slice(0, max);
    };
    put("id", LIMITS.hintId);
    put("selector", LIMITS.hintSelector);
    put("role", LIMITS.hintRole);
    put("aria", LIMITS.hintAria);
    if (Array.isArray(c.hint.classes)) {
      h.classes = c.hint.classes
        .filter((s) => typeof s === "string" && s.length > 0 && s.length <= LIMITS.hintClass && !HINT_BAD_RE.test(s) && !/\s/.test(s))
        .slice(0, LIMITS.hintClasses);
    }
    out.hint = h;
  }
  if (isPlainObject(c.ctx)) {
    const r = checkCtx(c.ctx);
    if (!r.error) out.ctx = r.value;
  }
  for (const f of ["src", "src_used"]) if (typeof c[f] === "string" && SHA_RE.test(c[f])) out[f] = c[f];
  if (typeof c.at === "string" && AT_RE.test(c.at)) out.at = c.at;
  const r = validateChange(out);
  return r.ok ? r.value : null;
}
