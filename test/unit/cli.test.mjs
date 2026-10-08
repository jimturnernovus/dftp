// The command line: help, version, where, done, and bad input.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { runCli, tempRoot, removeRoot, startApp, save, sampleChange, docPath, request, readHeaders, randomPort } from "../helpers.mjs";

const run = async (args, opts) => {
  const c = runCli(args, opts);
  const r = await c.exited;
  return { code: r.code, out: c.out(), err: c.err() };
};

test("help, version and unknown input", async () => {
  const h = await run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /^DFTP \(Designer for the Page\): a drag-and-drop layout designer for almost any web page/);
  const v = await run(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal((await run(["--nope"])).code, 2);
  assert.equal((await run(["frobnicate"])).code, 2);
  const noTarget = await run(["--root", "."]);
  assert.equal(noTarget.code, 2);
  assert.match(noTarget.err, /--target is required/);
  const badTarget = await run(["--target", "http://example.com"]);
  assert.equal(badTarget.code, 2);
});

test("where prints the CHANGES.md path", async () => {
  const root = await tempRoot();
  try {
    const r = await run(["where", "--root", root]);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), path.join(root, ".dftp", "CHANGES.md"));
    assert.match(r.err, /not written yet/);
  } finally {
    await removeRoot(root);
  }
});

test("done removes changes while the designer is running", async () => {
  const t = await startApp();
  try {
    const a = sampleChange({ id: "aaaa1111", key: "a#0" });
    const b = sampleChange({ id: "bbbb2222", key: "b#0" });
    assert.equal((await save(t, { list: [a, b] })).status, 200);
    const badId = await run(["done", "--root", t.root, "NOT-AN-ID"]);
    assert.equal(badId.code, 2);
    const noIds = await run(["done", "--root", t.root]);
    assert.equal(noIds.code, 2);
    const r = await run(["done", "--root", t.root, "--demo", "aaaa1111", "zzzz0000"]);
    assert.equal(r.code, 1, "an id that was not found makes the exit code 1");
    assert.match(r.out, /Removed 1 of 2 change\(s\): aaaa1111\./);
    assert.match(r.out, /Not found: zzzz0000/);
    const doc = JSON.parse(await fsp.readFile(docPath(t.root), "utf8"));
    assert.deepEqual(doc.list.map((c) => c.id), ["bbbb2222"]);
    assert.equal(doc.writer, "cli");
    // The open designer's next save is told to reload.
    const again = await save(t, { seq: 2, base: 1, list: [a, b] });
    assert.equal(again.status, 409);
    assert.deepEqual(JSON.parse(again.text), { conflict: true, rev: 2 });
    const md = await request(t.shellPort, { path: "/api/changes-md", headers: readHeaders(t) });
    assert.ok(!md.text.includes("aaaa1111"));
    const ok = await run(["done", "--root", t.root, "bbbb2222"]);
    assert.equal(ok.code, 0);
  } finally {
    await t.close();
  }
});

test("done in a project without .dftp does nothing", async () => {
  const root = await tempRoot();
  try {
    const r = await run(["done", "--root", root, "abcd1234"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /Nothing to do/);
    await assert.rejects(fsp.stat(path.join(root, ".dftp")));
  } finally {
    await removeRoot(root);
  }
});

test("a symlinked .dftp makes the command refuse to start", async () => {
  const root = await tempRoot();
  const elsewhere = await tempRoot({ demo: false });
  try {
    await fsp.symlink(elsewhere, path.join(root, ".dftp"));
    const r = await run(["--demo", "--root", root, "--port", String(randomPort())]);
    assert.equal(r.code, 2);
    assert.match(r.err, /refusing to start: \.dftp is a symbolic link/);
    assert.deepEqual(await fsp.readdir(elsewhere), []);
  } finally {
    await removeRoot(root);
    await removeRoot(elsewhere);
  }
});

test("--demo with a --root that has no demo page stops with a clear message and writes nothing", async () => {
  const root = await tempRoot({ demo: false });
  try {
    const r = await run(["--demo", "--root", root, "--port", String(randomPort())]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--demo shows demo\/active-clients\.html from the project folder/);
    assert.deepEqual(await fsp.readdir(root), []);
    const unknown = await run(["--bogus"]);
    assert.match(unknown.err, /unknown option "--bogus"; dftp --help lists the options/);
  } finally {
    await removeRoot(root);
  }
});

test("the start-up check tries every address the proxy would, and warns only when none answers", async (t) => {
  const { startUpstream } = await import("../fixtures/upstream.mjs");
  let v6;
  try {
    v6 = await startUpstream({ host: "::1" });
  } catch {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  const root = await tempRoot({ demo: false });
  try {
    const ok = runCli(["--target", `http://localhost:${v6.port}`, "--root", root, "--port", String(randomPort())]);
    try {
      await ok.waitFor(/Designer:/);
      await new Promise((r) => setTimeout(r, 2500));
      assert.doesNotMatch(ok.err(), /nothing answered/, "a dev server on ::1 only is found for a localhost target");
    } finally {
      await ok.stop();
    }
    const dead = runCli(["--target", `http://localhost:${randomPort() + 1}`, "--root", root, "--port", String(randomPort())]);
    try {
      await dead.waitFor(/Designer:/);
      const until = Date.now() + 6000;
      while (!/nothing answered/.test(dead.err()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      assert.match(dead.err(), /nothing answered at http:\/\/localhost:\d+ \(tried 127\.0\.0\.1 and \[::1\]/);
      assert.match(dead.err(), /use the exact address it prints/);
    } finally {
      await dead.stop();
    }
  } finally {
    await v6.close();
    await removeRoot(root);
  }
});
