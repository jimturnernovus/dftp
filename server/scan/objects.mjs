// Object styles: the whole look of common things on the project's pages
// (buttons, cards, text boxes, badges, avatars, links, headings, body text
// and dividers) as bundles of style properties, each property named by a
// token wherever a token has its value. Two kinds of record:
//
//   static  from the files: rules whose selector names such a thing
//           (.btn-primary, .card, input, h1 ...), custom properties and
//           token-file entries named for one (--card-radius,
//           --btn-primary-bg, --card and --card-foreground), and shared
//           components in the library folders (their file only: classes in
//           code are not read yet, so they add a source, not values)
//   live    from the page: the bundles the designer's live sample recorded
//           for the elements it recognised (layer/core/overlay.js)
//
// Nothing here reads files or runs project code. Values are normalised with
// css-values.js and kept only when tokens.js accepts them; the work is
// bounded by the number of declarations the adapters return (capped there)
// and by OBJECT_LIMITS below.

import {
  splitTop, parseColor, parseGradient, parseBorder, parseShadow, parseDimension, parseFontFamily, parseFontWeight,
  parseFontShorthand, normalizeValue, valueKey, BORDER_STYLES,
} from "../../client/core/css-values.js";
import {
  OBJECT_KIND_PROPS, OBJECT_PROP_LIST, LIVE_VARIANTS, TOKEN_LIMITS, checkObjectValue, cleanName, pxOf,
} from "../../client/core/tokens.js";
import { OBJECT_KINDS, isFilePath, isId } from "../../client/core/schema.js";
import { BUILT_IN_DEVICES } from "../../client/core/devices.js";

export const OBJECT_LIMITS = Object.freeze({
  // Declarations kept per kind while reading rules.
  decls: 400,
  // Different selectors remembered while classifying.
  selectors: 5000,
  // Bundles a page sample may hold per kind and variant (the layer keeps
  // the same number).
  perClass: TOKEN_LIMITS.objectVariants,
});

const BORDER_STYLE_SET = new Set(BORDER_STYLES);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Words that name a thing in a class name or a token name.
const BLOCKS = new Map([
  ["btn", "button"], ["button", "button"],
  ["card", "card"], ["panel", "card"], ["tile", "card"],
  ["badge", "badge"], ["chip", "badge"], ["pill", "badge"], ["tag", "badge"],
  ["avatar", "avatar"],
  ["input", "input"], ["form-control", "input"], ["form-input", "input"], ["text-field", "input"], ["textfield", "input"],
  ["text-input", "input"], ["textarea", "input"], ["select", "input"], ["form-select", "input"],
  ["divider", "divider"], ["separator", "divider"],
  ["link", "link"],
  ["h1", "heading"], ["h2", "heading"], ["h3", "heading"],
]);

// ---------------------------------------------------------------- matching values with tokens

// The token types a property's value may be named by.
const PROP_TOKEN_TYPES = Object.freeze({
  background: ["color", "gradient"],
  color: ["color"],
  "border-color": ["color"],
  "border-width": ["dimension"],
  "border-style": [],
  "border-radius": ["radius", "dimension"],
  "box-shadow": ["shadow"],
  "padding-block": ["dimension"],
  "padding-inline": ["dimension"],
  gap: ["dimension"],
  height: ["dimension"],
  "font-family": ["fontFamily"],
  "font-size": ["fontSize", "dimension"],
  "font-weight": ["fontWeight"],
  "line-height": ["lineHeight"],
  "letter-spacing": ["letterSpacing", "dimension"],
});
// The token group a property's size is best named from.
const PROP_GROUP = Object.freeze({ "padding-block": "spacing", "padding-inline": "spacing", gap: "spacing", "border-width": "border-width" });

const lenPx = (d) => {
  if (!d || typeof d !== "object") return null;
  const p = pxOf(d);
  if (p !== null) return p;
  return d.value === 0 ? 0 : null;
};
const dimKey = (d) => {
  const p = lenPx(d);
  return p !== null ? `d:${round(p)}` : `d:${d.value}${d.unit}`;
};
const colorKey = (c) => `c:${c.hex}:${round(c.alpha)}`;
const shadowKey = (v) => `s:${v.map((l) => [l.inset ? 1 : 0, ...["x", "y", "blur", "spread"].map((k) => round(lenPx(l[k]) ?? NaN)), l.color ? colorKey(l.color) : "cur"].join(",")).join(";")}`;

// A key that is the same for two values that look the same (a 0.5rem and
// an 8px radius, "Inter" and "inter"), by the kind of value.
function keyOf(kind, v) {
  if (v === null || typeof v !== "object") return null;
  switch (kind) {
    case "color": return typeof v.hex === "string" ? colorKey(v) : null;
    case "gradient": return Array.isArray(v.stops) ? `g:${valueKey("gradient", v)}` : null;
    case "shadow": return Array.isArray(v) ? shadowKey(v) : null;
    case "fontFamily": return Array.isArray(v.families) ? `f:${v.families.map((f) => f.toLowerCase()).join(",")}` : null;
    case "fontWeight": return Number.isFinite(v.value) ? `w:${v.value}` : null;
    case "ratio": return Number.isFinite(v.value) ? `r:${round(v.value, 3)}` : null;
    default: return Number.isFinite(v.value) ? dimKey(v) : null;
  }
}

// The kind of key for a property's value.
function propKeyKind(prop, v) {
  if (prop === "background") return v && typeof v.hex === "string" ? "color" : "gradient";
  if (prop === "color" || prop === "border-color") return "color";
  if (prop === "box-shadow") return "shadow";
  if (prop === "font-family") return "fontFamily";
  if (prop === "font-weight") return "fontWeight";
  if (prop === "line-height" && v && v.unit === "") return "ratio";
  return "dim";
}

