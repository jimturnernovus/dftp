// What the scan reads out of common real-world styling: naming schemes for
// roles, long font stacks, calc(), font shorthands and @font-face,
// color-mix() and relative colors, gradients with a direction, light-dark(),
// the usual prefers-color-scheme patterns, Tokens Studio, WordPress and
// Style Dictionary files, prefixed breakpoints and single-file components.
// Each project here is a small copy of a widespread pattern.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { scanProject, summaryLines } from "../../server/scan/scanner.mjs";
import { validateTokensDoc } from "../../client/core/tokens.js";
import { themeTokens, pickStyles } from "../../client/core/blank.js";
import { breakpointsOf } from "../../server/blank.mjs";
import { tempRoot, removeRoot, TOOL_DIR } from "../helpers.mjs";

async function scanOf(files, opts = {}) {
  const root = await tempRoot({ demo: false });
  try {
    for (const [rel, text] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.writeFile(path.join(root, rel), typeof text === "string" ? text : JSON.stringify(text, null, 2));
    }
    const doc = await scanProject({ root, ...opts });
    const r = validateTokensDoc(doc);
    assert.ok(r.ok, `the document validates: ${r.error}`);
    return doc;
  } finally {
    await removeRoot(root);
  }
}
const find = (doc, id) => doc.tokens.find((t) => t.id === id);
const hex = (doc, id) => (find(doc, id) && find(doc, id).value ? find(doc, id).value.hex : null);
const codes = (doc) => doc.diagnostics.map((d) => d.code);

test("roles: a kind word before a step decides (bg-primary is the page background, not the primary color)", async () => {
  const doc = await scanOf({
    "src/styles/theme.css": [
      ":root{--color-brand-600:#7f56d9;--color-bg-primary:#fff;--color-bg-secondary:#f9fafb;--color-text-primary:#101828;",
      "--color-text-secondary:#344054;--color-text-tertiary:#475467;--color-border-primary:#d0d5dd;--color-border-secondary:#eaecf0;",
      "--color-bg-brand-solid:#7f56d9}",
      "body{background:var(--color-bg-primary);color:var(--color-text-primary)}",
      ".btn-primary{background:var(--color-bg-brand-solid)}",
    ].join("\n"),
  });
  assert.equal(find(doc, "color.bg.primary").role, "background");
  assert.equal(find(doc, "color.text.primary").role, "text");
  assert.equal(find(doc, "color.border.primary").role, "border");
  assert.equal(find(doc, "color.bg.brand.solid").role, "primary");
  assert.notEqual(find(doc, "color.text.tertiary").role, "text", "the page's own text color wins the role");
  const T = themeTokens(doc);
  assert.equal(T.primary.id, "color.bg.brand.solid");
  assert.equal(T.background.id, "color.bg.primary");
  assert.equal(T.text.id, "color.text.primary");
  assert.equal(pickStyles(doc, "button").background, "color.bg.brand.solid", "a blank-page button is not white on white");
  assert.match(summaryLines(doc).join("\n"), /background color\.bg\.primary/);
});

test("roles: a hover rule or a state name never takes the primary role from the resting color", async () => {
  const doc = await scanOf({
    "a.css": ":root{--primary:#3b82f6;--primary-hover:#2f68c5} .btn{background:var(--primary)} .btn:hover{background:#2f68c5}",
  });
  assert.equal(find(doc, "color.primary").role, "primary");
  assert.equal(find(doc, "color.primary.hover").role, null);
});

test("roles: a project whose button color is named --accent gets it as the primary color", async () => {
  const doc = await scanOf({
    "src/app.css": ":root{--bg:#f6f7f9;--text:#1c2230;--accent:#2f5bd8} body{background:var(--bg);color:var(--text)} .btn-solid{background:var(--accent);color:#fff}",
  });
  assert.equal(find(doc, "color.accent").role, "primary");
  assert.equal(pickStyles(doc, "button").background, "color.accent");
});

