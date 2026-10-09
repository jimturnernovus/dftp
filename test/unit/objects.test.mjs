// Object styles: what the files say (selectors, variables named for an
// object, shared components), what the page sample says (bundles per kind
// and variant with counts), how values are named by tokens, and the
// document's rules for them.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TOOL_DIR } from "../helpers.mjs";
import { scanProject, summaryLines } from "../../server/scan/scanner.mjs";
import { applyLive } from "../../server/scan/live.mjs";
import { buildDoc, checkOutput } from "../../server/scan/build.mjs";
import { helpers } from "../../server/scan/helpers.mjs";
import css from "../../server/scan/adapters/css.mjs";
import cssVars from "../../server/scan/adapters/css-vars.mjs";
import {
  classifySelector, tokenObjectHint, liveObjects, staticObjects, tokenMatcher, OBJECT_LIMITS,
} from "../../server/scan/objects.mjs";
import {
  validateTokensDoc, validateSample, TOKEN_LIMITS, OBJECT_KIND_PROPS, LIVE_VARIANTS, checkObjectValue,
} from "../../client/core/tokens.js";
import { OBJECT_KINDS } from "../../client/core/schema.js";
import { pickLook } from "../../client/core/blank.js";
import { tokenStylesheet } from "../../server/blank.mjs";

const FIXTURE = path.join(TOOL_DIR, "test", "fixtures", "projects", "objects");
const AT = "2026-01-01T00:00:00Z";

let scanned = null;
async function fixtureDoc() {
  if (!scanned) scanned = await scanProject({ root: FIXTURE });
  return structuredClone(scanned);
}

const find = (doc, source, kind, variant) => doc.objects.find((o) => o.source === source && o.kind === kind && o.variant === variant) || null;
// A bundle's size in px, a token id read through the token.
const valuePx = (doc, v) => (typeof v === "string" ? doc.tokens.find((t) => t.id === v).value.px : v.px);

// The page sample of the fixture's home page as the layer sends it.
function homeSample(over = {}) {
  return {
    page: "home", device: "desktop", theme: "light", elements: 40, values: [], sampled_at: AT,
    objects: [
      {
        kind: "button", variant: "primary", count: 3,
        style: {
          background: "rgb(37, 99, 235)", color: "rgb(255, 255, 255)", "border-width": "1px", "border-style": "solid",
          "border-color": "rgba(0, 0, 0, 0)", "border-radius": "8px", "box-shadow": "none", "padding-block": "10px",
          "padding-inline": "18px", height: "42px", "font-family": "Inter, system-ui, sans-serif", "font-size": "14px",
          "font-weight": "600", "line-height": "20px",
        },
      },
      {
        kind: "button", variant: "secondary", count: 2,
        style: { background: "rgb(255, 255, 255)", color: "rgb(17, 24, 39)", "border-color": "rgb(209, 213, 219)", "border-width": "1px", "border-style": "solid" },
      },
      {
        kind: "card", variant: "default", count: 2,
        style: {
          background: "rgb(255, 255, 255)", "border-color": "rgb(209, 213, 219)", "border-width": "1px", "border-style": "solid",
          "border-radius": "12px", "box-shadow": "rgba(0, 0, 0, 0.12) 0px 1px 3px 0px", "padding-block": "20px", "padding-inline": "24px",
        },
      },
      { kind: "badge", variant: "pill", count: 4, style: { background: "rgb(220, 252, 231)", color: "rgb(22, 101, 52)", "border-radius": "9999px", height: "20px" } },
      { kind: "avatar", variant: "initials", count: 3, style: { background: "rgb(224, 231, 255)", "border-radius": "50%", height: "40px" } },
      { kind: "text", variant: "body", count: 2, style: { "font-size": "16px", "line-height": "24px", color: "rgb(17, 24, 39)" } },
    ],
    ...over,
  };
}