function tokenKeyKind(t) {
  if (["color", "gradient", "shadow", "fontFamily", "fontWeight"].includes(t.type)) return t.type;
  if (t.type === "lineHeight" && t.value && t.value.unit === "") return "ratio";
  return "dim";
}

// Roles a color token may not have to name a property by its value alone:
// a white button text is not "the surface color" because both are white.
// A token the declaration refers to is always taken; otherwise one whose
// name says it is for that use is taken whatever its role, and one whose
// name says it is for another use never is.
const ROLE_MISFIT = Object.freeze({
  color: new Set(["background", "surface", "border"]),
  background: new Set(["text", "border"]),
  "border-color": new Set(["background", "surface", "text"]),
});

// Words in a token's id that say what a color is for, and words that say
// it is for something else: "primary-foreground" is a text color, never a
// fill, though "primary" alone would be one.
const INK = ["fg", "foreground", "text", "ink", "on", "content", "label"];
const FILL = ["bg", "background", "surface", "fill"];
const PURPOSE_WORDS = Object.freeze({
  color: { fit: new Set(INK), not: new Set(FILL) },
  background: { fit: new Set([...FILL, "card", "primary", "secondary", "accent", "muted"]), not: new Set(INK) },
  "border-color": { fit: new Set(["border", "outline", "stroke", "line", "input"]), not: new Set([...INK, ...FILL]) },
});
const wordsOf = (t) => t.id.toLowerCase().split(/[._-]+/);
const fitsByName = (prop, t) => {
  const p = PURPOSE_WORDS[prop];
  if (!p) return false;
  const words = wordsOf(t);
  return words.some((w) => p.fit.has(w)) && !words.some((w) => p.not.has(w));
};
const otherByName = (prop, t) => {
  const p = PURPOSE_WORDS[prop];
  return !!p && wordsOf(t).some((w) => p.not.has(w)) && !fitsByName(prop, t);
};

// A value that is nothing at all: no token stands for it.
function isNothing(prop, v) {
  if (v === null || typeof v !== "object") return true;
  if (typeof v.hex === "string") return v.alpha === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v.style === "string") return true;
  if (prop !== "font-weight" && prop !== "line-height" && Number.isFinite(v.value) && v.value === 0) return true;
  return false;
}

const isNamed = (t) => t.sources.some((s) => s.name);
const used = (t) => (t.usage.count || 0) + (t.usage.live || 0);

// Words in a token's id that tie it to a part of a page that is none of the
// object kinds (a navigation bar, an accordion, a menu ...): such a token
// never names the value of a button, a heading or a card.
const OTHER_PARTS = new Set([
  "nav", "navbar", "navigation", "sidebar", "breadcrumb", "pagination", "tab", "tabs", "toolbar", "menu", "menubar",
  "dropdown", "popover", "tooltip", "modal", "dialog", "sheet", "drawer", "offcanvas", "toast", "alert", "callout",
  "accordion", "carousel", "header", "footer", "hero", "banner", "table", "list", "chart", "progress", "spinner",
  "skeleton", "switch", "checkbox", "radio", "toggle", "slider", "range", "scrollbar", "code", "kbd", "blockquote",
]);
// Words that name an object kind in a token's id ("pill" is left out: a
// "radius-pill" is a shape any kind may use).
const KIND_WORDS = new Map([...BLOCKS].filter(([w]) => !w.includes("-") && w !== "pill"));
// Words that say a size is a height, and words that say a plain size
// (not a font size token) is for type.
const HEIGHT_WORDS = new Set(["height", "h", "size", "sizes", "sizing"]);
const TYPE_WORDS = new Set(["font", "text", "type", "typography", "letter", "tracking"]);
// Words of spacing tokens, and of sizes that are no spacing.
const SPACE_WORDS = new Set(["spacing", "space", "spacer", "padding", "pad", "gap", "margin", "gutter", "inset"]);
const NOT_SPACE_WORDS = new Set(["border", "stroke", "outline", "radius", "height", "width"]);
// Whether a token's id says it is the kind of size a property takes: a
// height is named only by a height or size token, a font size or letter
// spacing by a plain size only when it is named for type, a padding or gap
// never by a border width, radius, height or width, and a border width
// never by a spacing (whatever value they share).
function sizeFits(prop, t) {
  const words = wordsOf(t);
  if (prop === "height") return words.some((w) => HEIGHT_WORDS.has(w));
  if ((prop === "font-size" || prop === "letter-spacing") && t.type === "dimension") return words.some((w) => TYPE_WORDS.has(w));
  if (prop === "padding-block" || prop === "padding-inline" || prop === "gap") return !words.some((w) => NOT_SPACE_WORDS.has(w));
  if (prop === "border-width") return !words.some((w) => SPACE_WORDS.has(w));
  return true;
}

// The kind of thing a token's id names: an object kind, "other" for another
// part of a page, or null for a token of no particular thing.
function kindOfToken(t) {
  const words = wordsOf(t);
  if (words.some((w) => OTHER_PARTS.has(w))) return "other";
  for (const w of words) if (KIND_WORDS.has(w)) return KIND_WORDS.get(w);
  return null;
}