test("the example app: its Button's color is the blank button's, and body type comes from the font shorthand", async () => {
  const doc = await scanProject({ root: path.join(TOOL_DIR, "examples", "vite-react"), libraryPrefixes: ["src/components/ui/"] });
  assert.ok(validateTokensDoc(doc).ok);
  assert.equal(pickStyles(doc, "button").background, "color.accent");
  assert.equal(pickStyles(doc, "button")["font-weight"], undefined, "the 700 of a price is not the button's weight");
  const text = pickStyles(doc, "text");
  assert.equal(find(doc, text["font-size"]).value.px, 16, "body text is 16px, not a card title's 20px");
  assert.deepEqual(find(doc, text["font-family"]).value.families, ["system-ui", "sans-serif"]);
  assert.equal(find(doc, pickStyles(doc, "input")["font-size"]).value.px, 16);
});

test("font stacks longer than 12 families (Bootstrap, Tailwind CSS v3) are kept, first 10 families", async () => {
  const bootstrap = "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, sans-serif, \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\"";
  const tw3 = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif, \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\"";
  const doc = await scanOf({
    "b.css": `:root{--bs-font-sans-serif: ${bootstrap};--bs-font-monospace: SFMono-Regular, Menlo, monospace;--bs-body-font-family: var(--bs-font-sans-serif)} body{font-family:var(--bs-body-font-family)}`,
    "t.css": `:root{--font-sans: ${tw3}}`,
  });
  const sans = find(doc, "font.bs.font.sans.serif");
  assert.ok(sans, "the 13-family stack is a token");
  assert.equal(sans.value.families.length, 10);
  assert.equal(sans.value.families[0], "system-ui");
  assert.equal(find(doc, "font.sans").value.families[0], "ui-sans-serif");
  assert.notEqual(themeTokens(doc).body.id, "font.bs.font.monospace", "blank pages do not turn monospace");
});

test("numbers, lengths and CSS-wide keywords are not font families; under a font name they are weights and sizes", async () => {
  const doc = await scanOf({
    "tokens/size/font.json": { size: { font: { small: { value: "0.75" }, medium: { value: "1" }, large: { value: "2" }, base: { value: "{size.font.medium.value}" } } } },
    "theme.json": { fonts: { body: "system-ui, sans-serif", heading: "inherit" } },
    "a.css": ":root{--font-bold:700;--font-medium:500;--font-lg:1.125rem}",
  });
  assert.ok(!doc.tokens.some((t) => t.type === "fontFamily" && t.value && t.value.families.some((f) => /^[\d.]/.test(f) || f === "inherit")));
  assert.equal(find(doc, "font.heading").value, null, "\"inherit\" is no family");
  assert.equal(find(doc, "font-weight.font.bold").value.value, 700);
  assert.equal(find(doc, "font-weight.font.medium").value.value, 500);
  assert.equal(find(doc, "font-size.font.lg").value.px, 18);
  assert.equal(find(doc, "font-size.small").value.px, 12, "Style Dictionary sizes are rem");
  assert.equal(find(doc, "font-size.base").aliasOf, "font-size.medium");
  assert.notEqual(themeTokens(doc).body.value.families[0], "1");
});

test("calc() of lengths is worked out: shadcn / Tailwind v4 radius steps and calc line heights", async () => {
  const doc = await scanOf({
    "app/globals.css": [
      "@theme inline { --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px); --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px) }",
      ":root{--radius:0.625rem}",
      "@theme { --text-tiny: 0.625rem; --text-tiny--line-height: calc(1 / 0.625) }",
      ":root{--wide: calc(100% - 2rem)}",
    ].join("\n"),
  });
  assert.equal(find(doc, "radius.sm").value.px, 6);
  assert.equal(find(doc, "radius.md").value.px, 8);
  assert.equal(find(doc, "radius.lg").value.px, 10);
  assert.equal(find(doc, "radius.xl").value.px, 14);
  assert.deepEqual(doc.scales.radius, [6, 8, 10, 14]);
  assert.deepEqual(find(doc, "line-height.text-tiny").value, { value: 1.6, unit: "" });
  assert.equal(find(doc, "size.wide"), undefined, "a percentage mix stays unread");
});

