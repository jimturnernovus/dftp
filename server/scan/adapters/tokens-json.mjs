// Token files in JSON: the Design Tokens Community Group format ($value,
// $type, nested groups, {path.to.token} references), the Style Dictionary
// form (value, type; a "size" category of plain numbers is in rem, as its
// size/rem transform makes it), Tokens Studio exports (token sets: the set
// names are not part of a token's path, and a set named for the dark theme
// holds dark values), WordPress theme.json files (the presets under
// "settings" as the --wp--preset--* variables WordPress makes of them; the
// "styles" part is read as uses of those, not as definitions) and common
// theme objects (colors, space, fontSizes, radii, shadows, breakpoints ...
// including lists of {slug, color} entries). Composite values are written
// out as the CSS text they stand for, so the scanner normalises every token
// the same way.

import { getKey as get } from "../json-parse.mjs";

const MAX_TOKENS = 5000;
const FILE_RE = /(?:^|\/)(?:[^/]+\.tokens(?:\.json)?|tokens\.json|design-tokens[^/]*\.json|theme[^/]*\.json)$/i;
const DIR_RE = /(?:^|\/)(?:design-)?tokens\/(?:[^/]+\/)*[^/]+\.json$/i;

// DTCG and Tokens Studio type names -> [token type, group, unit of a plain
// number written as a string]. Tokens Studio writes sizes as plain numbers
// ("16") meaning px.
const TYPES = {
  color: ["color"],
  dimension: ["dimension", null, "px"],
  fontfamily: ["fontFamily"],
  fontfamilies: ["fontFamily"],
  fontweight: ["fontWeight"],
  fontweights: ["fontWeight"],
  fontsize: ["fontSize", null, "px"],
  fontsizes: ["fontSize", null, "px"],
  lineheight: ["lineHeight"],
  lineheights: ["lineHeight"],
  letterspacing: ["letterSpacing"],
  duration: ["duration"],
  cubicbezier: ["easing"],
  border: ["border"],
  shadow: ["shadow"],
  boxshadow: ["shadow"],
  gradient: ["gradient"],
  borderradius: ["radius", null, "px"],
  radius: ["radius", null, "px"],
  spacing: ["dimension", "spacing", "px"],
  sizing: ["dimension", "size", "px"],
  borderwidth: ["dimension", "border-width", "px"],
  opacity: ["opacity"],
  number: [null],
  typography: ["typography"],
  transition: ["transition"],
};

// Theme object groups, by key without case, "-" or "_".
const GROUPS = {
  colors: ["color", "color"],
  color: ["color", "color"],
  palette: ["color", "color"],
  gradients: ["gradient", "gradient"],
  space: ["dimension", "spacing"],
  spaces: ["dimension", "spacing"],
  spacing: ["dimension", "spacing"],
  spacingsizes: ["dimension", "spacing"],
  sizes: ["dimension", "size"],
  fontsizes: ["fontSize", "fontSize"],
  fontsize: ["fontSize", "fontSize"],
  fonts: ["fontFamily", "font"],
  fontfamily: ["fontFamily", "font"],
  fontfamilies: ["fontFamily", "font"],
  fontweights: ["fontWeight", "fontWeight"],
  lineheights: ["lineHeight", "lineHeight"],
  letterspacings: ["letterSpacing", "letterSpacing"],
  radii: ["radius", "radius"],
  radius: ["radius", "radius"],
  borderradius: ["radius", "radius"],
  shadows: ["shadow", "shadow"],
  boxshadow: ["shadow", "shadow"],
  breakpoints: ["breakpoint", "breakpoint"],
  screens: ["breakpoint", "breakpoint"],
  zindices: ["zIndex", "zIndex"],
  zindex: ["zIndex", "zIndex"],
  opacity: ["opacity", "opacity"],
  opacities: ["opacity", "opacity"],
  durations: ["duration", "duration"],
};
const ENTRY_VALUE_KEYS = ["color", "gradient", "size", "fontFamily", "value", "shadow"];
const SD_KEYS = new Set(["value", "type", "comment", "description", "attributes", "name", "themeable", "original", "path", "filePath", "isSource", "$type", "$description"]);
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji"]);
const COLOR_SPACES = new Set(["srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020", "xyz", "xyz-d50", "xyz-d65"]);
const COLOR_FNS = new Set(["hsl", "hwb", "lab", "lch", "oklab", "oklch"]);

