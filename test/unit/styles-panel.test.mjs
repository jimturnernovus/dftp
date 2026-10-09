// The Styles tab's pure parts: grouping and ordering tokens, the text shown
// for values and sources, and the way live samples are sent to the server
// (one at a time, newest only, no repeats unless asked).

import test from "node:test";
import assert from "node:assert/strict";
import {
  styleGroups, valueText, sourceText, sourcesTitle, summaryText, createSampleForwarder, MAX_ROWS,
} from "../../client/core/styles-panel.js";
import { validateTokensDoc, pxOf } from "../../client/core/tokens.js";

const src = (file, line, name) => ({ adapter: "css-vars", file, line, ...(name ? { name } : {}) });
const tok = (id, type, value, over = {}) => ({
  id, type, value, raw: "", modes: {}, aliasOf: null, role: null,
  sources: [src("src/styles/tokens.css", 1)], usage: { count: 0, seenLive: false }, confidence: 0.9, ...over,
});
const px = (n, unit = "px", p) => ({ value: n, unit, ...(p === undefined ? {} : { px: p }) });

function docOf(tokens, over = {}) {
  const r = validateTokensDoc({
    format: "dftp.tokens", version: 1, generated_at: "2026-01-02T03:04:05.000Z", root: ".",
    tokens, scales: { spacing: [4, 8, 16], fontSize: [14, 28], radius: [8] },
    breakpoints: [{ name: "lg", min: 1024 }, { name: "md", min: 768 }],
    components: [{ kind: "button", file: "src/components/ui/button.jsx", export: "Button" }],
    diagnostics: [], ...over,
  });
  assert.ok(r.ok, r.error);
  return r.value;
}

const sample = docOf([
  tok("color.brand.600", "color", { hex: "#2f5bd8", alpha: 1 }, { usage: { count: 5, seenLive: true, live: 9 } }),
  tok("color.primary", "color", { hex: "#2f5bd8", alpha: 1 }, { role: "primary", aliasOf: "color.brand.600" }),
  tok("color.text", "color", { hex: "#0f1729", alpha: 1 }, { role: "text", modes: { dark: { hex: "#e6e9f2", alpha: 1 } } }),
  tok("color.surface", "color", { hex: "#ffffff", alpha: 1 }, { role: "surface" }),
  tok("color.overlay", "color", { hex: "#000000", alpha: 0.5 }),
  tok("color.unknown", "color", null),
  tok("font.sans", "fontFamily", { families: ["Inter", "sans-serif"] }),
  tok("font-size.sm", "fontSize", px(0.875, "rem", 14)),
  tok("font-size.xl", "fontSize", px(28)),
  tok("font-size.fluid", "fontSize", px(5, "vw")),
  tok("font-weight.bold", "fontWeight", { value: 700 }),
  tok("font-weight.normal", "fontWeight", { value: 400 }),
  tok("spacing.4", "dimension", px(16)),
  tok("spacing.1", "dimension", px(4)),
  tok("size.card", "dimension", px(320)),
  tok("radius.lg", "radius", px(12)),
  tok("radius.sm", "radius", px(0.25, "rem", 4)),
  tok("shadow.sm", "shadow", [{ x: px(0), y: px(1), blur: px(2), spread: px(0), color: { hex: "#000000", alpha: 0.08 }, inset: false }]),
  tok("color.auto.654321", "color", { hex: "#654321", alpha: 1 }, {
    sources: [{ adapter: "live", page: "home", device: "desktop" }], usage: { count: 0, seenLive: true, live: 4 }, confidence: 0.45,
  }),
]);

test("tokens are grouped by what the tab shows, in a reading order", () => {
  const g = styleGroups(sample);
  // Colors with a role first, in the role order; then by use.
  assert.deepEqual(g.colors.map((t) => t.id), ["color.primary", "color.surface", "color.text", "color.brand.600", "color.auto.654321", "color.overlay"]);
  assert.ok(!g.colors.some((t) => t.id === "color.unknown"), "no value, not shown");
  assert.deepEqual(g.sizes.map((t) => t.id), ["font-size.xl", "font-size.sm", "font-size.fluid"], "largest first, no px last");
  assert.deepEqual(g.weights.map((t) => t.id), ["font-weight.normal", "font-weight.bold"]);
  assert.deepEqual(g.spacing.map((t) => t.id), ["spacing.1", "spacing.4"], "only the spacing family, smallest first");
  assert.deepEqual(g.radii.map((t) => t.id), ["radius.sm", "radius.lg"]);
  assert.deepEqual(g.shadows.map((t) => t.id), ["shadow.sm"]);
  assert.deepEqual(g.families.map((t) => t.id), ["font.sans"]);
  assert.deepEqual(g.scale, [4, 8, 16]);
  assert.deepEqual(g.breakpoints.map((b) => b.name), ["md", "lg"]);
  assert.equal(g.components[0].export, "Button");
  assert.ok(MAX_ROWS >= 20);
});

