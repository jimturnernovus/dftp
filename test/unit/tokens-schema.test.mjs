// The tokens document and live-sample validators shared by the designer and
// the server.

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTokensDoc, validateSample, checkValue, isTokenId, cleanName, cleanRaw, TOKENS_FORMAT, TOKEN_LIMITS,
  TOKEN_TYPES, ROLES, SAMPLE_PROPS,
} from "../../client/core/tokens.js";
import { safeParse } from "../../client/core/schema.js";

const color = (hex = "#2f5bd8", alpha = 1) => ({ hex, alpha });

function token(over = {}) {
  return {
    id: "color.brand.600",
    type: "color",
    value: color(),
    raw: "rgb(47 91 216)",
    modes: { dark: color("#6b8cff") },
    aliasOf: null,
    role: "primary",
    sources: [{ adapter: "css-vars", file: "src/index.css", line: 12, name: "--brand-600" }],
    usage: { count: 41, seenLive: true, live: 3 },
    confidence: 0.95,
    ...over,
  };
}

function doc(over = {}) {
  return {
    format: TOKENS_FORMAT,
    version: 1,
    generated_at: "2026-01-02T03:04:05Z",
    root: ".",
    tokens: [token()],
    scales: { spacing: [4, 8, 12], fontSize: [12, 14], radius: [4] },
    breakpoints: [{ name: "md", min: 768, count: 2 }],
    components: [{ kind: "button", file: "src/components/ui/button.jsx", export: "Button" }],
    diagnostics: [{ adapter: "css", file: "x.css", line: 3, code: "parse-skip" }, { adapter: "scan", code: "budget-time" }],
    scan: { files: 3, skipped: 0, adapters: { css: 2 }, truncated: false, ms: 12, classes: 4 },
    live: [{ page: "home", device: "desktop", theme: "light", elements: 10, values: [{ prop: "color", value: "rgb(0, 0, 0)", count: 4 }], sampled_at: "2026-01-02T03:04:05Z" }],
    ...over,
  };
}

const bad = (d, re) => {
  const r = validateTokensDoc(d);
  assert.equal(r.ok, false, "should be refused");
  if (re) assert.match(r.error, re);
};

test("a full document passes, unknown fields are dropped, and the copy is fresh", () => {
  const d = doc({ extra: 1 });
  d.tokens[0].extra = "x";
  d.tokens[0].sources[0].extra = "y";
  const r = validateTokensDoc(d);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.extra, undefined);
  assert.equal(r.value.tokens[0].extra, undefined);
  assert.equal(r.value.tokens[0].sources[0].extra, undefined);
  assert.notEqual(r.value.tokens[0], d.tokens[0]);
  assert.deepEqual(r.value.live[0].values, d.live[0].values);
  assert.equal(validateTokensDoc(safeParse(JSON.stringify(r.value))).ok, true);
});

test("format, version, root and lists are checked", () => {
  bad(doc({ format: "other" }), /format/);
  bad(doc({ version: 2 }), /version/);
  bad(doc({ root: "/home" }), /root/);
  bad(doc({ generated_at: "yesterday" }), /generated_at/);
  bad(doc({ tokens: {} }), /tokens/);
  bad(doc({ scales: { spacing: [4], fontSize: [] } }), /scales/);
  bad(doc({ scales: { spacing: [-1], fontSize: [], radius: [] } }), /scales/);
  bad(doc({ breakpoints: [{ name: "MD!", min: 768 }] }), /breakpoints/);
  bad(doc({ components: [{ kind: "spaceship", file: "a.jsx", export: "A" }] }), /components/);
  bad(doc({ components: [{ kind: "button", file: "../a.jsx", export: "A" }] }), /components/);
  bad(doc({ components: [{ kind: "button", file: "a.jsx", export: "a b" }] }), /components/);
  bad(doc({ diagnostics: [{ adapter: "css", code: "made-up" }] }), /diagnostics/);
  bad(doc({ diagnostics: [{ adapter: "css", code: "parse-skip", file: "/etc/passwd" }] }), /diagnostics/);
  bad(doc({ scan: { files: -1, skipped: 0, adapters: {}, truncated: false, ms: 0 } }), /scan/);
  bad(doc({ tokens: Array.from({ length: TOKEN_LIMITS.tokens + 1 }, (_, i) => token({ id: `color.c${i}` })) }), /tokens/);
});

test("token fields: ids, types, values, modes, aliases, roles, sources, usage", () => {
  const one = (over, re) => bad(doc({ tokens: [token(over)] }), re);
  one({ id: "nodots" }, /id/);
  one({ id: ".color.x" }, /id/);
  one({ id: "color.a b" }, /id/);
  one({ type: "colour" }, /type/);
  one({ value: { hex: "#2F5BD8", alpha: 1 } }, /value/);
  one({ value: { hex: "#2f5bd8", alpha: 2 } }, /value/);
  one({ value: "#2f5bd8" }, /value/);
  one({ raw: "a\u0000b" }, /raw/);
  one({ raw: "x".repeat(301) }, /raw/);
  one({ modes: { Dark: color() } }, /modes/);
  one({ modes: { dark: { hex: "red", alpha: 1 } } }, /modes/);
  one({ role: "hero" }, /role/);
  one({ aliasOf: "color.missing" }, /aliasOf/);
  one({ aliasOf: "color.brand.600" }, /aliasOf/);
  one({ sources: [] }, /sources/);
  one({ sources: [{ adapter: "Bad Id" }] }, /sources/);
  one({ sources: [{ adapter: "css", file: "../x.css" }] }, /sources/);
  one({ sources: [{ adapter: "css", file: "C:x.css" }] }, /sources/);
  one({ sources: [{ adapter: "css", name: "<img>" }] }, /sources/);
  one({ sources: [{ adapter: "live", page: "Bad" }] }, /sources/);
  one({ usage: { count: -1, seenLive: false } }, /usage/);
  one({ usage: { count: 1, seenLive: "yes" } }, /usage/);
  one({ confidence: 1.5 }, /confidence/);
  bad(doc({ tokens: [token(), token()] }), /duplicate/);
  assert.ok(validateTokensDoc(doc({ tokens: [token({ value: null })] })).ok, "a token whose value could not be read keeps value null");
  const alias = validateTokensDoc(doc({ tokens: [token(), token({ id: "color.primary", aliasOf: "color.brand.600" })] }));
  assert.ok(alias.ok, alias.error);
});

