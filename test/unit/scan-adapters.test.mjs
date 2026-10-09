// Each phase-1 adapter on its own: what it reports, what it leaves alone,
// and that malformed or hostile input neither throws nor takes long.

import test from "node:test";
import assert from "node:assert/strict";
import css from "../../server/scan/adapters/css.mjs";
import cssVars from "../../server/scan/adapters/css-vars.mjs";
import tailwindV4, { themeVar } from "../../server/scan/adapters/tailwind-v4.mjs";
import tokensJson, { modeFromPath } from "../../server/scan/adapters/tokens-json.mjs";
import html from "../../server/scan/adapters/html.mjs";
import components, { kindOf } from "../../server/scan/adapters/components.mjs";
import { ADAPTERS, checkAdapters } from "../../server/scan/registry.mjs";
import { helpers } from "../../server/scan/helpers.mjs";

const run = (adapter, text, path = "x.css") => adapter.extract({ path, text, helpers });
const byName = (out) => Object.fromEntries(out.tokens.map((t) => [`${t.name}${t.mode ? `@${t.mode}` : ""}${t.scoped ? "~" : ""}`, t]));

test("the registry lists every phase-1 adapter once, and checks new ones", () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id), ["css", "css-vars", "tailwind-v4", "tokens-json", "html", "sfc", "components"]);
  assert.throws(() => checkAdapters([{ id: "Bad", match() {}, extract() {} }]), /lower-case/);
  assert.throws(() => checkAdapters([{ id: "scan", match() {}, extract() {} }]), /lower-case/);
  assert.throws(() => checkAdapters([css, css]), /twice/);
  assert.throws(() => checkAdapters([{ id: "x", match() {} }]), /extract/);
  assert.throws(() => checkAdapters([{ id: "x", rank: 1.5, match() {}, extract() {} }]), /rank/);
  assert.equal(checkAdapters([css]).length, 1);
});

test("css: style declarations become usages; custom properties and other properties do not", () => {
  const out = run(css, [
    ".btn { color: #fff; background-color: var(--primary); padding: 8px 16px; width: 10px; --x: red; content: \"a\" }",
    "@media (min-width: 768px) and (max-width: 1023.98px) { .btn { border-radius: 6px } }",
  ].join("\n"));
  assert.deepEqual(out.usages.map((u) => u.prop), ["color", "background-color", "padding", "border-radius", "media-min", "media-max"]);
  assert.equal(out.usages[0].selector, ".btn");
  assert.equal(out.usages[3].line, 2);
  assert.deepEqual(out.tokens, []);
  const long = run(css, `a { color: ${"r".repeat(3000)} }`);
  assert.deepEqual(long.diagnostics, [{ code: "value-too-long", line: 1 }]);
  assert.equal(css.match("src/a.CSS"), true);
  assert.equal(css.match("src/a.scss"), false);
});

test("css-vars: page-wide definitions, theme modes, narrower scopes and references", () => {
  const out = run(cssVars, [
    ":root { --bg: #fff; --primary: var(--blue, #00f); }",
    ".dark { --bg: #000; }",
    "@media (prefers-color-scheme: dark) { :root { --primary: #88f; } }",
    "[data-theme=\"sepia\"] { --bg: #f4ecd8; }",
    ".card { --pad: 4px; }",
    "@theme { --color-x: red; }",
  ].join("\n"));
  const t = byName(out);
  assert.equal(t["--bg"].raw, "#fff");
  assert.equal(t["--bg@dark"].raw, "#000");
  assert.equal(t["--bg@sepia"].raw, "#f4ecd8");
  assert.equal(t["--primary"].aliasRef, "--blue");
  assert.equal(t["--primary@dark"].raw, "#88f");
  assert.equal(t["--pad~"].raw, "4px");
  assert.equal(t["--color-x"], undefined, "@theme belongs to tailwind-v4");
  assert.equal(t["--bg"].line, 1);
  assert.equal(t["--bg@dark"].line, 2);
});

