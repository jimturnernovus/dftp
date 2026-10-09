// Blank pages: the shared rules (blank.js: token custom properties, the
// build order of new elements, seeding, picking tokens and components) and
// the generated document and style sheet (server/blank.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ELEMENTS, PALETTE, tokenVar, styleVar, insertTree, depthUnder, seedInserts, pickStyles, componentFor, themeTokens,
  INSERT_DEPTH,
} from "../../client/core/blank.js";
import { INSERT_ELEMENTS, INSERT_BOXES, INSERT_STYLE_PROPS, validateList } from "../../client/core/schema.js";
import { TOKENS_FORMAT, COMPONENT_KINDS, validateTokensDoc, pxOf } from "../../client/core/tokens.js";
import {
  blankPageHtml, tokenStylesheet, safeCssValue, breakpointsOf, blankPath, BLANK_PREFIX, TOKENS_CSS,
} from "../../server/blank.mjs";
import { scanProject } from "../../server/scan/scanner.mjs";
import { TOOL_DIR } from "../helpers.mjs";

const FIX = (name) => path.join(TOOL_DIR, "test", "fixtures", "projects", name);

const ins = (id, over = {}) => ({ id, key: `ins:${id}`, kind: "insert", element: "text", tag: "p", parent: "scaffold", index: 0, styles: {}, ...over });

function tokenDoc(tokens, over = {}) {
  return {
    format: TOKENS_FORMAT, version: 1, generated_at: "2026-01-02T03:04:05Z", root: ".",
    tokens, scales: { spacing: [4, 8, 16, 32], fontSize: [14, 16], radius: [6] }, breakpoints: [], components: [], diagnostics: [], ...over,
  };
}
const tok = (id, type, value, over = {}) => ({
  id, type, value, raw: "x", modes: {}, aliasOf: null, role: null, sources: [{ adapter: "css-vars", file: "a.css", line: 1, name: `--${id.replace(/\./g, "-")}` }],
  usage: { count: 1, seenLive: false }, confidence: 0.9, ...over,
});

test("every kind of new element is described, and the palette offers them all", () => {
  assert.deepEqual(PALETTE, INSERT_ELEMENTS);
  for (const k of INSERT_ELEMENTS) {
    const d = ELEMENTS[k];
    assert.match(d.tag, /^[a-z][a-z0-9]*$/);
    assert.ok(COMPONENT_KINDS.includes(d.kind), k);
    assert.equal(d.box, INSERT_BOXES.includes(k));
  }
});

test("token and style custom properties never collide and hold nothing but safe names", () => {
  assert.equal(tokenVar("color.brand.600"), "--dftp-t-color_dbrand_d600");
  assert.equal(tokenVar("size.card_pad"), "--dftp-t-size_dcard_upad");
  assert.notEqual(tokenVar("a.b_c"), tokenVar("a_b.c"));
  assert.notEqual(tokenVar("a.b-c"), tokenVar("a-b.c"));
  assert.equal(tokenVar("not an id"), "");
  assert.equal(tokenVar("x;}body{"), "");
  for (const p of INSERT_STYLE_PROPS) assert.match(styleVar(p), /^--dftp-s-[a-z-]+$/);
  assert.equal(styleVar("position"), "");
});

test("build order: depth first by place, list order on ties; orphans, loops and depth", () => {
  const list = [
    ins("b0000001", { parent: "ins:a0000001", index: 1 }),
    ins("a0000001", { element: "card", index: 0 }),
    ins("c0000001", { parent: "ins:a0000001", index: 0 }),
    ins("d0000001", { index: 1 }),
    ins("e0000001", { index: 1 }),
    ins("f0000001", { parent: "ins:nope0001" }),
    ins("g0000001", { parent: "ins:d0000001" }),
    ins("h0000001", { element: "card", parent: "ins:i0000001" }),
    ins("i0000001", { element: "card", parent: "ins:h0000001" }),
  ];
  const { order, orphans } = insertTree(list);
  assert.deepEqual(order.map((o) => o.c.id), ["a0000001", "c0000001", "b0000001", "d0000001", "e0000001"]);
  assert.deepEqual(order.map((o) => `${o.depth}:${o.pos}/${o.of}`), ["0:0/3", "1:0/2", "1:1/2", "0:1/3", "0:2/3"]);
  assert.deepEqual(orphans.map((c) => c.id).sort(), ["f0000001", "g0000001", "h0000001", "i0000001"], "missing parent, a parent that is no box, a loop");
  const deep = [];
  let parent = "scaffold";
  for (let i = 0; i < INSERT_DEPTH + 2; i++) {
    const id = `s${String(i).padStart(7, "0")}`;
    deep.push(ins(id, { element: "section", parent }));
    parent = `ins:${id}`;
  }
  assert.equal(insertTree(deep).order.length, INSERT_DEPTH);
  assert.equal(depthUnder(deep, "scaffold"), 0);
  assert.equal(depthUnder(deep, "ins:s0000000"), 1);
  assert.equal(depthUnder(deep, "ins:zzzz0000"), -1);
  assert.deepEqual(insertTree(null), { order: [], orphans: [] });
});

