// The scan's core: resolving references, merging by value, naming,
// precedence, roles, scales, breakpoints, checking adapter output, and
// merging live samples.

import test from "node:test";
import assert from "node:assert/strict";
import { buildDoc, checkOutput, uniqueId, slugFor, computeScales, BUILD_LIMITS } from "../../server/scan/build.mjs";
import { applyLive, mergeSamples, LIVE_MIN } from "../../server/scan/live.mjs";
import { validateTokensDoc, TOKEN_LIMITS } from "../../client/core/tokens.js";

const res = (file, adapter, rank, out) => ({
  file,
  adapter: { id: adapter, rank },
  out: checkOutput({ tokens: [], usages: [], components: [], diagnostics: [], ...out }),
});
const tok = (name, raw, extra = {}) => ({ name, raw, line: extra.line || 1, ...extra });
const use = (prop, raw, extra = {}) => ({ prop, raw, line: 1, ...extra });
const build = (...results) => {
  const doc = buildDoc({ results, now: () => new Date("2026-01-02T03:04:05Z") });
  const r = validateTokensDoc(doc);
  assert.ok(r.ok, `the built document validates: ${r.error}`);
  return doc;
};
const find = (doc, id) => doc.tokens.find((t) => t.id === id);
const codes = (doc) => doc.diagnostics.map((d) => d.code);

test("references resolve through chains; the token points at its direct target", () => {
  const doc = build(res("a.css", "css-vars", 20, {
    tokens: [
      tok("--blue-600", "#2563eb"),
      tok("--brand", "var(--blue-600)", { aliasRef: "--blue-600" }),
      tok("--button-bg", "var(--brand)", { aliasRef: "--brand" }),
      tok("--ring", "0 0 0 2px var(--brand)"),
    ],
  }));
  assert.deepEqual(find(doc, "color.button.bg").value, { hex: "#2563eb", alpha: 1 });
  assert.equal(find(doc, "color.button.bg").aliasOf, "color.brand");
  assert.equal(find(doc, "color.brand").aliasOf, "color.blue.600");
  assert.equal(find(doc, "shadow.ring").value[0].color.hex, "#2563eb");
  assert.equal(find(doc, "shadow.ring").aliasOf, null, "a value that only contains a reference is not an alias");
});

test("cycles and missing names are reported; a fallback is used when there is one", () => {
  const doc = build(res("a.css", "css-vars", 20, {
    tokens: [
      tok("--a", "var(--b)", { aliasRef: "--b", line: 2 }),
      tok("--b", "var(--a)", { aliasRef: "--a", line: 3 }),
      tok("--c", "var(--nope)", { aliasRef: "--nope", line: 4 }),
      tok("--d", "var(--nope, #ff0000)", { aliasRef: "--nope", line: 5 }),
      tok("--e", "1px solid var(--a)", { line: 6 }),
    ],
  }));
  assert.deepEqual(doc.diagnostics.map((d) => [d.code, d.line]), [["alias-cycle", 2], ["alias-cycle", 3], ["alias-missing", 4], ["alias-cycle", 6]]);
  assert.deepEqual(find(doc, "color.d").value, { hex: "#ff0000", alpha: 1 });
  assert.equal(find(doc, "color.d").aliasOf, null, "the target does not exist");
  assert.equal(find(doc, "color.a"), undefined, "a value that never resolves has no type, so no token");
});

test("long chains stop at the depth limit", () => {
  // Longest chain first, so the walk starts at the far end.
  const tokens = [];
  for (let i = BUILD_LIMITS.chain + 5; i >= 1; i--) tokens.push(tok(`--n${i}`, `var(--n${i - 1})`, { aliasRef: `--n${i - 1}` }));
  tokens.push(tok("--n0", "#000"));
  const doc = build(res("a.css", "css-vars", 20, { tokens }));
  assert.ok(codes(doc).includes("alias-depth"));
  assert.ok(find(doc, "color.n5"), "a name close enough to the end still resolves");
  assert.equal(find(doc, `color.n${BUILD_LIMITS.chain + 5}`).value, null, "the far end keeps its name but no value");
});

