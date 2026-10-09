// Where the style scan, the live sample and blank pages meet: the message
// that has a blank page load its token style sheet again after a rescan,
// the rules the three share (token ids, component and mode names, sizes in
// px, the style sheet's address), and how samples taken under the dark
// theme and line-height ratios are merged.

import test from "node:test";
import assert from "node:assert/strict";
import { validateShellMsg, envelope, makeNonce, SHELL_TYPES, BEFORE_TYPES } from "../../client/core/protocol.js";
import { isTokenRef, isComponentName } from "../../client/core/schema.js";
import { isTokenId, isModeName, pxOf, validateTokensDoc } from "../../client/core/tokens.js";
import { TOKENS_CSS } from "../../client/core/blank.js";
import { TOKENS_CSS as SERVED_CSS } from "../../server/blank.mjs";
import { buildDoc, checkOutput } from "../../server/scan/build.mjs";
import { applyLive, LIVE_MIN } from "../../server/scan/live.mjs";

const ns = "dftp";
const nonce = makeNonce();
const fromShell = (type, fields) => validateShellMsg(envelope(ns, nonce, type, fields), { ns, nonce });

test("reload-tokens is a shell message with no fields, and it works in Before too", () => {
  assert.ok(SHELL_TYPES.includes("reload-tokens"));
  // It changes no record, and a sheet loaded during Before is what After shows.
  assert.ok(BEFORE_TYPES.includes("reload-tokens"));
  assert.deepEqual(fromShell("reload-tokens", { href: "https://example.invalid/x.css", extra: 1 }), { type: "reload-tokens" });
});

test("one rule each for token ids, component names, mode names, sizes in px and the style sheet's address", () => {
  assert.equal(isTokenId, isTokenRef, "tokens.js and schema.js accept the same token ids");
  assert.ok(isModeName("dark") && isModeName("high-contrast"));
  assert.ok(!isModeName("Dark") && !isModeName("") && !isModeName(`m${"x".repeat(30)}`) && !isModeName(null));
  // The scan keeps a component only under a name schema.js accepts.
  const out = checkOutput({
    tokens: [], usages: [], diagnostics: [],
    components: [{ kind: "button", export: "Button" }, { kind: "card", export: "card" }, { kind: "input", export: "Input<x>" }],
  });
  assert.deepEqual(out.components.map((c) => c.export), ["Button"]);
  assert.ok(out.components.every((c) => isComponentName(c.export)));
  // A theme name the document refuses never reaches it.
  const doc = buildDoc({
    results: [{ file: "a.css", adapter: { id: "css-vars", rank: 20 }, out: checkOutput({ tokens: [{ name: "--x", raw: "#111111", line: 1, mode: "Dark Mode" }, { name: "--x", raw: "#ffffff", line: 2 }] }) }],
  });
  assert.ok(validateTokensDoc(doc).ok);
  assert.deepEqual(doc.tokens.find((t) => t.id === "color.x").modes, {});
  // Sizes in px: the px field, a px value, a rem or em at 16 px, else none.
  assert.equal(pxOf({ value: 0.5, unit: "rem", px: 8 }), 8);
  assert.equal(pxOf({ value: 12, unit: "px" }), 12);
  assert.equal(pxOf({ value: 1.5, unit: "em" }), 24);
  assert.equal(pxOf({ value: 50, unit: "%" }), null);
  assert.equal(pxOf({ value: 1.5, unit: "" }), null);
  assert.equal(pxOf("12px"), null);
  // The page and the server name the same style sheet.
  assert.equal(TOKENS_CSS, SERVED_CSS);
  assert.equal(TOKENS_CSS, "/__dftp/tokens.css");
});

// A scanned document: a brand color with a dark value, text with a dark
// value, and a unitless line height.
function scanned() {
  const t = (name, raw, line, extra = {}) => ({ name, raw, line, ...extra });
  const doc = buildDoc({
    results: [{
      file: "src/tokens.css",
      adapter: { id: "css-vars", rank: 20 },
      out: checkOutput({
        tokens: [
          t("--brand", "#2f5bd8", 1), t("--brand", "#6b8cff", 2, { mode: "dark" }),
          t("--text", "#111827", 3), t("--text", "#e5e7eb", 4, { mode: "dark" }),
          t("--leading-normal", "1.5", 5, { type: "lineHeight" }),
        ],
      }),
    }],
    now: () => new Date("2026-01-02T03:04:05Z"),
  });
  assert.ok(validateTokensDoc(doc).ok);
  return doc;
}
const find = (doc, id) => doc.tokens.find((x) => x.id === id);
const sample = (theme, values) => ({ page: "home", device: "desktop", theme, elements: 40, sampled_at: "2026-01-02T03:04:05Z", values });

test("a sample taken under the dark theme matches the tokens' dark values and adds no tokens", () => {
  const base = scanned();
  const brand = base.tokens.find((x) => x.value && x.value.hex === "#2f5bd8");
  assert.deepEqual(brand.modes.dark, { hex: "#6b8cff", alpha: 1 });
  const doc = applyLive(base, [sample("dark", [
    { prop: "background-color", value: "rgb(107, 140, 255)", count: 6 },
    { prop: "color", value: "rgb(229, 231, 235)", count: 20 },
    // Shown on many elements in the dark theme, named by no file.
    { prop: "background-color", value: "rgb(11, 16, 32)", count: 30 },
  ])]);
  assert.ok(validateTokensDoc(doc).ok);
  assert.equal(find(doc, brand.id).usage.seenLive, true);
  assert.equal(find(doc, brand.id).usage.live, 6);
  const text = doc.tokens.find((x) => x.value && x.value.hex === "#111827");
  assert.equal(text.usage.seenLive, true);
  assert.equal(doc.tokens.filter((x) => x.id.includes(".auto.")).length, 0, "no token from a dark value");
  assert.equal(doc.tokens.length, base.tokens.length);

  // The same values in a light sample: the brand's dark value is not its
  // value, and a frequent unknown color becomes a token.
  const light = applyLive(base, [sample("light", [
    { prop: "background-color", value: "rgb(107, 140, 255)", count: 6 },
    { prop: "background-color", value: "rgb(11, 16, 32)", count: 30 },
  ])]);
  assert.equal(find(light, brand.id).usage.seenLive, false);
  assert.ok(find(light, "color.auto.6b8cff"));
  assert.ok(find(light, "color.auto.0b1020"));
});

test("a line height sent as a ratio marks a unitless token as seen, and never becomes a token", () => {
  const base = scanned();
  const leading = base.tokens.find((x) => x.type === "lineHeight");
  assert.deepEqual([leading.value.value, leading.value.unit], [1.5, ""]);
  const doc = applyLive(base, [sample("light", [
    { prop: "line-height", value: "24px", count: 12 },
    { prop: "line-height", value: "1.5", count: 12 },
    { prop: "line-height", value: "1.333", count: LIVE_MIN + 5 },
  ])]);
  assert.ok(validateTokensDoc(doc).ok);
  assert.equal(find(doc, leading.id).usage.seenLive, true);
  assert.equal(find(doc, leading.id).usage.live, 12);
  const auto = doc.tokens.filter((x) => x.type === "lineHeight" && x.id !== leading.id);
  // The px value is a value of its own; a ratio is not.
  assert.deepEqual(auto.map((x) => [x.value.value, x.value.unit]), [[24, "px"]]);
});
