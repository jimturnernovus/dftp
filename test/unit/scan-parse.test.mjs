// The scanner's readers: CSS, style attributes, JSON with positions,
// .gitignore patterns, references, theme scopes and media queries. Each must
// keep linear time on hostile input.

import test from "node:test";
import assert from "node:assert/strict";
import { parseCss, parseDeclList, CSS_LIMITS } from "../../server/scan/css-parse.mjs";
import { parseJsonTree, getKey, plain, JsonError, JSON_LIMITS } from "../../server/scan/json-parse.mjs";
import { createIgnore, globSegment, IGNORE_LIMITS } from "../../server/scan/ignore.mjs";
import { findVarRefs, wholeVarRef, findBraceRefs, wholeBraceRef, usageValues, propKind } from "../../server/scan/usage.mjs";
import { positions, themeScope, mediaWidths } from "../../server/scan/helpers.mjs";
import { words, idFromName, inferType, roleFromName } from "../../server/scan/names.mjs";

const timed = (fn, ms = 2000) => {
  const t0 = Date.now();
  fn();
  const took = Date.now() - t0;
  assert.ok(took < ms, `took ${took} ms`);
};

test("CSS: declarations with their rule and at-rule chain, comments and strings stepped over", () => {
  const css = [
    "/* a { color: red } */",
    ":root { --brand: #2f5bd8; --pad: 4px }",
    "@media (prefers-color-scheme: dark) { :root { --brand: #6b8cff !important; } }",
    ".a::before { content: \"}{;\"; color: rgb(1 2 3) }",
    "@theme inline { --color-x: var(--brand); }",
    ".nest { color: red; &:hover { color: blue; } }",
    "@layer base { body { margin: 0 } }",
  ].join("\n");
  const p = parseCss(css);
  const at = (prop) => p.decls.filter((d) => d.prop === prop);
  assert.deepEqual(at("--brand").map((d) => d.value), ["#2f5bd8", "#6b8cff"]);
  assert.equal(at("--brand")[1].important, true);
  assert.deepEqual(at("--brand")[1].ctx.media, ["(prefers-color-scheme: dark)"]);
  assert.deepEqual(at("--brand")[1].ctx.rules, [":root"]);
  assert.equal(at("content")[0].value, "\"}{;\"");
  assert.equal(at("--color-x")[0].ctx.theme, true);
  assert.deepEqual(at("color").map((d) => d.ctx.rules.join(" | ")), [".a::before", ".nest", ".nest | &:hover"]);
  assert.deepEqual(at("margin")[0].ctx.at, ["layer"]);
  assert.deepEqual(p.blocks.map((b) => b.name), ["media", "theme", "layer"]);
  const pos = positions(css);
  assert.equal(pos(at("--pad")[0].offset).line, 2);
  assert.equal(pos(p.blocks[0].offset).line, 3);
  assert.equal(at("color").some((d) => d.value === "red" && d.ctx.rules[0] === "a"), false, "commented rules are not read");
});

test("CSS: malformed input is read as far as it makes sense", () => {
  const p = parseCss(".a { color: red; .b { color: blue } } } } .c { color: green; ");
  assert.deepEqual(p.decls.map((d) => d.value), ["red", "blue", "green"]);
  assert.deepEqual(parseCss("a { color: \"unterminated\n; margin: 1px }").decls.map((d) => d.prop), ["color", "margin"], "a string ends at the end of its line");
  assert.deepEqual(parseCss("color: red; a { : x; 1x: y; ok: z }").decls.map((d) => d.prop), ["ok"]);
  assert.deepEqual(parseCss("a { color: red /* never closed").decls.map((d) => d.value), ["red"]);
  const long = parseCss(`a { --x: ${"y".repeat(CSS_LIMITS.value + 1)} }`);
  assert.equal(long.decls[0].tooLong, true);
  assert.equal(long.decls[0].value, "");
});

