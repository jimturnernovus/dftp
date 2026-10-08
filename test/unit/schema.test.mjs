import test from "node:test";
import assert from "node:assert/strict";
import {
  validateChange, validateList, validateDoc, validateSave, validateFiles, coerceChange, safeParse,
  isId, isLoc, isFilePath, splitLoc, newChangeId, stripControls, LIMITS, FORMAT_ID,
} from "../../client/core/schema.js";
import { sampleChange } from "../helpers.mjs";

const ok = (c) => validateChange(c).ok;
const field = (over) => ok(sampleChange(over));

test("no-net preload is active", () => {
  assert.equal(globalThis.__dftpNoNet, true);
});

test("a full change passes and unknown keys are dropped", () => {
  const c = sampleChange({
    used_in: "src/views/list.jsx:4:2", was_loc: "", part: false, piece: false, hidden: true, missing: false,
    inline: true, text_multi: false, path: "1.2>~0.3", w: 140, h: null, text_from: "a", text_to: "b\nc",
    text_attr: null, src: "0123456789ab", src_used: "", extra: "dropped", lk: "x",
    hint: { id: "x", classes: ["btn", "btn-ghost"], selector: "main > div:nth-of-type(2)", role: "button", aria: "Export" },
    ctx: { display: "block", position: "static", parent: { display: "flex", dir: "row", wrap: "nowrap", gap_px: 8, grid_cols: 0 }, index: 1, count: 4, slot: { before_index: 0 } },
  });
  const r = validateChange(c);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.extra, undefined);
  assert.equal(r.value.lk, undefined);
  assert.equal(r.value.text_to, "b\nc");
  assert.deepEqual(r.value.hint.classes, ["btn", "btn-ghost"]);
});

test("id and key rules", () => {
  assert.ok(!field({ id: "ABCD1234" }));
  assert.ok(!field({ id: "abc" }));
  assert.ok(!field({ id: undefined }));
  assert.ok(!field({ key: "" }));
  assert.ok(!field({ key: "k\u00e9y" }));
  assert.ok(!field({ key: "a".repeat(513) }));
  assert.ok(field({ key: "a".repeat(512) }));
  assert.ok(!field({ key: { toString: () => "x" } }));
});

test("loc rules: relative paths only", () => {
  assert.ok(field({ loc: "app/[id]/page.tsx:3:5" }));
  assert.ok(field({ loc: "routes/$id.tsx:1:1" }));
  assert.ok(field({ loc: "src/(group)/a+b@c.jsx:10:2" }));
  assert.ok(field({ loc: "" }));
  for (const bad of [
    "../../.ssh/id_rsa:1:1", "a/../b.js:1:1", "/etc/passwd:1:1", "~/x.js:1:1", "C:\\x.js:1:1", "C:/x.js:1:1",
    "a//b.js:1:1", "a/./b.js:1:1", "x.js:1", "x.js", "x.js:1234567:1", "x.js:1:123456", "a b.js:1:1",
    "x.js:1:1\n", `${"a".repeat(301)}:1:1`,
  ]) {
    assert.ok(!field({ loc: bad }), bad);
    assert.ok(!field({ used_in: bad }), bad);
    assert.ok(!field({ was_loc: bad }), bad);
  }
  assert.ok(!isLoc(null));
  assert.deepEqual(splitLoc("a/b.js:3:7"), { file: "a/b.js", line: 3, col: 7 });
  assert.equal(splitLoc("../a.js:1:1"), null);
  assert.ok(isFilePath("demo/active-clients.html"));
  assert.ok(!isFilePath("demo/"));
});