test("selectors that name one thing in its resting state, and nothing else", () => {
  const cases = {
    ".btn": { kind: "button", variant: null },
    ".btn-primary": { kind: "button", variant: "primary" },
    ".btn.btn-primary": { kind: "button", variant: "primary" },
    "button.primary": { kind: "button", variant: "primary" },
    ".button--secondary": { kind: "button", variant: "secondary" },
    ".btn-outline-primary": { kind: "button", variant: "secondary" },
    ".btn-ghost": { kind: "button", variant: "ghost" },
    "a.btn": { kind: "button", variant: null },
    "input[type=submit]": { kind: "button", variant: null },
    ".card": { kind: "card", variant: "default" },
    input: { kind: "input", variant: "text" },
    "input[type=\"email\"]": { kind: "input", variant: "text" },
    ".form-control": { kind: "input", variant: "text" },
    textarea: { kind: "input", variant: "textarea" },
    "select.form-select": { kind: "input", variant: "select" },
    ".badge": { kind: "badge", variant: null },
    ".badge-pill": { kind: "badge", variant: "pill" },
    ".avatar": { kind: "avatar", variant: "default" },
    a: { kind: "link", variant: "default" },
    h1: { kind: "heading", variant: "h1" },
    ".h3": { kind: "heading", variant: "h3" },
    hr: { kind: "divider", variant: "default" },
    p: { kind: "text", variant: "body" },
    body: { kind: "text", variant: "body" },
  };
  for (const [sel, want] of Object.entries(cases)) assert.deepEqual(classifySelector(sel), want, sel);
  for (const sel of [".btn-lg", ".btn:hover", ".btn.active", ".card .title", "main .card", ".card-header", "[style]", "#save", ".card > p",
    "input[type=checkbox]", "button[disabled]", ".btn::before", "div", ".x", "h4", `.${"b".repeat(300)}`, ".card.btn"]) {
    assert.equal(classifySelector(sel), null, sel);
  }
});

test("token names that describe an object: kind, variant and the properties they set", () => {
  assert.deepEqual(tokenObjectHint("--card-radius", "radius"), { kind: "card", variant: null, props: ["border-radius"] });
  assert.deepEqual(tokenObjectHint("--btn-primary-bg", "color"), { kind: "button", variant: "primary", props: ["background"] });
  assert.deepEqual(tokenObjectHint("--card", "color"), { kind: "card", variant: null, props: ["background"] });
  assert.deepEqual(tokenObjectHint("--card-foreground", "color"), { kind: "card", variant: null, props: ["color"] });
  assert.deepEqual(tokenObjectHint("--color-card", "color"), { kind: "card", variant: null, props: ["background"] });
  assert.deepEqual(tokenObjectHint("--input", "color"), { kind: "input", variant: "text", props: ["border-color"] });
  assert.deepEqual(tokenObjectHint("--button-padding-x", "dimension"), { kind: "button", variant: null, props: ["padding-inline"] });
  assert.deepEqual(tokenObjectHint("--avatar-size", "dimension"), { kind: "avatar", variant: null, props: ["height"] });
  assert.deepEqual(tokenObjectHint("component.button.secondary.background", "color"), { kind: "button", variant: "secondary", props: ["background"] });
  for (const [name, type] of [["--font-body", "fontFamily"], ["--color-primary", "color"], ["--card-z", "zIndex"], ["--link-weight", "dimension"]]) {
    assert.equal(tokenObjectHint(name, type), null, name);
  }
});