test("tailwind-v4: @theme namespaces set type and path; resets and animations are skipped", () => {
  const out = run(tailwindV4, [
    "@import \"tailwindcss\";",
    "@theme {",
    "  --color-*: initial;",
    "  --color-brand-600: #2f5bd8;",
    "  --font-sans: Inter, sans-serif;",
    "  --font-weight-bold: 700;",
    "  --text-lg: 1.125rem;",
    "  --text-lg--line-height: 1.75rem;",
    "  --spacing: 0.25rem;",
    "  --radius-md: 0.375rem;",
    "  --breakpoint-md: 48rem;",
    "  --animate-spin: spin 1s linear infinite;",
    "  --color-primary: var(--primary);",
    "}",
    ":root { --primary: red; }",
  ].join("\n"));
  const t = byName(out);
  assert.deepEqual(Object.keys(t).sort(), ["--breakpoint-md", "--color-brand-600", "--color-primary", "--font-sans", "--font-weight-bold", "--radius-md", "--spacing", "--text-lg", "--text-lg--line-height"]);
  assert.deepEqual([t["--color-brand-600"].type, t["--color-brand-600"].path], ["color", ["brand", "600"]]);
  assert.equal(t["--font-sans"].type, "fontFamily");
  assert.equal(t["--font-weight-bold"].type, "fontWeight");
  assert.deepEqual([t["--text-lg--line-height"].type, t["--text-lg--line-height"].path], ["lineHeight", ["text-lg"]]);
  assert.deepEqual([t["--spacing"].type, t["--spacing"].group], ["dimension", "spacing"]);
  assert.equal(t["--breakpoint-md"].type, "breakpoint");
  assert.equal(t["--color-primary"].aliasRef, "--primary");
  assert.deepEqual(run(tailwindV4, ":root { --a: 1px }").tokens, [], "no @theme, nothing to do");
  assert.equal(themeVar("--animate-x"), null);
  assert.deepEqual(themeVar("--my-thing"), { type: null, group: null, path: null });
});

test("tokens-json: DTCG groups, inherited types, references, composites and modes", () => {
  const text = JSON.stringify({
    color: {
      $type: "color",
      brand: { 600: { $value: "#2f5bd8" } },
      bg: { $value: "{color.brand.600}", $extensions: { mode: { dark: "#000", light: "#fff" } } },
      p3: { $value: { colorSpace: "display-p3", components: [1, 0, 0], alpha: 0.5 } },
    },
    space: { $type: "dimension", sm: { $value: { value: 4, unit: "px" } } },
    shadow: { $type: "shadow", card: { $value: [{ color: "#0000001a", offsetX: "0px", offsetY: "1px", blur: "2px", spread: "0px", inset: true }] } },
    type: { h1: { $type: "typography", $value: { fontFamily: ["Inter", "sans-serif"], fontSize: "32px", fontWeight: 700 } } },
    motion: { t: { $type: "transition", $value: { duration: "200ms", timingFunction: [0.4, 0, 0.2, 1] } } },
    misc: { stroke: { $type: "strokeStyle", $value: "dashed" } },
  }, null, 2);
  const out = run(tokensJson, text, "design/brand.tokens.json");
  const t = byName(out);
  assert.equal(t["color.brand.600"].type, "color");
  assert.equal(t["color.bg"].aliasRef, "color.brand.600");
  assert.equal(t["color.bg@dark"].raw, "#000");
  assert.equal(t["color.bg@light"], undefined, "light is the base, not a mode");
  assert.equal(t["color.p3"].raw, "color(display-p3 1 0 0 / 0.5)");
  assert.equal(t["space.sm"].raw, "4px");
  assert.equal(t["shadow.card"].raw, "inset 0px 1px 2px 0px #0000001a");
  assert.equal(t["type.h1.fontFamily"].raw, "Inter, sans-serif");
  assert.deepEqual(t["type.h1.fontSize"].path, ["h1"]);
  assert.equal(t["type.h1.fontWeight"].raw, "700");
  assert.equal(t["motion.t.timingFunction"].raw, "cubic-bezier(0.4, 0, 0.2, 1)");
  assert.equal(t["motion.t.duration"].type, "duration");
  assert.equal(t["misc.stroke"].type, undefined);
  assert.equal(t["color.brand.600"].line, 5, "the line of the token's own key");
});