const norm = (s) => String(s).toLowerCase().replace(/[-_\s]/g, "");
const num = (n) => (Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : null);
const PLAIN_NUMBER_RE = /^[+-]?(?:\d{1,9}(?:\.\d{0,9})?|\.\d{1,9})$/;

export function modeFromPath(relPath) {
  const ws = String(relPath).toLowerCase().split(/[^a-z0-9]+/);
  if (ws.includes("dark")) return "dark";
  return null;
}

// Style Dictionary's "size" category (CTI: category, type, item): plain
// numbers in rem; the second segment says what kind of size it is.
const SIZE_KINDS = {
  font: ["fontSize"], fontsize: ["fontSize"], text: ["fontSize"],
  padding: ["dimension", "spacing"], margin: ["dimension", "spacing"], spacing: ["dimension", "spacing"],
  space: ["dimension", "spacing"], gap: ["dimension", "spacing"], gutter: ["dimension", "spacing"],
  radius: ["radius"], borderradius: ["radius"], border: ["dimension", "border-width"], borderwidth: ["dimension", "border-width"],
  lineheight: ["lineHeight"], leading: ["lineHeight"],
};

// ---------------------------------------------------------------- values as CSS text

function dimText(node, defaultUnit = "px") {
  if (!node) return null;
  if (node.t === "str") return node.v;
  if (node.t === "num") return `${num(node.v)}${node.v === 0 ? "" : defaultUnit}`;
  if (node.t === "obj") {
    const v = get(node, "value");
    const u = get(node, "unit");
    if (v && v.t === "num" && u && u.t === "str" && /^[a-z%]{0,6}$/i.test(u.v)) return `${num(v.v)}${u.v}`;
  }
  return null;
}

function colorText(node) {
  if (!node) return null;
  if (node.t === "str") return node.v;
  if (node.t !== "obj") return null;
  const hex = get(node, "hex");
  const space = get(node, "colorSpace");
  const comps = get(node, "components");
  const alpha = get(node, "alpha");
  const a = alpha && alpha.t === "num" ? ` / ${num(alpha.v)}` : "";
  if (space && space.t === "str" && comps && comps.t === "arr" && comps.items.length === 3) {
    const c = comps.items.map((x) => (x.t === "num" ? num(x.v) : x.t === "str" && x.v === "none" ? "none" : null));
    if (c.every((x) => x !== null)) {
      const sp = space.v.toLowerCase();
      if (COLOR_SPACES.has(sp)) return `color(${sp} ${c.join(" ")}${a})`;
      if (COLOR_FNS.has(sp)) {
        const parts = sp === "hsl" || sp === "hwb" ? [c[0], `${c[1]}%`, `${c[2]}%`] : c;
        return `${sp}(${parts.join(" ")}${a})`;
      }
    }
  }
  if (hex && hex.t === "str") return hex.v;
  return null;
}

const quoteFamily = (f) => (GENERIC.has(f.toLowerCase()) || !/\s/.test(f) ? f : `"${f.replace(/["\\]/g, "")}"`);

function shadowLayer(node) {
  if (!node || node.t !== "obj") return node && node.t === "str" ? node.v : null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = get(node, k);
      if (v) return v;
    }
    return null;
  };
  const x = dimText(pick("offsetX", "x"));
  const y = dimText(pick("offsetY", "y"));
  const blur = dimText(pick("blur")) || "0";
  const spread = dimText(pick("spread")) || "0";
  const color = colorText(pick("color"));
  const insetNode = get(node, "inset");
  const typeNode = get(node, "type");
  const inset = (insetNode && insetNode.t === "bool" && insetNode.v) || (typeNode && typeNode.t === "str" && /inner/i.test(typeNode.v));
  if (x === null || y === null) return null;
  return `${inset ? "inset " : ""}${x} ${y} ${blur} ${spread}${color ? ` ${color}` : ""}`;
}