test("static objects of the fixture: rules, variables named for objects and components, named by tokens, with sources", async () => {
  const doc = await fixtureDoc();
  assert.ok(validateTokensDoc(doc).ok, validateTokensDoc(doc).error);
  assert.deepEqual(doc.objects.map((o) => `${o.kind}.${o.variant}`), [
    "button.primary", "button.secondary", "card.default", "input.text", "badge.default", "avatar.default", "link.default",
    "heading.h1", "heading.h2", "text.body", "divider.default",
  ]);
  assert.ok(doc.objects.every((o) => o.source === "static"));
  const primary = find(doc, "static", "button", "primary");
  // The shared .btn rule under the .btn-primary one; a variable the rule
  // refers to wins over another token with the same value.
  assert.equal(primary.style.background, "color.primary");
  assert.equal(primary.style.color, "color.primary.foreground");
  assert.equal(primary.style["border-radius"], "radius.md");
  assert.deepEqual(primary.style["border-color"], { hex: "#000000", alpha: 0 });
  assert.deepEqual(primary.style["border-style"], { style: "solid" });
  assert.deepEqual(primary.sources, [
    { adapter: "css", file: "src/styles/app.css", line: 62, name: ".btn-primary" },
    { adapter: "css", file: "src/styles/app.css", line: 52, name: ".btn" },
    { adapter: "components", file: "src/components/ui/button.jsx", line: 1, name: "Button" },
  ]);
  assert.equal(primary.count, 3);
  const secondary = find(doc, "static", "button", "secondary");
  assert.equal(secondary.style.background, "color.surface");
  assert.equal(secondary.style["border-color"], "color.border");
  // --card-radius names the card's radius; the rule refers to it.
  const card = find(doc, "static", "card", "default");
  assert.equal(card.style["border-radius"], "radius.card.radius");
  assert.equal(card.style["box-shadow"], "shadow.card");
  assert.ok(card.sources.some((s) => s.name === "--card-radius"));
  // A font size is named by a font-size token, never by a spacing token of the same size.
  assert.equal(find(doc, "static", "text", "body").style["font-size"], "font-size.auto.16px");
  assert.equal(find(doc, "static", "heading", "h2").style["font-size"], "font-size.auto.24px");
  const divider = find(doc, "static", "divider", "default").style;
  assert.deepEqual([divider["border-color"], divider["border-style"], divider["border-width"].px], ["color.border", { style: "solid" }, 1]);
  assert.ok(summaryLines(doc).some((l) => l.startsWith("Object styles: button primary, secondary; card default")));
});

test("static objects leave out media-query rules, states and descendants, and a component with no rule still gives a source", () => {
  const text = [
    ".btn { padding: 8px 16px; background: #123456; }",
    ".btn:hover { background: #000000; }",
    "@media (min-width: 900px) { .btn { padding: 20px 40px; } }",
    ".toolbar .btn { padding: 2px; }",
    ".card { border-radius: 10px; }",
  ].join("\n");
  const results = [{ file: "a.css", adapter: { id: "css", rank: 10 }, out: checkOutput(css.extract({ path: "a.css", text, helpers })) },
    { file: "src/components/ui/avatar.jsx", adapter: { id: "components", rank: 10 }, out: checkOutput({ components: [{ kind: "avatar", export: "Avatar", line: 2 }] }) }];
  const doc = buildDoc({ results });
  const button = find(doc, "static", "button", "default");
  assert.equal(button.count, 1);
  const px = (id) => doc.tokens.find((t) => t.id === id).value.px;
  assert.deepEqual([px(button.style["padding-block"]), px(button.style["padding-inline"])], [8, 16]);
  assert.equal(doc.tokens.find((t) => t.id === button.style.background).value.hex, "#123456");
  assert.deepEqual(find(doc, "static", "avatar", "default"), {
    kind: "avatar", variant: "default", source: "static", count: 1, style: {},
    sources: [{ adapter: "components", file: "src/components/ui/avatar.jsx", line: 2, name: "Avatar" }],
  });
  assert.ok(validateTokensDoc(doc).ok);
});

test("live objects: one bundle per variant, counted once over screen sizes, named by tokens, dark samples left out", async () => {
  const doc = await fixtureDoc();
  const phone = homeSample({ device: "phone", objects: [homeSample().objects[0]] });
  const dark = homeSample({ theme: "dark", objects: [{ kind: "button", variant: "ghost", count: 9, style: { color: "rgb(1, 2, 3)" } }] });
  const out = applyLive(doc, [homeSample(), phone, dark]);
  const v = validateTokensDoc(out);
  assert.ok(v.ok, v.error);
  const primary = find(out, "live", "button", "primary");
  // The same three buttons seen on two screen sizes are three buttons.
  assert.equal(primary.count, 3);
  assert.ok(!("screens" in primary), "the phone shows the same look");
  assert.deepEqual(primary.sources.filter((s) => s.adapter === "live"), [
    { adapter: "live", page: "home", device: "desktop" }, { adapter: "live", page: "home", device: "phone" },
  ]);
  assert.equal(primary.style.background, "color.primary");
  // A white text color is the token named for text on the primary color,
  // not the white surface.
  assert.equal(primary.style.color, "color.primary.foreground");
  assert.equal(primary.style["border-radius"], "radius.md");
  assert.deepEqual(primary.style["box-shadow"], []);
  assert.deepEqual(primary.style["border-color"], { hex: "#000000", alpha: 0 });
  assert.equal(find(out, "live", "button", "ghost"), null, "a dark sample adds no object");
  // It looks like the .btn-primary rule: that rule's sources are added.
  assert.ok(primary.sources.some((s) => s.name === ".btn-primary" && s.file === "src/styles/app.css"));
  const secondary = find(out, "live", "button", "secondary");
  assert.equal(secondary.style.background, "color.surface");
  assert.ok(!secondary.sources.some((s) => s.name === ".btn-primary"));
  const card = find(out, "live", "card", "default");
  assert.equal(card.style["box-shadow"], "shadow.card");
  assert.equal(card.style["border-radius"], "radius.card.radius");
  assert.equal(find(out, "live", "avatar", "initials").style["border-radius"], "radius.auto.50pct", "the 50% the .avatar rule uses");
  // Live objects come first, the static ones stay.
  assert.equal(out.objects[0].source, "live");
  assert.equal(out.objects.filter((o) => o.source === "static").length, doc.objects.length);
});

