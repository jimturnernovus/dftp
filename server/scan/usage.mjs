// Which style properties the scan counts, and what typed values a literal
// property value holds. Used for declarations found in files and for the
// computed styles the live sample reports, so both are counted the same way.

import {
  splitTop, parseColor, parseGradient, parseBorder, parseShadow, parseDimension, parseFontFamily,
  parseFontWeight, parseDuration, parseEasing, parseOpacity, parseZIndex, fnCall, stripImportant, parseFontShorthand,
} from "../../client/core/css-values.js";

const COLOR_PROPS = new Set([
  "color", "background-color", "border-color", "border-top-color", "border-right-color", "border-bottom-color",
  "border-left-color", "border-block-color", "border-inline-color", "border-block-start-color",
  "border-block-end-color", "border-inline-start-color", "border-inline-end-color", "outline-color", "fill",
  "stroke", "caret-color", "accent-color", "text-decoration-color", "column-rule-color", "stop-color",
  "flood-color", "-webkit-text-fill-color",
]);
const BORDER_PROPS = new Set([
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-block", "border-inline",
  "border-block-start", "border-block-end", "border-inline-start", "border-inline-end", "outline",
]);
const RADIUS_PROPS = new Set([
  "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius",
  "border-bottom-right-radius", "border-start-start-radius", "border-start-end-radius",
  "border-end-start-radius", "border-end-end-radius",
]);
const SPACING_PROPS = new Set([
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-block", "margin-inline",
  "margin-block-start", "margin-block-end", "margin-inline-start", "margin-inline-end",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "padding-block", "padding-inline",
  "padding-block-start", "padding-block-end", "padding-inline-start", "padding-inline-end",
  "gap", "row-gap", "column-gap", "grid-gap", "grid-row-gap", "grid-column-gap",
]);
const SIMPLE = {
  font: "font",
  background: "background",
  "background-image": "gradient",
  "box-shadow": "shadow",
  "font-family": "fontFamily",
  "font-size": "fontSize",
  "font-weight": "fontWeight",
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "z-index": "zIndex",
  opacity: "opacity",
  transition: "transition",
  animation: "transition",
  "transition-duration": "duration",
  "animation-duration": "duration",
  "transition-timing-function": "easing",
  "animation-timing-function": "easing",
  "border-width": "borderWidth",
};

// The kind of value a property holds, or null when the scan ignores it.
export function propKind(prop) {
  const p = String(prop).toLowerCase();
  if (COLOR_PROPS.has(p)) return "color";
  if (BORDER_PROPS.has(p)) return "border";
  if (RADIUS_PROPS.has(p)) return "radius";
  if (SPACING_PROPS.has(p)) return "spacing";
  return Object.prototype.hasOwnProperty.call(SIMPLE, p) ? SIMPLE[p] : null;
}

export const isStyleProp = (prop) => propKind(prop) !== null;

// How a color is used, for guessing roles: text, a fill behind content, or
// a line around it.
export function colorUse(prop) {
  const p = String(prop).toLowerCase();
  if (p === "color" || p === "-webkit-text-fill-color") return "fg";
  if (p === "background" || p === "background-color") return "bg";
  if (p.startsWith("border") || p.startsWith("outline")) return "border";
  return null;
}

const visible = (c) => c && c.alpha > 0;