test("values read as CSS, with px beside other units and alpha as a percentage", () => {
  assert.equal(valueText("color", { hex: "#2f5bd8", alpha: 1 }), "#2f5bd8");
  assert.equal(valueText("color", { hex: "#000000", alpha: 0.5 }), "#000000 · 50%");
  assert.equal(valueText("radius", px(0.5, "rem", 8)), "0.5rem (8px)");
  assert.equal(valueText("dimension", px(16)), "16px");
  assert.equal(valueText("lineHeight", px(1.5, "")), "1.5");
  assert.equal(valueText("fontSize", px(5, "vw")), "5vw");
  assert.equal(valueText("fontFamily", { families: ["Inter", "sans-serif"] }), "\"Inter\", sans-serif");
  assert.equal(valueText("shadow", sample.tokens.find((t) => t.id === "shadow.sm").value), "0px 1px 2px 0px #00000014");
  assert.equal(pxOf(px(0.5, "rem", 8)), 8);
  assert.equal(pxOf(px(12)), 12);
  // A rem or em without a px field counts at 16 px, as the scan counts it.
  assert.equal(pxOf(px(2, "em")), 32);
  assert.equal(pxOf(px(5, "vw")), null);
  assert.equal(pxOf(null), null);
});

test("sources read as file:line, with how many more, or as seen on the page", () => {
  const t = tok("color.x", "color", { hex: "#000000", alpha: 1 }, {
    sources: [src("src/a.css", 3, "--x"), src("src/b.css", 9), { adapter: "live", page: "home", device: "phone" }],
  });
  assert.equal(sourceText(t), "src/a.css:3 (+1 more)");
  assert.equal(sourcesTitle(t), "src/a.css:3 --x (css-vars)\nsrc/b.css:9 (css-vars)\npage home, phone (computed styles)");
  assert.equal(sourceText({ ...t, sources: [{ adapter: "tokens-json", file: "tokens/a.json" }] }), "tokens/a.json");
  assert.equal(sourceText(sample.tokens.find((x) => x.id === "color.auto.654321")), "seen on the page (home, desktop)");
});

test("the summary counts tokens, files read and tokens seen on the page", () => {
  assert.equal(summaryText(sample), `${sample.tokens.length} tokens · 2 seen on the page`);
  const one = docOf([tok("color.a", "color", { hex: "#000000", alpha: 1 })], { scan: { files: 1, skipped: 0, ms: 3, truncated: false, adapters: { css: 1 } } });
  assert.equal(summaryText(one), "1 token · 1 file read");
});

// A forwarder whose server answers when told to, and whose timers run when
// the test says so.
function rig({ status = 200 } = {}) {
  const calls = [];
  const docs = [];
  const timers = [];
  let answer = null;
  const fw = createSampleForwarder({
    post: (body) => new Promise((resolve) => {
      calls.push(body);
      answer = () => resolve({ status, body: status === 200 ? { ok: true, doc: { n: calls.length } } : { error: "x" } });
    }),
    onDoc: (d) => docs.push(d),
    later: (fn, ms) => timers.push({ fn, ms }),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    fw, calls, docs, timers,
    async answer() {
      answer();
      await settle();
    },
    async tick() {
      const t = timers.shift();
      t.fn();
      await settle();
    },
  };
}

const where = { page: "home", device: "desktop", theme: "light" };
const s1 = { elements: 3, values: [{ prop: "color", value: "rgb(0, 0, 0)", count: 3 }] };
const s2 = { elements: 4, values: [{ prop: "color", value: "rgb(0, 0, 0)", count: 4 }] };

test("samples go out one at a time with the window's page, device and theme; the newest waiting one wins", async () => {
  const r = rig();
  assert.equal(r.fw.push(where, s1), true);
  assert.deepEqual(r.calls, [{ ...where, ...s1 }]);
  // Two more arrive while the first is on its way: only the newest is kept.
  r.fw.push(where, s2);
  r.fw.push({ ...where, device: "phone" }, s1);
  assert.equal(r.calls.length, 1);
  await r.answer();
  assert.deepEqual(r.docs, [{ n: 1 }]);
  assert.equal(r.timers.length, 1);
  assert.ok(r.timers[0].ms >= 500, "a gap between requests");
  await r.tick();
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1], { ...where, device: "phone", ...s1 });
});

test("a sample equal to the last one sent for the same page, device and theme is not sent again unless forced", async () => {
  const r = rig();
  r.fw.push(where, s1);
  await r.answer();
  await r.tick();
  assert.equal(r.fw.push(where, { elements: 3, values: [{ prop: "color", value: "rgb(0, 0, 0)", count: 3 }] }), false);
  assert.equal(r.calls.length, 1);
  // Another theme is another sample.
  assert.equal(r.fw.push({ ...where, theme: "dark" }, s1), true);
  await r.answer();
  await r.tick();
  r.fw.force();
  assert.equal(r.fw.push(where, s1), true);
  assert.equal(r.calls.length, 3);
  await r.answer();
  await r.tick();
  // force() covers one sample only.
  assert.equal(r.fw.push(where, s1), false);
});

test("a refused sample is not remembered, so the same one is sent again later", async () => {
  const r = rig({ status: 400 });
  r.fw.push(where, s1);
  await r.answer();
  assert.deepEqual(r.docs, []);
  await r.tick();
  assert.equal(r.fw.push(where, s1), true);
  assert.equal(r.calls.length, 2);
});