test("CSS: deep nesting is followed but not reported, and huge or hostile input stays linear", () => {
  const deep = `${"a{".repeat(CSS_LIMITS.depth + 10)}color:red;${"}".repeat(CSS_LIMITS.depth + 10)} b { color: blue }`;
  const p = parseCss(deep);
  assert.equal(p.truncated, true);
  assert.deepEqual(p.decls.map((d) => d.value), ["blue"]);
  timed(() => parseCss("{".repeat(1024 * 1024)));
  timed(() => parseCss(`a { color: ${"(".repeat(500000)} }`));
  timed(() => parseCss(`a { ${"x:y;".repeat(200000)} }`));
  timed(() => parseCss(`${"/*".repeat(300000)}`));
  timed(() => parseCss(`a { b: ${"\\".repeat(500000)} }`));
  timed(() => parseCss(`${"a ".repeat(400000)}{ color: red }`));
  assert.ok(parseCss(`a { ${"x:y;".repeat(30000)} }`).decls.length <= CSS_LIMITS.decls);
});

test("style attributes: declarations with offsets; entities do not end a declaration", () => {
  const ds = parseDeclList("color: red; font-family: &quot;Fira Sans&quot;, serif; --x: 1px; bad", {
    base: 100,
    decode: (s) => s.replace(/&quot;/g, "\""),
  });
  assert.deepEqual(ds.map((d) => [d.prop, d.value]), [["color", "red"], ["font-family", "\"Fira Sans\", serif"], ["--x", "1px"]]);
  assert.equal(ds[0].offset, 100);
  timed(() => parseDeclList("&".repeat(500000)));
  timed(() => parseDeclList("a:".repeat(300000)));
});

test("JSON: positions for every key, limits, and no prototype keys", () => {
  const text = "{\n  \"color\": {\n    \"brand\": { \"$value\": \"#2f5bd8\" }\n  },\n  \"list\": [1, true, null, \"\\u0041\"]\n}";
  const tree = parseJsonTree(text);
  const pos = positions(text);
  const color = tree.entries[0];
  assert.equal(color.k, "color");
  assert.equal(pos(color.off).line, 2);
  const brand = getKey(color.v, "brand");
  assert.equal(pos(brand.off).line, 3);
  assert.deepEqual(plain(getKey(tree, "list")), [1, true, null, "A"]);
  const proto = parseJsonTree("{\"__proto__\": {\"x\": 1}, \"constructor\": 1, \"ok\": 2}");
  assert.deepEqual(proto.entries.map((e) => e.k), ["ok"]);
  assert.equal(Object.getPrototypeOf(plain(proto)), null);
  for (const badJson of ["{", "{\"a\":}", "[1,]", "{'a':1}", "{\"a\":1} x", "\"\u0001\"", "{\"a\":\"\\x\"}", "01", "NaN"]) {
    assert.throws(() => parseJsonTree(badJson), (e) => e instanceof JsonError && e.code === "json-invalid", badJson);
  }
  assert.throws(() => parseJsonTree("[".repeat(JSON_LIMITS.depth + 2)), (e) => e.code === "json-too-deep");
  timed(() => assert.throws(() => parseJsonTree("[".repeat(1000000))));
  timed(() => assert.throws(() => parseJsonTree(`"${"\\n".repeat(400000)}`)));
  timed(() => parseJsonTree(`[${"1,".repeat(150000)}1]`));
  assert.equal(parseJsonTree("\ufeff{}").t, "obj");
});

test(".gitignore patterns: anchoring, folders only, negation, wildcards and **", () => {
  const ig = createIgnore();
  ig.add(["# comment", "", "*.log", "/dist-root", "generated/", "!keep.log", "docs/**/draft.css", "a/*/b.css", "tmp[0-9].css", "\\#hash.css"].join("\n"));
  ig.add("local.css\n", "packages/web");
  assert.equal(ig.ignored("x.log", false), true);
  assert.equal(ig.ignored("deep/x.log", false), true);
  assert.equal(ig.ignored("keep.log", false), false);
  assert.equal(ig.ignored("dist-root", true), true);
  assert.equal(ig.ignored("src/dist-root", true), false, "a leading slash anchors");
  assert.equal(ig.ignored("src/generated", true), true);
  assert.equal(ig.ignored("src/generated", false), false, "a trailing slash means folders only");
  assert.equal(ig.ignored("docs/draft.css", false), true);
  assert.equal(ig.ignored("docs/x/y/draft.css", false), true);
  assert.equal(ig.ignored("a/x/b.css", false), true);
  assert.equal(ig.ignored("a/x/y/b.css", false), false);
  assert.equal(ig.ignored("tmp3.css", false), true);
  assert.equal(ig.ignored("tmpx.css", false), false);
  assert.equal(ig.ignored("#hash.css", false), true);
  assert.equal(ig.ignored("packages/web/local.css", false), true);
  assert.equal(ig.ignored("local.css", false), false, "a nested .gitignore applies below its folder only");
  assert.equal(globSegment("*.css", "a.css"), true);
  assert.equal(globSegment("a?c", "abc"), true);
  assert.equal(globSegment("[!a]*", "abc"), false);
  assert.equal(globSegment("[unclosed", "[unclosed"), true);
});

