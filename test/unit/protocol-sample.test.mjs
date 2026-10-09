// The live style sample messages: "style-sample" from the layer (the page's
// computed styles, counted) and "sample-styles" from the designer window
// (count them now).

import test from "node:test";
import assert from "node:assert/strict";
import { envelope, validateFrameMsg, validateShellMsg, makeNonce, FRAME_TYPES, SHELL_TYPES, BEFORE_TYPES } from "../../client/core/protocol.js";
import { TOKEN_LIMITS, SAMPLE_PROPS } from "../../client/core/tokens.js";

const ns = "dftp";
const nonce = makeNonce();
const fromFrame = (fields) => validateFrameMsg(envelope(ns, nonce, "style-sample", fields), { ns, nonce });

const good = {
  elements: 42,
  values: [
    { prop: "color", value: "rgb(15, 23, 42)", count: 30 },
    { prop: "font-family", value: "\"Inter\", system-ui, sans-serif", count: 30 },
    { prop: "box-shadow", value: "rgba(0, 0, 0, 0.08) 0px 1px 2px 0px", count: 2 },
  ],
};

test("both sample messages are listed, and Before ignores a request to sample", () => {
  assert.ok(FRAME_TYPES.includes("style-sample"));
  assert.ok(SHELL_TYPES.includes("sample-styles"));
  assert.ok(!BEFORE_TYPES.includes("sample-styles"));
});

test("a well-formed sample comes back with only its known fields", () => {
  const m = fromFrame({ ...good, page: "other", device: "phone", theme: "dark", extra: "x" });
  assert.deepEqual(m, { type: "style-sample", elements: 42, values: good.values });
  assert.notEqual(m.values, good.values, "a fresh copy");
  assert.deepEqual(fromFrame({ elements: 0, values: [] }), { type: "style-sample", elements: 0, values: [] });
});

test("a sample needs the nonce", () => {
  assert.ok(fromFrame(good));
  assert.equal(validateFrameMsg(envelope(ns, makeNonce(), "style-sample", good), { ns, nonce }), null);
  assert.equal(validateFrameMsg({ dftp: 1, type: "style-sample", ...good }, { ns, nonce }), null);
});

test("malformed samples are dropped whole", () => {
  assert.ok(fromFrame(good));
  const bad = [
    {},
    { elements: 1 },
    { values: [] },
    { elements: -1, values: [] },
    { elements: 1.5, values: [] },
    { elements: TOKEN_LIMITS.sampleElements + 1, values: [] },
    { elements: "3", values: [] },
    { elements: 1, values: {} },
    { elements: 1, values: [null] },
    { elements: 1, values: [{ prop: "content", value: "\"x\"", count: 1 }] },
    { elements: 1, values: [{ prop: "color", value: "", count: 1 }] },
    { elements: 1, values: [{ prop: "color", value: "red", count: 0 }] },
    { elements: 1, values: [{ prop: "color", value: "red", count: TOKEN_LIMITS.sampleCount + 1 }] },
    { elements: 1, values: [{ prop: "color", value: "red", count: 1.5 }] },
    { elements: 1, values: [{ prop: "color", value: "x".repeat(TOKEN_LIMITS.sampleValue + 1), count: 1 }] },
    { elements: 1, values: [{ prop: "color", value: "red", count: 1 }, { prop: "color", value: "red", count: 2 }] },
    { elements: 1, values: Array.from({ length: TOKEN_LIMITS.sampleValues + 1 }, (_, i) => ({ prop: "padding", value: `${i}px`, count: 1 })) },
  ];
  for (const v of bad) assert.equal(fromFrame(v), null, JSON.stringify(v).slice(0, 120));
});

test("values that could carry markup, a rule or control characters are refused", () => {
  assert.ok(fromFrame({ elements: 1, values: [{ prop: "color", value: "color(display-p3 1 0 0 / 0.5)", count: 1 }] }));
  for (const value of ["<img src=x>", "red; color: blue", "red}", "{a}", "a\\62", "`x`", "red\nblue", "red\u0000", "red\u0085"]) {
    assert.equal(fromFrame({ elements: 1, values: [{ prop: "color", value, count: 1 }] }), null, JSON.stringify(value));
  }
});

test("every sampled property is accepted, and only those", () => {
  for (const prop of SAMPLE_PROPS) assert.ok(fromFrame({ elements: 1, values: [{ prop, value: "1px", count: 1 }] }), prop);
  for (const prop of ["background-image", "transform", "COLOR", "--x", "text"]) {
    assert.equal(fromFrame({ elements: 1, values: [{ prop, value: "1px", count: 1 }] }), null, prop);
  }
});

test("the request to sample carries nothing and needs the nonce", () => {
  assert.deepEqual(validateShellMsg(envelope(ns, nonce, "sample-styles", { force: true, values: [] }), { ns, nonce }), { type: "sample-styles" });
  assert.equal(validateShellMsg({ dftp: 1, type: "sample-styles" }, { ns, nonce }), null);
  assert.equal(validateShellMsg(envelope(ns, nonce, "style-sample", good), { ns, nonce }), null, "a layer message is not a shell message");
  assert.equal(validateFrameMsg(envelope(ns, nonce, "sample-styles"), { ns, nonce }), null, "and the other way round");
});