test("named variables with equal values stay apart: shadcn's card, popover, muted, accent and input", async () => {
  const doc = await scanOf({
    "app/globals.css": [
      ":root{--background:0 0% 100%;--foreground:222.2 84% 4.9%;--card:0 0% 100%;--popover:0 0% 100%;--secondary:210 40% 96.1%;",
      "--muted:210 40% 96.1%;--muted-foreground:215.4 16.3% 46.9%;--accent:210 40% 96.1%;--border:214.3 31.8% 91.4%;--input:214.3 31.8% 91.4%}",
      ".dark{--background:222.2 84% 4.9%;--card:222.2 84% 4.9%;--popover:222.2 84% 4.9%;--secondary:217.2 32.6% 17.5%;--muted:217.2 32.6% 17.5%;",
      "--accent:217.2 32.6% 17.5%;--border:217.2 32.6% 17.5%;--input:217.2 32.6% 17.5%}",
      "@theme inline{--color-muted:var(--muted);--color-accent:var(--accent);--color-card:var(--card);--color-popover:var(--popover)}",
    ].join("\n"),
  });
  for (const id of ["color.background", "color.card", "color.popover", "color.secondary", "color.muted", "color.accent", "color.border", "color.input"]) {
    assert.ok(find(doc, id), id);
  }
  assert.deepEqual(find(doc, "color.muted").sources.map((s) => s.name), ["--muted", "--muted", "--color-muted"]);
  assert.equal(find(doc, "color.accent").aliasOf, null);
  assert.equal(find(doc, "color.card").role, "surface");
  assert.equal(themeTokens(doc).surface.id === "color.card" || themeTokens(doc).surface.id === "color.popover", true);
  assert.ok(themeTokens(doc).mutedBg, "a muted background exists");
});

test("light-dark() gives dark values without any dark rule", async () => {
  const doc = await scanOf({ "a.css": ":root{color-scheme:light dark;--surface:light-dark(#ffffff,#121212);--ink:light-dark(#1a1a1a,#eeeeee)}" });
  assert.equal(find(doc, "color.surface").modes.dark.hex, "#121212");
  assert.equal(find(doc, "color.ink").modes.dark.hex, "#eeeeee");
});

test("prefers-color-scheme: :root:not(.light), :root:not([data-theme]) and <style media> give dark values", async () => {
  const doc = await scanOf({
    "a.css": ":root{--a:#ffffff} @media (prefers-color-scheme: dark){:root:not(.light){--a:#000000}}",
    "b.css": ":root{--b:#ffffff} @media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]){--b:#111111}}",
    "c.css": ":root{--c:#ffffff} @media (prefers-color-scheme: dark){:root:not([data-theme]){--c:#222222}}",
    "i.html": "<style>:root{--d:#ffffff}</style><style media=\"(prefers-color-scheme: dark)\">:root{--d:#333333}</style>",
  });
  assert.equal(find(doc, "color.a").modes.dark.hex, "#000000");
  assert.equal(find(doc, "color.b").modes.dark.hex, "#111111");
  assert.equal(find(doc, "color.c").modes.dark.hex, "#222222");
  assert.equal(find(doc, "color.d").modes.dark.hex, "#333333");
  assert.ok(!codes(doc).includes("redefined"));
});

test("a narrower definition ignored because a page-wide one exists is reported", async () => {
  const doc = await scanOf({ "a.css": ":root{--x:#ffffff} @media (min-width: 900px){:root{--x:#000000}} .card{--x:#ffffff}" });
  assert.deepEqual(doc.diagnostics.filter((d) => d.code === "scoped-skip").map((d) => d.line), [1]);
  assert.equal(doc.diagnostics.filter((d) => d.code === "scoped-skip").length, 1, "a narrower rule with the same value says nothing");
});

