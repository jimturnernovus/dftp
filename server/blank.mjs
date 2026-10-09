// Blank pages (dftp --blank): a generated document holding nothing but an
// empty, responsive page frame (the scaffold), and a style sheet made from
// the style scan's tokens. Both are served from the frame origin under the
// same policy as the demo page, and no project code runs on a blank page.
//
// The style sheet is built only from token documents that pass validation,
// from normalised values written back as CSS by css-values.js, and each
// value then has to pass safeCssValue: no url(), no other function than a
// gradient or an easing curve, no brace, semicolon, backslash, comment, "@",
// "!" or single quote, double quotes only in pairs (font names) and balanced
// parentheses. Anything else is left out.

import { validateTokensDoc } from "../client/core/tokens.js";
import { formatValue } from "../client/core/css-values.js";
import { isId } from "../client/core/schema.js";
import { tokenVar, styleVar, themeTokens, SCAFFOLD_ATTR, KIND_ATTR, BOX_ATTR, TOKENS_CSS } from "../client/core/blank.js";
import { layerTag } from "./inject.mjs";

export const BLANK_PREFIX = "/__dftp/blank/";
export { TOKENS_CSS };
export const blankPath = (id) => `${BLANK_PREFIX}${id}`;
export const DEFAULT_BREAKPOINTS = Object.freeze({ md: 768, lg: 1024 });