test("tokens-json: Style Dictionary values and theme objects", () => {
  const sd = run(tokensJson, JSON.stringify({ size: { base: { value: "16px", type: "fontSize" } }, color: { link: { value: "{color.a.value}", attributes: { category: "color" } } } }), "tokens/a.json");
  const s = byName(sd);
  assert.equal(s["size.base"].type, "fontSize");
  assert.equal(s["color.link"].aliasRef, "color.a");
  assert.equal(s["color.link"].type, "color");

  const theme = run(tokensJson, JSON.stringify({
    colors: { text: "#111", gray: { 100: "#f3f4f6" }, modes: { dark: { text: "#eee" } } },
    space: [0, 4, 8],
    fontSizes: { sm: 14 },
    radii: { md: 6 },
    lineHeights: { body: 1.5 },
    settings: { color: { palette: [{ slug: "ink", color: "#1f2937" }], gradients: [{ slug: "dawn", gradient: "linear-gradient(red, blue)" }] } },
  }), "theme.json");
  const th = byName(theme);
  assert.equal(th["color.text"].raw, "#111");
  assert.equal(th["color.text@dark"].raw, "#eee");
  assert.equal(th["color.gray.100"].raw, "#f3f4f6");
  assert.equal(th["spacing.2"].raw, "8px");
  assert.equal(th["fontSize.sm"].raw, "14px");
  assert.equal(th["radius.md"].raw, "6px");
  assert.equal(th["lineHeight.body"].raw, "1.5");
  assert.equal(th["color.ink"].raw, "#1f2937");
  assert.equal(th["gradient.dawn"].type, "gradient");
});

test("tokens-json: file matching, dark files, broken and hostile JSON", () => {
  for (const p of ["a.tokens.json", "a.tokens", "tokens.json", "tokens/x/y.json", "design-tokens.json", "theme.json", "theme-dark.json", "src/design-tokens/c.json"]) {
    assert.equal(tokensJson.match(p), true, p);
  }
  for (const p of ["package.json", "tsconfig.json", "src/x.json", "my-theme.js", "tokens.js"]) assert.equal(tokensJson.match(p), false, p);
  assert.equal(modeFromPath("tokens/color.dark.json"), "dark");
  assert.equal(modeFromPath("tokens/darkness.json"), null);
  const dark = run(tokensJson, JSON.stringify({ color: { bg: { $value: "#000", $type: "color" } } }), "tokens/dark/color.json");
  assert.equal(dark.tokens[0].mode, "dark");
  const broken = run(tokensJson, "{\n  \"a\": {\n    \"b\": oops\n  }\n}", "theme.json");
  assert.deepEqual(broken.diagnostics, [{ code: "json-invalid", line: 3 }]);
  const deep = run(tokensJson, `${"{\"a\":".repeat(100)}1${"}".repeat(100)}`, "theme.json");
  assert.equal(deep.diagnostics[0].code, "json-too-deep");
  const proto = run(tokensJson, "{\"colors\": {\"__proto__\": \"#fff\", \"ok\": \"#000\"}}", "theme.json");
  assert.deepEqual(proto.tokens.map((t) => t.name), ["color.ok"]);
  const t0 = Date.now();
  run(tokensJson, `{"colors": {${Array.from({ length: 20000 }, (_, i) => `"c${i}": "#${String(i % 999).padStart(3, "0")}"`).join(",")}}}`, "theme.json");
  run(tokensJson, `{"a": "${"{".repeat(500000)}"}`, "theme.json");
  assert.ok(Date.now() - t0 < 3000);
});