test("Tokens Studio: set names leave the ids, references cross sets, a dark set is the dark mode, plain numbers are px", async () => {
  const doc = await scanOf({
    "tokens/tokens.json": {
      global: {
        colors: { blue: { 500: { value: "#3b82f6", type: "color" } } },
        spacing: { sm: { value: "8", type: "spacing" } },
        borderRadius: { md: { value: "6", type: "borderRadius" } },
        fontSizes: { body: { value: "16", type: "fontSizes" } },
      },
      light: { bg: { default: { value: "{colors.blue.500}", type: "color" } } },
      dark: { bg: { default: { value: "#000000", type: "color" } } },
      $themes: [],
      $metadata: { tokenSetOrder: ["global", "light", "dark"] },
    },
  });
  const bg = find(doc, "color.bg.default");
  assert.equal(bg.value.hex, "#3b82f6");
  assert.equal(bg.modes.dark.hex, "#000000");
  assert.equal(bg.role, "background");
  assert.equal(themeTokens(doc).background.value.hex, "#3b82f6", "light mode is not black");
  assert.equal(find(doc, "radius.md").value.px, 6);
  assert.equal(find(doc, "spacing.sm").value.px, 8);
  assert.equal(find(doc, "font-size.body").value.px, 16);
  assert.deepEqual(doc.scales.spacing, [8]);
  assert.ok(!doc.tokens.some((t) => /\.(global|light|dark)\./.test(`${t.id}.`)), "no set name in an id");
  // The multi-file export: plain numbers in a set file are px too.
  const multi = await scanOf({ "tokens/global.json": { fontSizes: { body: { value: "16", type: "fontSizes" } }, borderRadius: { md: { value: "6", type: "borderRadius" } } } });
  assert.equal(find(multi, "font-size.body").value.px, 16);
  assert.equal(find(multi, "radius.md").value.px, 6);
});

test("WordPress theme.json: presets become the --wp--preset--* tokens, styles are uses, settings are not values", async () => {
  const doc = await scanOf({
    "theme.json": {
      version: 3,
      settings: {
        appearanceTools: true,
        color: { palette: [{ slug: "base", name: "Base", color: "#ffffff" }, { slug: "contrast", name: "Contrast", color: "#111111" }], gradients: [{ slug: "vivid", name: "Vivid", gradient: "linear-gradient(135deg,#ff0000 0%,#0000ff 100%)" }] },
        spacing: { units: ["%", "px", "em", "rem", "vh", "vw"], spacingSizes: [{ slug: "50", name: "Medium", size: "2rem" }], spacingScale: { steps: 0 } },
        typography: { fontSizes: [{ slug: "small", name: "Small", size: "0.875rem" }], fontFamilies: [{ slug: "body", name: "Body", fontFamily: "\"Inter\", sans-serif" }] },
        shadow: { presets: [{ slug: "natural", name: "Natural", shadow: "6px 6px 9px rgba(0, 0, 0, 0.2)" }] },
        layout: { contentSize: "645px" },
      },
      styles: {
        color: { background: "var:preset|color|base", text: "var:preset|color|contrast" },
        typography: { fontFamily: "var:preset|font-family|body" },
        spacing: { padding: { left: "var:preset|spacing|50", right: "var:preset|spacing|50" } },
        elements: { button: { color: { background: "var(--wp--preset--color--contrast)", text: "var(--wp--preset--color--base)" } } },
      },
    },
  });
  assert.equal(hex(doc, "color.base"), "#ffffff");
  assert.equal(find(doc, "color.base").role, "background");
  assert.equal(find(doc, "color.contrast").role, "text");
  assert.deepEqual(find(doc, "color.base").sources.map((s) => s.name), ["--wp--preset--color--base"]);
  assert.equal(find(doc, "shadow.natural").value[0].blur.value, 9);
  assert.equal(find(doc, "gradient.vivid").value.head, "135deg");
  assert.equal(find(doc, "spacing.50").value.px, 32);
  assert.equal(find(doc, "font.body").role, "text");
  assert.ok(find(doc, "color.base").usage.count >= 1, "styles count as uses of the presets");
  assert.ok(!doc.tokens.some((t) => t.value === null), "no token without a value");
  assert.ok(!doc.tokens.some((t) => /units|padding|default/.test(t.id)), "settings and styles are not definitions");
  assert.ok(!codes(doc).includes("redefined"));
});

test("Style Dictionary's size category is in rem, typed by its second segment", async () => {
  const doc = await scanOf({
    "tokens/size/padding.json": { size: { padding: { small: { value: "0.5" }, medium: { value: "1" }, large: { value: "1.5" } } } },
    "tokens/size/radius.json": { size: { radius: { base: { value: "0.25" } } } },
  });
  assert.equal(find(doc, "spacing.padding.small").value.px, 8);
  assert.equal(find(doc, "spacing.padding.large").value.unit, "rem");
  assert.equal(find(doc, "radius.base").value.px, 4);
  assert.deepEqual(doc.scales.spacing, [8, 16, 24]);
});