// The document of a blank page: the token style sheet, the layer and the
// empty scaffold. `scriptSrc` is the layer's boot module on the frame origin.
export function blankPageHtml({ id, scriptSrc }) {
  if (!isId(id)) throw new Error("bad page id");
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>New page ${id}</title>`,
    `<link rel="stylesheet" href="${TOKENS_CSS}">`,
    layerTag(scriptSrc, null),
    "</head>",
    "<body>",
    `<main ${SCAFFOLD_ATTR}></main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- values

// eslint-disable-next-line no-control-regex
const CSS_BAD_RE = /[\u0000-\u001F\u007F-\u009F;{}<>\\@!`']|\/\*|\*\//;
const NAME_CHAR_RE = /[A-Za-z-]/;
const CSS_FN_OK = new Set([
  "linear-gradient", "radial-gradient", "conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient", "cubic-bezier",
]);

// The value when it is safe to write after "name:" in a declaration, else "".
export function safeCssValue(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 400 || CSS_BAD_RE.test(s)) return "";
  let depth = 0;
  let inQuote = false;
  let nameStart = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (!NAME_CHAR_RE.test(ch) && ch !== "(") nameStart = i + 1;
    if (ch === "(") {
      if (!CSS_FN_OK.has(s.slice(nameStart, i).toLowerCase())) return "";
      depth++;
      nameStart = i + 1;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return "";
    }
  }
  return depth === 0 && !inQuote ? s : "";
}

const HEX_RE = /^#[0-9a-f]{6}$/;

// Black or white text, whichever reads better on a color value.
function contrastOn(c) {
  if (!c || typeof c.hex !== "string" || !HEX_RE.test(c.hex)) return "";
  const ch = [1, 3, 5].map((i) => {
    const v = parseInt(c.hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.4 ? "#111111" : "#ffffff";
}

// The color t of the way from hex a to hex b (both #rrggbb).
function mixHex(a, b, t) {
  const ch = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t).toString(16).padStart(2, "0")).join("")}`;
}

// A spacing step from the scan's spacing scale near `want` px, else `want`.
function spaceStep(scale, want) {
  let best = want;
  let bestD = Infinity;
  for (const n of Array.isArray(scale) ? scale : []) {
    if (!Number.isFinite(n) || n < want * 0.6 || n > want * 1.6) continue;
    const d = Math.abs(Math.log(n / want));
    if (d < bestD) [best, bestD] = [n, d];
  }
  return Math.round(best * 100) / 100;
}

// The md and lg boundaries: the project's breakpoints of those names, else
// 768 and 1024 px.
export function breakpointsOf(doc) {
  const list = doc && Array.isArray(doc.breakpoints) ? doc.breakpoints : [];
  const find = (name) => {
    const b = list.find((x) => x && x.name === name && Number.isFinite(x.min));
    return b ? b.min : null;
  };
  const md = find("md") ?? DEFAULT_BREAKPOINTS.md;
  const lg = find("lg") ?? DEFAULT_BREAKPOINTS.lg;
  if (md < 300 || lg > 4000 || md >= lg) return { ...DEFAULT_BREAKPOINTS };
  return { md: Math.round(md * 100) / 100, lg: Math.round(lg * 100) / 100 };
}

const WORD_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Where dark values apply: the element the designer's Light / Dark switch
// marks (theme setting), or the system setting when there is no switch.
function darkSelector(theme) {
  if (!theme || typeof theme !== "object") return null;
  if (typeof theme.darkClass === "string" && WORD_RE.test(theme.darkClass)) return `[class~="${theme.darkClass}"]`;
  if (typeof theme.attribute === "string" && /^data-[a-z0-9-]{1,30}$/.test(theme.attribute) && typeof theme.dark === "string" && WORD_RE.test(theme.dark)) {
    return `[${theme.attribute}="${theme.dark}"]`;
  }
  return null;
}

// ---------------------------------------------------------------- the style sheet

const S = (prop, fallback) => `var(${styleVar(prop)}, ${fallback})`;
const SOFT_LINE = "color-mix(in srgb, currentColor 22%, transparent)";

// Base rules of every new element: the look without any token, and the
// token styles (--dftp-s-*) on top.
function baseRules() {
  const el = (kind) => `[${KIND_ATTR}="${kind}"]`;
  const type = (size, weight, lh) => [
    `color: ${S("color", "inherit")};`,
    `font-family: ${S("font-family", "inherit")};`,
    `font-size: ${S("font-size", size)};`,
    `font-weight: ${S("font-weight", weight)};`,
    `line-height: ${S("line-height", lh)};`,
    `letter-spacing: ${S("letter-spacing", "normal")};`,
  ];
  const rule = (sel, decls) => `${sel} {\n${decls.map((d) => `  ${d}`).join("\n")}\n}`;
  return [
    rule(`[${KIND_ATTR}]`, ["box-sizing: border-box;", "min-width: 0;", "margin: 0;"]),
    rule(el("heading"), type("2rem", "700", "1.2").map((d) => (d.startsWith("font-family:") ? `font-family: ${S("font-family", "var(--dftp-font-heading, inherit)")};` : d))),
    rule(el("text"), type("1rem", "400", "1.6")),
    rule(el("button"), [
      "display: inline-flex;", "align-items: center;", "justify-content: center;", "justify-self: start;", "align-self: flex-start;",
      `padding-block: ${S("padding-block", "0.5rem")};`, `padding-inline: ${S("padding-inline", "1rem")};`,
      "border-style: solid;", `border-width: ${S("border-width", "0px")};`, `border-color: ${S("border-color", "transparent")};`,
      `border-radius: ${S("border-radius", "var(--dftp-radius, 8px)")};`,
      `background: ${S("background", "var(--dftp-color-primary, #2563eb)")};`,
      ...type("0.875rem", "600", "1.25").map((d) => (d.startsWith("color:") ? `color: ${S("color", "var(--dftp-on-primary, #ffffff)")};` : d)),
      `box-shadow: ${S("box-shadow", "none")};`, "cursor: pointer;",
    ]),
    rule(el("input"), [
      "display: block;", "width: 100%;", "max-width: 28rem;",
      `padding-block: ${S("padding-block", "0.5rem")};`, `padding-inline: ${S("padding-inline", "0.75rem")};`,
      "border-style: solid;", `border-width: ${S("border-width", "1px")};`,
      `border-color: ${S("border-color", `var(--dftp-color-border, ${SOFT_LINE})`)};`,
      `border-radius: ${S("border-radius", "var(--dftp-radius, 8px)")};`,
      `background: ${S("background", "var(--dftp-color-surface, transparent)")};`,
      ...type("1rem", "400", "1.5"),
    ]),
    rule(el("card"), [
      "display: flex;", "flex-direction: column;", `gap: ${S("gap", "0.75rem")};`,
      `padding-block: ${S("padding-block", "1.5rem")};`, `padding-inline: ${S("padding-inline", "1.5rem")};`,
      "border-style: solid;", `border-width: ${S("border-width", "1px")};`,
      `border-color: ${S("border-color", `var(--dftp-color-border, ${SOFT_LINE})`)};`,
      `border-radius: ${S("border-radius", "var(--dftp-radius, 12px)")};`,
      `background: ${S("background", "var(--dftp-color-surface, transparent)")};`,
      `color: ${S("color", "inherit")};`, `box-shadow: ${S("box-shadow", "var(--dftp-shadow, none)")};`,
    ]),
    rule(el("image"), [
      "display: block;", "width: 100%;", "aspect-ratio: 16 / 9;", "max-height: 22rem;",
      `border-radius: ${S("border-radius", "var(--dftp-radius, 8px)")};`,
      `background: ${S("background", "var(--dftp-placeholder, color-mix(in srgb, currentColor 10%, transparent))")};`,
    ]),
    rule(el("divider"), [
      "width: 100%;", "height: 0;", "border: 0;", "border-top-style: solid;",
      `border-top-width: ${S("border-width", "1px")};`,
      `border-top-color: ${S("border-color", `var(--dftp-color-border, ${SOFT_LINE})`)};`,
    ]),
    rule(el("section"), [
      "display: flex;", "flex-direction: column;", `gap: ${S("gap", "var(--dftp-space-md, 16px)")};`,
      `padding-block: ${S("padding-block", "var(--dftp-space-lg, 32px)")};`, `padding-inline: ${S("padding-inline", "0px")};`,
      `background: ${S("background", "transparent")};`, `color: ${S("color", "inherit")};`,
    ]),
    rule(el("grid"), [
      "display: grid;", "grid-template-columns: repeat(3, minmax(0, 1fr));", `gap: ${S("gap", "var(--dftp-space-md, 16px)")};`,
      `padding-block: ${S("padding-block", "0px")};`, `padding-inline: ${S("padding-inline", "0px")};`,
      `background: ${S("background", "transparent")};`,
    ]),
    rule(`[${BOX_ATTR}]:empty`, ["min-height: 4rem;", `outline: 1px dashed ${SOFT_LINE};`, "outline-offset: -1px;"]),
  ];
}

// The style sheet for blank pages from a tokens document (or null).
// opts.theme: the designer's theme setting, for where dark values apply.
export function tokenStylesheet(input, { theme = null } = {}) {
  const r = input ? validateTokensDoc(input) : null;
  const doc = r && r.ok ? r.value : null;
  const light = [];
  const dark = [];
  const names = new Set();
  for (const t of doc ? doc.tokens : []) {
    const name = tokenVar(t.id);
    if (!name || names.has(name) || t.value === null) continue;
    const v = safeCssValue(formatValue(t.type, t.value));
    if (!v) continue;
    names.add(name);
    light.push(`${name}: ${v};`);
    const dv = t.modes && t.modes.dark ? safeCssValue(formatValue(t.type, t.modes.dark)) : "";
    if (dv) dark.push(`${name}: ${dv};`);
  }

  const T = themeTokens(doc);
  const ref = (t) => (t && names.has(tokenVar(t.id)) ? `var(${tokenVar(t.id)})` : "");
  const roles = [];
  const role = (name, value) => {
    if (value) roles.push(`${name}: ${value};`);
  };
  // The page is drawn in the background color, or in the surface color
  // when the project names no background (a page whose body uses its
  // surface color).
  const pageTok = ref(T.background) ? T.background : ref(T.surface) ? T.surface : null;
  role("--dftp-color-primary", ref(T.primary));
  role("--dftp-color-text", ref(T.text));
  role("--dftp-color-background", ref(pageTok));
  role("--dftp-color-surface", ref(T.surface) || ref(T.background));
  role("--dftp-color-border", ref(T.border));
  role("--dftp-placeholder", ref(T.placeholder));
  role("--dftp-font-body", ref(T.body));
  role("--dftp-font-heading", ref(T.heading));
  role("--dftp-radius", ref(T.radius));
  role("--dftp-shadow", ref(T.shadow));
  const onPrimary = ref(T.onPrimary);
  if (onPrimary) role("--dftp-on-primary", onPrimary);
  else if (T.primary && names.has(tokenVar(T.primary.id))) {
    role("--dftp-on-primary", contrastOn(T.primary.value));
    const d = T.primary.modes && T.primary.modes.dark ? contrastOn(T.primary.modes.dark) : "";
    if (d) dark.push(`--dftp-on-primary: ${d};`);
  }
  // A page with no background or text token still turns dark.
  if (!pageTok) dark.push("--dftp-color-background: #0f141c;");
  if (!ref(T.text)) dark.push("--dftp-color-text: #e7eaf0;");
  // A page color with a dark value while the text or surface color has
  // none: those get dark values worked out from the dark page color, on
  // their own token variables, so every element that uses them follows.
  const pageDark = pageTok && pageTok.modes && pageTok.modes.dark ? pageTok.modes.dark : null;
  const onDark = pageDark ? contrastOn(pageDark) : "";
  if (onDark) {
    const lacksDark = (t) => !!t && !!ref(t) && t !== pageTok && !(t.modes && t.modes.dark);
    if (lacksDark(T.text)) dark.push(`${tokenVar(T.text.id)}: ${onDark === "#ffffff" ? "#e7eaf0" : "#111827"};`);
    if (lacksDark(T.surface)) dark.push(`${tokenVar(T.surface.id)}: ${mixHex(pageDark.hex, onDark === "#ffffff" ? "#ffffff" : "#000000", 0.06)};`);
  }

  const scale = doc ? doc.scales.spacing : [];
  const space = [
    `--dftp-space-sm: ${spaceStep(scale, 8)}px;`,
    `--dftp-space-md: ${spaceStep(scale, 16)}px;`,
    `--dftp-space-lg: ${spaceStep(scale, 32)}px;`,
    "--dftp-max-width: 1200px;",
  ];
  const { md, lg } = breakpointsOf(doc);
  const dsel = darkSelector(theme);
  const block = (sel, decls) => `${sel} {\n${decls.map((d) => `  ${d}`).join("\n")}\n}`;
  const scaffold = `[${SCAFFOLD_ATTR}]`;
  const props = [...new Set(baseRules().join("\n").match(/--dftp-s-[a-z-]+/g) || [])];

  const out = [
    "/* Generated by DFTP for blank pages from .dftp/tokens.json. Rebuilt on every request; do not edit. */",
    // The token styles of an element are its own: a card's background must
    // not reach the button inside it.
    ...props.map((p) => `@property ${p} { syntax: "*"; inherits: false; }`),
    block(":root", ["color-scheme: light;", ...light, ...space]),
  ];
  // The role variables come before the dark values: a role worked out for
  // the dark theme (the text on the primary color) must win over its light
  // value. The roles are declared on the dark element again so the token
  // variables they name resolve to their dark values there.
  if (dsel) {
    if (roles.length) out.push(block(`:root, ${dsel}`, roles));
    out.push(block(dsel, ["color-scheme: dark;", ...dark]));
  } else {
    if (roles.length) out.push(block(":root", roles));
    out.push(`@media (prefers-color-scheme: dark) {\n${block(":root", ["color-scheme: dark;", ...roles, ...dark])}\n}`);
  }
  out.push(
    block("html, body", ["margin: 0;"]),
    block("body", [
      "background: var(--dftp-color-background, #ffffff);",
      "color: var(--dftp-color-text, #111827);",
      "font-family: var(--dftp-font-body, system-ui, sans-serif);",
      "font-size: 16px;",
      "line-height: 1.5;",
    ]),
    block(scaffold, [
      "box-sizing: border-box;", "display: grid;", "grid-template-columns: repeat(12, minmax(0, 1fr));", "align-content: start;",
      "gap: var(--dftp-space-md);", "width: 100%;", "max-width: var(--dftp-max-width);", "min-height: 100vh;", "margin: 0 auto;",
      "padding: var(--dftp-space-lg);",
    ]),
    block(`${scaffold} > *`, ["grid-column: 1 / -1;"]),
    block(`${scaffold}:empty::before`, [
      "content: \"Drag elements here from the palette above the preview, or click one there.\";",
      "grid-column: 1 / -1;", "padding: 48px 16px;", `border: 1px dashed ${SOFT_LINE};`, "border-radius: 8px;",
      "opacity: 0.7;", "font-size: 14px;", "text-align: center;",
    ]),
    ...baseRules(),
    `@media (width < ${lg}px) {\n${block(scaffold, ["grid-template-columns: repeat(6, minmax(0, 1fr));"])}\n${block(`[${KIND_ATTR}="grid"]`, ["grid-template-columns: repeat(2, minmax(0, 1fr));"])}\n}`,
    `@media (width < ${md}px) {\n${block(scaffold, ["display: flex;", "flex-direction: column;", "padding: var(--dftp-space-md);"])}\n${block(`[${KIND_ATTR}="grid"]`, ["grid-template-columns: minmax(0, 1fr);"])}\n}`,
  );
  return `${out.join("\n")}\n`;
}
