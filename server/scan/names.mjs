// Token names: the dotted id a token gets, the type a name and value
// suggest when the source does not say, and the role a color plays.

import {
  parseColor, parseHslChannels, parseLightDark, parseGradient, parseShadow, parseLength, parseDuration,
  parseEasing, parseFontFamily, parseFontWeight, parseNumber, parseBorder, fnCall, isComputedColor,
} from "../../client/core/css-values.js";

// The first segment of an id, by type.
export const TYPE_GROUP = Object.freeze({
  color: "color",
  gradient: "gradient",
  dimension: "size",
  fontFamily: "font",
  fontSize: "font-size",
  fontWeight: "font-weight",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  radius: "radius",
  shadow: "shadow",
  border: "border",
  opacity: "opacity",
  zIndex: "z-index",
  duration: "duration",
  easing: "easing",
  breakpoint: "breakpoint",
});

// Leading words that only repeat the type ("--color-brand", "fontSizes.lg"),
// compared without case, "-" or "_".
const PREFIX_WORDS = {
  color: ["color", "colors", "colour", "colours", "clr", "palette"],
  gradient: ["gradient", "gradients"],
  fontFamily: ["font", "fonts", "fontfamily", "fontfamilies", "family", "families", "typeface", "ff"],
  fontSize: ["fontsize", "fontsizes", "text", "textsize", "fs", "sizefont"],
  fontWeight: ["fontweight", "fontweights", "weight", "weights", "fw"],
  lineHeight: ["lineheight", "lineheights", "leading", "lh"],
  letterSpacing: ["letterspacing", "letterspacings", "tracking", "ls"],
  radius: ["radius", "radii", "rounded", "borderradius", "corner", "corners"],
  shadow: ["shadow", "shadows", "boxshadow", "elevation", "elevations"],
  border: ["border", "borders"],
  opacity: ["opacity", "opacities", "alpha"],
  zIndex: ["zindex", "zindices", "z", "layer", "layers"],
  duration: ["duration", "durations", "speed", "transitionduration"],
  easing: ["easing", "easings", "ease", "timing", "curve"],
  breakpoint: ["breakpoint", "breakpoints", "bp", "screen", "screens"],
};
const PREFIX_SETS = Object.fromEntries(Object.entries(PREFIX_WORDS).map(([k, v]) => [k, new Set(v)]));

// Families of plain lengths; the word becomes the id's first segment.
const DIMENSION_GROUPS = {
  spacing: "spacing", space: "spacing", spaces: "spacing", gap: "spacing", gutter: "spacing", inset: "spacing",
  padding: "spacing", margin: "spacing", size: "size", sizes: "size", sizing: "size", container: "container",
  containers: "container", width: "width", height: "height", layout: "layout",
};
export const SPACING_GROUPS = new Set(["spacing"]);

const norm = (s) => s.toLowerCase().replace(/[-_\s]/g, "");

