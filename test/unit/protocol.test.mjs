import test from "node:test";
import assert from "node:assert/strict";
import {
  envelope, validateFrameMsg, validateShellMsg, makeNonce, windowName, nonceFromName,
  FRAME_TYPES, SHELL_TYPES, KEY_ALLOW, TOAST_CODES, BEFORE_TYPES,
} from "../../client/core/protocol.js";
import { sampleChange } from "../helpers.mjs";

const ns = "dftp";
const nonce = makeNonce();
const fromFrame = (type, fields) => validateFrameMsg(envelope(ns, nonce, type, fields), { ns, nonce });
const fromShell = (type, fields) => validateShellMsg(envelope(ns, nonce, type, fields), { ns, nonce });

const init = {
  list: [sampleChange()],
  mode: "design",
  view: "after",
  theme: "light",
  grid: { on: false, size: 8, snap: true },
  code: { "demo/active-clients.html": "0123456789ab", "src/x.js": null },
  page: { id: "active-clients", path: "/", keep: [] },
  device: { id: "desktop", width: 1440, height: 900 },
  scale: 0.75,
};

test("nonces and window names", () => {
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(nonceFromName(ns, windowName(ns, nonce)), nonce);
  assert.equal(nonceFromName(ns, `other:${nonce}`), null);
  assert.equal(nonceFromName(ns, "dftp:xyz"), null);
  assert.equal(nonceFromName(ns, undefined), null);
});

test("envelope cannot be overridden by fields", () => {
  const m = envelope(ns, nonce, "ready", { type: "init", n: "x", dftp: 2, path: "/" });
  assert.deepEqual(m, { dftp: 1, type: "ready", n: nonce, path: "/" });
});

test("wrong namespace, nonce or type is dropped", () => {
  assert.equal(validateFrameMsg({ dftp: 1, n: nonce, type: "ready" }, { ns, nonce: makeNonce() }), null);
  assert.equal(validateFrameMsg({ other: 1, n: nonce, type: "ready" }, { ns, nonce }), null);
  assert.equal(validateFrameMsg({ dftp: "1", n: nonce, type: "ready" }, { ns, nonce }), null);
  assert.equal(validateFrameMsg({ dftp: 1, n: nonce, type: "init" }, { ns, nonce }), null);
  assert.equal(validateShellMsg({ dftp: 1, n: nonce, type: "ready" }, { ns, nonce }), null);
  assert.equal(validateFrameMsg(null, { ns, nonce }), null);
  assert.equal(validateFrameMsg("ready", { ns, nonce }), null);
  assert.equal(validateShellMsg({ dftp: 1, type: "undo" }, { ns, nonce }), null, "shell messages always need the nonce");
});

test("hello needs no nonce; everything else does", () => {
  assert.deepEqual(validateFrameMsg({ dftp: 1, type: "hello" }, { ns, nonce: null }), { type: "hello" });
  assert.equal(validateFrameMsg({ dftp: 1, type: "ready" }, { ns, nonce: null }), null);
});

test("every listed type has a validator", () => {
  assert.ok(FRAME_TYPES.length > 5 && SHELL_TYPES.length > 5);
  assert.ok(BEFORE_TYPES.every((t) => SHELL_TYPES.includes(t)));
});

test("layer messages", () => {
  assert.deepEqual(fromFrame("ready", { path: "/x?y=1" }), { type: "ready", path: "/x?y=1" });
  const ch = fromFrame("changes", { list: [sampleChange()], canUndo: true, extra: 1 });
  assert.equal(ch.list.length, 1);
  assert.equal(ch.canUndo, true);
  assert.equal(ch.canRedo, false);
  assert.equal(ch.extra, undefined);
  assert.equal(fromFrame("changes", { list: [{ key: {} }] }), null);
  assert.equal(fromFrame("changes", { list: [sampleChange()], canUndo: "yes" }), null);
  assert.deepEqual(fromFrame("toast", { code: TOAST_CODES[0] }), { type: "toast", code: TOAST_CODES[0] });
  assert.equal(fromFrame("toast", { code: "<b>hi</b>" }), null);
  assert.equal(fromFrame("toast", { text: "free text" }), null);
  assert.deepEqual(fromFrame("navigate", { path: "/a", to: "/b" }), { type: "navigate", path: "/a", to: "/b" });
  assert.equal(fromFrame("navigate", { path: "x".repeat(2001) }), null);
  assert.deepEqual(fromFrame("mode-request", { mode: "use" }), { type: "mode-request", mode: "use" });
  assert.equal(fromFrame("mode-request", { mode: "edit" }), null);
  assert.deepEqual(fromFrame("need-code", { files: ["a.js", "a.js"] }), { type: "need-code", files: ["a.js"] });
  assert.equal(fromFrame("need-code", { files: ["../a.js"] }), null);
  for (const t of ["save-now", "grid-toggle", "view-toggle", "drawer-toggle"]) assert.deepEqual(fromFrame(t, { x: 1 }), { type: t });
});