// Typed values of a literal value: [{type, value, group}]. group names the
// family a value belongs to (spacing for margins, padding and gaps). A value
// that refers to a custom property is not literal; callers count those
// references instead.
export function usageValues(prop, raw) {
  const kind = propKind(prop);
  if (!kind || typeof raw !== "string" || raw.length > 4000) return [];
  const s = stripImportant(raw.trim());
  if (!s || s.length > 2000) return [];
  const out = [];
  const add = (type, value, group = null) => {
    if (value !== null && value !== undefined) out.push({ type, value, group });
  };
  switch (kind) {
    case "color":
      for (const w of splitTop(s, " ")) {
        const c = parseColor(w);
        if (visible(c)) add("color", c);
      }
      break;
    case "background":
      for (const layer of splitTop(s, ",")) {
        for (const w of splitTop(layer, " ")) {
          const fn = fnCall(w);
          if (fn && fn.name.endsWith("-gradient")) add("gradient", parseGradient(w));
          else {
            const c = parseColor(w);
            if (visible(c)) add("color", c);
          }
        }
      }
      break;
    case "gradient":
      for (const layer of splitTop(s, ",")) add("gradient", parseGradient(layer));
      break;
    case "border": {
      const b = parseBorder(s);
      if (b && !(b.width && b.width.value === 0)) {
        add("border", b);
        if (visible(b.color)) add("color", b.color);
      }
      break;
    }
    case "radius":
      for (const w of splitTop(s, " ")) {
        if (w === "/") continue;
        const d = parseDimension(w, { unitless: false });
        if (d && d.value > 0) add("radius", d);
      }
      break;
    case "spacing":
      for (const w of splitTop(s, " ")) {
        const d = parseDimension(w, { unitless: false });
        if (d && d.value > 0) add("dimension", d, "spacing");
      }
      break;
    case "borderWidth":
      for (const w of splitTop(s, " ")) {
        const d = parseDimension(w, { unitless: false });
        if (d && d.value > 0) add("dimension", d, "border-width");
      }
      break;
    case "shadow":
      if (s.toLowerCase() !== "none") add("shadow", parseShadow(s));
      break;
    case "fontFamily":
      add("fontFamily", parseFontFamily(s));
      break;
    case "font": {
      // The shorthand counts as its parts.
      const f = parseFontShorthand(s);
      if (!f) break;
      if (f.size && f.size.value > 0) add("fontSize", f.size);
      if (f.lineHeight && f.lineHeight.value > 0) add("lineHeight", f.lineHeight);
      add("fontWeight", f.weight);
      add("fontFamily", f.family);
      break;
    }
    case "fontSize": {
      const d = parseDimension(s, { unitless: false });
      if (d && d.value > 0) add("fontSize", d);
      break;
    }
    case "fontWeight":
      add("fontWeight", parseFontWeight(s));
      break;
    case "lineHeight": {
      const d = s.toLowerCase() === "normal" ? null : parseDimension(s);
      if (d && d.value > 0) add("lineHeight", d);
      break;
    }
    case "letterSpacing": {
      const d = s.toLowerCase() === "normal" ? null : parseDimension(s, { unitless: false });
      if (d && d.value !== 0) add("letterSpacing", d);
      break;
    }
    case "zIndex":
      add("zIndex", parseZIndex(s));
      break;
    case "opacity": {
      const o = parseOpacity(s);
      if (o && o.value < 1) add("opacity", o);
      break;
    }
    case "duration":
      for (const w of splitTop(s, ",")) {
        const d = parseDuration(w);
        if (d && d.ms > 0) add("duration", d);
      }
      break;
    case "easing":
      for (const w of splitTop(s, ",")) add("easing", parseEasing(w));
      break;
    case "transition":
      for (const layer of splitTop(s, ",")) {
        let dur = null;
        let ease = null;
        for (const w of splitTop(layer, " ")) {
          if (!dur) {
            const d = parseDuration(w);
            if (d && d.ms > 0 && /[a-z]$/i.test(w)) {
              dur = d;
              continue;
            }
          }
          if (!ease) ease = parseEasing(w);
        }
        add("duration", dur);
        add("easing", ease);
      }
      break;
    default:
      break;
  }
  return out;
}

const VAR_NAME_RE = /^--[A-Za-z0-9_-]{1,200}$/;
const isWordChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;

// Every var(--name ...) in a value: [{name, start, end, fallback}] where
// start..end covers "var(...)" and fallback is the text after the first
// top-level comma, or null. Nested references (in a fallback, or inside
// another function) are found too, outermost first. One pass over the text
// with a stack of open parentheses, so nesting never costs a second pass.
export function findVarRefs(text, max = 64) {
  const s = String(text);
  const found = [];
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 40) {
      const isVar = i >= 3 && (s.charCodeAt(i - 1) | 32) === 114 && (s.charCodeAt(i - 2) | 32) === 97 && (s.charCodeAt(i - 3) | 32) === 118 &&
        !(i > 3 && isWordChar(s.charCodeAt(i - 4)));
      if (stack.length < 1000) stack.push({ at: isVar ? i - 3 : -1, comma: -1 });
      else stack.push(null);
    } else if (c === 41) {
      const f = stack.pop();
      if (f && f.at !== -1) {
        const name = s.slice(f.at + 4, f.comma === -1 ? i : f.comma).trim();
        if (VAR_NAME_RE.test(name)) found.push({ name, start: f.at, end: i + 1, fallback: f.comma === -1 ? null : s.slice(f.comma + 1, i).trim() });
      }
    } else if (c === 44 && stack.length) {
      const f = stack[stack.length - 1];
      if (f && f.comma === -1) f.comma = i;
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found.length > max ? found.slice(0, max) : found;
}

// The whole value is one reference: "var(--x)" or "var(--x, fallback)".
export function wholeVarRef(text) {
  const s = String(text).trim();
  const refs = findVarRefs(s, 1);
  return refs.length && refs[0].start === 0 && refs[0].end === s.length ? refs[0] : null;
}

// Every {path.to.token} in a token-file value: [{name, start, end}].
export function findBraceRefs(text, max = 64) {
  const s = String(text);
  const out = [];
  let from = 0;
  let b = -1;
  while (out.length < max) {
    const a = s.indexOf("{", from);
    if (a === -1) break;
    // The next "}" is looked up again only once it lies behind, so a run of
    // "{" costs one pass.
    if (b < a) b = s.indexOf("}", a + 1);
    if (b === -1) break;
    // Only a short stretch is looked at, so a long run of "{" stays linear.
    const inner = b - a <= 202 ? s.slice(a + 1, b).trim() : "";
    if (inner.length > 0 && inner.length <= 200 && !inner.includes("{") && /^[^\s"'`<>\\]+$/.test(inner)) {
      out.push({ name: inner.replace(/\.value$/, ""), start: a, end: b + 1 });
    }
    from = a + 1;
  }
  return out;
}

export function wholeBraceRef(text) {
  const s = String(text).trim();
  const refs = findBraceRefs(s, 1);
  return refs.length && refs[0].start === 0 && refs[0].end === s.length ? refs[0] : null;
}