test("resolution work stays bounded on hostile reference graphs", () => {
  const t0 = Date.now();
  // Every link has a fallback to the same name: retrying it must not double the work.
  const chain = [];
  for (let i = 200; i >= 1; i--) chain.push(tok(`--n${i}`, `var(--n${i - 1}, var(--n${i - 1}))`, { aliasRef: `--n${i - 1}` }));
  chain.push(tok("--n0", "#000"));
  build(res("a.css", "css-vars", 20, { tokens: chain }));
  // Each value repeats the one before it: the text would double at every step.
  const wide = [tok("--w0", "#111111")];
  for (let i = 1; i <= 40; i++) wide.push(tok(`--w${i}`, Array.from({ length: 8 }, () => `var(--w${i - 1})`).join(" ")));
  const doc = build(res("b.css", "css-vars", 20, { tokens: wide }), res("c.css", "css", 10, { usages: [use("color", "var(--w40)")] }));
  assert.ok(codes(doc).includes("value-too-long"));
  // Many themes over many names.
  const themed = [];
  for (let i = 0; i < 2000; i++) {
    themed.push(tok(`--t${i}`, i ? `var(--t${i - 1})` : "#222222", i ? { aliasRef: `--t${i - 1}` } : {}));
    if (i % 250 === 0) for (let m = 0; m < 8; m++) themed.push(tok(`--t${i}`, "#333333", { mode: `m${m}` }));
  }
  build(res("d.css", "css-vars", 20, { tokens: themed }));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("modes: theme definitions, and values that depend on a themed name", () => {
  const doc = build(res("a.css", "css-vars", 20, {
    tokens: [
      tok("--bg", "#ffffff"),
      tok("--bg", "#000000", { mode: "dark" }),
      tok("--surface", "var(--bg)", { aliasRef: "--bg" }),
      tok("--text", "light-dark(#111111, #eeeeee)"),
      tok("--only-dark", "#123456", { mode: "dark" }),
    ],
  }));
  assert.deepEqual(find(doc, "color.bg").modes, { dark: { hex: "#000000", alpha: 1 } });
  assert.deepEqual(find(doc, "color.surface").modes, { dark: { hex: "#000000", alpha: 1 } });
  assert.deepEqual(find(doc, "color.text").value, { hex: "#111111", alpha: 1 });
  assert.deepEqual(find(doc, "color.text").modes, { dark: { hex: "#eeeeee", alpha: 1 } });
  assert.ok(codes(doc).includes("mode-only"));
  assert.equal(find(doc, "color.only.dark"), undefined);
});

test("merge: one token defined in two systems is one token named by the best source; other names stay apart", () => {
  const doc = build(
    res("a.css", "css-vars", 20, { tokens: [tok("--brand-main", "#2f5bd8"), tok("--link", "rgb(47 91 216)")] }),
    res("tokens/c.tokens.json", "tokens-json", 30, { tokens: [tok("color.brand.main", "#2F5BD8", { type: "color" })] }),
    res("b.css", "css", 10, { usages: [use("color", "#2f5bd8"), use("border-color", "rgb(18.43% 35.69% 84.71%)")] }),
  );
  const colors = doc.tokens.filter((t) => t.type === "color");
  assert.deepEqual(colors.map((t) => t.id).sort(), ["color.brand.main", "color.link"]);
  const t = find(doc, "color.brand.main");
  assert.deepEqual(t.sources.map((s) => s.name || s.adapter), ["color.brand.main", "--brand-main"], "a token file outranks a style sheet");
  assert.equal(t.usage.count, 2, "literal uses of the same value count towards the best named token");
  assert.deepEqual(find(doc, "color.link").sources.map((s) => s.name), ["--link"], "a differently named variable keeps its own token");
});

test("merge: differently named variables with equal values keep their ids and roles; an alias names its own target", () => {
  const doc = build(
    res("g.css", "css-vars", 20, {
      tokens: [
        tok("--background", "0 0% 100%"), tok("--card", "0 0% 100%"), tok("--popover", "0 0% 100%"),
        tok("--secondary", "210 40% 96.1%"), tok("--muted", "210 40% 96.1%"), tok("--accent", "210 40% 96.1%"),
        tok("--border", "214.3 31.8% 91.4%"), tok("--input", "214.3 31.8% 91.4%"),
      ],
    }),
    res("t.css", "tailwind-v4", 20, {
      tokens: [
        tok("--color-muted", "var(--muted)", { aliasRef: "--muted", type: "color", path: ["muted"] }),
        tok("--color-popover", "var(--popover)", { aliasRef: "--popover", type: "color", path: ["popover"] }),
      ],
    }),
  );
  for (const id of ["color.background", "color.card", "color.popover", "color.secondary", "color.muted", "color.accent", "color.border", "color.input"]) {
    assert.ok(find(doc, id), id);
    assert.equal(find(doc, id).aliasOf, null, id);
  }
  assert.equal(find(doc, "color.card").role, "surface");
  assert.equal(find(doc, "color.muted").role, "muted");
  assert.equal(find(doc, "color.accent").role, "accent");
  assert.deepEqual(find(doc, "color.muted").sources.map((s) => s.name), ["--muted", "--color-muted"], "--color-muted joins --muted, not --secondary");
  assert.deepEqual(find(doc, "color.popover").sources.map((s) => s.name), ["--popover", "--color-popover"]);
});

test("precedence: one name defined twice keeps the higher rank; equal rank keeps the first", () => {
  const doc = build(
    res("a.css", "css-vars", 20, { tokens: [tok("--x", "#111111", { line: 3 })] }),
    res("b.css", "css-vars", 20, { tokens: [tok("--x", "#222222", { line: 7 })] }),
    res("c.css", "tailwind-v4", 25, { tokens: [tok("--y", "#333333")] }),
    res("d.css", "css-vars", 20, { tokens: [tok("--y", "#444444")] }),
  );
  assert.equal(find(doc, "color.x").value.hex, "#111111");
  assert.equal(find(doc, "color.y").value.hex, "#333333");
  assert.deepEqual(doc.diagnostics.filter((d) => d.code === "redefined").map((d) => [d.file, d.line]), [["b.css", 7], ["d.css", 1]]);
});

test("scoped definitions are a fallback only; aliases with their target's id join it", () => {
  const doc = build(res("a.css", "css-vars", 20, {
    tokens: [
      tok("--pad", "4px", { scoped: true }),
      tok("--gap", "8px"),
      tok("--gap", "12px", { scoped: true }),
      tok("--primary", "#2f5bd8"),
      tok("--color-primary", "var(--primary)", { aliasRef: "--primary" }),
    ],
  }));
  assert.equal(find(doc, "size.pad").confidence, 0.6);
  assert.equal(find(doc, "spacing.default").value.px, 8);
  const p = find(doc, "color.primary");
  assert.deepEqual(p.sources.map((s) => s.name), ["--primary", "--color-primary"]);
  assert.equal(p.aliasOf, null);
  assert.equal(doc.tokens.filter((t) => t.type === "color").length, 1);
});

test("usage: references count, plain lengths take a type from where they are used, literals become unnamed tokens", () => {
  const doc = build(
    res("a.css", "css-vars", 20, { tokens: [tok("--step-2", "1.25rem"), tok("--brand", "#2f5bd8"), tok("--gutter", "24px")] }),
    res("b.css", "css", 10, {
      usages: [
        use("font-size", "var(--step-2)"),
        use("font-size", "var(--step-2)"),
        use("padding", "var(--gutter)"),
        use("color", "var(--brand)"),
        use("color", "#ff6600"),
        use("color", "#ff6600"),
        use("margin", "12px"),
        use("margin", "12px 0"),
        use("class", "btn"),
        use("color", "transparent"),
      ],
    }),
  );
  assert.equal(find(doc, "font-size.step.2").type, "fontSize");
  assert.equal(find(doc, "font-size.step.2").usage.count, 2);
  assert.ok(find(doc, "spacing.default"), "a length used only as spacing joins the spacing family");
  assert.equal(find(doc, "color.brand").usage.count, 1);
  const auto = find(doc, "color.auto.ff6600");
  assert.equal(auto.usage.count, 2);
  assert.equal(auto.sources[0].adapter, "css");
  assert.equal(auto.sources[0].name, undefined);
  assert.equal(find(doc, "spacing.auto.12px").usage.count, 2);
  assert.equal(doc.scan.classes, 1);
  assert.equal(find(doc, "color.auto.000000-0"), undefined, "invisible colors are not tokens");
});

test("roles: from names, shades give way to plain names, and from usage when names say nothing", () => {
  const named = build(res("a.css", "css-vars", 20, {
    tokens: [tok("--brand-600", "#2f5bd8"), tok("--brand-400", "#6b8cff"), tok("--primary", "#111111"), tok("--danger", "#dc2626"), tok("--primary-foreground", "#ffffff")],
  }));
  assert.equal(find(named, "color.primary").role, "primary");
  assert.equal(find(named, "color.brand.600").role, null);
  assert.equal(find(named, "color.danger").role, "danger");
  assert.equal(find(named, "color.primary.foreground").role, null);
  const shadesOnly = build(res("a.css", "css-vars", 20, { tokens: [tok("--brand-600", "#2f5bd8")] }));
  assert.equal(find(shadesOnly, "color.brand.600").role, "primary");

  const plain = build(res("a.css", "css", 10, {
    usages: [
      use("color", "#1f2937", { selector: "body" }),
      use("color", "#6b7280"), use("color", "#6b7280"), use("color", "#6b7280"),
      use("background-color", "#fafaf9", { selector: "html, body" }),
      use("background", "#0e7490", { selector: ".actions > button" }),
      use("border-color", "#e5e7eb"), use("border", "1px solid #e5e7eb"),
    ],
  }));
  assert.equal(find(plain, "color.auto.1f2937").role, "text", "the root's text color wins over a more frequent one");
  assert.equal(find(plain, "color.auto.fafaf9").role, "background");
  assert.equal(find(plain, "color.auto.0e7490").role, "primary");
  assert.equal(find(plain, "color.auto.e5e7eb").role, "border");
});

test("scales: named spacing, Tailwind's spacing unit, font sizes and radii", () => {
  const doc = build(
    res("a.css", "tailwind-v4", 20, {
      tokens: [
        tok("--spacing", "0.25rem", { type: "dimension", group: "spacing", path: ["default"] }),
        tok("--text-sm", "0.875rem", { type: "fontSize", path: ["sm"] }),
        tok("--radius-pill", "9999px", { type: "radius", path: ["pill"] }),
        tok("--radius-md", "6px", { type: "radius", path: ["md"] }),
      ],
    }),
    res("b.css", "css", 10, { usages: [use("padding", "18px"), use("padding", "18px"), use("margin", "7px"), use("font-size", "30px")] }),
  );
  assert.deepEqual(doc.scales.spacing, [4, 8, 12, 16, 18, 20, 24, 32, 40, 48, 64, 80, 96]);
  assert.deepEqual(doc.scales.fontSize, [14, 30]);
  assert.deepEqual(doc.scales.radius, [6], "pill radii are left out");
  const many = computeScales(Array.from({ length: 40 }, (_, i) => ({
    id: `spacing.s${i}`, type: "dimension", value: { value: i + 1, unit: "px", px: i + 1 }, sources: [{ adapter: "css-vars", name: `--s${i}` }], usage: { count: i, seenLive: false },
  })));
  assert.equal(many.spacing.length, 24);
  assert.equal(many.spacing[0], 17, "the most used are kept");
});

test("breakpoints from theme variables and media queries", () => {
  const doc = build(
    res("a.css", "tailwind-v4", 20, { tokens: [tok("--breakpoint-tablet", "48rem", { type: "breakpoint", path: ["tablet"] })] }),
    res("b.css", "css", 10, {
      usages: [
        use("media-min", "768px"), use("media-min", "640px"), use("media-max", "1023.98px"), use("media-max", "1279px"),
        use("media-min", "100px"), use("media-min", "50%"), use("media-min", "90em"),
      ],
    }),
  );
  assert.deepEqual(doc.breakpoints, [
    { name: "sm", min: 640, count: 1 },
    { name: "tablet", min: 768, count: 1 },
    { name: "lg", min: 1024, count: 1 },
    { name: "xl", min: 1280, count: 1 },
    { name: "bp-1440", min: 1440, count: 1 },
  ]);
});

test("components are kept once per file, in order", () => {
  const doc = build(
    res("src/components/ui/card.jsx", "components", 10, { components: [{ kind: "card", export: "Card" }, { kind: "card", export: "Card" }] }),
    res("src/components/ui/button.jsx", "components", 10, { components: [{ kind: "button", export: "Button" }] }),
  );
  assert.deepEqual(doc.components, [
    { kind: "button", file: "src/components/ui/button.jsx", export: "Button" },
    { kind: "card", file: "src/components/ui/card.jsx", export: "Card" },
  ]);
});

test("adapter output is checked: junk dropped, fields cleaned, sizes capped", () => {
  assert.equal(checkOutput(null), null);
  assert.equal(checkOutput("x"), null);
  assert.equal(checkOutput(Promise.resolve({})), null);
  const out = checkOutput({
    tokens: [
      { name: "--ok", raw: "#fff", line: 2, type: "color", mode: "dark", aliasRef: "--x", path: ["a"], group: "spacing", extra: 1 },
      { name: "", raw: "#fff" },
      { name: "--a", raw: "" },
      { name: "--b\u0000‮", raw: "1px", type: "bogus", mode: "Dark!", line: -3 },
      { name: "x".repeat(300), raw: "1px" },
      null,
    ],
    usages: [{ prop: "color", raw: "red", selector: "a" }, { prop: "bad prop", raw: "x" }, { prop: "color" }],
    components: [{ kind: "button", export: "Button" }, { kind: "rocket", export: "R" }, { kind: "card", export: "not pascal" }],
    diagnostics: [{ code: "made-up" }, { code: "binary", line: 4 }],
  });
  assert.deepEqual(out.tokens.map((t) => t.name), ["--ok", "--b"]);
  assert.equal(out.tokens[0].extra, undefined);
  assert.equal(out.tokens[1].type, undefined);
  assert.equal(out.tokens[1].mode, undefined);
  assert.equal(out.tokens[1].line, 1);
  assert.deepEqual(out.usages.map((u) => u.prop), ["color"]);
  assert.deepEqual(out.components.map((c) => c.kind), ["button"]);
  assert.deepEqual(out.diagnostics, [{ code: "parse-skip" }, { code: "binary", line: 4 }]);
  const big = checkOutput({ tokens: Array.from({ length: BUILD_LIMITS.tokensPerFile + 10 }, (_, i) => ({ name: `--t${i}`, raw: "1px" })) });
  assert.equal(big.tokens.length, BUILD_LIMITS.tokensPerFile);
  assert.equal(big.capped, true);
});

test("ids: collisions get a suffix; unnamed slugs are readable", () => {
  const used = new Set(["color.a"]);
  assert.equal(uniqueId("color.a", used), "color.a-2");
  assert.equal(uniqueId("color.a", used), "color.a-3");
  assert.equal(slugFor("color", { hex: "#2f5bd8", alpha: 0.5 }), "2f5bd8-50");
  assert.equal(slugFor("dimension", { value: -1.5, unit: "rem" }), "m1_5rem");
  assert.equal(slugFor("lineHeight", { value: 1.5, unit: "" }), "1_5x");
  assert.match(slugFor("shadow", [{ x: 1 }]), /^[0-9a-f]{8}$/);
  const doc = build(
    res("a.css", "css-vars", 20, { tokens: [tok("--x", "#111111")] }),
    res("b.json", "tokens-json", 30, { tokens: [tok("color.x", "#222222", { type: "color" })] }),
  );
  assert.deepEqual(doc.tokens.map((t) => t.id).sort(), ["color.x", "color.x-2"]);
  assert.equal(find(doc, "color.x").value.hex, "#222222");
});

test("the number of tokens is capped, named ones first", () => {
  const usages = Array.from({ length: 2000 }, (_, i) => use("color", `#${i.toString(16).padStart(6, "0")}`));
  const doc = build(res("a.css", "css", 10, { usages }), res("b.css", "css-vars", 20, { tokens: [tok("--keep", "#abcdef")] }));
  assert.equal(doc.tokens.filter((t) => t.type === "color").length, BUILD_LIMITS.unnamedPerType + 1);
  assert.ok(find(doc, "color.keep"));
  assert.ok(TOKEN_LIMITS.tokens >= BUILD_LIMITS.unnamedPerType * 16);
});

test("live samples: seen values are marked, frequent new ones added, roles filled, samples kept", () => {
  const base = build(res("a.css", "css-vars", 20, { tokens: [tok("--brand", "#2f5bd8"), tok("--pad", "16px")] }));
  const sample = {
    page: "home", device: "desktop", theme: "light", elements: 40, sampled_at: "2026-01-02T03:04:05Z",
    values: [
      { prop: "background-color", value: "rgb(47, 91, 216)", count: 5 },
      { prop: "color", value: "rgb(17, 24, 39)", count: 30 },
      { prop: "background-color", value: "rgb(255, 255, 255)", count: 12 },
      { prop: "color", value: "rgb(1, 2, 3)", count: LIVE_MIN - 1 },
      { prop: "padding", value: "16px 8px", count: 4 },
      { prop: "font-size", value: "14px", count: 9 },
      { prop: "background-color", value: "rgba(0, 0, 0, 0)", count: 90 },
    ],
  };
  const doc = applyLive(base, [sample]);
  assert.ok(validateTokensDoc(doc).ok);
  const brand = find(doc, "color.brand");
  assert.equal(brand.usage.seenLive, true);
  assert.equal(brand.usage.live, 5);
  assert.deepEqual(brand.sources.at(-1), { adapter: "live", page: "home", device: "desktop" });
  assert.equal(find(doc, "color.auto.111827").role, "text");
  assert.equal(find(doc, "color.auto.ffffff").role, "background");
  assert.equal(find(doc, "color.auto.010203"), undefined, "too rare");
  assert.equal(find(doc, "color.auto.000000-0"), undefined, "invisible");
  assert.equal(find(doc, "size.pad").usage.live, 4);
  assert.ok(find(doc, "spacing.auto.8px"));
  assert.deepEqual(doc.scales.fontSize, [14]);
  assert.deepEqual(doc.live, [sample]);
  assert.equal(find(base, "color.brand").usage.seenLive, false, "the scanned document is not changed");

  let list = mergeSamples([], { ...sample, sampled_at: undefined }, "2026-01-01T00:00:00Z");
  list = mergeSamples(list, { ...sample, values: [] }, "2026-01-01T00:00:01Z");
  assert.equal(list.length, 1, "one sample per page, device and theme");
  assert.deepEqual(list[0].values, []);
  for (let i = 0; i < 20; i++) list = mergeSamples(list, { ...sample, page: `p${i}` }, `2026-01-01T00:01:${String(i).padStart(2, "0")}Z`);
  assert.equal(list.length, TOKEN_LIMITS.liveSamples);
  assert.equal(list.at(-1).page, "p19");
});