test("seeding keeps the elements and drops what one screen size did to them", () => {
  const list = [
    ins("a0000001", { text: "Hi", text_from: "Text", text_to: "Hello", dx: 4, dy: 5, w: 100, h: null, hidden: true, base: { x: 0, y: 0, w: 1, h: 1 }, ctx: { display: "block" }, detached: true, missing: true, styles: { color: "color.text" } }),
    { id: "zzzz0001", key: "src/a.jsx:1:1#0", dx: 4 },
  ];
  const s = seedInserts(list);
  assert.equal(s.length, 1);
  assert.deepEqual(Object.keys(s[0]).sort(), ["element", "id", "index", "key", "kind", "parent", "styles", "tag", "text", "text_from", "text_to"].sort());
  assert.notEqual(s[0].styles, list[0].styles, "a copy");
  assert.ok(validateList(s).ok);
});

test("picked styles follow roles, the most used radius and the scales", () => {
  const doc = tokenDoc([
    tok("color.primary", "color", { hex: "#2f5bd8", alpha: 1 }, { role: "primary" }),
    tok("color.primary.foreground", "color", { hex: "#ffffff", alpha: 1 }),
    tok("color.text", "color", { hex: "#111111", alpha: 1 }, { role: "text" }),
    tok("color.surface", "color", { hex: "#fafafa", alpha: 1 }, { role: "surface" }),
    tok("color.border", "color", { hex: "#e4e4e7", alpha: 1 }, { role: "border" }),
    tok("font.sans", "fontFamily", { families: ["Inter", "sans-serif"] }),
    tok("font.display", "fontFamily", { families: ["Fraunces", "serif"] }, { usage: { count: 0, seenLive: false } }),
    tok("radius.sm", "radius", { value: 4, unit: "px", px: 4 }, { usage: { count: 1, seenLive: false } }),
    tok("radius.md", "radius", { value: 0.5, unit: "rem", px: 8 }, { usage: { count: 9, seenLive: false } }),
    tok("spacing.2", "dimension", { value: 8, unit: "px", px: 8 }),
    tok("spacing.4", "dimension", { value: 16, unit: "px", px: 16 }),
    tok("spacing.6", "dimension", { value: 24, unit: "px", px: 24 }),
    tok("size.max", "dimension", { value: 16, unit: "px", px: 16 }),
    tok("font-size.sm", "fontSize", { value: 14, unit: "px", px: 14 }),
    tok("font-size.3xl", "fontSize", { value: 30, unit: "px", px: 30 }),
    tok("font-weight.bold", "fontWeight", { value: 700 }),
    tok("shadow.card", "shadow", [{ x: { value: 0, unit: "px" }, y: { value: 1, unit: "px" }, blur: { value: 2, unit: "px" }, spread: { value: 0, unit: "px" }, color: { hex: "#000000", alpha: 0.1 }, inset: false }]),
  ], { components: [{ kind: "button", file: "src/components/ui/button.jsx", export: "Button" }, { kind: "card", file: "src/ui/card.vue", export: "Card" }] });
  assert.deepEqual(pickStyles(doc, "button"), {
    background: "color.primary", color: "color.primary.foreground", "border-radius": "radius.md", "font-family": "font.sans",
    "font-size": "font-size.sm", "padding-block": "spacing.2", "padding-inline": "spacing.4",
  }, "a 700 weight from elsewhere on the page is not a button's");
  assert.deepEqual(pickStyles(doc, "heading"), { color: "color.text", "font-family": "font.display", "font-size": "font-size.3xl", "font-weight": "font-weight.bold" });
  assert.deepEqual(pickStyles(doc, "card"), {
    background: "color.surface", color: "color.text", "border-color": "color.border", "border-radius": "radius.md", "box-shadow": "shadow.card",
    "padding-block": "spacing.6", "padding-inline": "spacing.6", gap: "spacing.4",
  });
  assert.deepEqual(pickStyles(doc, "divider"), { "border-color": "color.border" });
  assert.deepEqual(pickStyles(doc, "grid"), { gap: "spacing.4" }, "a dimension not named for spacing is not a spacing step");
  assert.deepEqual(componentFor(doc, "button"), { export: "Button", file: "src/components/ui/button.jsx" });
  assert.deepEqual(componentFor(doc, "card"), { export: "Card", file: "src/ui/card.vue" });
  assert.equal(componentFor(doc, "heading"), null);
  for (const k of INSERT_ELEMENTS) assert.deepEqual(pickStyles(null, k), {}, "no scan: no token styles");
  assert.deepEqual(pickStyles({ tokens: [{ id: "x;}", type: "color", value: {}, role: "primary" }, "junk"] }, "button"), {});
  assert.equal(componentFor({ components: [{ kind: "button", file: "../x.jsx", export: "Button" }] }, "button"), null);
  assert.equal(pxOf({ value: 2, unit: "rem" }), 32);
  assert.equal(pxOf({ value: 50, unit: "%" }), null);
});