test("prefixed breakpoint names (--bs-breakpoint-md) are named md, and the blank scaffold uses them", async () => {
  const doc = await scanOf({ "b.css": ":root{--bs-breakpoint-xs:0;--bs-breakpoint-sm:576px;--bs-breakpoint-md:768px;--bs-breakpoint-lg:992px;--bs-breakpoint-xl:1200px}" });
  assert.deepEqual(doc.breakpoints.map((b) => [b.name, b.min]), [["xs", 0], ["sm", 576], ["md", 768], ["lg", 992], ["xl", 1200]]);
  assert.deepEqual(breakpointsOf(doc), { md: 768, lg: 992 });
});

test(".vue, .svelte and .astro style blocks are read; scss and less blocks are skipped with a code", async () => {
  const doc = await scanOf({
    "src/App.svelte": "<script>let n = 1;</script>\n<style>:global(:root){--brand:#ff3e00} .app{color:#333333;padding:16px}</style>",
    "src/App.vue": "<template><div class=\"x\">Hi</div></template>\n<style>:root{--accent:#42b883}</style>\n<style lang=\"scss\">$x: red; .a { color: $x; }</style>",
    "src/routes/index.astro": "---\nconst title = \"Home\";\n---\n<h1>{title}</h1>\n<style>:root{--ink:#111111}</style>",
  });
  assert.equal(hex(doc, "color.brand"), "#ff3e00");
  assert.equal(find(doc, "color.brand").scoped, undefined, ":global(:root) is the page root");
  assert.equal(hex(doc, "color.accent"), "#42b883");
  assert.equal(hex(doc, "color.ink"), "#111111");
  assert.ok(find(doc, "color.auto.333333"));
  assert.ok(doc.diagnostics.some((d) => d.adapter === "sfc" && d.code === "parse-skip" && d.file === "src/App.vue"));
  assert.ok(doc.scan.adapters.sfc === 3);
  assert.ok(!JSON.stringify(doc).includes("Home"), "templates and scripts are not read");
});

test("gradients keep their direction, shape and position, and different ones stay apart", async () => {
  const doc = await scanOf({
    "site.css": ".a{background-image:linear-gradient(90deg,#f00,#00f)} .b{background-image:linear-gradient(180deg,#f00,#00f)} .c{background-image:radial-gradient(circle at top left,#f00,#00f)}",
  });
  const grads = doc.tokens.filter((t) => t.type === "gradient").map((t) => t.value.head).sort();
  assert.deepEqual(grads, ["180deg", "90deg", "circle at top left"]);
});

test("color-mix() and relative colors are worked out; one that is not is kept with no value and a code", async () => {
  const doc = await scanOf({
    "a.css": [
      ":root{--primary:#3b82f6;--primary-hover:color-mix(in srgb, var(--primary) 80%, black);--primary-soft:oklch(from var(--primary) l c h / 20%);",
      "--ring:rgb(from #3b82f6 r g b / 50%);--odd:oklch(from var(--primary) calc(l - 0.1) c h)}",
      ".btn:hover{background:color-mix(in srgb,#3b82f6 80%,#000)}",
    ].join("\n"),
  });
  assert.equal(hex(doc, "color.primary.hover"), "#2f68c5");
  assert.equal(find(doc, "color.primary.hover").usage.count, 1, "the literal color-mix() counts towards it");
  assert.deepEqual(find(doc, "color.primary.soft").value, { hex: "#3b82f6", alpha: 0.2 });
  assert.deepEqual(find(doc, "color.ring").value, { hex: "#3b82f6", alpha: 0.5 });
  assert.equal(find(doc, "color.odd").value, null);
  assert.deepEqual(doc.diagnostics.filter((d) => d.code === "unsupported-color").map((d) => d.line), [2]);
});