test(".gitignore: capped rule count and hostile patterns stay fast", () => {
  const ig = createIgnore();
  ig.add(Array.from({ length: IGNORE_LIMITS.rules + 50 }, (_, i) => `x${i}`).join("\n"));
  assert.equal(ig.capped, true);
  const hostile = createIgnore();
  hostile.add(`${"*a".repeat(400)}b\n${"**/".repeat(60)}z\n${"a".repeat(2000)}`);
  timed(() => {
    for (let i = 0; i < 200; i++) hostile.ignored(`${"a".repeat(200)}/${"a/".repeat(20)}${"a".repeat(250)}`, false);
  });
});

test("references: var() with fallbacks and nesting, and {path} references", () => {
  const refs = findVarRefs("calc(var(--a) + var(--b, var(--c, 2px)))");
  assert.deepEqual(refs.map((r) => r.name), ["--a", "--b", "--c"]);
  assert.equal(refs[1].fallback, "var(--c, 2px)");
  assert.equal(wholeVarRef(" var(--x, red) ").name, "--x");
  assert.equal(wholeVarRef("1px solid var(--x)"), null);
  assert.deepEqual(findVarRefs("somevar(--x) var( --y )").map((r) => r.name), ["--y"]);
  assert.equal(findVarRefs("var(--x").length, 0);
  assert.deepEqual(findBraceRefs("1px solid {color.border}").map((r) => r.name), ["color.border"]);
  assert.equal(wholeBraceRef("{color.accent.value}").name, "color.accent");
  assert.equal(wholeBraceRef("{a b}"), null);
  timed(() => findBraceRefs(`${"{".repeat(500000)}}`));
  timed(() => findVarRefs("var(".repeat(200000)));
});

test("usage values by property", () => {
  const types = (prop, raw) => usageValues(prop, raw).map((v) => `${v.type}${v.group ? `:${v.group}` : ""}`);
  assert.deepEqual(types("background", "url(x.png) no-repeat, linear-gradient(red, blue), #fff"), ["gradient", "color"]);
  assert.deepEqual(types("border", "1px solid #e5e7eb"), ["border", "color"]);
  assert.deepEqual(types("border", "0 none"), []);
  assert.deepEqual(types("padding", "8px 0 16px auto"), ["dimension:spacing", "dimension:spacing"]);
  assert.deepEqual(types("border-radius", "4px 8px / 2px"), ["radius", "radius", "radius"]);
  assert.deepEqual(types("transition", "color 120ms ease-out, opacity .2s cubic-bezier(0, 0, 1, 1)"), ["duration", "easing", "duration", "easing"]);
  assert.deepEqual(types("color", "transparent"), []);
  assert.deepEqual(types("opacity", "1"), []);
  assert.deepEqual(types("line-height", "normal"), []);
  assert.deepEqual(types("width", "10px"), []);
  assert.equal(propKind("border-top-left-radius"), "radius");
  assert.equal(propKind("content"), null);
});

test("theme scopes of custom property definitions", () => {
  const scope = (rules, media = [], theme = false) => themeScope({ rules, media, theme });
  assert.deepEqual(scope([":root"]), { kind: "base" });
  assert.deepEqual(scope([":root, :host"]), { kind: "base" });
  assert.deepEqual(scope(["html"]), { kind: "base" });
  assert.deepEqual(scope([".light"]), { kind: "base" });
  assert.deepEqual(scope([".dark"]), { kind: "mode", mode: "dark" });
  assert.deepEqual(scope([":root.dark"]), { kind: "mode", mode: "dark" });
  assert.deepEqual(scope(["html[data-theme='dark']"]), { kind: "mode", mode: "dark" });
  assert.deepEqual(scope(["[data-mode=\"dark\"], .dark"]), { kind: "mode", mode: "dark" });
  assert.deepEqual(scope([".theme-ocean"]), { kind: "mode", mode: "ocean" });
  assert.deepEqual(scope([":root"], ["(prefers-color-scheme: dark)"]), { kind: "mode", mode: "dark" });
  assert.deepEqual(scope([":root"], ["(prefers-color-scheme: light)"]), { kind: "base" });
  assert.deepEqual(scope([":root"], ["(min-width: 768px)"]), { kind: "scoped" });
  assert.deepEqual(scope([".card"]), { kind: "scoped" });
  assert.deepEqual(scope([".card.dark"]), { kind: "scoped" });
  assert.deepEqual(scope([":root, .dark"]), { kind: "scoped" });
  assert.deepEqual(scope([], [], true), { kind: "base" });
});

