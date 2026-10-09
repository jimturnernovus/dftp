// The core of the style scan: adapter output in, one tokens document out.
// Nothing here reads files; scanner.mjs does the reading.
//
//   1. Definitions: named tokens by name. The page-wide definition with the
//      highest adapter rank is the value; theme definitions (dark ...) are
//      the token's modes; definitions in narrower rules are a fallback only.
//   2. Resolution: references (var(--x), {path.to.token}) are followed, with
//      cycles and missing names reported. A value that depends on a themed
//      name gets that theme as a mode too.
//   3. Usage: references count towards the token they name; literal values
//      are normalised and counted by value.
//   4. Merge: definitions of one token (the same name in several files, or
//      names in different systems that give the same id, such as a token
//      file's color.brand.600 and --color-brand-600) with the same type,
//      value and modes become one token with several sources, named by the
//      best source. Differently named variables stay apart even when their
//      values are equal. Literal values count towards a named token with
//      the same value; those no name covers become unnamed tokens
//      (color.auto.2f5bd8).
//   5. Ids, aliases, roles, scales, breakpoints and components.
//   6. Object styles named in the files (objects.mjs): rules for .btn,
//      .card, input ..., variables named for them, shared components.
//
// All of it runs on a fixed work budget (BUILD_LIMITS.work, characters
// looked at while following references and reading values), so no project
// content can make the build take long; what is left when it runs out has
// no value, with a "budget-build" diagnostic.

import {
  normalizeValue, valueKey, parseLightDark, parseDimension, TYPE_ORDER, isComputedColor,
} from "../../client/core/css-values.js";
import {
  TOKENS_FORMAT, TOKENS_VERSION, TOKEN_TYPES, TOKEN_LIMITS, DIAG_CODES, COMPONENT_KINDS, cleanName, cleanRaw,
  isTokenId, isModeName, checkValue,
} from "../../client/core/tokens.js";
import { isFilePath, isComponentName, stripControls } from "../../client/core/schema.js";
import { usageValues, colorUse, findVarRefs, findBraceRefs, propKind } from "./usage.mjs";
import { idFromName, inferType, roleFromName, TYPE_GROUP, SPACING_GROUPS } from "./names.mjs";
import { staticObjects } from "./objects.mjs";

export const BUILD_LIMITS = Object.freeze({
  tokensPerFile: 5000,
  usagesPerFile: 50000,
  componentsPerFile: 50,
  diagnosticsPerFile: 100,
  chain: 32,
  steps: 1000000,
  work: 20000000,
  fallbackDepth: 32,
  substituted: 2000,
  unnamedPerType: 300,
  sourcesPerUsage: 5,
});

const TYPE_SET = new Set(TOKEN_TYPES);
const DIAG_SET = new Set(DIAG_CODES);
const KIND_SET = new Set(COMPONENT_KINDS);
const GROUP_RE = /^[a-z][a-z0-9-]{0,31}$/;
const USAGE_PROP_RE = /^-{0,2}[a-z][a-z0-9-]{0,60}$/;
const TAILWIND_BREAKPOINTS = new Map([[640, "sm"], [768, "md"], [1024, "lg"], [1280, "xl"], [1536, "2xl"]]);

export const stamp = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const str = (v, max) => (typeof v === "string" && v.length <= max ? stripControls(v, true) : null);

// ---------------------------------------------------------------- adapter output

// Adapter output checked and trimmed to known fields and sizes. Returns null
// when it is not output at all (the adapter then counts as failed).
export function checkOutput(out) {
  if (!out || typeof out !== "object" || typeof out.then === "function") return null;
  const res = { tokens: [], usages: [], components: [], diagnostics: [], capped: false };
  const arr = (v) => (Array.isArray(v) ? v : []);
  for (const t of arr(out.tokens)) {
    if (res.tokens.length >= BUILD_LIMITS.tokensPerFile) {
      res.capped = true;
      break;
    }
    if (!t || typeof t !== "object") continue;
    const name = str(t.name, 200);
    const raw = str(t.raw, 2000);
    if (!name || !name.trim() || raw === null || !raw.trim()) continue;
    const r = { name: name.trim(), raw: raw.trim(), line: isInt(t.line, 1, 1e7) ? t.line : 1 };
    if (TYPE_SET.has(t.type)) r.type = t.type;
    if (isModeName(t.mode) && t.mode !== "light") r.mode = t.mode;
    if (t.scoped === true) r.scoped = true;
    const alias = str(t.aliasRef, 200);
    if (alias && alias.trim()) r.aliasRef = alias.trim();
    if (Array.isArray(t.path) && t.path.length <= 11 && t.path.every((p) => typeof p === "string" && p.length > 0 && p.length <= 64)) r.path = t.path.slice();
    if (typeof t.group === "string" && GROUP_RE.test(t.group)) r.group = t.group;
    res.tokens.push(r);
  }
  for (const u of arr(out.usages)) {
    if (res.usages.length >= BUILD_LIMITS.usagesPerFile) {
      res.capped = true;
      break;
    }
    if (!u || typeof u !== "object" || typeof u.prop !== "string" || !USAGE_PROP_RE.test(u.prop)) continue;
    const raw = str(u.raw, 2000);
    if (raw === null) continue;
    const r = { prop: u.prop, raw, line: isInt(u.line, 1, 1e7) ? u.line : 1 };
    const sel = str(u.selector, 300);
    if (sel) r.selector = sel;
    if (u.narrow === true) r.narrow = true;
    res.usages.push(r);
  }
  for (const c of arr(out.components).slice(0, BUILD_LIMITS.componentsPerFile)) {
    if (c && KIND_SET.has(c.kind) && isComponentName(c.export)) {
      res.components.push({ kind: c.kind, export: c.export, line: isInt(c.line, 1, 1e7) ? c.line : 1 });
    }
  }
  for (const d of arr(out.diagnostics).slice(0, BUILD_LIMITS.diagnosticsPerFile)) {
    if (!d || typeof d !== "object") continue;
    const r = { code: DIAG_SET.has(d.code) ? d.code : "parse-skip" };
    if (isInt(d.line, 1, 1e7)) r.line = d.line;
    res.diagnostics.push(r);
  }
  return res;
}

