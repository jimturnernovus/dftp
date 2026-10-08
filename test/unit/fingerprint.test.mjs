import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { createFingerprinter, filesOf, isSourcePath } from "../../server/fingerprint.mjs";
import { tempRoot, removeRoot } from "../helpers.mjs";

test("fingerprints: hash only, inside the root only", async () => {
  const root = await tempRoot({ demo: false });
  const outside = await tempRoot({ demo: false });
  try {
    await fsp.mkdir(path.join(root, "src"));
    await fsp.writeFile(path.join(root, "src", "a.jsx"), "export const a = 1;\n");
    await fsp.writeFile(path.join(outside, "b.js"), "secret");
    await fsp.symlink(path.join(outside, "b.js"), path.join(root, "src", "link.js"));
    await fsp.symlink(path.join(root, "src", "a.jsx"), path.join(root, "src", "inside-link.jsx"));
    const key = randomBytes(32);
    const fp = createFingerprinter(root, { key });
    const want = createHmac("sha256", key).update("export const a = 1;\n").digest("hex").slice(0, 12);
    assert.equal(await fp.hash("src/a.jsx"), want);
    assert.equal(await fp.hash("src/inside-link.jsx"), want);
    assert.equal(await fp.hash("src/link.js"), null);
    assert.equal(await fp.hash("src/missing.js"), null);
    assert.equal(await fp.hash("../b.js"), null);
    assert.equal(await fp.hash("/etc/hosts"), null);
    assert.equal(await fp.hash("src"), null);
    const many = await fp.hashMany(["src/a.jsx", "src/a.jsx", "../x", "src/missing.js"]);
    assert.deepEqual(Object.keys(many), ["src/a.jsx", "src/missing.js"]);
    assert.equal(Object.getPrototypeOf(many), null);
    await fsp.writeFile(path.join(root, "src", "a.jsx"), "changed\n");
    const later = new Date(Date.now() + 5000);
    await fsp.utimes(path.join(root, "src", "a.jsx"), later, later);
    assert.notEqual(await fp.hash("src/a.jsx"), want);
    const small = createFingerprinter(root, { key, limit: 3 });
    assert.equal(await small.hash("src/a.jsx"), null);
    const other = createFingerprinter(root, { key: randomBytes(32) });
    assert.notEqual(await other.hash("src/a.jsx"), await fp.hash("src/a.jsx"), "another key gives another value");
    assert.throws(() => createFingerprinter(root), TypeError);
  } finally {
    await removeRoot(root);
    await removeRoot(outside);
  }
});

test("files named by a list of changes", () => {
  assert.deepEqual(filesOf([{ loc: "a.js:1:1", used_in: "b.js:2:2" }, { loc: "a.js:3:3" }, { loc: "../x.js:1:1" }, {}]), ["a.js", "b.js"]);
});

test("only ordinary source files are fingerprinted: no dot paths, no node_modules, known types only", async () => {
  const root = await tempRoot({ demo: false });
  try {
    const files = {
      ".env": "API_KEY=hunter2\n",
      ".git/HEAD": "ref: refs/heads/secret-branch\n",
      ".dftp/fingerprint.key": "x\n",
      "config/.secrets/a.js": "x\n",
      "node_modules/pkg/index.js": "x\n",
      "notes.txt": "x\n",
      "package.json": "{}\n",
      "src/App.tsx": "x\n",
      "src/app.css": "x\n",
      "pages/index.html": "x\n",
    };
    for (const [f, text] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, f)), { recursive: true });
      await fsp.writeFile(path.join(root, f), text);
    }
    await fsp.symlink(path.join(root, ".env"), path.join(root, "src", "env.js"));
    const fp = createFingerprinter(root, { key: randomBytes(32) });
    const got = await fp.hashMany([...Object.keys(files), "src/env.js", "nope.js"]);
    for (const f of [".env", ".git/HEAD", ".dftp/fingerprint.key", "config/.secrets/a.js", "node_modules/pkg/index.js", "notes.txt", "package.json", "src/env.js", "nope.js"]) {
      assert.equal(got[f], null, f);
    }
    for (const f of ["src/App.tsx", "src/app.css", "pages/index.html"]) assert.match(got[f], /^[0-9a-f]{12}$/, f);
    assert.equal(isSourcePath("src/Thing.VUE"), true);
    assert.equal(isSourcePath("src/.hidden.js"), false);
    assert.equal(isSourcePath("../x.js"), false);
  } finally {
    await removeRoot(root);
  }
});