test("a kind with one variant keeps its three most common looks; others keep the most common look per variant", async () => {
  const doc = await fixtureDoc();
  const card = (n, pad) => ({ kind: "card", variant: "default", count: n, style: { "padding-block": `${pad}px`, background: "rgb(255, 255, 255)" } });
  const btn = (n, bg) => ({ kind: "button", variant: "primary", count: n, style: { background: bg } });
  const s1 = homeSample({ objects: [card(5, 11), card(9, 12), card(2, 13), card(7, 14), btn(2, "rgb(1, 1, 1)"), btn(4, "rgb(2, 2, 2)")] });
  const s2 = homeSample({ device: "tablet", objects: [card(4, 13), btn(3, "rgb(1, 1, 1)")] });
  const out = applyLive(doc, [s1, s2]);
  assert.ok(validateTokensDoc(out).ok);
  // The desktop's looks and counts; the tablet keeps what differs there.
  const cards = out.objects.filter((o) => o.source === "live" && o.kind === "card");
  assert.deepEqual(cards.map((o) => [o.variant, o.count]), [["default", 9], ["default-2", 7], ["default-3", 5]]);
  assert.deepEqual(Object.keys(cards[0].screens), ["tablet"]);
  assert.equal(cards[0].screens.tablet["padding-block"].px, 13);
  const buttons = out.objects.filter((o) => o.source === "live" && o.kind === "button");
  assert.deepEqual(buttons.map((o) => [o.variant, o.count]), [["primary", 4]]);
  assert.deepEqual(buttons[0].style.background, { hex: "#020202", alpha: 1 });
  assert.deepEqual(buttons[0].screens, { tablet: { background: { hex: "#010101", alpha: 1 } } });
});

test("a line height in px is named by a unitless token through the font size; values that cannot be read are left out", () => {
  const vars = ":root { --leading-normal: 1.5; --brand: #2f5bd8; }\n";
  const doc = buildDoc({ results: [{ file: "t.css", adapter: { id: "css-vars", rank: 20 }, out: checkOutput(cssVars.extract({ path: "t.css", text: vars, helpers })) }] });
  const lh = doc.tokens.find((t) => t.type === "lineHeight");
  assert.ok(lh, "a unitless line-height token");
  const out = applyLive(doc, [homeSample({
    objects: [{ kind: "text", variant: "body", count: 3, style: { "font-size": "16px", "line-height": "24px", color: "oklch(0.5 0.1 200)", "letter-spacing": "normal" } }],
  })]);
  const body = find(out, "live", "text", "body");
  assert.equal(body.style["line-height"], lh.id);
  assert.ok(!("letter-spacing" in body.style));
  assert.ok(validateTokensDoc(out).ok);
});

test("token matching: the property's own type and purpose, never a zero or a see-through color", async () => {
  const doc = await fixtureDoc();
  const match = tokenMatcher(doc.tokens);
  assert.equal(match("background", { hex: "#2563eb", alpha: 1 }), "color.primary");
  assert.equal(match("color", { hex: "#ffffff", alpha: 1 }), "color.primary.foreground");
  assert.equal(match("background", { hex: "#ffffff", alpha: 1 }), "color.surface");
  assert.equal(match("font-size", { value: 16, unit: "px", px: 16 }), "font-size.auto.16px");
  assert.equal(match("padding-block", { value: 0.5, unit: "rem", px: 8 }), "spacing.2");
  assert.equal(match("background", { hex: "#000000", alpha: 0 }), null);
  assert.equal(match("padding-block", { value: 0, unit: "px", px: 0 }), null);
  assert.equal(match("border-style", { style: "solid" }), null);
  assert.equal(match("background", { hex: "#abcdef", alpha: 1 }), null);
});