// The CSS text of a token value of `type`, or null.
function valueText(type, node) {
  if (!node) return null;
  switch (type) {
    case "color":
      return colorText(node);
    case "fontFamily":
      if (node.t === "arr") {
        const names = node.items.filter((x) => x.t === "str").map((x) => quoteFamily(x.v));
        return names.length ? names.join(", ") : null;
      }
      return node.t === "str" ? node.v : null;
    case "easing":
      if (node.t === "arr" && node.items.length === 4 && node.items.every((x) => x.t === "num")) {
        return `cubic-bezier(${node.items.map((x) => num(x.v)).join(", ")})`;
      }
      return node.t === "str" ? node.v : null;
    case "duration":
      return dimText(node, "ms");
    case "fontWeight":
    case "opacity":
    case "zIndex":
    case "lineHeight":
      if (node.t === "num") return num(node.v);
      return type === "lineHeight" ? dimText(node, "") : node.t === "str" ? node.v : null;
    case "shadow":
      if (node.t === "arr") {
        const layers = node.items.map(shadowLayer);
        return layers.length && layers.every(Boolean) ? layers.join(", ") : null;
      }
      return shadowLayer(node);
    case "border": {
      if (node.t !== "obj") return node.t === "str" ? node.v : null;
      const w = dimText(get(node, "width"));
      const s = get(node, "style");
      const c = colorText(get(node, "color"));
      const style = s && s.t === "str" ? s.v : "solid";
      return [w, style, c].filter(Boolean).join(" ") || null;
    }
    case "gradient":
      if (node.t === "arr") {
        const stops = node.items.map((st) => {
          if (st.t !== "obj") return null;
          const c = colorText(get(st, "color"));
          const p = get(st, "position");
          if (!c) return null;
          return p && p.t === "num" ? `${c} ${num(p.v * 100)}%` : c;
        });
        return stops.length >= 2 && stops.every(Boolean) ? `linear-gradient(${stops.join(", ")})` : null;
      }
      return node.t === "str" ? node.v : null;
    case null:
      if (node.t === "num") return num(node.v);
      return node.t === "str" ? node.v : null;
    default:
      return dimText(node);
  }
}

// ---------------------------------------------------------------- walkers

function emit(ctx, t) {
  if (ctx.out.tokens.length >= MAX_TOKENS) {
    ctx.capped = true;
    return;
  }
  ctx.out.tokens.push(t);
}

function tokenFrom(ctx, { name, type, group, path, node, off, mode, sub, bare }) {
  let raw = valueText(type, node);
  if (raw === null || raw === "") return;
  // A plain number written as a string, for a type whose numbers are lengths.
  if (bare && node.t === "str" && PLAIN_NUMBER_RE.test(raw.trim()) && Number(raw) !== 0) raw = `${raw.trim()}${bare}`;
  const { line, col } = ctx.pos(off);
  const t = { name: sub ? `${name}.${sub}` : name, raw, line, col };
  if (type) t.type = type;
  if (group) t.group = group;
  if (path) t.path = path;
  const m = mode || ctx.fileMode;
  if (m) t.mode = m;
  const ref = ctx.helpers.wholeBraceRef(raw);
  if (ref) t.aliasRef = ref.name;
  emit(ctx, t);
}

const COMPOSITE_PREFIX = new Set(["typography", "type", "text", "font", "fonts", "transition", "transitions", "motion"]);

// A typography or transition composite becomes one token per part.
function splitComposite(ctx, kind, { name, path, node, off, mode }) {
  if (node.t !== "obj") return;
  let p = [...path];
  while (p.length > 1 && COMPOSITE_PREFIX.has(p[0].toLowerCase())) p = p.slice(1);
  const parts = kind === "typography"
    ? [["fontFamily", "fontFamily"], ["fontSize", "fontSize"], ["fontWeight", "fontWeight"], ["lineHeight", "lineHeight"], ["letterSpacing", "letterSpacing"]]
    : [["duration", "duration"], ["timingFunction", "easing"]];
  for (const [key, type] of parts) {
    const v = get(node, key);
    if (v) tokenFrom(ctx, { name, type, path: p, node: v, off, mode, sub: key });
  }
}

function typeOf(node) {
  const t = node && node.t === "str" ? TYPES[norm(node.v)] : undefined;
  return t || null;
}

function dtcgToken(ctx, path, node, off, inherited) {
  const own = typeOf(get(node, "$type"));
  const [type, group, bare] = own || inherited || [null];
  const name = path.join(".");
  const value = get(node, "$value");
  const emitOne = (v, mode) => {
    if (type === "typography" || type === "transition") splitComposite(ctx, type, { name, path, node: v, off, mode });
    else tokenFrom(ctx, { name, type, group, node: v, off, mode, bare });
  };
  emitOne(value, null);
  const ext = get(node, "$extensions");
  const modes = ext && (get(ext, "mode") || get(ext, "modes"));
  if (modes && modes.t === "obj") {
    for (const e of modes.entries.slice(0, 8)) {
      const m = e.k.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
      if (/^[a-z]/.test(m) && m !== "light") emitOne(e.v, m);
    }
  }
}

