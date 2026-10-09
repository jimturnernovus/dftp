// New elements on blank pages. Shared by the designer window, the layer and
// the server, so it uses only standard JavaScript.
//
// A blank page is a generated document whose body holds one empty page
// frame, the scaffold (<main data-dftp-scaffold>). Elements added from the
// designer's palette are changes of kind "insert" (schema.js), drawn by the
// layer. Their look comes from the project's style tokens: every style of an
// element is a token id, carried by a custom property on the element
// (--dftp-s-<property>) whose value is that token's own custom property
// (--dftp-t-<id>) from the generated style sheet. The element's base rule in
// that style sheet reads --dftp-s-<property> and has a plain fallback, so a
// token that has gone since leaves the base look in place.

import {
  INSERT_ELEMENTS, INSERT_BOXES, INSERT_STYLE_PROPS, SCAFFOLD_KEY, isTokenRef, isComponentName, isFilePath,
} from "./schema.js";
import { pxOf } from "./tokens.js";

// Where the frame origin serves the style sheet made from the tokens.
export const TOKENS_CSS = "/__dftp/tokens.css";
export const SCAFFOLD_ATTR = "data-dftp-scaffold";
export const INSERT_ATTR = "data-dftp-ins";
export const KIND_ATTR = "data-dftp-el";
export const BOX_ATTR = "data-dftp-box";
export const COMPONENT_ATTR = "data-dftp-component";
// How deep boxes may nest inside the scaffold.
export const INSERT_DEPTH = 6;

// What each new element is: its tag, its name in the palette, the text it
// starts with (for an input, its placeholder), whether it holds other new
// elements, and the kind of shared component that would stand for it.
export const ELEMENTS = Object.freeze({
  heading: Object.freeze({ tag: "h2", label: "Heading", text: "Heading", box: false, kind: "heading" }),
  text: Object.freeze({ tag: "p", label: "Text", text: "Text", box: false, kind: "text" }),
  button: Object.freeze({ tag: "button", label: "Button", text: "Button", box: false, kind: "button" }),
  input: Object.freeze({ tag: "input", label: "Input", text: "Type here", box: false, kind: "input" }),
  card: Object.freeze({ tag: "div", label: "Card", text: null, box: true, kind: "card" }),
  image: Object.freeze({ tag: "div", label: "Image", text: null, box: false, kind: "image" }),
  divider: Object.freeze({ tag: "hr", label: "Divider", text: null, box: false, kind: "divider" }),
  section: Object.freeze({ tag: "section", label: "Section", text: null, box: true, kind: "container" }),
  grid: Object.freeze({ tag: "div", label: "Grid row", text: null, box: true, kind: "grid" }),
});

const BOX_SET = new Set(INSERT_BOXES);
const PROP_SET = new Set(INSERT_STYLE_PROPS);

export const isInsert = (c) => !!c && typeof c === "object" && c.kind === "insert";

// The custom property that holds a token's value in the generated style
// sheet. "." becomes "_d" and "_" becomes "_u", so two ids never share one.
export function tokenVar(id) {
  if (!isTokenRef(id)) return "";
  return `--dftp-t-${id.replace(/[._]/g, (ch) => (ch === "." ? "_d" : "_u"))}`;
}

// The custom property that carries one style of a new element.
export function styleVar(prop) {
  return PROP_SET.has(prop) ? `--dftp-s-${prop}` : "";
}

// The new elements of a change list in the order they are built: each with
// its depth, its parent's key, and its place (pos of of) among the parent's
// new elements. Elements whose parent is not in the list, is not a box, is
// nested too deep or loops back are left out of the order and returned as
// orphans.
export function insertTree(list) {
  const inserts = (Array.isArray(list) ? list : []).filter(isInsert);
  const kids = new Map();
  for (const c of inserts) {
    if (!kids.has(c.parent)) kids.set(c.parent, []);
    kids.get(c.parent).push(c);
  }
  // Array.prototype.sort is stable: equal indexes keep their list order.
  for (const arr of kids.values()) arr.sort((a, b) => a.index - b.index);
  const order = [];
  const seen = new Set();
  const walk = (parentKey, depth) => {
    const arr = (kids.get(parentKey) || []).filter((c) => !seen.has(c.key));
    arr.forEach((c, pos) => {
      seen.add(c.key);
      order.push({ c, depth, parent: parentKey, pos, of: arr.length });
      if (BOX_SET.has(c.element) && depth + 1 < INSERT_DEPTH) walk(c.key, depth + 1);
    });
  };
  walk(SCAFFOLD_KEY, 0);
  return { order, orphans: inserts.filter((c) => !seen.has(c.key)) };
}

// How deep a new element held by `parentKey` would sit (0: in the scaffold).
// -1 when the parent is not in the list.
export function depthUnder(list, parentKey) {
  if (parentKey === SCAFFOLD_KEY) return 0;
  const hit = insertTree(list).order.find((o) => o.c.key === parentKey);
  return hit ? hit.depth + 1 : -1;
}

