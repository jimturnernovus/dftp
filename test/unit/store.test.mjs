import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { openStore, prepareDirs, checkDirs, loadFingerprintKey, StoreError, HISTORY_KEEP, KEY_FILE } from "../../server/store.mjs";
import { BUILT_IN_DEVICES } from "../../client/core/devices.js";
import { validateDoc } from "../../client/core/schema.js";
import { tempRoot, removeRoot, sampleChange, sleep } from "../helpers.mjs";

const pages = [{ id: "active-clients", label: "Active Clients", path: "/", keep: [] }];

async function makeStore(root, over = {}) {
  return openStore({ root, pages, devices: BUILT_IN_DEVICES, version: "9.9.9", ...over });
}

const body = (over = {}) => ({
  page: "active-clients", device: "desktop", theme: "light", list: [sampleChange()], tab: "tab-one", seq: 1, base: 0, ...over,
});

async function withRoot(fn) {
  const root = await tempRoot();
  try {
    await fn(root);
  } finally {
    await removeRoot(root);
  }
}

const docFile = (root, device = "desktop") => path.join(root, ".dftp", "changes", `active-clients__${device}.json`);
const readJson = async (f) => JSON.parse(await fsp.readFile(f, "utf8"));

test("first run makes the folders and an ignore-everything .gitignore", () => withRoot(async (root) => {
  await makeStore(root);
  for (const d of [".dftp", ".dftp/changes", ".dftp/history"]) assert.ok((await fsp.stat(path.join(root, d))).isDirectory(), d);
  assert.equal(await fsp.readFile(path.join(root, ".dftp/.gitignore"), "utf8"), "*\n");
}));

test("symbolic links and odd entries make startup refuse", async () => {
  const outside = await tempRoot({ demo: false });
  try {
    await withRoot(async (root) => {
      await fsp.symlink(outside, path.join(root, ".dftp"));
      await assert.rejects(makeStore(root), (e) => e instanceof StoreError && e.code === "unsafe" && /symbolic link/.test(e.message));
    });
    await withRoot(async (root) => {
      await fsp.mkdir(path.join(root, ".dftp"));
      await fsp.symlink(outside, path.join(root, ".dftp", "changes"));
      await assert.rejects(makeStore(root), (e) => e.code === "unsafe");
    });
    await withRoot(async (root) => {
      await fsp.mkdir(path.join(root, ".dftp"));
      await fsp.mkdir(path.join(root, ".dftp", "changes"));
      await fsp.symlink(outside, path.join(root, ".dftp", "history"));
      await assert.rejects(makeStore(root), (e) => e.code === "unsafe");
    });
    await withRoot(async (root) => {
      await fsp.writeFile(path.join(root, ".dftp"), "not a folder");
      await assert.rejects(makeStore(root), (e) => e.code === "unsafe" && /not a folder/.test(e.message));
    });
    await withRoot(async (root) => {
      await prepareDirs(root);
      await fsp.symlink(path.join(outside, "x.md"), path.join(root, ".dftp", "CHANGES.md"));
      await assert.rejects(makeStore(root), (e) => e.code === "unsafe");
    });
    assert.deepEqual(await fsp.readdir(outside), [], "nothing was written outside");
  } finally {
    await removeRoot(outside);
  }
});

test("the fingerprint key is made once, readable by the owner only, and kept", () => withRoot(async (root) => {
  const s1 = await makeStore(root);
  const keyFile = path.join(root, ".dftp", KEY_FILE);
  const st = await fsp.stat(keyFile);
  assert.equal(st.mode & 0o777, 0o600);
  const text = await fsp.readFile(keyFile, "utf8");
  assert.match(text, /^[0-9a-f]{64}\n$/);
  await fsp.mkdir(path.join(root, "src"));
  await fsp.writeFile(path.join(root, "src", "a.jsx"), "export const a = 1;\n");
  const first = await s1.fingerprint.hash("src/a.jsx");
  assert.match(first, /^[0-9a-f]{12}$/);
  const s2 = await makeStore(root);
  assert.equal(await fsp.readFile(keyFile, "utf8"), text, "the key is reused");
  assert.equal(await s2.fingerprint.hash("src/a.jsx"), first, "fingerprints survive a restart");
  await fsp.writeFile(keyFile, "not a key\n");
  await assert.rejects(makeStore(root), (e) => e instanceof StoreError && e.code === "unsafe" && /fingerprint\.key/.test(e.message));
  await fsp.unlink(keyFile);
  const outside = await tempRoot({ demo: false });
  try {
    await fsp.writeFile(path.join(outside, "k"), `${"a".repeat(64)}\n`);
    await fsp.symlink(path.join(outside, "k"), keyFile);
    await assert.rejects(makeStore(root), (e) => e.code === "unsafe");
  } finally {
    await removeRoot(outside);
  }
}));