// ---------------------------------------------------------------- small pieces

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const DIM_TYPES = new Set(["dimension", "fontSize", "lineHeight", "letterSpacing", "radius", "breakpoint"]);

// The last segment of an unnamed token's id: readable for colors and
// lengths, a short hash for anything else.
export function slugFor(type, v) {
  if (type === "color") return `${v.hex.slice(1)}${v.alpha < 1 ? `-${Math.round(v.alpha * 100)}` : ""}`;
  if (DIM_TYPES.has(type)) {
    const n = String(v.value).replace("-", "m").replace(".", "_");
    const u = v.unit === "%" ? "pct" : v.unit || "x";
    return `${n}${u}`;
  }
  if (type === "fontWeight" || type === "zIndex") return String(v.value).replace("-", "m").replace(".", "_");
  if (type === "opacity") return String(Math.round(v.value * 100));
  if (type === "duration") return `${String(v.ms).replace(".", "_")}ms`;
  return fnv(valueKey(type, v));
}

// The id `wanted`, or with -2, -3 ... added when it is taken.
export function uniqueId(wanted, used) {
  let id = wanted;
  for (let n = 2; used.has(id) || !isTokenId(id); n++) {
    id = `${wanted.slice(0, TOKEN_LIMITS.id - 6)}-${n}`;
    if (n > 9999) return null;
  }
  used.add(id);
  return id;
}

function naturalCompare(a, b) {
  const ra = a.match(/\d+|\D+/g) || [];
  const rb = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return ra.length - rb.length;
}

const isNamed = (t) => t.sources.some((s) => s.name);

export function sortTokens(tokens) {
  const order = new Map(TYPE_ORDER.map((t, i) => [t, i]));
  return tokens.sort((a, b) => (order.get(a.type) - order.get(b.type)) ||
    (Number(isNamed(b)) - Number(isNamed(a))) ||
    naturalCompare(a.id, b.id));
}

function saturationOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

const newUse = () => ({ fg: 0, bg: 0, border: 0, rootFg: 0, rootBg: 0, btnBg: 0, rootFont: 0 });