// match(prop, value, prefer, kind) -> token id or null: the token whose
// value looks the same, of a type the property takes. prefer: ids the
// declaration itself refers to (or the project's own rules use for that
// property of that kind), which win. kind: the kind of thing the value
// belongs to; a token whose id names another kind or another part of a
// page is never taken, and one named for this kind and property ("--card"
// for a card's fill, "--btn-padding-y" for a button's) comes first. A
// size is named only by a token whose id fits it (sizeFits).
// Then the property's own type (a font size before a plain size), a named
// token over an unnamed one, one whose name says it is for this (a
// "foreground" for a text color), one from the property's own group
// (spacing for padding), one with a role, a page-wide one, then
// confidence, use and id.
export function tokenMatcher(tokens) {
  const index = new Map();
  const kinds = new Map();
  for (const t of tokens || []) {
    if (!t || !t.value) continue;
    const k = keyOf(tokenKeyKind(t), t.value);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(t);
    kinds.set(t, kindOfToken(t));
  }
  return (prop, v, prefer = null, kind = null) => {
    const types = PROP_TOKEN_TYPES[prop];
    if (!types || !types.length || isNothing(prop, v)) return null;
    const k = keyOf(propKeyKind(prop, v), v);
    const misfit = ROLE_MISFIT[prop];
    const preferred = (t) => !!prefer && prefer.has(t.id);
    const fits = (t) => !otherByName(prop, t) && !(misfit && t.role && misfit.has(t.role) && !fitsByName(prop, t)) &&
      !(kind && kinds.get(t) !== null && kinds.get(t) !== kind) && sizeFits(prop, t);
    const list = k ? (index.get(k) || []).filter((t) => types.includes(t.type) && (preferred(t) || fits(t))) : [];
    if (!list.length) return null;
    const group = PROP_GROUP[prop];
    const forThis = (t) => {
      if (!kind || kinds.get(t) !== kind) return false;
      const hint = tokenObjectHint(t.id, t.type);
      return !!hint && hint.kind === kind && hint.props.includes(prop);
    };
    const score = (t) => [
      prefer && prefer.has(t.id) ? 1 : 0,
      forThis(t) ? 1 : 0,
      -types.indexOf(t.type),
      isNamed(t) ? 1 : 0,
      fitsByName(prop, t) ? 1 : 0,
      group && t.id.startsWith(`${group}.`) ? 1 : 0,
      t.role ? 1 : 0,
      t.scoped ? 0 : 1,
      t.confidence,
      used(t),
    ];
    list.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return list[0].id;
  };
}

// A bundle's property value as a key, a token id read as the token's value.
function styleKey(prop, v, byId) {
  if (typeof v === "string") {
    const t = byId.get(v);
    return t && t.value ? keyOf(tokenKeyKind(t), t.value) || `id:${v}` : `id:${v}`;
  }
  return keyOf(propKeyKind(prop, v), v);
}

// ---------------------------------------------------------------- live

// A corner radius at least this large draws a pill whatever the size: a
// "fully round" radius written as a huge length (calc(infinity * 1px)
// computes to 3.35544e+07px) is kept as this many px.
export const PILL_PX = 9999;
const HUGE_PX_RE = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e\+?\d{1,3})?px$/i;

