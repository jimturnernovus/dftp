import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { createStatic, contentTypeFor, readRegularFile, SHELL_FILES, LAYER_FILES } from "../../server/static.mjs";
import { TOOL_DIR, tempRoot, removeRoot } from "../helpers.mjs";

test("only listed, existing files inside the base folder are served", async () => {
  const base = await tempRoot({ demo: false });
  const outside = await tempRoot({ demo: false });
  try {
    await fsp.mkdir(path.join(base, "client"));
    await fsp.writeFile(path.join(base, "client", "a.js"), "a");
    await fsp.writeFile(path.join(outside, "secret.txt"), "secret");
    await fsp.symlink(path.join(outside, "secret.txt"), path.join(base, "client", "link.txt"));
    await fsp.mkdir(path.join(base, "client", "dir.js"));
    const st = await createStatic(base, [
      ["/a.js", "client/a.js"],
      ["/missing.js", "client/missing.js"],
      ["/link.txt", "client/link.txt"],
      ["/dir.js", "client/dir.js"],
      ["/escape.txt", "../secret.txt"],
      ["no-slash", "client/a.js"],
    ]);
    assert.deepEqual(st.paths(), ["/a.js"]);
    assert.equal(st.get("/a.js").type, "text/javascript; charset=utf-8");
    for (const p of ["/missing.js", "/link.txt", "/dir.js", "/escape.txt", "no-slash", "/A.JS", "/a.js/", "/./a.js", undefined]) {
      assert.equal(st.get(p), undefined, String(p));
    }
  } finally {
    await removeRoot(base);
    await removeRoot(outside);
  }
});

test("traversal-shaped paths never match the real lists", async () => {
  const shell = await createStatic(TOOL_DIR, SHELL_FILES);
  const layer = await createStatic(TOOL_DIR, LAYER_FILES);
  assert.ok(shell.get("/shell.js"));
  assert.ok(layer.get("/__dftp/core/schema.js"));
  for (const p of [
    "/%2e%2e/%2e%2e/package.json", "/..%5c..%5cserver.mjs", "/%00", "/../package.json", "/core/../../package.json",
    "/core/%2e%2e/%2e%2e/package.json", "/shell.js%00.png", "/server/main.mjs", "/package.json", "/client/shell.js",
    "/__dftp/../package.json", "/__dftp/%2e%2e/server/main.mjs", "/__dftp/core/../../package.json",
  ]) {
    assert.equal(shell.get(p), undefined, p);
    assert.equal(layer.get(p), undefined, p);
  }
});

test("content types and regular-file reads", async () => {
  assert.equal(contentTypeFor("a.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.exe"), "application/octet-stream");
  const dir = await tempRoot({ demo: false });
  try {
    await fsp.writeFile(path.join(dir, "f.txt"), "hi");
    await fsp.symlink(path.join(dir, "f.txt"), path.join(dir, "l.txt"));
    assert.equal((await readRegularFile(path.join(dir, "f.txt"))).toString(), "hi");
    await assert.rejects(readRegularFile(path.join(dir, "l.txt")));
    await assert.rejects(readRegularFile(dir));
    await assert.rejects(readRegularFile(path.join(dir, "f.txt"), 1));
  } finally {
    await removeRoot(dir);
  }
});

test("the designer page template holds exactly one token placeholder", async () => {
  const { indexHasPlaceholder } = await import("../../server/shell-app.mjs");
  assert.ok(await indexHasPlaceholder(TOOL_DIR));
  const html = await fsp.readFile(path.join(TOOL_DIR, "client", "index.html"), "utf8");
  assert.match(html, /<meta name="dftp-token" content="%TOKEN%">/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline scripts");
  assert.ok(!/\sstyle=/i.test(html), "no inline style attributes");
  assert.ok(!/<style/i.test(html), "no style blocks");
});