function walkDtcg(ctx, node, path, inherited, depth) {
  if (!node || node.t !== "obj" || depth > 32 || ctx.capped) return;
  const groupType = typeOf(get(node, "$type")) || inherited;
  for (const e of node.entries) {
    if (e.k.startsWith("$") || e.v.t !== "obj") continue;
    const p = [...path, e.k];
    if (get(e.v, "$value")) dtcgToken(ctx, p, e.v, e.off, groupType);
    else walkDtcg(ctx, e.v, p, groupType, depth + 1);
  }
}

function isSdLeaf(node) {
  if (!node || node.t !== "obj") return false;
  const v = get(node, "value");
  if (!v) return false;
  return node.entries.every((e) => SD_KEYS.has(e.k));
}

function walkSd(ctx, node, path, depth) {
  if (!node || node.t !== "obj" || depth > 32 || ctx.capped) return;
  for (const e of node.entries) {
    if (e.v.t !== "obj") continue;
    const p = [...path, e.k];
    if (isSdLeaf(e.v)) {
      const t = typeOf(get(e.v, "type")) || typeOf(get(e.v, "$type"));
      let [type, group, bare] = t || [null];
      const name = p.join(".");
      const value = get(e.v, "value");
      let path = null;
      if (!t) {
        const cat = get(get(e.v, "attributes"), "category");
        if (cat && cat.t === "str" && norm(cat.v) === "color") type = "color";
        else if (norm(p[0]) === "size" && p.length >= 2 && value && (value.t === "num" || (value.t === "str" && PLAIN_NUMBER_RE.test(value.v.trim())))) {
          // size.font.small: "0.75" is 0.75rem.
          [type, group] = SIZE_KINDS[norm(p[1])] || ["dimension", "size"];
          bare = type === "lineHeight" ? "" : "rem";
          if (type === "dimension") path = p.slice(1);
          else if (type === "radius") path = p.slice(2).length ? p.slice(2) : p.slice(1);
          if (value.t === "num") {
            if (type !== "lineHeight" && value.v !== 0) {
              tokenFrom(ctx, { name, type, group, path, node: { t: "str", v: num(value.v) }, off: e.off, bare });
              continue;
            }
          }
        }
      }
      if (type === "typography" || type === "transition") splitComposite(ctx, type, { name, path: p, node: value, off: e.off });
      else tokenFrom(ctx, { name, type, group, path, node: value, off: e.off, bare });
    } else walkSd(ctx, e.v, p, depth + 1);
  }
}

function hasKey(node, key, depth = 0) {
  if (!node || depth > 32) return false;
  if (node.t === "obj") return node.entries.some((e) => e.k === key || hasKey(e.v, key, depth + 1));
  if (node.t === "arr") return node.items.some((x) => hasKey(x, key, depth + 1));
  return false;
}

function hasSdLeaf(node, depth = 0) {
  if (!node || node.t !== "obj" || depth > 32) return false;
  return node.entries.some((e) => isSdLeaf(e.v) || hasSdLeaf(e.v, depth + 1));
}

// Values inside one theme group (colors, space, ...), any shape.
function walkGroup(ctx, node, info, path, mode, depth) {
  if (!node || depth > 12 || ctx.capped) return;
  const [type, word] = info;
  const name = [word, ...path].join(".");
  if (node.t === "str" || node.t === "num") {
    tokenFrom(ctx, { name, type, node, off: ctx.lastOff, mode });
    return;
  }
  if (node.t === "arr") {
    node.items.forEach((item, i) => {
      if (item.t === "obj") {
        const label = get(item, "slug") || get(item, "name");
        const key = label && label.t === "str" ? label.v : String(i);
        let v = null;
        for (const k of ENTRY_VALUE_KEYS) v = v || get(item, k);
        if (v) tokenFrom(ctx, { name: [word, ...path, key].join("."), type: get(item, "gradient") ? "gradient" : type, node: v, off: item.off, mode });
      } else walkGroup(ctx, item, info, [...path, String(i)], mode, depth + 1);
    });
    return;
  }
  if (node.t !== "obj") return;
  for (const e of node.entries) {
    if (norm(e.k) === "modes" && type === "color" && e.v.t === "obj") {
      for (const m of e.v.entries.slice(0, 8)) {
        const mm = m.k.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
        if (/^[a-z]/.test(mm) && mm !== "light") walkGroup(ctx, m.v, info, path, mm, depth + 1);
      }
      continue;
    }
    // A group inside a group (settings.color.gradients) takes its own type.
    const inner = GROUPS[norm(e.k)];
    if (inner && inner[0] !== type) {
      walkGroup(ctx, e.v, inner, [], mode, depth + 1);
      continue;
    }
    ctx.lastOff = e.off;
    const skipKey = inner && inner[0] === type;
    walkGroup(ctx, e.v, info, skipKey ? path : [...path, e.k], mode, depth + 1);
  }
}