// The new elements of another screen size's list, for a screen size that
// has none yet: the same elements (same ids, so CHANGES.md can tell they are
// one element), without the moves, sizes and hiding made for that size.
const SEED_KEEP = [
  "id", "key", "kind", "element", "tag", "parent", "index", "text", "styles", "component", "component_file",
  "text_from", "text_to", "text_attr", "text_multi", "inline", "at",
];
export function seedInserts(list) {
  return (Array.isArray(list) ? list : []).filter(isInsert).map((c) => {
    const o = {};
    for (const k of SEED_KEEP) if (c[k] !== undefined) o[k] = k === "styles" && c.styles ? { ...c.styles } : c[k];
    return o;
  });
}

// ---------------------------------------------------------------- picking tokens

const SPACE_WORDS = new Set(["spacing", "space", "gap", "gutter", "inset", "padding", "pad"]);
const segsOf = (id) => id.toLowerCase().split(".");
const usageOf = (t) => (t.usage && Number.isFinite(t.usage.count) ? t.usage.count : 0);
const confOf = (t) => (Number.isFinite(t.confidence) ? t.confidence : 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Most trusted first: confidence, then use, then a token that is not an
// alias of another, then id.
const byTrust = (a, b) => confOf(b) - confOf(a) || usageOf(b) - usageOf(a) || Number(!!a.aliasOf) - Number(!!b.aliasOf) || byId(a, b);
// Most used first.
const byUse = (a, b) => usageOf(b) - usageOf(a) || confOf(b) - confOf(a) || Number(!!a.aliasOf) - Number(!!b.aliasOf) || byId(a, b);

// Tokens with a value that apply to the whole page: one defined only inside
// a component's rule (scoped) is undefined anywhere else.
function tokensOf(doc) {
  const list = doc && typeof doc === "object" && Array.isArray(doc.tokens) ? doc.tokens : [];
  return list.filter((t) => t && typeof t === "object" && isTokenRef(t.id) && typeof t.type === "string" &&
    t.value !== null && typeof t.value === "object" && t.scoped !== true);
}

// Telling colors apart. A fill on the page must differ from the page color
// by a contrast ratio of at least 1.05 (white and #f4f4f5 do, white and
// #f9fafb do not), in light and, when both colors have one, in dark.
const HEX6_RE = /^#[0-9a-f]{6}$/;
const MIN_APART = 1.05;
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const alphaOf = (c) => (Number.isFinite(c.alpha) ? Math.min(1, Math.max(0, c.alpha)) : 1);
// [r, g, b] of color c laid over the opaque [r, g, b] under it.
const over = (c, under) => channels(c.hex).map((v, i) => v * alphaOf(c) + under[i] * (1 - alphaOf(c)));
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Whether fill f shows on page color p (both {hex, alpha}); the page is laid
// over `base` (white in light, black in dark).
function shows(f, p, base) {
  if (!f || !p || !HEX6_RE.test(f.hex) || !HEX6_RE.test(p.hex)) return true;
  const page = over(p, base);
  const a = luminance(over(f, page));
  const b = luminance(page);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= MIN_APART;
}
function apart(fill, page) {
  if (!page) return true;
  if (fill === page || !shows(fill.value, page.value, [255, 255, 255])) return false;
  const fd = fill.modes && fill.modes.dark;
  const pd = page.modes && page.modes.dark;
  return !(fd && pd) || shows(fd, pd, [0, 0, 0]);
}

// The token whose size is closest to `want` px (as a ratio), within
// [want * lo, want * hi]; ties go to the more trusted one.
function nearestPx(list, want, lo = 0.6, hi = 1.6) {
  let best = null;
  let bestD = Infinity;
  for (const t of list) {
    const p = pxOf(t.value);
    if (p === null || p <= 0 || p < want * lo || p > want * hi) continue;
    const d = Math.abs(Math.log(p / want));
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && byTrust(t, best) < 0)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

function nearestNumber(list, want, lo, hi, read) {
  let best = null;
  let bestD = Infinity;
  for (const t of list) {
    const v = read(t.value);
    if (!Number.isFinite(v) || v < lo || v > hi) continue;
    const d = Math.abs(v - want);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && byTrust(t, best) < 0)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

// The tokens a blank page is built from: colors by role, the body and
// heading font families, the body text size, the most used radius and
// shadow, and the spacing, font-size, weight and line-height tokens to
// choose sizes from. The body family and size are the ones the scan found
// set on the page root (role "text"), else guessed from names and use.
export function themeTokens(doc) {
  const ts = tokensOf(doc);
  const colors = ts.filter((t) => t.type === "color").sort(byTrust);
  const role = (r) => colors.find((t) => t.role === r) || null;
  const families = ts.filter((t) => t.type === "fontFamily").sort(byUse);
  const famBy = (words) => families.find((t) => segsOf(t.id).some((s) => words.includes(s))) || null;
  const body = families.find((t) => t.role === "text") || famBy(["sans", "body", "base", "text", "copy", "ui", "default"]) || families[0] || null;
  const bodySize = ts.filter((t) => t.type === "fontSize" && t.role === "text" && (pxOf(t.value) || 0) >= 10 && pxOf(t.value) <= 24).sort(byUse)[0] || null;
  const heading = famBy(["heading", "headings", "display", "title", "serif"]) || body;
  const radii = ts.filter((t) => t.type === "radius" && (pxOf(t.value) || 0) > 0 && pxOf(t.value) < 1000)
    .sort((a, b) => usageOf(b) - usageOf(a) || Number(!!a.aliasOf) - Number(!!b.aliasOf) ||
      Math.abs(pxOf(a.value) - 8) - Math.abs(pxOf(b.value) - 8) || byId(a, b));
  const shadows = ts.filter((t) => t.type === "shadow").sort(byUse);
  const onPrimary = colors.find((t) => /(^|\.)(primary[.-](foreground|fg|contrast|content|text|on)|on[.-]primary)$/.test(t.id.toLowerCase())) || null;
  const mutedBg = colors.find((t) => t.role === "muted" && !/(foreground|fg|text|ink)/.test(t.id.toLowerCase())) || null;
  const background = role("background");
  const surface = role("surface");
  // The page itself is drawn in the background color, or the surface color
  // when there is none. An image placeholder is filled with the muted or
  // the surface color, unless that cannot be told from the page's (the same
  // token, or one too close to it): it then keeps its base look, a tint of
  // the text color.
  const page = background || surface;
  const placeholder = [mutedBg, surface].find((t) => t && apart(t, page)) || null;
  return {
    primary: role("primary"),
    onPrimary,
    text: role("text"),
    background,
    surface,
    border: role("border"),
    muted: role("muted"),
    mutedBg,
    placeholder,
    body,
    bodySize,
    heading,
    radius: radii[0] || null,
    shadow: shadows[0] || null,
    spacing: ts.filter((t) => t.type === "dimension" && segsOf(t.id).some((s) => SPACE_WORDS.has(s))),
    fontSizes: ts.filter((t) => t.type === "fontSize"),
    weights: ts.filter((t) => t.type === "fontWeight"),
    lineHeights: ts.filter((t) => t.type === "lineHeight" && t.value.unit === ""),
  };
}

// The token styles a new element of kind `element` starts with:
// {property: token id}. Role colors (primary button, text color, borders),
// the most used radius, sizes from the spacing and type scales, and the body
// or heading font. Properties with no fitting token are left out; the
// element's base rule covers them.
export function pickStyles(doc, element) {
  const T = themeTokens(doc);
  const out = {};
  const put = (prop, t) => {
    if (t && isTokenRef(t.id) && PROP_SET.has(prop)) out[prop] = t.id;
  };
  const space = (px) => nearestPx(T.spacing, px);
  const size = (px) => nearestPx(T.fontSizes, px, 0.8, 1.25);
  const weight = (w, lo, hi) => nearestNumber(T.weights, w, lo, hi, (v) => v.value);
  switch (element) {
    case "heading":
      put("color", T.text);
      put("font-family", T.heading);
      put("font-size", nearestPx(T.fontSizes, 30, 0.75, 1.5));
      put("font-weight", weight(700, 600, 1000));
      break;
    case "text":
      put("color", T.text);
      put("font-family", T.body);
      put("font-size", T.bodySize || size(16));
      put("line-height", nearestNumber(T.lineHeights, 1.5, 1.3, 1.8, (v) => v.value));
      break;
    case "button":
      put("background", T.primary);
      put("color", T.onPrimary);
      put("border-radius", T.radius);
      put("font-family", T.body);
      put("font-size", size(14));
      // A heavy weight elsewhere on the page (a price, a heading) is not a
      // button's; nothing near 500 leaves the button's own look.
      put("font-weight", weight(500, 400, 600));
      put("padding-block", space(8));
      put("padding-inline", space(16));
      break;
    case "input":
      put("background", T.surface || T.background);
      put("color", T.text);
      put("border-color", T.border);
      put("border-radius", T.radius);
      put("font-family", T.body);
      put("font-size", T.bodySize || size(16));
      put("padding-block", space(8));
      put("padding-inline", space(12));
      break;
    case "card":
      put("background", T.surface || T.background);
      put("color", T.text);
      put("border-color", T.border);
      put("border-radius", T.radius);
      put("box-shadow", T.shadow);
      put("padding-block", space(24));
      put("padding-inline", space(24));
      put("gap", space(12));
      break;
    case "image":
      put("background", T.placeholder);
      put("border-radius", T.radius);
      break;
    case "divider":
      put("border-color", T.border);
      break;
    case "section":
      put("padding-block", space(32));
      put("gap", space(16));
      break;
    case "grid":
      put("gap", space(16));
      break;
    default:
      break;
  }
  return out;
}

// The project's own component for a new element, from the style scan's
// list of shared components: {export, file} or null.
export function componentFor(doc, element) {
  const def = ELEMENTS[element];
  if (!def || !doc || typeof doc !== "object" || !Array.isArray(doc.components)) return null;
  const c = doc.components.find((x) => x && x.kind === def.kind && isComponentName(x.export) && isFilePath(x.file));
  return c ? { export: c.export, file: c.file } : null;
}

// Every kind in schema.js has a description here.
export const PALETTE = Object.freeze(INSERT_ELEMENTS.filter((k) => ELEMENTS[k]));