test("html: inline styles, style blocks and class names; never the text of the page", () => {
  const page = [
    "<!doctype html><html><head><style>",
    ":root { --accent: #0e7490 } body { color: #1f2937 }",
    "@theme { --color-brand: #123456; }",
    "</style></head><body>",
    "<!-- <p style=\"color: #ff00ff\">hidden</p> -->",
    "<h1 class=\"title big\" style=\"color: #0e7490; letter-spacing: -0.02em\">Visible words here</h1>",
    "<p style='font-family: &quot;Fira Sans&quot;, serif'>More words</p>",
    "<input value=\"typed secret\" style=color:red>",
    "<script>const s = \"<p style='color: #00ff00'>\";</script>",
    "<textarea style=\"color: #abcdef\"><b style=\"color: #fedcba\">x</b></textarea>",
    "<div class=\"[&>svg]:size-4 ok-class\"></div>",
    "</body></html>",
  ].join("\n");
  const out = run(html, page, "index.html");
  const usages = out.usages.map((u) => `${u.prop}=${u.raw}`);
  assert.ok(usages.includes("color=#1f2937"), "style block");
  assert.ok(usages.includes("color=#0e7490"), "style attribute");
  assert.ok(usages.includes("font-family=\"Fira Sans\", serif"), "entities decoded");
  assert.ok(usages.includes("color=red"), "unquoted attribute");
  assert.ok(usages.includes("color=#abcdef"), "a textarea's own attributes are read");
  assert.ok(!usages.some((u) => u.includes("#ff00ff")), "comments are skipped");
  assert.ok(!usages.some((u) => u.includes("#00ff00")), "scripts are skipped");
  assert.ok(!usages.some((u) => u.includes("#fedcba")), "textarea content is skipped");
  assert.deepEqual(out.usages.filter((u) => u.prop === "class").map((u) => u.raw), ["title", "big", "ok-class"]);
  const names = byName(out);
  assert.equal(names["--accent"].raw, "#0e7490");
  assert.equal(names["--color-brand"].type, "color");
  const all = JSON.stringify(out);
  for (const words of ["Visible words", "More words", "typed secret", "hidden"]) assert.ok(!all.includes(words), words);
  assert.equal(out.usages.find((u) => u.raw === "#0e7490" && u.selector === "[style]").line, 6);
  const t0 = Date.now();
  run(html, "<".repeat(500000));
  run(html, `<a ${"b=\"".repeat(200000)}`);
  run(html, `<style>${"{".repeat(300000)}`);
  run(html, `<div class="${"a ".repeat(300000)}">`);
  assert.ok(Date.now() - t0 < 3000);
});

test("components: library files with known names, and the name they export", () => {
  const opts = { libraryPrefixes: ["src/components/ui/"] };
  assert.equal(components.match("src/components/ui/button.jsx", opts), true);
  assert.equal(components.match("src/components/ui/radio-group.tsx", opts), true);
  assert.equal(components.match("src/components/ui/helpers.jsx", opts), false);
  assert.equal(components.match("src/components/ui/forms/input.jsx", opts), false, "direct children only");
  assert.equal(components.match("app/routes/button.jsx", opts), false);
  assert.equal(components.match("src/components/ui/button.css", opts), false);
  assert.equal(components.match("src/components/ui/button.jsx", {}), false);
  assert.equal(kindOf("x/Separator.tsx"), "divider");
  const one = (text, path = "src/components/ui/button.jsx") => run(components, text, path).components;
  assert.deepEqual(one("export const buttonVariants = 1;\nexport function Button() {}"), [{ kind: "button", export: "Button", line: 2 }]);
  assert.deepEqual(one("const Card = () => null;\nexport { Card, CardTitle as Title };", "src/components/ui/card.jsx").map((c) => c.export), ["Card"]);
  assert.deepEqual(one("export default function PrimaryButton() {}").map((c) => c.export), ["PrimaryButton"]);
  assert.deepEqual(one("<template><button/></template>", "src/components/ui/badge.vue"), [{ kind: "badge", export: "Badge", line: 1 }]);
  assert.deepEqual(one("const x = 1;"), []);
  const t0 = Date.now();
  one(`${"export ".repeat(200000)}`);
  one(`export {${"a,".repeat(300000)}`);
  one("export {".repeat(130000));
  assert.ok(Date.now() - t0 < 3000);
});