function walkTheme(ctx, node, depth) {
  if (!node || node.t !== "obj" || depth > 6 || ctx.capped) return;
  for (const e of node.entries) {
    const info = GROUPS[norm(e.k)];
    ctx.lastOff = e.off;
    if (info) walkGroup(ctx, e.v, info, [], null, 0);
    else if (e.v.t === "obj") walkTheme(ctx, e.v, depth + 1);
  }
}

// ---------------------------------------------------------------- Tokens Studio

// A Tokens Studio export in one file: token sets at the top, with $themes
// and $metadata.tokenSetOrder beside them.
function isTokensStudio(tree) {
  if (!tree || tree.t !== "obj") return false;
  const themes = get(tree, "$themes");
  const meta = get(tree, "$metadata");
  return (!!themes && themes.t === "arr") || (!!meta && meta.t === "obj" && !!get(meta, "tokenSetOrder"));
}

const setMode = (name) => (String(name).toLowerCase().split(/[^a-z0-9]+/).includes("dark") ? "dark" : null);

// Each set is read on its own, its name left out of the paths so references
// between sets resolve. Later sets win in Tokens Studio, so they are read
// first (the first definition of a name is the one kept).
function walkTokensStudio(ctx, tree) {
  const meta = get(tree, "$metadata");
  const orderNode = meta && meta.t === "obj" ? get(meta, "tokenSetOrder") : null;
  const order = orderNode && orderNode.t === "arr" ? orderNode.items.filter((x) => x.t === "str").map((x) => x.v) : [];
  const rank = (k) => (order.indexOf(k) === -1 ? order.length : order.indexOf(k));
  const sets = tree.entries.filter((e) => !e.k.startsWith("$") && e.v.t === "obj").map((e, i) => ({ e, i }));
  sets.sort((a, b) => rank(b.e.k) - rank(a.e.k) || b.i - a.i);
  const dtcg = hasKey(tree, "$value");
  const fileMode = ctx.fileMode;
  for (const { e } of sets) {
    ctx.fileMode = setMode(e.k) || fileMode;
    if (dtcg) walkDtcg(ctx, e.v, [], null, 0);
    else walkSd(ctx, e.v, [], 0);
  }
  ctx.fileMode = fileMode;
}

// ---------------------------------------------------------------- WordPress theme.json

// A block theme's theme.json: settings with presets, and a version number
// or the WordPress schema.
function isWordPress(tree) {
  if (!tree || tree.t !== "obj") return false;
  const settings = get(tree, "settings");
  if (!settings || settings.t !== "obj") return false;
  const version = get(tree, "version");
  const schema = get(tree, "$schema");
  return (!!version && version.t === "num") || (!!schema && schema.t === "str" && /schemas\.wp\.org/i.test(schema.v));
}

// [path under settings, value key, type, group, preset kind]
const WP_PRESETS = [
  [["color", "palette"], "color", "color", null, "color"],
  [["color", "gradients"], "gradient", "gradient", null, "gradient"],
  [["typography", "fontSizes"], "size", "fontSize", null, "font-size"],
  [["typography", "fontFamilies"], "fontFamily", "fontFamily", null, "font-family"],
  [["spacing", "spacingSizes"], "size", "dimension", "spacing", "spacing"],
  [["shadow", "presets"], "shadow", "shadow", null, "shadow"],
];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// "var:preset|color|base" (theme.json's own reference form) -> the
// variable WordPress writes for it, var(--wp--preset--color--base).
function wpRef(raw) {
  const m = /^var:(preset|custom)\|([a-z0-9|-]{1,120})$/i.exec(raw.trim());
  if (!m) return raw;
  return `var(--wp--${m[1].toLowerCase()}--${m[2].toLowerCase().split("|").join("--")})`;
}

const WP_STYLE_PROPS = {
  color: { background: "background-color", text: "color", gradient: "background-image" },
  typography: { fontSize: "font-size", fontFamily: "font-family", fontWeight: "font-weight", lineHeight: "line-height", letterSpacing: "letter-spacing" },
  border: { radius: "border-radius", color: "border-color", width: "border-width" },
  spacing: { blockGap: "gap", padding: "padding", margin: "margin" },
};
const WP_ELEMENTS = {
  button: "button", link: "a", heading: "h1, h2, h3, h4, h5, h6", h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  caption: "figcaption", cite: "cite",
};