test("numbers, booleans, tags and paths", () => {
  assert.ok(!field({ occ: -1 }));
  assert.ok(!field({ occ: 10001 }));
  assert.ok(!field({ occ: 1.5 }));
  assert.ok(field({ occ: 10000 }));
  for (const f of ["part", "piece", "hidden", "missing", "inline", "text_multi"]) {
    assert.ok(!field({ [f]: "true" }), f);
    assert.ok(!field({ [f]: 1 }), f);
  }
  assert.ok(!field({ path: "1.2/3" }));
  assert.ok(!field({ path: "x".repeat(10) }));
  assert.ok(field({ path: "0.1>~2.3" }));
  assert.ok(!field({ tag: "H1" }));
  assert.ok(!field({ tag: "1a" }));
  assert.ok(!field({ tag: "a".repeat(33) }));
  assert.ok(field({ tag: "my-element" }));
  for (const [f, v] of [["dx", 20001], ["dy", -20001], ["dx", Infinity], ["dy", NaN], ["dx", "4"]]) {
    assert.ok(!field({ [f]: v }), `${f}=${v}`);
  }
  assert.ok(field({ dx: 20000, dy: -20000 }));
  assert.ok(!field({ w: 3 }));
  assert.ok(!field({ h: 20001 }));
  assert.ok(field({ w: null, h: 4 }));
  assert.ok(!field({ base: { x: 0, y: 0, w: 10 } }));
  assert.ok(!field({ base: { x: Infinity, y: 0, w: 1, h: 1 } }));
  assert.ok(!field({ base: [0, 0, 1, 1] }));
});

test("text limits and stripped characters", () => {
  assert.ok(!field({ text: "a".repeat(LIMITS.text + 1) }));
  assert.ok(field({ text: "a".repeat(LIMITS.text) }));
  assert.ok(!field({ text_from: "a".repeat(501) }));
  assert.ok(!field({ text_to: "a".repeat(2001) }));
  assert.ok(field({ text_to: "a".repeat(2000) }));
  assert.ok(!field({ text: 5 }));
  const r = validateChange(sampleChange({
    text: "safe\u202Etxt.exe\u0000\u0007\n\u2066x\u2069\u200F\u2028",
    text_to: "line one\r\nline two\u202D\u009B",
  }));
  assert.ok(r.ok);
  assert.equal(r.value.text, "safetxt.exex");
  assert.equal(r.value.text_to, "line one\nline two");
  assert.equal(stripControls("a\tb"), "ab");
});

test("text_attr, hint, ctx, fingerprints and time", () => {
  assert.ok(!field({ text_attr: "value" }));
  assert.ok(field({ text_attr: "placeholder" }));
  assert.ok(!field({ hint: { id: "a<b" } }));
  assert.ok(!field({ hint: { selector: "a[x=\"y\"]" } }));
  assert.ok(!field({ hint: { aria: "it's" } }));
  assert.ok(!field({ hint: { classes: new Array(9).fill("c") } }));
  assert.ok(!field({ hint: { classes: ["has space"] } }));
  assert.ok(!field({ hint: { role: "r".repeat(33) } }));
  assert.ok(field({ hint: { aria: "Ünïcode label" } }));
  assert.ok(!field({ ctx: { display: "Flex" } }));
  assert.ok(!field({ ctx: { parent: { gap_px: -1 } } }));
  assert.ok(!field({ ctx: { index: 1.5 } }));
  assert.ok(!field({ ctx: { slot: { before_index: "1" } } }));
  assert.ok(field({ ctx: { slot: null } }));
  assert.ok(field({ ctx: { slot: { before_index: null } } }));
  assert.ok(!field({ src: "0123456789AB" }));
  assert.ok(!field({ src: "0123" }));
  assert.ok(field({ src: "" }));
  assert.ok(!field({ at: "yesterday" }));
  assert.ok(!field({ at: "2".repeat(41) }));
});

test("lists: limit and duplicates", () => {
  const many = Array.from({ length: LIMITS.changes + 1 }, (_, i) => sampleChange({ id: `a${String(i).padStart(7, "0")}`, key: `k${i}` }));
  assert.ok(!validateList(many).ok);
  assert.ok(validateList(many.slice(0, LIMITS.changes)).ok);
  assert.ok(!validateList([sampleChange(), sampleChange({ key: "other" })]).ok, "duplicate id");
  assert.ok(!validateList([sampleChange(), sampleChange({ id: "zzzz9999" })]).ok, "duplicate key");
  assert.ok(!validateList({}).ok);
  assert.ok(!validateList([{ key: {} }]).ok);
});

test("safeParse refuses prototype keys and pollutes nothing", () => {
  assert.throws(() => safeParse('[{"__proto__":{"polluted":1},"key":"a"}]'));
  assert.throws(() => safeParse('{"constructor":{"prototype":{"polluted":1}}}'));
  assert.throws(() => safeParse('{"a":{"prototype":1}}'));
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(safeParse('{"a":[1,{"b":2}]}'), { a: [1, { b: 2 }] });
});