test("a data folder replaced by a link while running is refused, never followed", async () => {
  const outside = await tempRoot({ demo: false });
  try {
    // .dftp/changes swapped (what a branch switch that tracks it as a link does)
    await withRoot(async (root) => {
      const s = await makeStore(root);
      assert.equal((await s.save(body())).status, 200);
      const changes = path.join(root, ".dftp", "changes");
      await fsp.rename(changes, `${changes}.old`);
      await fsp.symlink(outside, changes);
      await assert.rejects(s.save(body({ device: "tablet" })), (e) => e instanceof StoreError && e.code === "unsafe");
      await assert.rejects(s.read("active-clients", "desktop"), (e) => e.code === "unsafe");
      await assert.rejects(s.done(["abcd1234"]), (e) => e.code === "unsafe");
      await assert.rejects(s.buildMd(), (e) => e.code === "unsafe");
      // A real folder put back under the same name is still not the one the
      // store opened.
      await fsp.unlink(changes);
      await fsp.mkdir(changes);
      await assert.rejects(s.save(body({ device: "tablet" })), (e) => e.code === "unsafe");
    });
    // .dftp itself swapped for a link to a look-alike folder
    await withRoot(async (root) => {
      const s = await makeStore(root);
      const look = path.join(outside, "look");
      await fsp.mkdir(path.join(look, "changes"), { recursive: true });
      await fsp.mkdir(path.join(look, "history"));
      await fsp.rename(path.join(root, ".dftp"), path.join(root, ".dftp-old"));
      await fsp.symlink(look, path.join(root, ".dftp"));
      await assert.rejects(s.save(body()), (e) => e.code === "unsafe");
      await assert.rejects(s.rebuildMd(), (e) => e.code === "unsafe");
      await assert.rejects(checkDirs(s.abs), (e) => e.code === "unsafe");
      await assert.rejects(loadFingerprintKey(s.abs), (e) => e.code === "unsafe");
      assert.deepEqual((await fsp.readdir(look)).sort(), ["changes", "history"]);
      assert.deepEqual(await fsp.readdir(path.join(look, "changes")), []);
      await fsp.unlink(path.join(root, ".dftp"));
      await fsp.rm(look, { recursive: true });
    });
    assert.deepEqual(await fsp.readdir(outside), [], "nothing was written outside the project");
  } finally {
    await removeRoot(outside);
  }
});