test("@font-face descriptors are not uses; the font shorthand counts as its parts and marks the body's type", async () => {
  const doc = await scanOf({
    "a.css": [
      "@font-face{font-family:\"Inter\";font-weight:400;src:url(a.woff2)}",
      "@font-face{font-family:\"Inter\";font-weight:700;src:url(b.woff2)}",
      "body{font:600 18px/1.4 \"Inter\",sans-serif}",
      "h2{font-size:1.25rem}",
      ".menu{font:menu}",
    ].join("\n"),
  });
  const weights = doc.tokens.filter((t) => t.type === "fontWeight").map((t) => t.value.value);
  assert.deepEqual(weights, [600]);
  const fam = doc.tokens.find((t) => t.type === "fontFamily");
  assert.deepEqual(fam.value.families, ["Inter", "sans-serif"]);
  assert.equal(fam.usage.count, 1);
  assert.equal(fam.role, "text");
  assert.equal(find(doc, "font-size.auto.18px").role, "text");
  assert.ok(find(doc, "line-height.auto.1_4x"));
  assert.equal(find(doc, pickStyles(doc, "text")["font-size"]).value.px, 18);
  assert.equal(themeTokens(doc).body.id, fam.id);
});

test("body type set by the font shorthand on the page root is the blank page's text, never a heading's size", async () => {
  // The smallest case: the body's type only in the shorthand, a heading size beside it.
  const a = await scanOf({ "src/app.css": "body { color:#1c2230; font: 16px/1.5 Inter, system-ui, sans-serif }\nh2 { font-size: 1.25rem }\n" });
  const fam = a.tokens.find((t) => t.type === "fontFamily");
  assert.deepEqual(fam.value.families, ["Inter", "system-ui", "sans-serif"]);
  assert.equal(fam.role, "text");
  assert.equal(find(a, "font-size.auto.16px").role, "text");
  assert.equal(find(a, "font-size.auto.1_25rem").role, null);
  assert.deepEqual(find(a, "line-height.auto.1_5x").value, { value: 1.5, unit: "" });
  for (const el of ["text", "input"]) assert.equal(pickStyles(a, el)["font-size"], "font-size.auto.16px", el);
  assert.equal(pickStyles(a, "text")["line-height"], "line-height.auto.1_5x");
  assert.equal(pickStyles(a, "text")["font-family"], fam.id);

  // Weight first and a size in rem, on html; a 16px label elsewhere is not the body's size.
  const b = await scanOf({ "a.css": "html{font:600 1.125rem/1.4 X} .label{font-size:16px} h1{font-size:2rem}" });
  assert.equal(find(b, "font-weight.auto.600").usage.count, 1);
  assert.equal(find(b, "font-size.auto.1_125rem").role, "text");
  assert.ok(find(b, "line-height.auto.1_4x"));
  assert.deepEqual(b.tokens.find((t) => t.type === "fontFamily").value.families, ["X"]);
  assert.equal(pickStyles(b, "text")["font-size"], "font-size.auto.1_125rem");
  const c = await scanOf({ "a.css": "body{font:600 1rem/1.4 X}" });
  assert.deepEqual(c.tokens.map((t) => t.type).sort(), ["fontFamily", "fontSize", "fontWeight", "lineHeight"]);

  // The family from a custom property: the literal size and line height still count.
  const v = await scanOf({ "a.css": ":root{--font-sans:Inter,sans-serif} body{font:16px/1.5 var(--font-sans)} h2{font-size:1.25rem}" });
  assert.equal(find(v, "font.sans").role, "text");
  assert.equal(find(v, "font-size.auto.16px").role, "text");
  assert.ok(find(v, "line-height.auto.1_5x"));
  assert.equal(pickStyles(v, "text")["font-size"], "font-size.auto.16px");
  assert.equal(pickStyles(v, "text")["font-family"], "font.sans");

  // A var() before the family cannot be placed, and system fonts are no sizes: nothing is guessed.
  const n = await scanOf({ "a.css": "body{font:var(--w) 16px/1.5 X} p{font:600 var(--s)/1.4 Y} .m{font:menu} .c{font:caption} .i{font:inherit}" });
  assert.deepEqual(n.tokens.filter((t) => ["fontSize", "lineHeight", "fontWeight", "fontFamily"].includes(t.type)).map((t) => t.id), []);
});