const ROOT_SEL = new Set([":root", "html", "body", "[style]"]);
function isRootSelector(sel) {
  if (!sel) return false;
  return sel.toLowerCase().split(",").some((s) => ROOT_SEL.has(s.trim()) && s.trim() !== "[style]");
}
// A rule for buttons in their resting state (a :hover or :disabled rule
// says nothing about the button's own fill).
const STATE_SEL_RE = /:(?:hover|active|focus|focus-visible|focus-within|disabled|visited)\b|\[(?:aria-)?disabled/i;
function isButtonSelector(sel) {
  if (!sel) return false;
  return sel.split(",").some((s) => /(^|[\s>+~(])button\b|\.btn\b|\.button\b|type=["']?submit/i.test(` ${s}`) && !STATE_SEL_RE.test(s));
}

// ---------------------------------------------------------------- scales and breakpoints

const weight = (t) => (t.usage.count || 0) + (t.usage.live || 0);

function pickScale(entries, max) {
  const byPx = new Map();
  for (const e of entries) {
    const px = round(e.px, 2);
    if (!(px > 0)) continue;
    const cur = byPx.get(px);
    if (!cur || e.w > cur.w) byPx.set(px, { px, w: e.w });
  }
  let list = [...byPx.values()];
  if (list.length > max) list = list.sort((a, b) => b.w - a.w).slice(0, max);
  return list.map((e) => e.px).sort((a, b) => a - b);
}

const TAILWIND_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
// The largest scale step and breakpoint kept, in px (the token file's limit).
const SCALE_MAX_PX = 1e5;
const BREAKPOINT_WORDS = new Set(["breakpoint", "breakpoints", "bp", "screen", "screens"]);

// Spacing, font-size and radius scales in px, from the tokens themselves.
export function computeScales(tokens) {
  const spacing = [];
  const fontSize = [];
  const radius = [];
  for (const t of tokens) {
    if (!t.value || t.value.px === undefined) continue;
    const named = isNamed(t);
    const w = (named ? 1e6 : 0) + weight(t);
    const group = t.id.split(".")[0];
    if (t.type === "dimension" && SPACING_GROUPS.has(group) && t.value.px <= 512 && (named || weight(t) >= 2)) {
      spacing.push({ px: t.value.px, w });
      // Tailwind v4 keeps one spacing unit (--spacing) and multiplies it.
      if (t.sources.some((s) => s.name === "--spacing")) for (const k of TAILWIND_STEPS) spacing.push({ px: t.value.px * k, w: w - 1 });
    } else if (t.type === "fontSize" && t.value.px <= SCALE_MAX_PX && (named || weight(t) >= 1)) fontSize.push({ px: t.value.px, w });
    else if (t.type === "radius" && t.value.px < 1000 && (named || weight(t) >= 1)) radius.push({ px: t.value.px, w });
  }
  return { spacing: pickScale(spacing, 24), fontSize: pickScale(fontSize, 16), radius: pickScale(radius, 12) };
}

// The name of a breakpoint token: the segments after the last breakpoint
// word, so a prefixed name (--bs-breakpoint-md, breakpoint.bs.breakpoint.md)
// is "md" like an unprefixed one.
export function breakpointName(id) {
  const segs = String(id).split(".").slice(1);
  let k = -1;
  segs.forEach((seg, i) => {
    if (BREAKPOINT_WORDS.has(seg.toLowerCase())) k = i;
  });
  const rest = k >= 0 && k < segs.length - 1 ? segs.slice(k + 1) : segs;
  return rest.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 32) || "bp";
}

export function computeBreakpoints(tokens, media) {
  const out = new Map();
  for (const t of tokens) {
    if (t.type !== "breakpoint" || !t.value || t.value.px === undefined || !(t.value.px >= 0 && t.value.px <= SCALE_MAX_PX)) continue;
    const name = breakpointName(t.id);
    const min = round(t.value.px, 2);
    if (!out.has(min)) out.set(min, { name, min });
  }
  for (const [px, count] of media) {
    const min = round(px, 2);
    const cur = out.get(min);
    if (cur) cur.count = (cur.count || 0) + count;
    else out.set(min, { name: TAILWIND_BREAKPOINTS.get(min) || `bp-${Math.round(min)}`, min, count });
  }
  const names = new Set();
  return [...out.values()].sort((a, b) => a.min - b.min).filter((b) => {
    if (names.has(b.name)) return false;
    names.add(b.name);
    return true;
  }).slice(0, 12);
}

// ---------------------------------------------------------------- the build

// results: [{file, adapter: {id, rank}, out}] with out from checkOutput.
// diagnostics: diagnostics from the walk. stats: {files, skipped, truncated, adapters, ms}.
export function buildDoc({ results = [], diagnostics = [], stats = {}, now = () => new Date() } = {}) {
  const diags = [];
  const addDiag = (adapter, file, line, code) => {
    const d = { adapter, code };
    if (file && isFilePath(file)) d.file = file;
    if (isInt(line, 1, 1e7)) d.line = line;
    diags.push(d);
  };
  for (const d of diagnostics) addDiag(d.adapter, d.file, d.line, d.code);
  for (const r of results) for (const d of r.out.diagnostics) addDiag(r.adapter.id, r.file, d.line, d.code);

  // 1. Definitions.
  const entries = new Map();
  let order = 0;
  for (const r of results) {
    const rank = Number.isInteger(r.adapter.rank) ? r.adapter.rank : 10;
    for (const t of r.out.tokens) {
      const ns = t.name.startsWith("--") ? "css" : "tok";
      const key = `${ns}:${t.name}`;
      let e = entries.get(key);
      if (!e) {
        e = { key, name: t.name, base: [], scoped: [], modes: new Map(), def: null };
        entries.set(key, e);
      }
      const def = { ...t, key, file: r.file, adapter: r.adapter.id, rank, order: order++ };
      if (t.mode) {
        if (!e.modes.has(t.mode)) e.modes.set(t.mode, []);
        e.modes.get(t.mode).push(def);
      } else if (t.scoped) e.scoped.push(def);
      else e.base.push(def);
    }
  }
  const byRank = (a, b) => b.rank - a.rank || a.order - b.order;
  const allModes = new Set();
  for (const e of entries.values()) {
    for (const [m, list] of e.modes) {
      list.sort(byRank);
      allModes.add(m);
    }
    const pool = e.base.length ? e.base : e.scoped;
    if (!pool.length) {
      const first = [...e.modes.values()][0][0];
      addDiag(first.adapter, first.file, first.line, "mode-only");
      continue;
    }
    pool.sort(byRank);
    e.def = pool[0];
    e.scopedOnly = e.base.length === 0;
    e.extra = [];
    for (const d of pool.slice(1)) {
      if (d.raw === e.def.raw) e.extra.push(d);
      else if (!e.scopedOnly) addDiag(d.adapter, d.file, d.line, "redefined");
    }
    // A narrower rule's own value is not kept when the page-wide one exists.
    if (!e.scopedOnly) for (const d of e.scoped) if (d.raw !== e.def.raw) addDiag(d.adapter, d.file, d.line, "scoped-skip");
  }
  // light-dark(a, b) gives every token that uses it a dark value, even when
  // no rule of the project defines a dark theme.
  for (const e of entries.values()) {
    if ([...e.base, ...e.scoped].some((d) => d.raw.length <= 4000 && d.raw.toLowerCase().includes("light-dark("))) {
      allModes.add("dark");
      break;
    }
  }
  const modes = [...allModes].sort().slice(0, TOKEN_LIMITS.modes);
  const lookup = (name) => entries.get(`${name.startsWith("--") ? "css" : "tok"}:${name}`);

  // 2. Resolution. Every answer is remembered, so each name is resolved once
  // per mode; a hard cap on steps, on the depth of fallbacks inside
  // fallbacks and on the characters looked at bounds the work whatever the
  // input.
  const memo = new Map();
  let steps = 0;
  let work = 0;
  let outOfWork = false;
  const spend = (n) => {
    work += n;
    if (work > BUILD_LIMITS.work) outOfWork = true;
    return !outOfWork;
  };
  const defFor = (e, mode) => (mode && e.modes.has(mode) ? e.modes.get(mode)[0] : e.def);

  function substitute(raw, mode, stack, depth = 0) {
    if (depth > BUILD_LIMITS.fallbackDepth || !spend(raw.length + 1)) return { raw: null, error: "alias-depth" };
    let text = raw;
    if (text.toLowerCase().includes("var(")) {
      const refs = findVarRefs(text);
      let out = "";
      let at = 0;
      for (const ref of refs) {
        if (ref.start < at) continue;
        const target = lookup(ref.name);
        let r = target && target.def ? resolve(target, mode, stack) : { raw: null, error: "alias-missing" };
        if (r.error && ref.fallback !== null) r = substitute(ref.fallback, mode, stack, depth + 1);
        if (r.error) return r;
        out += text.slice(at, ref.start) + r.raw;
        at = ref.end;
      }
      text = out + text.slice(at);
    }
    if (text.includes("{")) {
      const refs = findBraceRefs(text);
      let out = "";
      let at = 0;
      for (const ref of refs) {
        const target = lookup(ref.name);
        if (!target || !target.def) continue;
        const r = resolve(target, mode, stack);
        if (r.error) return r;
        out += text.slice(at, ref.start) + r.raw;
        at = ref.end;
      }
      text = out + text.slice(at);
    }
    if (text.length > BUILD_LIMITS.substituted) return { raw: null, error: "value-too-long" };
    return { raw: text, error: null };
  }

  function resolve(e, mode, stack) {
    const k = `${e.key}\u0000${mode || ""}`;
    if (memo.has(k)) return memo.get(k);
    if (stack.includes(e.key)) return { raw: null, error: "alias-cycle" };
    // Too deep from here, or out of steps: answered without remembering it,
    // so a walk that starts closer to the end can still resolve this name.
    if (stack.length >= BUILD_LIMITS.chain || ++steps > BUILD_LIMITS.steps) return { raw: null, error: "alias-depth" };
    const d = defFor(e, mode);
    if (!d) return { raw: null, error: "alias-missing" };
    const st = [...stack, e.key];
    let res;
    if (d.aliasRef) {
      const target = lookup(d.aliasRef);
      res = target && target.def ? resolve(target, mode, st) : { raw: null, error: "alias-missing" };
      if (res.error && spend(d.raw.length)) {
        const whole = findVarRefs(d.raw, 1)[0];
        if (whole && whole.fallback !== null) res = substitute(whole.fallback, mode, st, 1);
      }
    } else res = substitute(d.raw, mode, st);
    memo.set(k, res);
    return res;
  }

  // 3. Usage.
  const refCount = new Map();
  const refKinds = new Map();
  const refUse = new Map();
  const pool = new Map();
  const media = new Map();
  let classes = 0;
  const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
  const useOf = (map, key) => {
    let u = map.get(key);
    if (!u) {
      u = newUse();
      map.set(key, u);
    }
    return u;
  };
  const addUse = (u, use, sel) => {
    if (!use) return;
    u[use]++;
    if (use === "fg" && isRootSelector(sel)) u.rootFg++;
    if (use === "bg" && isRootSelector(sel)) u.rootBg++;
    if (use === "bg" && isButtonSelector(sel)) u.btnBg++;
  };
  for (const r of results) {
    for (const u of r.out.usages) {
      if (u.prop === "class") {
        classes++;
        continue;
      }
      if (u.prop === "media-min" || u.prop === "media-max") {
        const d = parseDimension(u.raw, { unitless: false });
        if (!d || d.px === undefined) continue;
        const b = u.prop === "media-min" ? d.px : Number.isInteger(d.px) ? d.px + 1 : Math.ceil(d.px);
        if (b >= 200 && b <= 4000) bump(media, round(b, 2));
        continue;
      }
      const use = colorUse(u.prop);
      const kind = propKind(u.prop);
      const rootFont = (kind === "fontFamily" || kind === "fontSize" || kind === "font") && isRootSelector(u.selector);
      const refs = findVarRefs(u.raw);
      if (refs.length) {
        for (const name of new Set(refs.map((x) => x.name))) {
          const key = `css:${name}`;
          bump(refCount, key);
          if (!refKinds.has(key)) refKinds.set(key, new Map());
          bump(refKinds.get(key), kind);
          const ru = useOf(refUse, key);
          addUse(ru, use, u.selector);
          if (rootFont) ru.rootFont++;
        }
        // The font shorthand's literal size and line height still count
        // when only its family is a reference ("16px/1.5 var(--font-sans)").
        if (kind !== "font") continue;
      }
      for (const v of usageValues(u.prop, u.raw)) {
        const k = valueKey(v.type, v.value);
        let p = pool.get(k);
        if (!p) {
          p = { key: k, type: v.type, value: v.value, group: v.group, count: 0, raw: u.raw, sources: [], use: newUse() };
          pool.set(k, p);
        }
        p.count++;
        if (v.type === "color") addUse(p.use, use, u.selector);
        if (rootFont && (v.type === "fontFamily" || v.type === "fontSize")) p.use.rootFont++;
        if (p.sources.length < BUILD_LIMITS.sourcesPerUsage) p.sources.push({ adapter: r.adapter.id, file: r.file, line: u.line });
      }
    }
  }

  // Types: what the source says, else what the name and value suggest; a
  // plain length takes a more specific type from what it refers to or from
  // the properties that use it.
  const typeMemo = new Map();
  const KIND_TYPES = { fontSize: "fontSize", radius: "radius", lineHeight: "lineHeight", letterSpacing: "letterSpacing" };
  function typeOf(e, depth = 0) {
    if (typeMemo.has(e.key)) return typeMemo.get(e.key);
    typeMemo.set(e.key, null);
    const d = e.def;
    const r = resolve(e, null, []);
    let t = d.type || null;
    if (r.raw !== null && (!t || (t === "dimension" && !d.path && !d.group)) && spend(r.raw.length * 4)) {
      const guess = inferType(e.name, r.raw);
      if (!t) t = guess;
      else if (guess && guess !== "dimension" && DIM_TYPES.has(guess)) t = guess;
    }
    if ((!t || t === "dimension") && d.aliasRef && depth < BUILD_LIMITS.chain) {
      const target = lookup(d.aliasRef);
      const tt = target && target.def ? typeOf(target, depth + 1) : null;
      if (tt && (!t || DIM_TYPES.has(tt))) t = tt;
    }
    if (t === "dimension" && refKinds.has(e.key)) {
      let best = null;
      let n = 0;
      for (const [kind, c] of refKinds.get(e.key)) if (KIND_TYPES[kind] && c > n) [best, n] = [KIND_TYPES[kind], c];
      if (best) t = best;
    }
    typeMemo.set(e.key, t);
    return t;
  }
  const spacingRefs = (key) => {
    const k = refKinds.get(key);
    return !!k && (k.get("spacing") || 0) > 0 && [...k.entries()].every(([kind, c]) => kind === "spacing" || c === 0);
  };

  const valueOf = (type, raw, mode) => {
    if (raw === null || !spend(raw.length)) return null;
    if (type === "color") {
      const ld = parseLightDark(raw);
      if (ld) return mode === "dark" ? ld.dark : ld.light;
    }
    return normalizeValue(type, raw);
  };

  const records = [];
  for (const e of entries.values()) {
    if (!e.def) continue;
    const r = resolve(e, null, []);
    // Once the work budget is spent, one "budget-build" says so for all.
    if (r.error && !(outOfWork && r.error === "alias-depth")) addDiag(e.def.adapter, e.def.file, e.def.line, r.error);
    const type = typeOf(e);
    if (!type) continue;
    const value = valueOf(type, r.raw, null);
    if (type === "color" && value === null && r.raw !== null && !outOfWork && isComputedColor(r.raw)) {
      addDiag(e.def.adapter, e.def.file, e.def.line, "unsupported-color");
    }
    const tokModes = {};
    for (const m of modes) {
      const rm = resolve(e, m, []);
      const vm = valueOf(type, rm.raw, m);
      if (vm && (!value || valueKey(type, vm) !== valueKey(type, value))) tokModes[m] = vm;
    }
    const alias = e.def.aliasRef ? lookup(e.def.aliasRef) : null;
    let group = e.def.group || null;
    if (!group && type === "dimension" && spacingRefs(e.key)) group = "spacing";
    const want = idFromName(e.name, type, { group, path: e.def.path || null });
    records.push({ e, type, value, modes: tokModes, aliasKey: alias && alias.def ? alias.key : null, group, rank: e.def.rank, order: e.def.order, want });
  }
  // Equal rank: a name that is only a list position ("space.2") gives way to
  // a real name for the same value.
  const indexLike = (rec) => /^\d{1,2}$/.test(rec.e.name.slice(rec.e.name.lastIndexOf(".") + 1)) && !rec.e.name.startsWith("--");
  records.sort((a, b) => b.rank - a.rank || Number(indexLike(a)) - Number(indexLike(b)) || a.order - b.order);

  // 4. Merge.
  const modesKey = (type, m) => Object.keys(m).sort().map((k) => `${k}=${valueKey(type, m[k])}`).join(";");
  const groups = [];
  const byValue = new Map();
  for (const rec of records) {
    if (rec.aliasKey || rec.value === null) {
      groups.push({ type: rec.type, value: rec.value, modes: rec.modes, members: [rec], alias: !!rec.aliasKey, poolCount: 0, use: null, sources: [] });
      continue;
    }
    // One token: the same id (one name, or one name in two systems) and the
    // same value and modes.
    const k = `${rec.want}#${valueKey(rec.type, rec.value)}#${modesKey(rec.type, rec.modes)}`;
    const g = byValue.get(k);
    if (g) g.members.push(rec);
    else {
      const ng = { type: rec.type, value: rec.value, modes: rec.modes, members: [rec], alias: false, poolCount: 0, use: null, sources: [] };
      byValue.set(k, ng);
      groups.push(ng);
    }
  }
  const baseIndex = new Map();
  for (const g of groups) {
    if (g.alias || g.value === null) continue;
    const k = valueKey(g.type, g.value);
    if (!baseIndex.has(k)) baseIndex.set(k, g);
  }
  const unnamedByType = new Map();
  for (const p of pool.values()) {
    const g = baseIndex.get(p.key);
    if (g) {
      g.poolCount += p.count;
      g.use = g.use || newUse();
      for (const k of Object.keys(p.use)) g.use[k] += p.use[k];
      continue;
    }
    if (!unnamedByType.has(p.type)) unnamedByType.set(p.type, []);
    unnamedByType.get(p.type).push(p);
  }
  for (const list of unnamedByType.values()) {
    list.sort((a, b) => b.count - a.count);
    for (const p of list.slice(0, BUILD_LIMITS.unnamedPerType)) {
      groups.push({ type: p.type, value: p.value, modes: {}, members: [], alias: false, poolCount: p.count, use: p.use, sources: p.sources, raw: p.raw, group: p.group });
    }
  }

  // 5. Ids. Literal tokens first, then aliases once their target has an id;
  // an alias whose id would be its target's id is the same token under a
  // second name and joins it.
  const used = new Set();
  const keyToGroup = new Map();
  const idFor = (g) => {
    const best = g.members[0];
    return idFromName(best.e.name, g.type, { group: best.group, path: best.e.def.path || null });
  };
  for (const g of groups) {
    if (g.alias || g.members.length === 0) continue;
    g.id = uniqueId(idFor(g), used);
    for (const m of g.members) keyToGroup.set(m.e.key, g);
  }
  let pending = groups.filter((g) => g.alias);
  for (let pass = 0; pending.length && pass < BUILD_LIMITS.chain + 1; pass++) {
    const next = [];
    for (const g of pending) {
      const target = keyToGroup.get(g.members[0].aliasKey);
      if (!target) {
        next.push(g);
        continue;
      }
      const want = idFor(g);
      if (want === target.id && target.type === g.type) {
        target.members.push(g.members[0]);
        g.merged = true;
      } else {
        g.id = uniqueId(want, used);
        g.aliasOf = target.id;
      }
      keyToGroup.set(g.members[0].e.key, g.merged ? target : g);
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const g of pending) {
    g.id = uniqueId(idFor(g), used);
    g.aliasOf = null;
    keyToGroup.set(g.members[0].e.key, g);
  }
  for (const g of groups) {
    if (g.members.length || g.id) continue;
    g.id = uniqueId(`${g.group || TYPE_GROUP[g.type]}.auto.${slugFor(g.type, g.value)}`, used);
  }

  // Tokens.
  let tokens = [];
  const meta = new Map();
  for (const g of groups) {
    if (g.merged || !g.id) continue;
    let count = g.poolCount;
    const use = newUse();
    if (g.use) for (const k of Object.keys(use)) use[k] += g.use[k];
    const sources = [];
    const addSource = (d) => {
      if (sources.length >= TOKEN_LIMITS.sources) return;
      const s = { adapter: d.adapter };
      if (isFilePath(d.file)) s.file = d.file;
      if (isInt(d.line, 1, 1e7)) s.line = d.line;
      const n = d.name ? cleanName(d.name) : "";
      if (n) s.name = n;
      if (!sources.some((x) => x.adapter === s.adapter && x.file === s.file && x.line === s.line && x.name === s.name)) sources.push(s);
    };
    let role = null;
    for (const m of g.members) {
      count += refCount.get(m.e.key) || 0;
      const ru = refUse.get(m.e.key);
      if (ru) for (const k of Object.keys(use)) use[k] += ru[k];
      addSource(m.e.def);
      for (const d of m.e.extra || []) addSource(d);
      for (const list of m.e.modes.values()) addSource(list[0]);
      if (!role && g.type === "color") role = roleFromName(m.e.name);
    }
    for (const s of g.sources) addSource(s);
    if (!sources.length) continue;
    const best = g.members[0];
    // Only values the token file accepts are kept (a 1000000in length or a
    // 1e9 curve point is not): a named token keeps its place with no value,
    // an unnamed one is left out, and a mode with such a value is dropped.
    const where = best ? best.e.def : g.sources[0] || {};
    let value = g.value;
    if (value !== null && !checkValue(g.type, value)) {
      addDiag(where.adapter, where.file, where.line, "value-invalid");
      if (!best) continue;
      value = null;
    }
    const tokModes = {};
    for (const [m, mv] of Object.entries(g.modes)) {
      if (checkValue(g.type, mv)) tokModes[m] = mv;
      else addDiag(where.adapter, where.file, where.line, "value-invalid");
    }
    let confidence;
    if (!best) confidence = Math.min(0.8, 0.3 + 0.05 * count);
    else if (value === null) confidence = 0.4;
    else if (best.e.scopedOnly) confidence = 0.6;
    else confidence = best.rank >= 30 ? 0.95 : best.rank >= 20 ? 0.9 : best.rank >= 15 ? 0.85 : 0.8;
    const t = {
      id: g.id,
      type: g.type,
      value,
      raw: cleanRaw(best ? best.e.def.raw : g.raw || ""),
      modes: tokModes,
      aliasOf: g.aliasOf || null,
      role,
      sources,
      usage: { count: Math.min(count, TOKEN_LIMITS.count), seenLive: false },
      confidence: round(confidence, 2),
    };
    // Defined only inside a narrower rule (a component): not a page-wide value.
    if (best && best.e.scopedOnly) t.scoped = true;
    tokens.push(t);
    meta.set(t, use);
  }

  // A palette shade (color.brand.600) keeps a role from its name only when
  // no token with a plain name (color.primary) has that role.
  const shade = (t) => /^\d{2,4}$/.test(t.id.slice(t.id.lastIndexOf(".") + 1));
  for (const role of new Set(tokens.map((t) => t.role).filter(Boolean))) {
    const holders = tokens.filter((t) => t.role === role);
    if (holders.some((t) => !shade(t))) for (const t of holders) if (shade(t)) t.role = null;
  }

  // Several holders of one role by name: how they are used picks the ones
  // that keep it (the color behind the page root, the page's text, the
  // buttons' fill), when that tells them apart.
  const EVIDENCE = { background: (u) => u.rootBg, text: (u) => u.rootFg, primary: (u) => u.btnBg };
  for (const [role, ev] of Object.entries(EVIDENCE)) {
    const holders = tokens.filter((t) => t.role === role && t.type === "color");
    if (holders.length < 2) continue;
    const most = Math.max(...holders.map((t) => ev(meta.get(t))));
    if (most > 0) for (const t of holders) if (ev(meta.get(t)) < most) t.role = null;
  }

  // Roles the names did not give, from how colors are used.
  const hasRole = (role) => tokens.some((t) => t.role === role);
  const pickBy = (score, min) => {
    let best = null;
    let bestScore = min - 1;
    for (const t of tokens) {
      if (t.type !== "color" || t.role || !t.value) continue;
      const s = score(meta.get(t), t);
      if (s > bestScore) [best, bestScore] = [t, s];
    }
    return best;
  };
  if (!hasRole("text")) {
    const t = pickBy((u) => u.rootFg, 1) || pickBy((u) => u.fg, 2);
    if (t) t.role = "text";
  }
  if (!hasRole("background")) {
    const t = pickBy((u) => u.rootBg, 1);
    if (t) t.role = "background";
  }
  if (!hasRole("primary")) {
    // The color buttons are filled with most, even when its name made it
    // the accent; else a saturated color in frequent use.
    let t = null;
    let most = 0;
    for (const x of tokens) {
      if (x.type !== "color" || !x.value || (x.role && x.role !== "accent")) continue;
      const n = meta.get(x).btnBg;
      if (n > most) [t, most] = [x, n];
    }
    t = t || pickBy((u, tok) => {
      const { s, l } = saturationOf(tok.value.hex);
      return s >= 0.3 && l > 0.15 && l < 0.85 ? u.fg + u.bg + u.border : -1;
    }, 2);
    if (t) t.role = "primary";
  }
  if (!hasRole("border")) {
    const t = pickBy((u) => u.border, 2);
    if (t) t.role = "border";
  }
  // The body text's font family and size: the ones set on :root, html or
  // body (role "text" on a font token).
  for (const type of ["fontFamily", "fontSize"]) {
    if (tokens.some((t) => t.type === type && t.role === "text")) continue;
    let best = null;
    let most = 0;
    for (const t of tokens) {
      if (t.type !== type || !t.value || t.scoped) continue;
      const n = meta.get(t).rootFont;
      if (n > most) [best, most] = [t, n];
    }
    if (best) best.role = "text";
  }

  // Cap, keeping named tokens and the most used unnamed ones.
  if (tokens.length > TOKEN_LIMITS.tokens) {
    addDiag("scan", null, null, "too-many-tokens");
    tokens = tokens.sort((a, b) => (Number(isNamed(b)) - Number(isNamed(a))) || (weight(b) - weight(a))).slice(0, TOKEN_LIMITS.tokens);
    const ids = new Set(tokens.map((t) => t.id));
    for (const t of tokens) if (t.aliasOf && !ids.has(t.aliasOf)) t.aliasOf = null;
  }
  sortTokens(tokens);

  const components = [];
  const seenComp = new Set();
  for (const r of results) {
    for (const c of r.out.components) {
      const k = `${c.kind}|${r.file}`;
      if (seenComp.has(k) || !isFilePath(r.file) || components.length >= TOKEN_LIMITS.components) continue;
      seenComp.add(k);
      components.push({ kind: c.kind, file: r.file, export: c.export });
    }
  }
  components.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // 6. Object styles. A value is read with its variables put in, and names
  // the tokens it refers to first.
  const finalIds = new Set(tokens.map((t) => t.id));
  const objects = staticObjects({
    results,
    tokens,
    resolve: (raw) => {
      if (!raw.toLowerCase().includes("var(")) return raw;
      const r = substitute(raw, null, []);
      return r.error ? null : r.raw;
    },
    refIds: (raw) => {
      const out = new Set();
      if (!raw.toLowerCase().includes("var(")) return out;
      for (const ref of findVarRefs(raw, 8)) {
        const g = keyToGroup.get(`css:${ref.name}`);
        if (g && g.id && finalIds.has(g.id)) out.add(g.id);
      }
      return out;
    },
  });

  if (outOfWork) addDiag("scan", null, null, "budget-build");
  const seenDiag = new Set();
  const outDiags = diags.filter((d) => {
    const k = `${d.adapter}|${d.file || ""}|${d.line || 0}|${d.code}`;
    if (seenDiag.has(k)) return false;
    seenDiag.add(k);
    return true;
  }).sort((a, b) => ((a.file || "") < (b.file || "") ? -1 : (a.file || "") > (b.file || "") ? 1 : (a.line || 0) - (b.line || 0)))
    .slice(0, TOKEN_LIMITS.diagnostics);

  const adapters = {};
  for (const [k, v] of Object.entries(stats.adapters || {})) if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(k) && isInt(v, 0, 1e9)) adapters[k] = v;
  return {
    format: TOKENS_FORMAT,
    version: TOKENS_VERSION,
    generated_at: stamp(now()),
    root: ".",
    tokens,
    scales: computeScales(tokens),
    breakpoints: computeBreakpoints(tokens, media),
    components,
    diagnostics: outDiags,
    objects,
    scan: {
      files: isInt(stats.files, 0, 1e9) ? stats.files : 0,
      skipped: isInt(stats.skipped, 0, 1e9) ? stats.skipped : 0,
      adapters,
      truncated: !!stats.truncated || outOfWork,
      ms: isInt(stats.ms, 0, 1e9) ? stats.ms : 0,
      classes: Math.min(classes, 1e9),
    },
  };
}