function wpUse(ctx, prop, node, off, selector) {
  if (!node || (node.t !== "str" && node.t !== "num")) return;
  const raw = node.t === "num" ? num(node.v) : wpRef(node.v);
  if (raw === null || raw.length > 2000) return;
  const { line, col } = ctx.pos(off);
  if (ctx.out.usages.length < MAX_TOKENS * 4) ctx.out.usages.push({ prop, raw, line, col, selector });
}

// One "styles" object (the page's, an element's or a block's) as uses.
function walkWpStyles(ctx, node, selector, depth) {
  if (!node || node.t !== "obj" || depth > 4) return;
  for (const e of node.entries) {
    const group = WP_STYLE_PROPS[e.k];
    if (group && e.v.t === "obj") {
      for (const g of e.v.entries) {
        const prop = group[g.k];
        if (!prop) continue;
        if (g.v.t === "obj") {
          // padding: {top, right, bottom, left}; radius: {topLeft ...}
          for (const side of g.v.entries) {
            const s = side.k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            const p = prop === "border-radius" ? `border-${s}-radius` : prop === "gap" ? prop : `${prop}-${s}`;
            if (/^[a-z-]{1,40}$/.test(p)) wpUse(ctx, p, side.v, side.off, selector);
          }
        } else wpUse(ctx, prop, g.v, g.off, selector);
      }
    } else if (e.k === "shadow") wpUse(ctx, "box-shadow", e.v, e.off, selector);
    else if (e.k === "elements" && e.v.t === "obj") {
      for (const el of e.v.entries) {
        const sel = WP_ELEMENTS[el.k];
        if (sel) walkWpStyles(ctx, el.v, selector === "body" ? sel : `${selector} ${sel}`, depth + 1);
      }
    } else if (e.k === "blocks" && e.v.t === "obj") {
      for (const b of e.v.entries) {
        const name = /^[a-z0-9-]{1,40}\/([a-z0-9-]{1,60})$/.exec(b.k);
        if (name) walkWpStyles(ctx, b.v, `.wp-block-${name[1]}`, depth + 1);
      }
    } else if (e.k.startsWith(":") && /^:[a-z-]{1,20}$/.test(e.k)) walkWpStyles(ctx, e.v, `${selector}${e.k}`, depth + 1);
  }
}

function walkWordPress(ctx, tree) {
  const settings = get(tree, "settings");
  for (const [where, valueKey, type, group, kind] of WP_PRESETS) {
    let node = settings;
    for (const k of where) node = node && node.t === "obj" ? get(node, k) : null;
    if (!node || node.t !== "arr") continue;
    for (const item of node.items) {
      if (item.t !== "obj" || ctx.capped) continue;
      const slug = get(item, "slug");
      const v = get(item, valueKey);
      if (!slug || slug.t !== "str" || !SLUG_RE.test(slug.v) || !v) continue;
      tokenFrom(ctx, { name: `--wp--preset--${kind}--${slug.v}`, type, group, path: [slug.v], node: v, off: item.off });
    }
  }
  walkWpStyles(ctx, get(tree, "styles"), "body", 0);
}

export default {
  id: "tokens-json",
  rank: 30,
  match: (relPath) => FILE_RE.test(relPath) || DIR_RE.test(relPath),
  extract({ path, text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    const pos = helpers.positions(text);
    let tree;
    try {
      tree = helpers.parseJsonTree(text);
    } catch (e) {
      out.diagnostics.push({ code: e instanceof helpers.JsonError ? e.code : "json-invalid", line: e instanceof helpers.JsonError ? pos(e.offset).line : undefined });
      return out;
    }
    const ctx = { out, pos, helpers, fileMode: modeFromPath(path), capped: false, lastOff: 0 };
    if (isWordPress(tree)) walkWordPress(ctx, tree);
    else if (isTokensStudio(tree)) walkTokensStudio(ctx, tree);
    else if (hasKey(tree, "$value")) walkDtcg(ctx, tree, [], null, 0);
    else if (hasSdLeaf(tree)) walkSd(ctx, tree, [], 0);
    else walkTheme(ctx, tree, 0);
    if (ctx.capped) out.diagnostics.push({ code: "too-many-items" });
    return out;
  },
};