// Words of a name, lower case: "--colorBrand-600" -> ["color", "brand", "600"].
export function words(name) {
  return String(name)
    .replace(/^-+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cleanSeg = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

// Segments of a source name: a CSS custom property splits at "-" and "_"
// ("--brand-600" -> brand, 600); a token-file path splits at "." only.
export function segmentsOf(name) {
  const s = String(name);
  const raw = s.startsWith("--") ? s.slice(2).split(/[-_]+/) : s.split(".");
  return raw.map(cleanSeg).filter(Boolean).slice(0, 11);
}

// The dotted id for a name: the type's group, then the name's own segments
// without the words that only repeat the type. group overrides the group
// (spacing for a length used as spacing); path gives the segments directly.
export function idFromName(name, type, { group = null, path = null } = {}) {
  let segs = path ? path.map(cleanSeg).filter(Boolean).slice(0, 11) : segmentsOf(name);
  let g = group || TYPE_GROUP[type] || "token";
  if (!path) {
    const set = PREFIX_SETS[type];
    if (type === "dimension" && !group && segs.length && DIMENSION_GROUPS[norm(segs[0])]) {
      g = DIMENSION_GROUPS[norm(segs[0])];
      segs = segs.slice(1);
    } else if (set) {
      if (segs.length >= 2 && set.has(norm(segs[0] + segs[1]))) segs = segs.slice(2);
      else if (segs.length && set.has(norm(segs[0]))) segs = segs.slice(1);
    }
    if (group && segs.length && DIMENSION_GROUPS[norm(segs[0])] === group) segs = segs.slice(1);
  }
  if (segs.length === 0) segs = ["default"];
  return [g, ...segs].slice(0, 12).join(".");
}

// ---------------------------------------------------------------- types

const has = (ws, ...list) => list.some((w) => ws.includes(w));
const hasPair = (ws, a, b) => {
  for (let i = 0; i + 1 < ws.length; i++) if (ws[i] === a && ws[i + 1] === b) return true;
  return false;
};

// The type a name suggests for a length or plain number, or null.
function typeHint(ws) {
  if (has(ws, "breakpoint", "breakpoints", "bp", "screen", "screens")) return "breakpoint";
  if (has(ws, "radius", "radii", "rounded", "corner", "corners")) return "radius";
  if (hasPair(ws, "font", "size") || has(ws, "fontsize", "fs") || (ws[0] === "text" && ws.length > 1)) return "fontSize";
  if (hasPair(ws, "line", "height") || has(ws, "leading", "lineheight", "lh")) return "lineHeight";
  if (hasPair(ws, "letter", "spacing") || has(ws, "tracking", "letterspacing")) return "letterSpacing";
  if (hasPair(ws, "font", "weight") || has(ws, "weight", "fontweight", "fw")) return "fontWeight";
  if (ws[0] === "z" || has(ws, "zindex", "layer")) return "zIndex";
  if (has(ws, "opacity", "alpha")) return "opacity";
  if (has(ws, "duration", "speed", "delay")) return "duration";
  if (has(ws, "ease", "easing", "timing")) return "easing";
  if (has(ws, "shadow", "elevation")) return "shadow";
  return null;
}

const RGB_TRIPLET_RE = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/;
const COLORISH = ["color", "colors", "bg", "background", "foreground", "fg", "text", "border", "primary", "secondary", "accent", "brand"];

// The type of a custom property or token from its name and literal value,
// or null when it is not a style value DFTP keeps.
export function inferType(name, raw) {
  const v = String(raw).trim();
  if (!v) return null;
  const ws = words(name);
  // A color-mix() or relative color is a color even when it cannot be
  // worked out; it is then kept with no value.
  if (parseLightDark(v) || parseColor(v) || parseHslChannels(v) || isComputedColor(v)) return "color";
  if (RGB_TRIPLET_RE.test(v) && has(ws, ...COLORISH) && v.split(/\s+/).every((n) => Number(n) <= 255)) return "color";
  const fn = fnCall(v);
  if (fn && fn.name.endsWith("-gradient") && parseGradient(v)) return "gradient";
  const hint = typeHint(ws);
  if (hint === "shadow" && parseShadow(v)) return "shadow";
  if (hint === "duration" && parseDuration(v)) return "duration";
  if (hint === "easing" && parseEasing(v)) return "easing";
  if (has(ws, "border") && !has(ws, "radius", "width") && parseBorder(v) && /\b(solid|dashed|dotted|double)\b/i.test(v)) return "border";
  const fontName = has(ws, "font", "fonts", "family", "typeface") && !hint;
  // Under a "font" name, a weight (700, bold) is a font weight, and a length
  // a font size: neither is a family.
  if (fontName && has(ws, "font", "fonts")) {
    const n = parseNumber(v);
    if (n !== null ? n >= 100 && n <= 1000 : /^(?:bold|normal|medium|semibold|light|regular|thin|black|extrabold|extralight)$/i.test(v)) {
      if (parseFontWeight(v)) return "fontWeight";
    }
  }
  if (fontName && parseFontFamily(v)) return "fontFamily";
  const dim = parseLength(v);
  if (fontName && has(ws, "font", "fonts") && dim && dim.unit !== "" && dim.px !== undefined) return "fontSize";
  if (dim) {
    if (dim.unit === "") {
      if (hint === "fontWeight" || hint === "zIndex" || hint === "opacity" || hint === "lineHeight") return hint;
      if (hint === "duration" || hint === "easing") return null;
      return dim.value === 0 && hint ? hint : null;
    }
    if (hint && !["fontWeight", "zIndex", "opacity", "duration", "easing", "shadow"].includes(hint)) return hint;
    return "dimension";
  }
  if (hint === "fontWeight" && /^(normal|bold|light|medium|semibold|regular)$/i.test(v)) return "fontWeight";
  // Without a name to go by, only a shadow with a color or "inset" is told
  // apart from a list of lengths such as a padding.
  const sh = parseShadow(v);
  if (sh && sh.some((l) => l.color || l.inset)) return "shadow";
  if (parseDuration(v) && /[0-9]m?s$/i.test(v)) return "duration";
  if (/^cubic-bezier\(/i.test(v) && parseEasing(v)) return "easing";
  const fam = parseFontFamily(v, { requireHint: true });
  if (fam && v.includes(",")) return "fontFamily";
  if (parseNumber(v) !== null && hint) return hint;
  return null;
}

// ---------------------------------------------------------------- roles

const PAIR_WORDS = new Set(["foreground", "fg", "on", "contrast", "inverse"]);
// Words for what a color is painted on (a background, text, a line) and for
// a step in a set of them: in "bg-primary" or "text-secondary" the first
// decides the role ("bg-primary" is the main background, not the primary
// color). A name that starts with the step ("primary-bg") keeps it.
const KIND_WORDS = new Set([
  "bg", "background", "surface", "canvas", "backdrop", "page", "text", "fg", "foreground", "ink", "copy",
  "border", "stroke", "outline", "divider", "separator",
]);
const RANK_WORDS = new Set(["primary", "secondary", "tertiary", "quaternary"]);
// A color for one state of something ("primary-hover") is not the role's own.
const STATE_WORDS = new Set(["hover", "hovered", "active", "pressed", "focus", "focused", "disabled", "visited"]);
const ROLE_WORDS = [
  ["primary", ["primary", "brand"]],
  ["secondary", ["secondary"]],
  ["accent", ["accent", "highlight"]],
  ["danger", ["danger", "destructive", "error", "critical", "negative"]],
  ["success", ["success", "positive", "valid"]],
  ["warning", ["warning", "warn", "caution"]],
  ["muted", ["muted", "subtle", "subdued"]],
  ["border", ["border", "stroke", "outline", "divider", "separator", "input"]],
  ["surface", ["surface", "card", "panel", "popover", "sheet", "paper", "elevated", "raised"]],
  ["background", ["background", "bg", "canvas", "backdrop", "page"]],
  ["text", ["foreground", "fg", "text", "ink", "body", "copy", "content"]],
];

// The role a color's name gives it, or null. A color named for the text
// that sits on another role ("primary-foreground") gets no role, except a
// muted text color.
export function roleFromName(name) {
  const ws = words(name).filter((w) => !["color", "colors", "clr", "palette"].includes(w));
  if (ws.length === 0 || ws.some((w) => STATE_WORDS.has(w))) return null;
  const roleOf = (w) => {
    for (const [role, list] of ROLE_WORDS) if (list.includes(w)) return role;
    return null;
  };
  // "foreground" or "fg" first is a text color ("fg-primary"); after another
  // word it is the text that sits on that one ("primary-foreground").
  const pairing = ws.some((w, i) => PAIR_WORDS.has(w) && (i > 0 || (w !== "foreground" && w !== "fg")));
  const others = ws.filter((w) => !PAIR_WORDS.has(w) && w !== "text").map(roleOf).filter(Boolean);
  if (pairing && others.length) return others.includes("muted") ? "muted" : null;
  const firstKind = ws.findIndex((w) => KIND_WORDS.has(w));
  const firstRank = ws.findIndex((w) => RANK_WORDS.has(w));
  const kindFirst = firstKind !== -1 && firstRank !== -1 && firstKind < firstRank;
  for (const [role, list] of ROLE_WORDS) {
    if (!ws.some((w) => list.includes(w))) continue;
    // A rank after a kind word is only a step; "brand" still means primary.
    if (kindFirst && (role === "secondary" || (role === "primary" && !ws.includes("brand")))) continue;
    return role;
  }
  return null;
}