test("selection messages are strictly typed", () => {
  const info = {
    count: 1, key: "k#0", loc: "a.js:1:1", used_in: "", tag: "div", path: "", text: "Hello",
    rect: { x: 1, y: 2, w: 3, h: 4 }, part: false, piece: false, change: null,
    crumbs: [{ key: "p#0", tag: "main", text: "x", loc: "" }],
  };
  const ok = fromFrame("selection", { info });
  assert.equal(ok.info.rect.w, 3);
  assert.deepEqual(fromFrame("selection", { info: null }), { type: "selection", info: null });
  assert.equal(fromFrame("selection", { info: { ...info, rect: { ...info.rect, w: "<img src=x onerror=alert(1)>" } } }), null);
  assert.equal(fromFrame("selection", { info: { ...info, count: 0 } }), null);
  assert.equal(fromFrame("selection", { info: { ...info, tag: "<svg onload=alert(1)>" } }), null);
  assert.equal(fromFrame("selection", { info: { ...info, change: { key: "x" } } }), null);
  assert.equal(fromFrame("selection", { info: { ...info, crumbs: new Array(13).fill(info.crumbs[0]) } }), null);
  assert.equal(fromFrame("selection", { info: { ...info, loc: "../../etc/passwd:1:1" } }), null);
});

test("shell messages", () => {
  const i = fromShell("init", init);
  assert.equal(i.list.length, 1);
  assert.equal(i.code["src/x.js"], null);
  assert.equal(Object.getPrototypeOf(i.code), null);
  assert.equal(fromShell("init", { ...init, view: "sideways" }), null);
  assert.equal(fromShell("init", { ...init, grid: { on: true, size: 1, snap: true } }), null);
  assert.equal(fromShell("init", { ...init, code: { "../x": "0123456789ab" } }), null);
  assert.equal(fromShell("init", { ...init, scale: 0 }), null);
  assert.equal(fromShell("init", { ...init, page: { id: "A", path: "/" } }), null);
  assert.equal(fromShell("init", { ...init, key: "x", view: () => {} }), null);
  assert.deepEqual(fromShell("view", { view: "before" }), { type: "view", view: "before" });
  assert.equal(fromShell("view", { view: {} }), null);
  assert.deepEqual(fromShell("reset", {}), { type: "reset", key: null });
  assert.equal(fromShell("show", {}), null);
  assert.deepEqual(fromShell("select", { key: "k", real: true }), { type: "select", key: "k", real: true });
  assert.deepEqual(fromShell("theme", { theme: "dark" }), { type: "theme", theme: "dark" });
  assert.deepEqual(fromShell("scale", { scale: 1 }), { type: "scale", scale: 1 });
  assert.equal(fromShell("scale", { scale: Infinity }), null);
});

test("forwarded keys: allowlist and boolean modifiers only", () => {
  assert.deepEqual(fromShell("key", { init: { key: "ArrowLeft", shift: true } }), {
    type: "key", init: { key: "ArrowLeft", shift: true, alt: false, meta: false, ctrl: false },
  });
  assert.ok(KEY_ALLOW.includes("Delete"));
  assert.equal(fromShell("key", { init: { key: "x" } }), null);
  assert.equal(fromShell("key", { init: { key: "Delete", shift: "yes" } }), null);
  assert.equal(fromShell("key", { init: { key: "a", view: {} } }), null);
  assert.equal(fromShell("key", { init: "Delete" }), null);
});

test("flush and flushed carry nothing but their type", () => {
  assert.deepEqual(fromShell("flush", { extra: "x" }), { type: "flush" });
  assert.deepEqual(fromFrame("flushed", { list: [] }), { type: "flushed" });
  assert.ok(!BEFORE_TYPES.includes("flush"), "the layer answers a flush before its Before filter, never edits during Before");
  assert.ok(TOAST_CODES.includes("split-held"));
  assert.deepEqual(fromFrame("toast", { code: "split-held" }), { type: "toast", code: "split-held" });
  assert.deepEqual(fromFrame("mode-request", { mode: "design" }), { type: "mode-request", mode: "design" });
});