test("tokens.json: objects are validated, token ids must exist, and the list is capped", async () => {
  const doc = applyLive(await fixtureDoc(), [homeSample()]);
  assert.ok(validateTokensDoc(doc).ok);
  const bad = (mutate, re) => {
    const d = structuredClone(doc);
    mutate(d);
    const r = validateTokensDoc(d);
    assert.equal(r.ok, false, String(re));
    assert.match(r.error, re);
  };
  bad((d) => { d.objects[0].style.background = "color.missing"; }, /unknown token/);
  bad((d) => { d.objects[0].style.background = "url(x)"; }, /invalid/);
  bad((d) => { d.objects[0].style.background = { value: 3 }; }, /invalid/);
  bad((d) => { d.objects[0].style["z-index"] = { value: 3 }; }, /not allowed/);
  bad((d) => { d.objects.find((o) => o.kind === "link").style.background = { hex: "#ffffff", alpha: 1 }; }, /not allowed/);
  bad((d) => { d.objects[0].style["border-style"] = { style: "solid;x" }; }, /invalid/);
  bad((d) => { d.objects[0].kind = "carousel"; }, /kind/);
  bad((d) => { d.objects[0].variant = "Primary"; }, /variant/);
  bad((d) => { d.objects[0].source = "guess"; }, /source/);
  bad((d) => { d.objects[0].count = -1; }, /count/);
  bad((d) => { d.objects[1] = { ...d.objects[0] }; }, /duplicate/);
  bad((d) => { d.objects[0].sources = Array.from({ length: TOKEN_LIMITS.objectSources + 1 }, () => ({ adapter: "live", page: "home", device: "desktop" })); }, /sources/);
  bad((d) => { d.objects[0].sources = [{ adapter: "css", file: "../x.css" }]; }, /sources/);
  bad((d) => {
    d.objects = Array.from({ length: TOKEN_LIMITS.objects + 1 }, (_, i) => ({ kind: "card", variant: `v${i}`, source: "live", count: 1, style: {}, sources: [] }));
  }, /objects/);
  // Fields beyond the known ones are not kept.
  const extra = structuredClone(doc);
  extra.objects[0].text = "Buy now";
  extra.objects[0].sources[0].text = "Buy now";
  const r = validateTokensDoc(extra);
  assert.ok(r.ok);
  assert.ok(!JSON.stringify(r.value).includes("Buy now"));
  // A shadow may be none; a value of each declared type passes.
  assert.deepEqual(checkObjectValue("box-shadow", []), []);
  assert.deepEqual(checkObjectValue("background", { kind: "linear", repeating: false, stops: [{ color: { hex: "#000000", alpha: 1 }, at: null }, { color: { hex: "#ffffff", alpha: 1 }, at: null }] }).kind, "linear");
  assert.equal(checkObjectValue("height", { hex: "#ffffff", alpha: 1 }), null);
  assert.equal(checkObjectValue("unknown", "color.x"), null);
  // Every kind and its variants are known.
  for (const k of OBJECT_KINDS) assert.ok(OBJECT_KIND_PROPS[k].length && LIVE_VARIANTS[k].length, k);
});