test("the fixtures: Tailwind v4 theme tokens and shadcn-style components, plain custom properties", async () => {
  const tw = await scanProject({ root: FIX("tailwind-v4"), libraryPrefixes: ["src/components/ui/"] });
  assert.equal(pickStyles(tw, "button").background, "color.primary");
  assert.equal(pickStyles(tw, "button").color, "color.primary.foreground");
  assert.equal(componentFor(tw, "button").export, "Button");
  assert.equal(componentFor(tw, "card").export, "Card");
  const T = themeTokens(tw);
  assert.equal(T.text.id, "color.foreground");
  assert.equal(T.body.id, "font.sans");
  const css = await scanProject({ root: FIX("css-vars-dark"), libraryPrefixes: [] });
  assert.deepEqual(pickStyles(css, "card").background, "color.surface");
  // --card-pad is defined inside .card only: undefined anywhere else.
  assert.equal(css.tokens.find((t) => t.id === "size.card.pad").scoped, true);
  for (const kind of ["card", "section", "button", "input"]) {
    for (const id of Object.values(pickStyles(css, kind))) assert.notEqual(id, "size.card.pad", kind);
  }
});

// ---------------------------------------------------------------- the document and the style sheet

test("the blank document: the scaffold, the token style sheet and the layer, nothing else", () => {
  const src = "http://127.0.0.1:20001/__dftp/overlay.js";
  const html = blankPageHtml({ id: "blank-pricing", scriptSrc: src });
  assert.ok(html.includes("<main data-dftp-scaffold></main>"));
  assert.ok(html.includes(`<link rel="stylesheet" href="${TOKENS_CSS}">`));
  assert.ok(html.includes(`<script type="module" src="${src}"></script>`));
  assert.equal(html.match(/<script/g).length, 1);
  assert.throws(() => blankPageHtml({ id: "Bad Id", scriptSrc: src }));
  assert.throws(() => blankPageHtml({ id: "blank", scriptSrc: "http://example.com/x.js" }));
  assert.equal(blankPath("blank"), `${BLANK_PREFIX}blank`);
  assert.ok(TOKENS_CSS.startsWith("/__dftp/"));
});

test("safeCssValue lets through plain values and gradients only", () => {
  for (const ok of ["#2f5bd8", "#0000001a", "0.875rem", "\"Inter\", ui-sans-serif, system-ui", "0px 1px 3px 0px #0000001a",
    "linear-gradient(#ffffff, #000000 50%)", "cubic-bezier(0.2, 0, 0, 1)", "700", "-0.01em", "\"Noto Sans JP\", sans-serif"]) {
    assert.equal(safeCssValue(ok), ok, ok);
  }
  for (const bad of ["url(x)", "red;}body{color:red", "expression(alert(1))", "image-set(\"x.png\" 1x)", "a\\62 c", "/* x */",
    "x */", "\"unclosed", "a)b", "(a", "attr(title)", "var(--x)", "env(x)", "red !important", "@import x", "<style>", "a\nb",
    "'single'", "a{b}", "src(x)", "calc(1px)", "x".repeat(401), "", null, 7]) {
    assert.equal(safeCssValue(bad), "", String(bad));
  }
});