test("every type has a value shape", () => {
  const dim = { value: 1, unit: "rem", px: 16 };
  const values = {
    color: color(),
    gradient: { kind: "linear", repeating: false, stops: [{ color: color(), at: 0 }, { color: color("#000000"), at: null }] },
    dimension: dim,
    fontFamily: { families: ["Inter", "sans-serif"] },
    fontSize: dim,
    fontWeight: { value: 700 },
    lineHeight: { value: 1.5, unit: "" },
    letterSpacing: { value: -0.02, unit: "em", px: -0.32 },
    radius: dim,
    shadow: [{ x: { value: 0, unit: "px" }, y: { value: 1, unit: "px" }, blur: { value: 2, unit: "px" }, spread: { value: 0, unit: "px" }, color: null, inset: false }],
    border: { width: { value: 1, unit: "px", px: 1 }, style: "solid", color: color() },
    opacity: { value: 0.5 },
    zIndex: { value: 50 },
    duration: { ms: 120 },
    easing: { bezier: [0.4, 0, 0.2, 1] },
    breakpoint: { value: 48, unit: "rem", px: 768 },
  };
  assert.deepEqual(Object.keys(values).sort(), [...TOKEN_TYPES].sort());
  for (const [type, v] of Object.entries(values)) {
    assert.deepEqual(checkValue(type, v), v, type);
    assert.equal(checkValue(type, "1px"), null, `${type} refuses a string`);
  }
  assert.equal(checkValue("fontFamily", { families: ["x;}body{"] }), null);
  assert.equal(checkValue("dimension", { value: 1, unit: "px;" }), null);
  assert.equal(checkValue("border", { width: null, style: "solid;", color: null }), null);
  assert.equal(checkValue("easing", { bezier: [1, 2, 3] }), null);
  assert.equal(ROLES.length, 11);
});

test("prototype keys never reach the validator", () => {
  assert.throws(() => safeParse("{\"__proto__\": {\"polluted\": 1}}"));
  const r = validateTokensDoc(safeParse(JSON.stringify(doc())));
  assert.ok(r.ok);
  assert.equal({}.polluted, undefined);
});

test("ids, names and raw values are cleaned", () => {
  assert.ok(isTokenId("color.brand.600"));
  assert.ok(isTokenId("font-size.lg"));
  assert.ok(!isTokenId("color"));
  assert.ok(!isTokenId("color..x"));
  assert.ok(!isTokenId(`color.${"x".repeat(200)}`));
  assert.equal(cleanName("--brand‮-600\"<x>"), "--brand-600x");
  assert.equal(cleanName("x".repeat(200)).length, 120);
  assert.equal(cleanRaw("  a\n\tb  "), "a b");
  assert.equal(cleanRaw("x".repeat(400)).length, 300);
});

test("live samples: shape, limits, duplicates and characters", () => {
  const sample = (over = {}) => ({
    page: "home", device: "desktop", theme: "dark", elements: 120,
    values: [
      { prop: "color", value: "rgb(17, 24, 39)", count: 80 },
      { prop: "font-family", value: "\"Inter\", sans-serif", count: 120 },
      { prop: "box-shadow", value: "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px", count: 4 },
    ],
    ...over,
  });
  const ok = validateSample(sample({ extra: 1 }));
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.value.extra, undefined);
  const noTheme = sample();
  delete noTheme.theme;
  assert.equal(validateSample(noTheme).value.theme, "light");
  const no = (over, re) => {
    const r = validateSample(sample(over));
    assert.equal(r.ok, false);
    if (re) assert.match(r.error, re);
  };
  no({ page: "../x" }, /page/);
  no({ device: "A" }, /device/);
  no({ theme: "blue" }, /theme/);
  no({ elements: 1501 }, /elements/);
  no({ elements: -1 }, /elements/);
  no({ values: "x" }, /values/);
  no({ values: Array.from({ length: 401 }, (_, i) => ({ prop: "color", value: `rgb(${i}, 0, 0)`, count: 1 })) }, /values/);
  no({ values: [{ prop: "content", value: "x", count: 1 }] }, /prop/);
  no({ values: [{ prop: "color", value: "", count: 1 }] }, /value/);
  no({ values: [{ prop: "color", value: "x".repeat(201), count: 1 }] }, /value/);
  for (const ch of ["<", ">", "\\", "`", "{", "}", ";", "\u0000", "\n"]) {
    no({ values: [{ prop: "color", value: `red${ch}`, count: 1 }] }, /value/);
  }
  no({ values: [{ prop: "color", value: "red", count: 0 }] }, /count/);
  no({ values: [{ prop: "color", value: "red", count: 1.5 }] }, /count/);
  no({ values: [{ prop: "color", value: "red", count: 1 }, { prop: "color", value: "red", count: 2 }] }, /duplicate/);
  assert.equal(validateSample(null).ok, false);
  assert.equal(validateSample([]).ok, false);
  assert.ok(SAMPLE_PROPS.includes("background-color"));
});