test("media query widths", () => {
  assert.deepEqual(mediaWidths("screen and (min-width: 768px) and (max-width:1023.98px)"), [
    { prop: "media-min", raw: "768px" }, { prop: "media-max", raw: "1023.98px" },
  ]);
  assert.deepEqual(mediaWidths("(width >= 40rem)"), [{ prop: "media-min", raw: "40rem" }]);
  assert.deepEqual(mediaWidths("(width < 640px)"), [{ prop: "media-min", raw: "640px" }]);
  assert.deepEqual(mediaWidths("(1024px >= width)"), [{ prop: "media-max", raw: "1024px" }]);
  assert.deepEqual(mediaWidths("print"), []);
  timed(() => mediaWidths(`(${"min-width: ".repeat(100000)}`));
});

test("names: words, ids, types and roles", () => {
  assert.deepEqual(words("--colorBrand-600"), ["color", "brand", "600"]);
  assert.equal(idFromName("--brand-600", "color"), "color.brand.600");
  assert.equal(idFromName("--color-brand-600", "color"), "color.brand.600");
  assert.equal(idFromName("color.brand.600", "color"), "color.brand.600");
  assert.equal(idFromName("colors.primary", "color"), "color.primary");
  assert.equal(idFromName("--font-size-lg", "fontSize"), "font-size.lg");
  assert.equal(idFromName("fontSizes.lg", "fontSize"), "font-size.lg");
  assert.equal(idFromName("--space-4", "dimension"), "spacing.4");
  assert.equal(idFromName("--radius", "radius"), "radius.default");
  assert.equal(idFromName("--x", "dimension", { group: "spacing" }), "spacing.x");
  assert.equal(idFromName("--anything", "color", { path: ["a b", "c"] }), "color.a-b.c");
  assert.equal(inferType("--brand", "#fff"), "color");
  assert.equal(inferType("--primary", "222.2 47.4% 11.2%"), "color");
  assert.equal(inferType("--color-primary", "59 130 246"), "color");
  assert.equal(inferType("--radius-md", "6px"), "radius");
  assert.equal(inferType("--text-lg", "1.125rem"), "fontSize");
  assert.equal(inferType("--leading", "1.5"), "lineHeight");
  assert.equal(inferType("--font-weight-bold", "700"), "fontWeight");
  assert.equal(inferType("--z-modal", "50"), "zIndex");
  assert.equal(inferType("--duration-fast", "120ms"), "duration");
  assert.equal(inferType("--ease-out", "cubic-bezier(0, 0, .2, 1)"), "easing");
  assert.equal(inferType("--font-sans", "Inter, sans-serif"), "fontFamily");
  assert.equal(inferType("--elevation-1", "0 1px 2px rgb(0 0 0 / .1)"), "shadow");
  assert.equal(inferType("--card", "0 1px 2px #0003"), "shadow");
  assert.equal(inferType("--pad", "4px 8px 12px"), null);
  assert.equal(inferType("--gap", "12px"), "dimension");
  assert.equal(inferType("--count", "3"), null);
  assert.equal(inferType("--x", "calc(1px + 2px)"), "dimension");
  assert.equal(inferType("--x", "calc(100% - 2px)"), null);
  assert.equal(roleFromName("--color-primary"), "primary");
  assert.equal(roleFromName("--brand-600"), "primary");
  assert.equal(roleFromName("--primary-foreground"), null);
  assert.equal(roleFromName("--muted-foreground"), "muted");
  assert.equal(roleFromName("--foreground"), "text");
  assert.equal(roleFromName("--bg-surface"), "surface");
  assert.equal(roleFromName("--destructive"), "danger");
  assert.equal(roleFromName("--blue-500"), null);
});