// A computed value from the page as a normalised value of `prop`, or null.
function parseLive(prop, raw) {
  const s = String(raw).trim();
  switch (prop) {
    case "border-radius": {
      if (HUGE_PX_RE.test(s) && Number.parseFloat(s) > PILL_PX) return parseDimension(`${PILL_PX}px`, { unitless: false });
      return parseDimension(s, { unitless: false });
    }
    case "background":
      return /gradient\(/i.test(s) ? parseGradient(s) : parseColor(s);
    case "color":
    case "border-color":
      return parseColor(s);
    case "border-style":
      return BORDER_STYLE_SET.has(s) ? { style: s } : null;
    case "box-shadow": {
      if (s === "none") return [];
      const sh = parseShadow(s);
      if (!sh) return null;
      // Layers that draw nothing (a framework's resting "0 0 #0000") are
      // no shadow.
      const visible = sh.filter((l) => !(l.color && l.color.alpha === 0) && ["x", "y", "blur", "spread"].some((k) => lenPx(l[k]) !== 0));
      return visible.length ? visible : [];
    }
    case "font-family":
      return parseFontFamily(s);
    case "font-weight":
      return parseFontWeight(s);
    case "line-height":
    case "letter-spacing":
    case "gap":
      return s === "normal" ? null : parseDimension(s, { unitless: prop === "line-height" });
    default:
      return parseDimension(s, { unitless: false });
  }
}

// A sample's bundle (computed values) as a stored bundle: normalised, with
// token ids where a token has the value (kind: what the bundle is the look
// of; prefer: "kind|property" -> ids the project's own rules use there). A
// line height in px also matches a unitless token through the font size.
function liveStyle(kind, raw, match, prefer) {
  const out = {};
  for (const prop of OBJECT_KIND_PROPS[kind]) {
    if (!Object.prototype.hasOwnProperty.call(raw, prop)) continue;
    const v = parseLive(prop, raw[prop]);
    if (v === null) continue;
    const ids = prefer.get(`${kind}|${prop}`) || null;
    let id = null;
    if (prop === "line-height" && v.unit === "px") {
      const fs = raw["font-size"] ? parseDimension(String(raw["font-size"]), { unitless: false }) : null;
      if (fs && fs.px > 0) id = match(prop, { value: round(v.px / fs.px, 3), unit: "" }, ids, kind);
    }
    id = id || match(prop, v, ids, kind);
    const c = checkObjectValue(prop, id || v);
    if (c !== null) out[prop] = c;
  }
  return out;
}

// The token ids the project's own rules (static object styles) use, by
// "kind|property": a live value they have is named the project's way.
function preferOf(statics) {
  const out = new Map();
  for (const o of statics || []) {
    if (!o || !o.style || typeof o.style !== "object") continue;
    for (const [p, v] of Object.entries(o.style)) {
      if (typeof v !== "string") continue;
      const k = `${o.kind}|${p}`;
      if (!out.has(k)) out.set(k, new Set());
      out.get(k).add(v);
    }
  }
  return out;
}

const sigOf = (style) => JSON.stringify(OBJECT_PROP_LIST.filter((p) => Object.prototype.hasOwnProperty.call(style, p)).map((p) => [p, style[p]]));
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The bundle of another screen size that is the same thing as bundle `a`
// there: the same bundle, its only bundle of that kind and variant, or the
// one that shares the most of its values (at least half of all the
// properties either has), the more common one first; null when none.
function counterpart(a, list) {
  const same = list.find((e) => e.sig === a.sig);
  if (same) return same;
  if (list.length === 1) return list[0];
  let best = null;
  let bestSame = 0;
  for (const e of list) {
    const props = new Set([...Object.keys(a.style), ...Object.keys(e.style)]);
    let same = 0;
    for (const p of props) if (a.style[p] !== undefined && a.style[p] === e.style[p]) same++;
    if (same * 2 >= props.size && same > bestSame) [best, bestSame] = [e, same];
  }
  return best;
}

// The devices of the samples from the widest to the narrowest: those whose
// width is known first, then "desktop", then by id.
function deviceOrder(ids, widths) {
  const w = (id) => (widths.has(id) ? widths.get(id) : -1);
  return [...ids].sort((a, b) => w(b) - w(a) || (a === "desktop" ? -1 : b === "desktop" ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));
}

// The live object styles of stored samples (light theme only: a dark
// sample shows the dark look, not the project's own), kept per screen
// size. A look is taken from the widest screen size that shows the kind
// and variant (its "home"), with its count there (several pages of one
// size add up; the same elements seen at another size are not counted
// again). Narrower sizes whose look differs keep what differs as
// `screens: {device: {property: value}}`, for sizes whose width is known
// (opts.devices, the designer's screen sizes), taken from the bundle there
// that shares the most values with the look (counterpart). Per kind: the
// most common bundle of each variant, up to OBJECT_LIMITS.perClass
// variants; a kind with one variant keeps its most common bundles as
// default, default-2 and default-3. Equal counts go to the bundle seen
// more often over all sizes, then by its values.
//   opts.devices  [{id, width}] (default: the built-in screen sizes)
//   opts.statics  the static object styles, whose token ids are preferred
export function liveObjects(samples, tokens, { devices = BUILT_IN_DEVICES, statics = [] } = {}) {
  const match = tokenMatcher(tokens);
  const prefer = preferOf(statics);
  const widths = new Map((Array.isArray(devices) ? devices : []).filter((d) => d && isId(d.id) && Number.isFinite(d.width)).map((d) => [d.id, d.width]));
  // device -> "kind|variant" -> signature -> {style, sig, count}; and over
  // all sizes: "kind|variant\0signature" -> {count, where}.
  const byDevice = new Map();
  const totals = new Map();
  for (const s of samples || []) {
    if (!s || s.theme === "dark" || !Array.isArray(s.objects)) continue;
    if (!byDevice.has(s.device)) byDevice.set(s.device, new Map());
    const dev = byDevice.get(s.device);
    for (const o of s.objects) {
      const cls = `${o.kind}|${o.variant}`;
      if (!dev.has(cls)) dev.set(cls, new Map());
      const g = dev.get(cls);
      const sig = sigOf(o.style);
      let e = g.get(sig);
      if (!e) {
        e = { style: o.style, sig, count: 0 };
        g.set(sig, e);
      }
      e.count = Math.min(TOKEN_LIMITS.count, e.count + o.count);
      const tk = `${cls}\u0000${sig}`;
      let t = totals.get(tk);
      if (!t) {
        t = { count: 0, where: [] };
        totals.set(tk, t);
      }
      t.count = Math.min(TOKEN_LIMITS.count, t.count + o.count);
      if (t.where.length < TOKEN_LIMITS.objectSources && !t.where.some((w) => w.page === s.page && w.device === s.device)) {
        t.where.push({ page: s.page, device: s.device });
      }
    }
  }
  const order = deviceOrder(byDevice.keys(), widths);
  const total = (cls, e) => totals.get(`${cls}\u0000${e.sig}`);
  const ranked = (device, cls) => {
    const g = byDevice.get(device).get(cls);
    return g ? [...g.values()].sort((a, b) => b.count - a.count || total(cls, b).count - total(cls, a).count ||
      (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0)) : [];
  };
  const homeOf = (cls) => order.find((d) => byDevice.get(d).has(cls));
  const out = [];
  for (const kind of OBJECT_KINDS) {
    const classes = LIVE_VARIANTS[kind];
    let picks = [];
    if (classes.length === 1) {
      const cls = `${kind}|${classes[0]}`;
      const home = homeOf(cls);
      if (home) {
        picks = ranked(home, cls).slice(0, OBJECT_LIMITS.perClass)
          .map((e, i) => ({ e, cls, home, variant: i ? `${classes[0]}-${i + 1}` : classes[0] }));
      }
    } else {
      for (const c of classes) {
        const cls = `${kind}|${c}`;
        const home = homeOf(cls);
        if (home) picks.push({ e: ranked(home, cls)[0], cls, home, variant: c });
      }
      picks = picks.sort((a, b) => b.e.count - a.e.count || (a.e.sig < b.e.sig ? -1 : a.e.sig > b.e.sig ? 1 : 0)).slice(0, OBJECT_LIMITS.perClass)
        .sort((a, b) => classes.indexOf(a.variant) - classes.indexOf(b.variant));
    }
    // A bundle of another size is the counterpart of one look only, and one
    // that is exactly another look kept here is that look's.
    const taken = new Set();
    const kept = new Set(picks.map((p) => p.e.sig));
    for (const p of picks) {
      const style = liveStyle(kind, p.e.style, match, prefer);
      if (!Object.keys(style).length) continue;
      const o = {
        kind, variant: p.variant, source: "live", count: p.e.count, style,
        sources: total(p.cls, p.e).where.map((w) => ({ adapter: "live", page: w.page, device: w.device })),
      };
      // What narrower screen sizes show instead.
      const screens = {};
      for (const d of order) {
        if (Object.keys(screens).length >= TOKEN_LIMITS.objectScreens) break;
        if (d === p.home || !widths.has(d) || !widths.has(p.home) || widths.get(d) >= widths.get(p.home)) continue;
        const e = counterpart(p.e, ranked(d, p.cls).filter((x) => !taken.has(`${d}\u0000${x.sig}`) && (x.sig === p.e.sig || !kept.has(x.sig))));
        if (!e) continue;
        taken.add(`${d}\u0000${e.sig}`);
        if (e.sig === p.e.sig) continue;
        const there = liveStyle(kind, e.style, match, prefer);
        const diff = {};
        for (const prop of Object.keys(there)) if (!sameValue(there[prop], style[prop])) diff[prop] = there[prop];
        if (Object.keys(diff).length) screens[d] = diff;
      }
      if (Object.keys(screens).length) o.screens = screens;
      out.push(o);
    }
  }
  return out;
}

// Whether a live bundle and a static one describe the same look: they
// agree on at least two shared properties, on three in four of those they
// share, and on the fill and text color wherever both have them.
function sameLook(a, b, byId) {
  let n = 0;
  let agree = 0;
  for (const prop of OBJECT_PROP_LIST) {
    if (!Object.prototype.hasOwnProperty.call(a.style, prop) || !Object.prototype.hasOwnProperty.call(b.style, prop)) continue;
    n++;
    const same = styleKey(prop, a.style[prop], byId) === styleKey(prop, b.style[prop], byId);
    if (same) agree++;
    else if (prop === "background" || prop === "color") return false;
  }
  return n >= 2 && agree / n >= 0.75;
}

// Live bundles that match a static one get its file sources (the class or
// variable that gives the look), so a new element copied from the page can
// name the project's own class.
export function linkObjects(live, statics, tokens) {
  const byId = new Map((tokens || []).map((t) => [t.id, t]));
  return live.map((o) => {
    const sources = o.sources.slice();
    for (const s of statics) {
      if (s.kind !== o.kind || !sameLook(o, s, byId)) continue;
      for (const src of s.sources) {
        if (sources.length >= TOKEN_LIMITS.objectSources) break;
        if (!sources.some((x) => x.file === src.file && x.name === src.name && x.adapter === src.adapter)) sources.push(src);
      }
    }
    return { ...o, sources };
  });
}

// ---------------------------------------------------------------- static: selectors

// Tags that name a thing by themselves.
const TAGS = new Map([
  ["button", ["button", null]], ["input", ["input", "text"]], ["select", ["input", "select"]], ["textarea", ["input", "textarea"]],
  ["h1", ["heading", "h1"]], ["h2", ["heading", "h2"]], ["h3", ["heading", "h3"]],
  ["a", ["link", "default"]], ["hr", ["divider", "default"]], ["p", ["text", "body"]], ["body", ["text", "body"]],
]);
const TEXT_TYPES = new Set(["text", "email", "search", "url", "tel", "number"]);
const BUTTON_TYPES = new Set(["submit", "button", "reset"]);
// Modifier words that name a variant, by kind.
const VARIANT_WORDS = Object.freeze({
  button: new Map([
    ...["primary", "cta", "brand", "main", "solid", "filled", "accent"].map((w) => [w, "primary"]),
    ...["secondary", "outline", "outlined", "bordered", "default", "neutral", "light", "alt"].map((w) => [w, "secondary"]),
    ...["ghost", "text", "link", "plain", "flat", "subtle", "tertiary", "clear", "transparent"].map((w) => [w, "ghost"]),
  ]),
  badge: new Map([["pill", "pill"], ["rounded", "pill"], ["round", "pill"]]),
});
const COMPOUND_RE = /^([a-z][a-z0-9-]{0,31})?((?:\.[a-z0-9_-]{1,80}|\[[^\]]{1,60}\]|:link|:any-link)*)$/;
const ATTR_RE = /^\[\s*type\s*=\s*["']?([a-z]{1,20})["']?\s*\]$/;

// One selector of a list, e.g. ".btn.btn-primary", "button.primary",
// "input[type=email]", "h2": {kind, variant} (variant null for a base rule
// that every variant of a button or badge shares), or null when it does
// not name one thing in its resting state (descendants, states, sizes and
// other modifiers are left out).
export function classifySelector(part) {
  const s = String(part).trim().toLowerCase();
  if (!s || s.length > 200) return null;
  const m = COMPOUND_RE.exec(s);
  if (!m) return null;
  const tag = m[1] || null;
  let kind = null;
  let variant = null;
  if (tag) {
    if (!TAGS.has(tag)) return null;
    [kind, variant] = TAGS.get(tag);
  }
  const rest = m[2] || "";
  for (const a of rest.match(/\[[^\]]{1,60}\]/g) || []) {
    const t = ATTR_RE.exec(a);
    if (t && BUTTON_TYPES.has(t[1]) && (!tag || tag === "input" || tag === "button")) [kind, variant] = ["button", null];
    else if (t && TEXT_TYPES.has(t[1]) && (!tag || tag === "input")) [kind, variant] = ["input", "text"];
    else return null;
  }
  let block = null;
  const mods = [];
  for (const c of (rest.match(/\.[a-z0-9_-]{1,80}/g) || []).map((x) => x.slice(1))) {
    const words = c.split(/[-_]+/).filter(Boolean);
    if (!words.length) return null;
    let b = null;
    let at = 0;
    if (words.length >= 2 && BLOCKS.has(`${words[0]}-${words[1]}`)) [b, at] = [BLOCKS.get(`${words[0]}-${words[1]}`), 2];
    else if (BLOCKS.has(words[0])) [b, at] = [BLOCKS.get(words[0]), 1];
    if (!b) {
      mods.push(...words);
      continue;
    }
    if (block && block.kind !== b) return null;
    if (!block) block = { kind: b, word: at === 2 ? `${words[0]}-${words[1]}` : words[0] };
    if (words[0] === "pill") mods.push("pill");
    mods.push(...words.slice(at));
  }
  if (block) {
    // A tag and a class that name different things: only a link styled as
    // a button is one thing.
    if (kind && kind !== block.kind && !(tag === "a" && block.kind === "button")) return null;
    if (kind !== block.kind) variant = null;
    kind = block.kind;
    if (kind === "input") variant = block.word === "textarea" ? "textarea" : block.word === "select" || block.word === "form-select" ? "select" : variant || "text";
    else if (kind === "heading") variant = block.word;
  }
  if (!kind) return null;
  const words = VARIANT_WORDS[kind];
  for (const w of mods) {
    const v = words ? words.get(w) : undefined;
    if (v === undefined) return null;
    if (variant === null) variant = v;
  }
  if (variant === null && kind !== "button" && kind !== "badge") variant = "default";
  return { kind, variant };
}

// The selectors of a list, split at top-level commas.
function selectorParts(sel) {
  return splitTop(String(sel), ",").map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- static: declarations

const BORDER_WIDTHS = { thin: 1, medium: 3, thick: 5 };
const width = (w) => {
  const k = String(w).toLowerCase();
  if (BORDER_WIDTHS[k] !== undefined) return { value: BORDER_WIDTHS[k], unit: "px", px: BORDER_WIDTHS[k] };
  return normalizeValue("dimension", w);
};
const dim = (w) => normalizeValue("dimension", w);
const SIDE_PROPS = new Set(["border-top", "border-bottom", "border-block-start", "border-block-end"]);

// A declaration (its value with variables already put in) as bundle
// properties: [[property, value]].
function readDecl(kind, prop, text) {
  const s = text.trim();
  if (!s || s.length > 2000) return [];
  const words = splitTop(s, " ");
  const low = s.toLowerCase();
  const out = [];
  const put = (p, v) => {
    if (v !== null && v !== undefined) out.push([p, v]);
  };
  const border = (v) => {
    if (low === "none" || low === "0" || low === "0px" || low === "hidden") {
      put("border-width", { value: 0, unit: "px", px: 0 });
      put("border-style", { style: "none" });
      return;
    }
    const b = parseBorder(v);
    if (!b) return;
    if (b.width) put("border-width", b.width);
    if (b.style) put("border-style", { style: b.style });
    if (b.color) put("border-color", b.color);
  };
  switch (prop) {
    case "background-color":
      put("background", parseColor(s));
      break;
    case "background":
    case "background-image":
      if (/gradient\(/i.test(s)) put("background", splitTop(s, ",").length > 1 && !/^[a-z-]*gradient\(/i.test(s) ? null : parseGradient(s));
      else if (prop === "background") {
        const c = words.map((w) => parseColor(w)).find(Boolean);
        put("background", c || null);
      }
      break;
    case "color":
      put("color", parseColor(s));
      break;
    case "border":
      border(s);
      break;
    case "border-width":
      if (words.length === 1) put("border-width", width(s));
      break;
    case "border-style":
      if (words.length === 1 && BORDER_STYLE_SET.has(low)) put("border-style", { style: low });
      break;
    case "border-color":
      if (words.length === 1) put("border-color", parseColor(s));
      break;
    case "border-radius": {
      const ws = words.filter((w) => w !== "/");
      if (ws.length && ws.every((w) => w === ws[0])) put("border-radius", normalizeValue("radius", ws[0]));
      break;
    }
    case "box-shadow":
      put("box-shadow", low === "none" ? [] : parseShadow(s));
      break;
    case "padding":
      if (words.length >= 1 && words.length <= 4) {
        put("padding-block", dim(words[0]));
        put("padding-inline", dim(words[1] || words[0]));
      }
      break;
    case "padding-block":
    case "padding-top":
    case "padding-block-start":
      put("padding-block", dim(words[0]));
      break;
    case "padding-inline":
    case "padding-left":
    case "padding-inline-start":
      put("padding-inline", dim(words[0]));
      break;
    case "gap":
    case "row-gap":
    case "grid-gap":
      put("gap", dim(words[0]));
      break;
    case "height":
    case "min-height":
    case "block-size": {
      const d = dim(s);
      if (d && d.px !== undefined) put("height", d);
      break;
    }
    case "font": {
      const f = parseFontShorthand(s);
      if (f) {
        put("font-size", f.size);
        put("line-height", f.lineHeight);
        put("font-weight", f.weight);
        put("font-family", f.family);
      }
      break;
    }
    case "font-family":
      put("font-family", parseFontFamily(s));
      break;
    case "font-size":
      put("font-size", normalizeValue("fontSize", s));
      break;
    case "font-weight":
      put("font-weight", parseFontWeight(s));
      break;
    case "line-height":
      if (low !== "normal") put("line-height", normalizeValue("lineHeight", s));
      break;
    case "letter-spacing":
      if (low !== "normal") put("letter-spacing", normalizeValue("letterSpacing", s));
      break;
    default:
      // A divider is often drawn by one side's border.
      if (kind === "divider" && SIDE_PROPS.has(prop)) border(s);
      break;
  }
  return out;
}

// ---------------------------------------------------------------- static: token names

const TOKEN_BLOCKS = new Map([...BLOCKS].filter(([w]) => !w.includes("-")));
const FILL_WORDS = new Set(["bg", "background", "fill", "surface"]);
const INK_WORDS = new Set(["fg", "foreground", "text", "ink", "label", "content"]);
const LINE_WORDS = new Set(["border", "outline", "stroke", "line"]);
const PAD_WORDS = new Set(["padding", "pad", "inset", "spacer"]);

// What a named token says about an object: {kind, variant|null, props} or
// null. "--card-radius" is a card's radius, "--btn-primary-bg" a primary
// button's fill, "--card" and "--card-foreground" a card's fill and text
// (the convention of several component kits), "--input" a text box's
// border color.
export function tokenObjectHint(name, type) {
  const words = String(name).replace(/^-+/, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length || words.length > 8) return null;
  let at = -1;
  for (let i = 0; i < words.length; i++) {
    if (TOKEN_BLOCKS.has(words[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const kind = TOKEN_BLOCKS.get(words[at]);
  let variant = kind === "heading" ? words[at] : kind === "input" ? (words[at] === "textarea" ? "textarea" : words[at] === "select" ? "select" : "text") : null;
  const rest = words.slice(at + 1);
  const vw = VARIANT_WORDS[kind];
  const has = (set) => rest.some((w) => set.has(w));
  if (vw) for (const w of rest) if (vw.has(w)) {
    variant = vw.get(w);
    break;
  }
  let props = [];
  switch (type) {
    case "color":
      if (has(FILL_WORDS)) props = ["background"];
      else if (has(LINE_WORDS)) props = ["border-color"];
      else if (has(INK_WORDS)) props = ["color"];
      else if (!rest.length || rest.every((w) => vw && vw.has(w))) props = [kind === "input" ? "border-color" : "background"];
      break;
    case "gradient": props = ["background"]; break;
    case "radius": props = ["border-radius"]; break;
    case "shadow": props = ["box-shadow"]; break;
    case "fontFamily": props = ["font-family"]; break;
    case "fontSize": props = ["font-size"]; break;
    case "fontWeight": props = ["font-weight"]; break;
    case "lineHeight": props = ["line-height"]; break;
    case "letterSpacing": props = ["letter-spacing"]; break;
    case "dimension":
      if (rest.includes("radius") || rest.includes("rounded") || rest.includes("corner")) props = ["border-radius"];
      else if (rest.includes("px") || (has(PAD_WORDS) && rest.some((w) => ["x", "inline", "h", "horizontal"].includes(w)))) props = ["padding-inline"];
      else if (rest.includes("py") || (has(PAD_WORDS) && rest.some((w) => ["y", "block", "v", "vertical"].includes(w)))) props = ["padding-block"];
      else if (has(PAD_WORDS)) props = ["padding-block", "padding-inline"];
      else if (rest.includes("gap") || rest.includes("spacing")) props = ["gap"];
      else if (rest.includes("height") || rest.includes("h") || rest.includes("size")) props = ["height"];
      else if (has(LINE_WORDS)) props = ["border-width"];
      break;
    default:
      break;
  }
  props = props.filter((p) => OBJECT_KIND_PROPS[kind].includes(p));
  return props.length ? { kind, variant, props } : null;
}

// ---------------------------------------------------------------- static: the build

const COMPONENT_OBJECTS = Object.freeze({
  button: ["button", null], input: ["input", "text"], textarea: ["input", "textarea"], select: ["input", "select"],
  card: ["card", null], badge: ["badge", null], avatar: ["avatar", null], divider: ["divider", null], link: ["link", null],
});
// The order variants are listed in, by kind.
const VARIANT_ORDER = Object.freeze({
  button: ["primary", "secondary", "ghost", "default"],
  input: ["text", "select", "textarea"],
  heading: ["h1", "h2", "h3"],
  badge: ["default", "pill"],
});

function addSource(list, src) {
  if (list.length >= TOKEN_LIMITS.objectSources) return;
  if (!list.some((x) => x.adapter === src.adapter && x.file === src.file && x.name === src.name)) list.push(src);
}

// The static object styles of a scan.
//   results   [{file, adapter: {id}, out: {usages, components}}] (checkOutput)
//   tokens    the document's tokens (final ids)
//   resolve   (raw) -> the value with its variables put in, or null
//   refIds    (raw) -> Set of the token ids the value refers to
export function staticObjects({ results = [], tokens = [], resolve = (r) => r, refIds = () => new Set() } = {}) {
  const match = tokenMatcher(tokens);
  const ids = new Set(tokens.map((t) => t.id));
  const kinds = new Map();
  const bucket = (kind) => {
    if (!kinds.has(kind)) kinds.set(kind, { base: [], variants: new Map(), tokenBase: new Map(), tokenVariants: new Map(), comps: [] });
    return kinds.get(kind);
  };
  const seenSel = new Map();
  const classify = (sel) => {
    if (seenSel.has(sel)) return seenSel.get(sel);
    const out = [];
    for (const part of selectorParts(sel)) {
      const c = classifySelector(part);
      if (c) out.push({ ...c, name: part });
    }
    if (seenSel.size < OBJECT_LIMITS.selectors) seenSel.set(sel, out);
    return out;
  };

  // Rules, in file order.
  let order = 0;
  for (const r of results) {
    if (!isFilePath(r.file)) continue;
    for (const u of r.out.usages || []) {
      if (!u.selector || u.narrow || u.prop === "class" || u.prop.startsWith("media-") || u.prop.startsWith("--")) continue;
      for (const c of classify(u.selector)) {
        const b = bucket(c.kind);
        const list = c.variant === null ? b.base : (b.variants.get(c.variant) || b.variants.set(c.variant, []).get(c.variant));
        if (list.length >= OBJECT_LIMITS.decls) continue;
        list.push({ prop: u.prop, raw: u.raw, file: r.file, line: u.line, adapter: r.adapter.id, name: c.name, order: order++ });
      }
    }
  }

  // Tokens named for an object.
  for (const t of tokens) {
    if (!t.value) continue;
    const named = t.sources.find((s) => s.name && s.file);
    if (!named) continue;
    const hint = tokenObjectHint(named.name, t.type);
    if (!hint) continue;
    const b = bucket(hint.kind);
    const map = hint.variant === null ? b.tokenBase : (b.tokenVariants.get(hint.variant) || b.tokenVariants.set(hint.variant, new Map()).get(hint.variant));
    for (const p of hint.props) {
      if (map.has(p) || checkObjectValue(p, t.id) === null) continue;
      map.set(p, { id: t.id, src: { adapter: named.adapter, file: named.file, line: named.line, name: named.name } });
    }
  }

  // Shared components in the library folders.
  for (const r of results) {
    if (!isFilePath(r.file)) continue;
    for (const c of r.out.components || []) {
      const m = COMPONENT_OBJECTS[c.kind];
      if (!m) continue;
      bucket(m[0]).comps.push({ variant: m[1], src: { adapter: r.adapter.id, file: r.file, line: c.line, name: c.export } });
    }
  }

  const out = [];
  for (const kind of OBJECT_KINDS) {
    const b = kinds.get(kind);
    if (!b) continue;
    const names = new Set([...b.variants.keys(), ...b.tokenVariants.keys()]);
    for (const c of b.comps) if (c.variant) names.add(c.variant);
    const hasBase = b.base.length > 0 || b.tokenBase.size > 0 || b.comps.length > 0;
    if (!names.size && hasBase) names.add(kind === "input" ? "text" : "default");
    const orderOf = VARIANT_ORDER[kind] || [];
    const variants = [...names].sort((x, y) => {
      const a = orderOf.indexOf(x) === -1 ? 99 : orderOf.indexOf(x);
      const c = orderOf.indexOf(y) === -1 ? 99 : orderOf.indexOf(y);
      return a - c || (x < y ? -1 : x > y ? 1 : 0);
    }).slice(0, OBJECT_LIMITS.perClass);
    for (const variant of variants) {
      const style = {};
      const sources = [];
      const rules = new Set();
      const own = b.variants.get(variant) || [];
      // Variables named for the object first; rules that style it win.
      for (const map of [b.tokenBase, b.tokenVariants.get(variant) || new Map()]) {
        for (const [p, x] of map) {
          style[p] = x.id;
          rules.add(`${x.src.file}|${x.src.name}`);
        }
      }
      for (const d of [...b.base, ...own]) {
        const text = resolve(d.raw);
        if (text === null) continue;
        const prefer = refIds(d.raw);
        for (const [p, v] of readDecl(kind, d.prop, text)) {
          if (!OBJECT_KIND_PROPS[kind].includes(p)) continue;
          const id = match(p, v, prefer, kind);
          const c = checkObjectValue(p, id && ids.has(id) ? id : v);
          if (c === null) continue;
          style[p] = c;
        }
        rules.add(`${d.file}|${d.name}`);
      }
      // Sources: the variant's own rules first, then the shared ones.
      for (const d of own) addSource(sources, { adapter: d.adapter, file: d.file, line: d.line, name: cleanName(d.name) || undefined });
      for (const d of b.base) addSource(sources, { adapter: d.adapter, file: d.file, line: d.line, name: cleanName(d.name) || undefined });
      for (const map of [b.tokenVariants.get(variant), b.tokenBase]) {
        if (map) for (const x of map.values()) addSource(sources, { ...x.src, name: cleanName(x.src.name) || undefined });
      }
      for (const c of b.comps) {
        if (c.variant && c.variant !== variant) continue;
        addSource(sources, c.src);
        rules.add(`${c.src.file}|${c.src.name}`);
      }
      if (!sources.length) continue;
      for (const s of sources) {
        if (s.name === undefined) delete s.name;
        if (!Number.isInteger(s.line) || s.line < 1) delete s.line;
      }
      out.push({ kind, variant, source: "static", count: Math.min(rules.size, TOKEN_LIMITS.count), style, sources });
    }
  }
  return out;
}

// The objects of a document: live ones first (linked to the static ones
// they match), then static ones, at most TOKEN_LIMITS.objects.
export function mergeObjects(live, statics, tokens) {
  const all = [...linkObjects(live, statics, tokens), ...statics];
  return all.slice(0, TOKEN_LIMITS.objects);
}

// For tests and the summary: "button primary, secondary; card default".
export function objectSummary(objects) {
  const by = new Map();
  for (const o of objects || []) {
    if (!isPlainObject(o)) continue;
    if (!by.has(o.kind)) by.set(o.kind, new Set());
    by.get(o.kind).add(o.variant);
  }
  return [...by].map(([k, v]) => `${k} ${[...v].join(", ")}`).join("; ");
}