test("save writes a valid document and CHANGES.md, atomically", () => withRoot(async (root) => {
  const s = await makeStore(root);
  const r = await s.save(body());
  assert.deepEqual(r, { status: 200, body: { ok: true, rev: 1 } });
  const doc = await readJson(docFile(root));
  assert.ok(validateDoc(doc, { page: "active-clients", device: "desktop" }).ok);
  assert.equal(doc.rev, 1);
  assert.equal(doc.writer, "tab-one");
  assert.deepEqual(doc.viewport, { width: 1440, height: 900 });
  const md = await fsp.readFile(path.join(root, ".dftp", "CHANGES.md"), "utf8");
  assert.match(md, /^# Layout changes\n/);
  assert.match(md, /\[abcd1234\] <h1> "Active Clients"/);
  assert.match(md, /DFTP \(Designer for the Page\) 9\.9\.9/);
  const left = (await fsp.readdir(path.join(root, ".dftp", "changes"))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, []);
  assert.deepEqual(await s.read("active-clients", "desktop"), doc);
  assert.equal(await s.read("active-clients", "phone"), null);
}));

test("conflict protocol", () => withRoot(async (root) => {
  const s = await makeStore(root);
  assert.deepEqual(await s.save(body({ tab: null })), { status: 409, body: { legacy: true } });
  assert.equal((await s.save(body({ page: "elsewhere" }))).status, 400);
  assert.equal((await s.save(body({ device: "watch" }))).status, 400);
  assert.equal((await s.save(body({ seq: 1 }))).body.rev, 1);
  assert.equal((await s.save(body({ seq: 2 }))).body.rev, 2);
  assert.deepEqual(await s.save(body({ seq: 2 })), { status: 200, body: { ok: true, stale: true, rev: 2 } }, "late duplicate");
  assert.deepEqual(await s.save(body({ seq: 1 })), { status: 200, body: { ok: true, stale: true, rev: 2 } });
  assert.deepEqual(await s.save(body({ tab: "tab-two", seq: 1, base: 1 })), { status: 409, body: { conflict: true, rev: 2 } });
  const before = await fsp.readFile(docFile(root), "utf8");
  assert.equal(JSON.parse(before).writer, "tab-one", "a refused save writes nothing");
  assert.deepEqual(await s.save(body({ tab: "tab-two", seq: 1, base: 2, list: [] })), { status: 200, body: { ok: true, rev: 3 } });
  const doc = await readJson(docFile(root));
  assert.equal(doc.writer, "tab-two");
  assert.deepEqual(doc.list, []);
}));

test("an unreadable file is an error and is never overwritten", () => withRoot(async (root) => {
  const s = await makeStore(root);
  await prepareDirs(root);
  for (const bad of ["{ not json", JSON.stringify({ format: "dftp.changes", version: 1 }), '{"__proto__":{"polluted":1}}']) {
    await fsp.writeFile(docFile(root), bad);
    await assert.rejects(s.read("active-clients", "desktop"), (e) => e.code === "unreadable" && e.status === 500);
    await assert.rejects(s.save(body()), (e) => e.code === "unreadable");
    assert.equal(await fsp.readFile(docFile(root), "utf8"), bad);
  }
  assert.deepEqual(await fsp.readdir(path.join(root, ".dftp", "history")), []);
  assert.equal(({}).polluted, undefined);
  const md = await s.buildMd();
  assert.match(md, /Unreadable change file "\.dftp\/changes\/active-clients__desktop\.json"/);
}));

test("a symlinked change file is unreadable", () => withRoot(async (root) => {
  const s = await makeStore(root);
  const target = path.join(root, "elsewhere.json");
  await fsp.writeFile(target, "{}");
  await fsp.symlink(target, docFile(root));
  await assert.rejects(s.read("active-clients", "desktop"), (e) => e.code === "unreadable");
}));

test("bad ids are refused, never cleaned up", () => withRoot(async (root) => {
  const s = await makeStore(root);
  for (const bad of ["../../x", "..%2fx", "A", "a/b", "con", "", "a\\b", ".."]) {
    assert.throws(() => s.fileFor(bad, "desktop"), (e) => e.code === "bad-id", bad);
    assert.throws(() => s.fileFor("active-clients", bad), (e) => e.code === "bad-id", bad);
  }
}));

test("history keeps the newest 30 per page and device and touches nothing else", () => withRoot(async (root) => {
  const s = await makeStore(root);
  const hist = path.join(root, ".dftp", "history");
  const others = ["notes.txt", "active-clients__phone.2026-01-01T00-00-00-000Z.json", "active-clients__desktop.json.bak", "x__desktop.2020-01-01T00-00-00-000Z.json"];
  for (const f of others) await fsp.writeFile(path.join(hist, f), "keep");
  for (let i = 1; i <= HISTORY_KEEP + 6; i++) {
    const r = await s.save(body({ seq: i, list: [sampleChange({ dx: i })] }));
    assert.equal(r.status, 200);
  }
  const names = await fsp.readdir(hist);
  const mine = names.filter((n) => /^active-clients__desktop\.\d{4}-[\dT-]+Z?\.json$/.test(n));
  assert.equal(mine.length, HISTORY_KEEP);
  for (const f of others) assert.ok(names.includes(f), f);
  // The newest history entry is the version just before the current one.
  const sorted = mine.sort((a, b) => (a.replace(/Z?\.json$/, "") < b.replace(/Z?\.json$/, "") ? -1 : 1));
  const newest = await readJson(path.join(hist, sorted[sorted.length - 1]));
  assert.equal(newest.list[0].dx, HISTORY_KEEP + 5);
}));

test("done removes ids, keeps history and makes open windows reload", () => withRoot(async (root) => {
  const s = await makeStore(root);
  const a = sampleChange({ id: "aaaa1111", key: "a#0" });
  const b = sampleChange({ id: "bbbb2222", key: "b#0" });
  await s.save(body({ list: [a, b] }));
  await s.save(body({ device: "phone", list: [sampleChange({ id: "aaaa3333", key: "a#0" })] }));
  const r = await s.done(["aaaa1111", "aaaa3333", "zzzz9999"]);
  assert.deepEqual(r.removed.sort(), ["aaaa1111", "aaaa3333"]);
  assert.deepEqual(r.notFound, ["zzzz9999"]);
  const doc = await readJson(docFile(root));
  assert.deepEqual(doc.list.map((c) => c.id), ["bbbb2222"]);
  assert.equal(doc.rev, 2);
  assert.equal(doc.writer, "cli");
  assert.equal((await readJson(docFile(root, "phone"))).list.length, 0);
  const md = await fsp.readFile(path.join(root, ".dftp", "CHANGES.md"), "utf8");
  assert.ok(!md.includes("aaaa1111"));
  assert.ok(md.includes("bbbb2222"));
  // The window that saved rev 1 is behind now.
  assert.deepEqual(await s.save(body({ seq: 2, base: 1, list: [a, b] })), { status: 409, body: { conflict: true, rev: 2 } });
  assert.equal((await fsp.readdir(path.join(root, ".dftp", "history"))).length, 2);
}));

test("two writers on one project are serialised by the lock file", () => withRoot(async (root) => {
  const server = await makeStore(root);
  const cli = await makeStore(root);
  const ids = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(7, "0")}`);
  const changes = ids.map((id, i) => sampleChange({ id, key: `k${i}` }));
  await server.save(body({ list: changes, seq: 1 }));
  let rev = 1;
  const saves = [];
  const dones = [];
  for (let i = 0; i < 10; i++) {
    dones.push(cli.done([ids[i]]));
    saves.push(server.save(body({ seq: 2 + i, base: rev, list: changes })));
  }
  const doneResults = await Promise.all(dones);
  const saveResults = await Promise.all(saves);
  for (const r of saveResults) assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r));
  for (const r of doneResults) assert.deepEqual(r.unreadable, []);
  const doc = await readJson(docFile(root));
  assert.ok(validateDoc(doc).ok);
  // Every save after a done is refused (its base is old) unless it raced
  // ahead of that done, so no removed change ever comes back.
  const remaining = new Set(doc.list.map((c) => c.id));
  const removed = doneResults.flatMap((r) => r.removed);
  assert.ok(removed.length > 0);
  for (const id of removed) assert.ok(!remaining.has(id), `${id} came back`);
  assert.equal(remaining.size + removed.length, 20);
  assert.equal(await fsp.readFile(path.join(root, ".dftp", ".lock"), "utf8").catch(() => null), null, "lock released");
}));

test("a held lock is waited for; a stale one is broken", () => withRoot(async (root) => {
  const s = await makeStore(root);
  const lock = path.join(root, ".dftp", ".lock");
  await fsp.writeFile(lock, "123\n");
  const started = Date.now();
  const p = s.save(body());
  await sleep(150);
  await fsp.unlink(lock);
  assert.equal((await p).status, 200);
  assert.ok(Date.now() - started >= 140);
  await fsp.writeFile(lock, "123\n");
  const old = new Date(Date.now() - 60000);
  await fsp.utimes(lock, old, old);
  assert.equal((await s.save(body({ seq: 2 }))).status, 200);
}));