test("a sample's objects: only known kinds, variants and properties, printable values, at most 60; nothing else is kept", () => {
  const base = { page: "home", device: "desktop", elements: 10, values: [] };
  const ok = validateSample({ ...base, objects: [{ kind: "badge", variant: "pill", count: 2, style: { background: "rgb(1, 2, 3)" }, text: "Paid", attrs: { id: "x" } }] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.objects, [{ kind: "badge", variant: "pill", count: 2, style: { background: "rgb(1, 2, 3)" } }]);
  assert.ok(!("objects" in validateSample({ ...base, objects: [] }).value), "an empty list is left out");
  const refused = [
    [{ kind: "button", variant: "h1", count: 1, style: { color: "red" } }],
    [{ kind: "dialog", variant: "default", count: 1, style: { color: "red" } }],
    [{ kind: "button", variant: "primary", count: 0, style: { color: "red" } }],
    [{ kind: "button", variant: "primary", count: 1, style: {} }],
    [{ kind: "button", variant: "primary", count: 1, style: { "z-index": "3" } }],
    [{ kind: "link", variant: "default", count: 1, style: { background: "red" } }],
    [{ kind: "button", variant: "primary", count: 1, style: { color: "red;}body{x:y" } }],
    [{ kind: "button", variant: "primary", count: 1, style: { color: "<b>" } }],
    [{ kind: "button", variant: "primary", count: 1, style: { color: "x".repeat(TOKEN_LIMITS.sampleValue + 1) } }],
    [{ kind: "button", variant: "primary", count: 1, style: { color: 5 } }],
    Array.from({ length: TOKEN_LIMITS.sampleObjects + 1 }, () => ({ kind: "card", variant: "default", count: 1, style: { color: "red" } })),
    "nope",
  ];
  for (const objects of refused) assert.equal(validateSample({ ...base, objects }).ok, false, JSON.stringify(objects).slice(0, 80));
});

test("caps: a flood of different bundles keeps at most three per variant and the document stays within its limits", async () => {
  const doc = await fixtureDoc();
  const samples = [];
  for (let s = 0; s < TOKEN_LIMITS.liveSamples; s++) {
    const objects = [];
    for (const kind of OBJECT_KINDS) {
      for (const variant of LIVE_VARIANTS[kind]) {
        for (let i = 0; i < 3 && objects.length < TOKEN_LIMITS.sampleObjects; i++) {
          const style = { [OBJECT_KIND_PROPS[kind].includes("color") ? "color" : "background"]: `rgb(${s}, ${i}, ${OBJECT_KINDS.indexOf(kind)})` };
          if (OBJECT_KIND_PROPS[kind].includes("height")) style.height = `${10 + i}px`;
          objects.push({ kind, variant, count: 1 + i, style });
        }
      }
    }
    const r = validateSample({ page: "home", device: `d${s}`, elements: 10, values: [], objects });
    assert.ok(r.ok, r.error);
    samples.push({ ...r.value, sampled_at: AT });
  }
  const out = applyLive(doc, samples);
  const v = validateTokensDoc(out);
  assert.ok(v.ok, v.error);
  assert.ok(out.objects.length <= TOKEN_LIMITS.objects);
  for (const kind of OBJECT_KINDS) assert.ok(out.objects.filter((o) => o.source === "live" && o.kind === kind).length <= OBJECT_LIMITS.perClass, kind);
  assert.ok(out.objects.every((o) => o.sources.length <= TOKEN_LIMITS.objectSources));
  // liveObjects alone, with no tokens at all, keeps raw values.
  const raw = liveObjects([homeSample()], []);
  assert.deepEqual(raw.find((o) => o.kind === "button" && o.variant === "primary").style.background, { hex: "#2563eb", alpha: 1 });
  assert.deepEqual(staticObjects(), []);
});

// A document made from one CSS file, read by the custom-property and the
// plain CSS adapters.
function cssDoc(text) {
  const res = (a) => ({ file: "t.css", adapter: { id: a.id, rank: a.id === "css-vars" ? 20 : 10 }, out: checkOutput(a.extract({ path: "t.css", text, helpers })) });
  return buildDoc({ results: [res(cssVars), res(css)] });
}

const KIT_CSS = [
  ":root { --background: #ffffff; --card: #ffffff; --border: #e5e5e5; --input: #e5e5e5; --foreground: #0a0a0a; --control-height: 40px; }",
  ".dark { --background: #0a0a0a; --card: #171717; --input: #262626; --border: #262626; --foreground: #fafafa; }",
  ".nav { --nav-link-padding-y: 8px; }",
  ".badge { --badge-font-weight: 700; }",
  ".navbar { --navbar-brand-font-size: 20px; }",
  ".rule { border-width: 1px; height: 20px; padding: 20px; }",
  "",
].join("\n");

test("a value is named by a token for the same kind of thing; tokens of another kind or part of a page, and sizes of another use, never name it", () => {
  const doc = cssDoc(KIT_CSS);
  const out = applyLive(doc, [homeSample({
    objects: [
      { kind: "card", variant: "default", count: 2, style: { background: "rgb(255, 255, 255)", "border-color": "rgb(229, 229, 229)", "border-width": "1px", "border-style": "solid" } },
      { kind: "input", variant: "text", count: 2, style: { background: "rgb(255, 255, 255)", "border-color": "rgb(229, 229, 229)", height: "40px" } },
      { kind: "button", variant: "primary", count: 2, style: { background: "rgb(10, 10, 10)", "padding-block": "8px", "font-size": "20px", height: "20px" } },
      { kind: "heading", variant: "h1", count: 1, style: { "font-weight": "700", color: "rgb(10, 10, 10)" } },
      { kind: "divider", variant: "default", count: 1, style: { height: "1px", "border-width": "1px" } },
    ],
  })]);
  const v = validateTokensDoc(out);
  assert.ok(v.ok, v.error);
  // --card and --background are both white in the light theme; the card's
  // fill is the card's token, which has its own dark value.
  const card = find(out, "live", "card", "default");
  assert.equal(card.style.background, "color.card");
  assert.equal(card.style["border-color"], "color.border", "a text box's --input never names a card's border");
  const dark = (id) => out.tokens.find((t) => t.id === id).modes.dark.hex;
  assert.notEqual(dark("color.card"), dark("color.background"));
  assert.equal(pickLook(v.value, "card").styles.background, "color.card");
  const input = find(out, "live", "input", "text");
  assert.deepEqual([input.style.background, input.style["border-color"], input.style.height], ["color.background", "color.input", "size.control.height"]);
  // A navigation link's padding, a brand name's font size and a badge's
  // weight are no button's or heading's; a spacing size is no height and
  // no font size; a border width is no divider's height.
  const button = find(out, "live", "button", "primary");
  assert.deepEqual([button.style["padding-block"].px, button.style["font-size"].px, button.style.height.px], [8, 20, 20]);
  assert.deepEqual(find(out, "live", "heading", "h1").style["font-weight"], { value: 700 });
  assert.deepEqual(find(out, "live", "divider", "default").style.height, { value: 1, unit: "px", px: 1 });
  assert.equal(find(out, "live", "divider", "default").style["border-width"], "border-width.auto.1px");
  // The matcher itself: a kind given, another kind's token is left out.
  const match = tokenMatcher(doc.tokens);
  assert.equal(match("font-weight", { value: 700 }, null, "badge"), "font-weight.badge.font.weight");
  assert.equal(match("font-weight", { value: 700 }, null, "heading"), null);
  assert.equal(match("background", { hex: "#ffffff", alpha: 1 }, null, "card"), "color.card");
  assert.equal(match("height", { value: 20, unit: "px", px: 20 }, null, "badge"), null);
  // A padding is no border width, a border width no spacing.
  assert.equal(match("padding-block", { value: 1, unit: "px", px: 1 }, null, "button"), null);
  assert.equal(match("border-width", { value: 20, unit: "px", px: 20 }, null, "card"), null);
  assert.equal(match("padding-inline", { value: 20, unit: "px", px: 20 }, null, "card"), "spacing.auto.20px");
});

test("the same elements at several screen sizes: the widest size's look and count, and what narrower sizes show instead", async () => {
  const doc = await fixtureDoc();
  const h1 = (size, lh) => ({ kind: "heading", variant: "h1", count: 1, style: { "font-size": size, "line-height": lh, color: "rgb(17, 24, 39)" } });
  const card = (pad) => ({ kind: "card", variant: "default", count: 2, style: { background: "rgb(255, 255, 255)", "padding-block": pad, "padding-inline": pad, "border-radius": "12px" } });
  const at = (device, objects) => homeSample({ device, objects });
  // Phone first, and each size once: equal counts never go to the smaller
  // size because its values sort first.
  const out = applyLive(doc, [at("phone", [h1("22px", "28px"), card("16px")]), at("desktop", [h1("28px", "34px"), card("24px")]), at("tablet", [h1("22px", "28px"), card("24px")])]);
  const v = validateTokensDoc(out);
  assert.ok(v.ok, v.error);
  const heading = find(out, "live", "heading", "h1");
  assert.equal(heading.count, 1);
  assert.equal(valuePx(out, heading.style["font-size"]), 28);
  assert.deepEqual(Object.keys(heading.screens).sort(), ["phone", "tablet"]);
  assert.equal(valuePx(out, heading.screens.phone["font-size"]), 22);
  assert.ok(!("color" in heading.screens.phone), "only what differs");
  const c = find(out, "live", "card", "default");
  assert.equal(c.count, 2);
  assert.equal(valuePx(out, c.style["padding-block"]), 24);
  assert.deepEqual(Object.keys(c.screens), ["phone"], "the tablet shows the desktop's card");
  assert.equal(valuePx(out, c.screens.phone["padding-inline"]), 16);
  // The blank page: the desktop look in the element's rule, the others in
  // media queries below the middle of two sizes' widths, never set on the
  // element itself.
  const sheet = tokenStylesheet(v.value);
  const block = (sel) => sheet.slice(sheet.indexOf(sel));
  assert.match(sheet, /\[data-dftp-el\]\[data-dftp-obj="live\.heading\.h1"\] \{\n {2}--dftp-s-color: [^\n]+\n {2}--dftp-s-font-size: 28px;/);
  assert.match(block("@media (width < 1130px) {\n  [data-dftp-el][data-dftp-obj=\"live.heading.h1\"]"), /^@media \(width < 1130px\) \{\n {2}\[data-dftp-el\]\[data-dftp-obj="live\.heading\.h1"\] \{\n {4}--dftp-s-font-size: [^;]+;\n {4}--dftp-s-line-height: [^;]+;\n {2}\}\n\}/);
  assert.match(sheet, /@media \(width < 605px\) \{\n {2}\[data-dftp-el\]\[data-dftp-obj="live\.card\.default"\] \{\n {4}--dftp-s-padding-block: [^;]+;\n {4}--dftp-s-padding-inline: [^;]+;\n {2}\}\n\}/);
  assert.ok(sheet.indexOf("@media (width < 1130px) {\n  [data-dftp-el][data-dftp-obj=\"live.heading.h1\"]") < sheet.indexOf("@media (width < 605px) {\n  [data-dftp-el][data-dftp-obj=\"live.heading.h1\"]"), "widest first");
  assert.equal((sheet.match(/\{/g) || []).length, (sheet.match(/\}/g) || []).length, "braces balance");
  const look = pickLook(v.value, "heading");
  assert.equal(look.object.variant, "h1");
  for (const p of ["font-size", "line-height"]) assert.ok(!(p in look.styles), p);
  // Other screen sizes: their own widths.
  const devices = [{ id: "desktop", width: 1280 }, { id: "phone", width: 400 }];
  const custom = applyLive(doc, [at("phone", [h1("22px", "28px")]), at("desktop", [h1("28px", "34px")]), at("tablet", [h1("20px", "24px")])], { devices });
  const ch = find(custom, "live", "heading", "h1");
  assert.deepEqual(Object.keys(ch.screens), ["phone"], "a size with no known width keeps no look of its own");
  assert.match(tokenStylesheet(validateTokensDoc(custom).value, { devices }), /@media \(width < 840px\)/);
  // A screen size's look is checked like any other.
  const bad = structuredClone(out);
  bad.objects.find((o) => o.screens).screens.phone = { "z-index": "3" };
  assert.match(validateTokensDoc(bad).error, /screens/);
  const empty = structuredClone(out);
  empty.objects.find((o) => o.screens).screens.phone = {};
  assert.match(validateTokensDoc(empty).error, /empty/);
  const many = structuredClone(out);
  many.objects.find((o) => o.screens).screens = Object.fromEntries(Array.from({ length: TOKEN_LIMITS.objectScreens + 1 }, (_, i) => [`d${i}`, { color: "color.primary" }]));
  assert.match(validateTokensDoc(many).error, /screens/);
});

test("a fully round corner sent as a huge length is kept as a 9999px pill", async () => {
  const doc = await fixtureDoc();
  const out = applyLive(doc, [homeSample({ objects: [{ kind: "button", variant: "primary", count: 3, style: { "border-radius": "3.35544e+07px", background: "rgb(79, 57, 246)" } }] })]);
  const button = find(out, "live", "button", "primary");
  assert.equal(valuePx(out, button.style["border-radius"]), 9999);
  assert.ok(validateTokensDoc(out).ok);
});