test("ids: slugs only, reserved device names refused", () => {
  for (const good of ["home", "active-clients", "a", "a1-b2"]) assert.ok(isId(good), good);
  for (const bad of ["", "A", "a/b", "../../x", "..%2fx", "-a", "a_b", "con", "nul", "com1", "lpt9", "a".repeat(49), null]) {
    assert.ok(!isId(bad), String(bad));
  }
  assert.match(newChangeId(), /^[a-z0-9]{8}$/);
});

test("documents", () => {
  const doc = {
    format: FORMAT_ID, version: 1, page: "home", device: "phone", viewport: { width: 390, height: 844 },
    theme: "dark", saved_at: "2026-01-02T03:04:05Z", rev: 3, writer: "tab-1", seq: 7, list: [sampleChange()],
  };
  assert.ok(validateDoc(doc).ok);
  assert.ok(validateDoc(doc, { page: "home", device: "phone" }).ok);
  assert.ok(!validateDoc(doc, { page: "other" }).ok);
  assert.ok(!validateDoc({ ...doc, format: "something.else" }).ok);
  assert.ok(!validateDoc({ ...doc, version: 2 }).ok);
  assert.ok(!validateDoc({ ...doc, theme: "blue" }).ok);
  assert.ok(!validateDoc({ ...doc, rev: -1 }).ok);
  assert.ok(!validateDoc({ ...doc, writer: "has space" }).ok);
  assert.ok(!validateDoc({ ...doc, list: [{ id: "x" }] }).ok);
});

test("save bodies", () => {
  const body = { page: "home", device: "phone", theme: "light", list: [], tab: "t1", seq: 1, base: 0 };
  assert.ok(validateSave(body).ok);
  assert.equal(validateSave({ ...body, tab: undefined }).value.tab, null);
  assert.ok(!validateSave({ ...body, seq: -1 }).ok);
  assert.ok(!validateSave({ ...body, base: "0" }).ok);
  assert.ok(!validateSave({ ...body, page: "../x" }).ok);
  assert.ok(!validateSave({ ...body, tab: "a".repeat(81) }).ok);
  assert.ok(!validateSave([]).ok);
});

test("file lists", () => {
  assert.deepEqual(validateFiles(["a.js", "a.js", "b/c.jsx"]).value, ["a.js", "b/c.jsx"]);
  assert.ok(!validateFiles(["../a.js"]).ok);
  assert.ok(!validateFiles(new Array(201).fill("a.js")).ok);
  assert.ok(!validateFiles("a.js").ok);
});

test("coerceChange trims page data into a valid change", () => {
  const c = coerceChange({
    id: "abcd1234", key: "k#0", loc: "../bad:1:1", tag: "DIV", text: "x".repeat(900),
    dx: 99999, w: 1, hint: { aria: "say \"hi\" <b>", classes: ["ok", "has space", "<x>"] }, extra: 1,
  });
  assert.ok(c);
  assert.equal(c.loc, "");
  assert.equal(c.tag, "div");
  assert.equal(c.text.length, LIMITS.text);
  assert.equal(c.dx, LIMITS.move);
  assert.equal(c.w, LIMITS.sizeMin);
  assert.equal(c.hint.aria, "say hi b");
  assert.deepEqual(c.hint.classes, ["ok"]);
  assert.ok(validateChange(c).ok);
  assert.equal(coerceChange({ key: "k" }), null);
});

test("detached and its container", () => {
  const r = validateChange(sampleChange({ dy: 80, detached: true, container: { tag: "section", loc: "src/a.jsx:3:1", path: "0.2" } }));
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value.container, { tag: "section", loc: "src/a.jsx:3:1", path: "0.2" });
  assert.ok(!field({ detached: "yes" }));
  assert.ok(!field({ container: "section" }));
  assert.ok(!field({ container: { tag: "SECTION" } }));
  assert.ok(!field({ container: { loc: "../a.js:1:1" } }));
  assert.ok(!field({ container: { path: "1/2" } }));
  assert.ok(!field({ container: { text: "words" } }));
  const k = coerceChange(sampleChange({ detached: 1, container: { tag: "div", loc: "/etc/x:1:1", path: "0", text: "dropped" } }));
  assert.equal(k.detached, true);
  assert.deepEqual(k.container, { tag: "div", path: "0" });
});