test("the style sheet: tokens, roles, dark values, non-inherited element styles, breakpoints", () => {
  const doc = tokenDoc([
    tok("color.primary", "color", { hex: "#2f5bd8", alpha: 1 }, { role: "primary", modes: { dark: { hex: "#6b8cff", alpha: 1 } } }),
    tok("color.text", "color", { hex: "#111111", alpha: 1 }, { role: "text" }),
    tok("font.sans", "fontFamily", { families: ["Inter", "sans-serif"] }),
    tok("radius.md", "radius", { value: 8, unit: "px", px: 8 }),
  ], { breakpoints: [{ name: "md", min: 700 }, { name: "lg", min: 1100 }] });
  const css = tokenStylesheet(doc, { theme: { selector: "html", darkClass: "dark" } });
  assert.match(css, /--dftp-t-color_dprimary: #2f5bd8;/);
  assert.match(css, /\[class~="dark"\] \{\n {2}color-scheme: dark;\n {2}--dftp-t-color_dprimary: #6b8cff;/);
  assert.match(css, /:root, \[class~="dark"\] \{\n {2}--dftp-color-primary: var\(--dftp-t-color_dprimary\);/);
  assert.match(css, /--dftp-on-primary: #ffffff;/, "white text on a dark primary when no token names one");
  assert.match(css, /--dftp-font-body: var\(--dftp-t-font_dsans\);/);
  assert.match(css, /@property --dftp-s-background \{ syntax: "\*"; inherits: false; \}/);
  for (const p of INSERT_STYLE_PROPS) assert.ok(css.includes(`var(--dftp-s-${p},`), p);
  assert.match(css, /@media \(width < 1100px\)/);
  assert.match(css, /@media \(width < 700px\)/);
  assert.match(css, /\[data-dftp-scaffold\] \{[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
  const attr = tokenStylesheet(doc, { theme: { selector: "html", attribute: "data-theme", dark: "night", light: "day" } });
  assert.ok(attr.includes("[data-theme=\"night\"] {"));
  const none = tokenStylesheet(doc, { theme: null });
  assert.ok(none.includes("@media (prefers-color-scheme: dark) {"));
  const odd = tokenStylesheet(doc, { theme: { selector: "html", darkClass: "a\"]{x}" } });
  assert.ok(!odd.includes("a\"]{x}") && odd.includes("@media (prefers-color-scheme: dark)"), "an odd theme setting is not written into the sheet");
});

test("the style sheet is safe for any input: invalid documents give the plain look, values are filtered", () => {
  const plain = tokenStylesheet(null);
  assert.ok(plain.includes("[data-dftp-scaffold]"));
  assert.ok(!plain.includes("--dftp-t-"));
  assert.ok(plain.includes("--dftp-color-background: #0f141c;"), "dark defaults without tokens");
  // A document that does not validate is not used at all.
  const evil = tokenDoc([{ ...tok("color.x", "color", { hex: "red;}body{x:url(a)", alpha: 1 }) }]);
  assert.equal(validateTokensDoc(evil).ok, false);
  assert.ok(!tokenStylesheet(evil).includes("url("));
  // Font names are validated text, quoted; nothing can end the declaration.
  const fonts = tokenDoc([tok("font.odd", "fontFamily", { families: ["Inter & Co", "x"] })]);
  assert.match(tokenStylesheet(fonts), /--dftp-t-font_dodd: "Inter & Co", "x";/);
  for (const sheet of [plain, tokenStylesheet(fonts), tokenStylesheet(evil)]) {
    assert.ok(!/url\(|expression|@import|javascript:/i.test(sheet));
    assert.ok(!sheet.includes("\\"));
  }
  assert.deepEqual(breakpointsOf(null), { md: 768, lg: 1024 });
  assert.deepEqual(breakpointsOf({ breakpoints: [{ name: "md", min: 2000 }, { name: "lg", min: 900 }] }), { md: 768, lg: 1024 }, "out of order: the defaults");
});

// The value a custom property ends up with on an element the given rules
// all match (equal specificity: the last declaration in the sheet wins).
function lastValue(css, prop) {
  let value = null;
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i !== -1 && d.slice(0, i).trim() === prop) value = d.slice(i + 1).trim();
    }
  }
  return value;
}
const darkPart = (css, sel) => css.slice(css.indexOf(sel));

test("dark theme: the text on the primary color is worked out from its dark value and is not overridden", () => {
  const doc = tokenDoc([
    tok("color.primary", "color", { hex: "#18181b", alpha: 1 }, { role: "primary", modes: { dark: { hex: "#fafafa", alpha: 1 } } }),
  ]);
  // With a switch: everything the dark element matches, in order.
  const sw = tokenStylesheet(doc, { theme: { selector: "html", darkClass: "dark" } });
  assert.equal(lastValue(sw, "--dftp-on-primary"), "#111111", "dark text on a light primary in dark mode");
  const at = sw.indexOf("[class~=\"dark\"] {\n  color-scheme: dark;");
  const light = sw.slice(0, at) + sw.slice(sw.indexOf("}", at) + 1);
  assert.equal(lastValue(light, "--dftp-on-primary"), "#ffffff", "white text on the dark primary in light mode");
  // Following the system: the dark media rule.
  const sys = tokenStylesheet(doc, { theme: null });
  assert.equal(lastValue(darkPart(sys, "@media (prefers-color-scheme: dark)"), "--dftp-on-primary"), "#111111");
});

test("the page color is the surface color when the project names no background; the dark fallback only without either", () => {
  const surfaceOnly = tokenDoc([
    tok("color.surface", "color", { hex: "#ffffff", alpha: 1 }, { role: "surface", modes: { dark: { hex: "#0b1020", alpha: 1 } } }),
    tok("color.text", "color", { hex: "#0f1729", alpha: 1 }, { role: "text", modes: { dark: { hex: "#e6e9f2", alpha: 1 } } }),
  ]);
  const css = tokenStylesheet(surfaceOnly, { theme: { selector: "html", darkClass: "dark" } });
  assert.equal(lastValue(css, "--dftp-color-background"), "var(--dftp-t-color_dsurface)");
  assert.ok(!css.includes("#0f141c"), "no hard-coded dark page color");
  const none = tokenStylesheet(tokenDoc([]), { theme: { selector: "html", darkClass: "dark" } });
  assert.ok(none.includes("--dftp-color-background: #0f141c;"));
});

test("dark theme: text and surface colors without a dark value get one worked out from the dark page color", async () => {
  const doc = await scanProject({ root: FIX("dtcg-json") });
  const T = themeTokens(doc);
  assert.ok(T.background.modes.dark && !T.text.modes.dark && !T.surface.modes.dark, "the fixture has a dark page color only");
  const css = tokenStylesheet(doc, { theme: { selector: "html", darkClass: "dark" } });
  const dark = darkPart(css, "[class~=\"dark\"] {\n  color-scheme: dark;");
  const text = lastValue(dark, tokenVar(T.text.id));
  const surface = lastValue(dark, tokenVar(T.surface.id));
  assert.equal(text, "#e7eaf0", "light text on the dark page");
  assert.match(surface, /^#[0-9a-f]{6}$/);
  const lum = (h) => [1, 3, 5].reduce((a, i) => a + parseInt(h.slice(i, i + 2), 16), 0) / 3;
  assert.ok(lum(surface) < 80, `cards and inputs turn dark too (${surface})`);
  // A project whose text color has its own dark value keeps it.
  const own = await scanProject({ root: FIX("css-vars-dark") });
  const ownCss = tokenStylesheet(own, { theme: { selector: "html", darkClass: "dark" } });
  assert.equal(lastValue(darkPart(ownCss, "[class~=\"dark\"] {\n  color-scheme: dark;"), "--dftp-t-color_dtext"), "#e6e9f2");
});

test("the image placeholder is not drawn in the page's own color", async () => {
  const doc = await scanProject({ root: FIX("css-vars-dark") });
  const T = themeTokens(doc);
  assert.equal(T.background, null);
  assert.equal(pickStyles(doc, "image").background, undefined, "surface is the page color here: the base tint shows instead");
  const two = tokenDoc([
    tok("color.background", "color", { hex: "#ffffff", alpha: 1 }, { role: "background" }),
    tok("color.surface", "color", { hex: "#f4f4f5", alpha: 1 }, { role: "surface" }),
  ]);
  assert.equal(pickStyles(two, "image").background, "color.surface");
  const same = tokenDoc([
    tok("color.background", "color", { hex: "#ffffff", alpha: 1 }, { role: "background" }),
    tok("color.card", "color", { hex: "#ffffff", alpha: 1 }, { role: "surface" }),
  ]);
  assert.equal(pickStyles(same, "image").background, undefined, "a surface equal to the page color is not used");
});

test("the image placeholder is not drawn in a color too close to the page's, in light or dark", async () => {
  const c = (hex, alpha = 1) => ({ hex, alpha });
  const bg = (over = {}) => tok("color.background", "color", c("#f9fafb"), { role: "background", ...over });
  // Nearly the page's own color: an off-white card color on an off-white page.
  const near = tokenDoc([bg(), tok("color.paper", "color", c("#fffdf7"), { role: "surface" })]);
  assert.equal(pickStyles(near, "image").background, undefined);
  assert.equal(themeTokens(near).placeholder, null);
  // The fixture this comes from.
  const dtcg = await scanProject({ root: FIX("dtcg-json") });
  assert.equal(pickStyles(dtcg, "image").background, undefined);
  // Apart in light, the same in dark.
  const dark = tokenDoc([
    bg({ modes: { dark: c("#0f141c") } }),
    tok("color.surface", "color", c("#e5e7eb"), { role: "surface", modes: { dark: c("#0b1020") } }),
  ]);
  assert.equal(pickStyles(dark, "image").background, undefined, "#0b1020 cannot be told from #0f141c");
  // A see-through fill is laid over the page first.
  const faint = tokenDoc([bg(), tok("color.surface", "color", c("#000000", 0.01), { role: "surface" })]);
  assert.equal(pickStyles(faint, "image").background, undefined);
  // A muted fill that shows is used before the surface; one that does not, is skipped for it.
  const muted = tokenDoc([
    tok("color.background", "color", c("#ffffff"), { role: "background", modes: { dark: c("#09090b") } }),
    tok("color.muted", "color", c("#ffffff"), { role: "muted" }),
    tok("color.surface", "color", c("#e4e4e7"), { role: "surface", modes: { dark: c("#27272a") } }),
  ]);
  assert.equal(pickStyles(muted, "image").background, "color.surface");
  const shows = tokenDoc([
    tok("color.background", "color", c("#ffffff"), { role: "background" }),
    tok("color.muted", "color", c("#f4f4f5"), { role: "muted" }),
    tok("color.surface", "color", c("#e4e4e7"), { role: "surface" }),
  ]);
  assert.equal(pickStyles(shows, "image").background, "color.muted");
  // The base rule's fill follows the same choice: no fill, so the tint shows.
  const css = tokenStylesheet(near);
  assert.doesNotMatch(css, /--dftp-placeholder:/);
  assert.match(css, /background: var\(--dftp-s-background, var\(--dftp-placeholder, color-mix\(in srgb, currentColor 10%, transparent\)\)\);/);
  assert.match(tokenStylesheet(shows), /--dftp-placeholder: var\(--dftp-t-color_dmuted\);/);
});

test("body text: the font family and size set on the page root are the blank page's text", () => {
  const doc = tokenDoc([
    tok("font.auto.aaa", "fontFamily", { families: ["Inter", "sans-serif"] }, { role: "text", usage: { count: 1, seenLive: false } }),
    tok("font.mono", "fontFamily", { families: ["Menlo", "monospace"] }, { usage: { count: 9, seenLive: false } }),
    tok("font-size.auto.15px", "fontSize", { value: 15, unit: "px", px: 15 }, { role: "text" }),
    tok("font-size.auto.16px", "fontSize", { value: 16, unit: "px", px: 16 }),
  ]);
  assert.equal(themeTokens(doc).body.id, "font.auto.aaa");
  assert.equal(pickStyles(doc, "text")["font-size"], "font-size.auto.15px");
  assert.equal(pickStyles(doc, "input")["font-size"], "font-size.auto.15px");
  assert.equal(pickStyles(doc, "text")["font-family"], "font.auto.aaa");
});
