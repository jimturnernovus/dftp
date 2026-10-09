// The style scan stays inside the project: links out are not followed,
// secrets and output folders are never read, budgets hold, adapters that
// misbehave are contained, and the fenced command can still scan.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { scanProject } from "../../server/scan/scanner.mjs";
import { walkProject, isSecretName, isScannablePath, WALK_LIMITS } from "../../server/scan/walk.mjs";
import { ADAPTERS } from "../../server/scan/registry.mjs";
import { validateTokensDoc } from "../../client/core/tokens.js";
import { permissionSupported } from "../../server/permission.mjs";
import { tempRoot, removeRoot, runCli } from "../helpers.mjs";

const MARK = "#c0ffee";
const marked = (n = 0) => `:root { --leak-${n}: ${MARK}; }\n`;

async function withRoots(fn) {
  const root = await tempRoot({ demo: false });
  const outside = await tempRoot({ demo: false });
  try {
    await fn(root, outside);
  } finally {
    await removeRoot(root);
    await removeRoot(outside);
  }
}

const write = async (root, rel, text) => {
  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fsp.writeFile(path.join(root, rel), text);
};

async function scanned(root, opts = {}) {
  const doc = await scanProject({ root, ...opts });
  const r = validateTokensDoc(doc);
  assert.ok(r.ok, r.error);
  return { doc, json: JSON.stringify(doc) };
}

async function filesRead(root, opts = {}) {
  const state = { diagnostics: [], stats: { files: 0, skipped: 0, truncated: false } };
  const out = [];
  for await (const f of walkProject(root, { wants: () => true, state, ...opts })) out.push(f.rel);
  return { files: out, state };
}

test("links out of the project are never followed, to files or folders", { skip: process.platform === "win32" && "symbolic links need extra rights on Windows" }, () => withRoots(async (root, outside) => {
  await write(outside, "secret.css", marked());
  await write(outside, "dir/inner.css", marked(1));
  await write(root, "ok.css", ":root { --fine: #123456; }");
  await fsp.symlink(path.join(outside, "secret.css"), path.join(root, "linked.css"));
  await fsp.symlink(path.join(outside, "dir"), path.join(root, "linked-dir"));
  await fsp.symlink(path.join(outside, "dir"), path.join(root, "styles.css"));
  await fsp.symlink("/nonexistent-dftp-target.css", path.join(root, "dangling.css"));
  const { doc, json } = await scanned(root);
  assert.ok(!json.toLowerCase().includes(MARK), "nothing from outside the root");
  assert.ok(doc.tokens.some((t) => t.id === "color.fine"));
  const diag = doc.diagnostics.map((d) => `${d.code}:${d.file}`);
  assert.ok(diag.includes("symlink-outside:linked.css"), diag.join(" "));
  assert.ok(diag.includes("symlink-outside:styles.css"), diag.join(" "));
  assert.ok(diag.includes("symlink-outside:dangling.css"), diag.join(" "));
}));

test("a link inside the project is read only when its target may be read too", { skip: process.platform === "win32" && "symbolic links need extra rights on Windows" }, () => withRoots(async (root) => {
  await write(root, ".env", `PRIMARY=${MARK}`);
  await write(root, "node_modules/pkg/theme.css", marked());
  await write(root, "src/real.css", ":root { --real: #123456; }");
  await fsp.symlink(path.join(root, ".env"), path.join(root, "env.css"));
  await fsp.symlink(path.join(root, "node_modules/pkg/theme.css"), path.join(root, "vendor-link.css"));
  await fsp.symlink(path.join(root, "src/real.css"), path.join(root, "alias.css"));
  const { doc, json } = await scanned(root);
  assert.ok(!json.toLowerCase().includes(MARK));
  const diag = doc.diagnostics.map((d) => `${d.code}:${d.file}`);
  assert.ok(diag.includes("symlink-skip:env.css"));
  assert.ok(diag.includes("symlink-skip:vendor-link.css"));
  const real = doc.tokens.find((t) => t.id === "color.real");
  assert.equal(real.sources.length, 1, "a file reached twice is read once");
}));

test("a folder swapped for a link while the walk runs is not followed", { skip: process.platform === "win32" && "symbolic links need extra rights on Windows" }, () => withRoots(async (root, outside) => {
  await write(root, "a/first.css", ":root { --a: #111111; }");
  await write(root, "b/second.css", ":root { --b: #222222; }");
  await write(outside, "evil.css", marked());
  const state = { diagnostics: [], stats: { files: 0, skipped: 0, truncated: false } };
  const seen = [];
  for await (const f of walkProject(root, { wants: () => true, state })) {
    seen.push(f.rel);
    if (f.rel === "a/first.css") {
      await fsp.rm(path.join(root, "b"), { recursive: true });
      await fsp.symlink(outside, path.join(root, "b"));
    }
    assert.ok(!f.text.toLowerCase().includes(MARK));
  }
  assert.deepEqual(seen, ["a/first.css"]);
  assert.ok(state.diagnostics.some((d) => d.code === "symlink-skip" && d.file === "b"));
}));

test("secrets, dot folders and output folders are never read, whatever their names suggest", () => withRoots(async (root) => {
  const never = [
    ".env", ".env.local", ".env.theme.css", "theme.secret.json", "secrets/theme.json", "aws-credentials.json",
    "server.key", "cert.pem", "id_rsa", "id_ed25519.pub", "store.p12",
    ".git/theme.css", ".dftp/tokens/theme.json", ".cache/a.css", ".storybook/theme.css",
    "node_modules/pkg/a.css", "dist/a.css", "build/a.css", "out/a.css", "coverage/a.css", "packages/web/dist/a.css",
    "vendor/lib.css", "Node_Modules/x.css",
  ];
  for (const [i, rel] of never.entries()) await write(root, rel, rel.endsWith(".json") ? `{"colors": {"leak${i}": "${MARK}"}}` : marked(i));
  await write(root, "src/app.css", ":root { --ok: #123456; }");
  const { json } = await scanned(root);
  assert.ok(!json.toLowerCase().includes(MARK), "no secret or output file was read");
  assert.ok(json.includes("color.ok"));
  const { files } = await filesRead(root);
  assert.deepEqual(files, ["src/app.css"]);
  for (const n of [".env", ".env.production", "a.pem", "A.KEY", "id_rsa", "db-credentials.json", "my-secret.css"]) assert.equal(isSecretName(n), true, n);
  for (const n of ["button.jsx", "theme.json", "password-input.jsx"]) assert.equal(isSecretName(n), false, n);
  assert.equal(isScannablePath("src/../x.css"), false);
  assert.equal(isScannablePath("/abs.css"), false);
  assert.equal(isScannablePath("a/.hidden/x.css"), false);
}));

test(".gitignore files are honoured, nested ones below their folder", () => withRoots(async (root) => {
  await write(root, ".gitignore", "generated/\n*.min.css\n!keep.min.css\n");
  await write(root, "generated/a.css", marked(1));
  await write(root, "src/x.min.css", marked(2));
  await write(root, "src/keep.min.css", ":root { --kept: #111111; }");
  await write(root, "pkg/.gitignore", "local.css\n");
  await write(root, "pkg/local.css", marked(3));
  await write(root, "local.css", ":root { --top: #222222; }");
  const { json } = await scanned(root);
  assert.ok(!json.toLowerCase().includes(MARK));
  assert.ok(json.includes("color.kept"));
  assert.ok(json.includes("color.top"));
}));

test("size, binary and unreadable files are skipped with a code, never their contents", () => withRoots(async (root) => {
  await write(root, "big.css", `${marked()}${"/* pad */".repeat(Math.ceil(WALK_LIMITS.fileBytes / 9))}`);
  await write(root, "bin.css", `${marked(1)}\u0000\u0001\u0002`);
  await write(root, "ok.css", ":root { --ok: #123456; }");
  const { doc, json } = await scanned(root);
  assert.ok(!json.toLowerCase().includes(MARK));
  const diag = doc.diagnostics.map((d) => `${d.code}:${d.file}`);
  assert.ok(diag.includes("too-large:big.css"));
  assert.ok(diag.includes("binary:bin.css"));
}));

test("budgets: files, bytes, entries, depth and time", () => withRoots(async (root) => {
  for (let i = 0; i < 12; i++) await write(root, `f${String(i).padStart(2, "0")}.css`, `:root { --c${i}: #12345${i % 10}; }`);
  let r = await filesRead(root, { limits: { files: 5 } });
  assert.equal(r.files.length, 5);
  assert.equal(r.state.stats.truncated, true);
  assert.ok(r.state.diagnostics.some((d) => d.code === "budget-files"));
  r = await filesRead(root, { limits: { totalBytes: 100 } });
  assert.ok(r.state.diagnostics.some((d) => d.code === "budget-bytes"));
  r = await filesRead(root, { limits: { entries: 3 } });
  assert.ok(r.state.diagnostics.some((d) => d.code === "budget-entries"));
  let t = 0;
  r = await filesRead(root, { limits: { ms: 50 }, now: () => (t += 20) });
  assert.ok(r.state.diagnostics.some((d) => d.code === "budget-time"));
  assert.ok(r.files.length < 12);
  await write(root, `${Array.from({ length: 6 }, (_, i) => `d${i}`).join("/")}/deep.css`, marked());
  r = await filesRead(root, { limits: { depth: 3 } });
  assert.ok(!r.files.some((f) => f.endsWith("deep.css")));
  const controller = new AbortController();
  controller.abort();
  r = await filesRead(root, { signal: controller.signal });
  assert.deepEqual(r.files, []);
  const { doc } = await scanned(root, { limits: { files: 2 } });
  assert.equal(doc.scan.truncated, true);
}));

test("adapters that throw, hang on to promises or return junk are contained", () => withRoots(async (root) => {
  await write(root, "a.css", ":root { --ok: #123456; }");
  const bad = [
    { id: "thrower", match: () => true, extract() { throw new Error(`boom ${MARK}`); } },
    { id: "promiser", match: () => true, extract: async () => ({ tokens: [{ name: "--p", raw: MARK }] }) },
    { id: "junk", match: () => true, extract: () => ({ tokens: [{ name: "--../../x‮", raw: "#abcdef", line: "1" }, { name: 5 }], usages: "no" }) },
    { id: "bad-match", match() { throw new Error("x"); }, extract: () => ({}) },
    { id: "loose-match", match: () => "yes", extract: () => ({ tokens: [{ name: "--never", raw: MARK }] }) },
  ];
  const doc = await scanProject({ root, adapters: [...ADAPTERS, ...bad] });
  assert.ok(validateTokensDoc(doc).ok);
  const json = JSON.stringify(doc);
  assert.ok(!json.toLowerCase().includes(MARK));
  assert.ok(json.includes("color.ok"));
  const diag = doc.diagnostics.map((d) => `${d.adapter}:${d.code}`);
  assert.ok(diag.includes("thrower:adapter-error"));
  assert.ok(diag.includes("promiser:adapter-error"));
  const junk = doc.tokens.find((t) => t.sources.some((s) => s.adapter === "junk"));
  assert.ok(junk, "usable parts of junk output are kept");
  assert.ok(!JSON.stringify(junk).includes("‮"));
  assert.ok(isScannablePath(junk.sources[0].file));
}));

test("the fenced command scans the project and writes only .dftp/tokens.json", { skip: !permissionSupported() && "this Node has no permission model" }, () => withRoots(async (root, outside) => {
  await write(outside, "secret.css", marked());
  await write(root, "src/app.css", ":root { --brand: #2f5bd8; }");
  if (process.platform !== "win32") await fsp.symlink(path.join(outside, "secret.css"), path.join(root, "src/linked.css"));
  const before = (await fsp.readdir(root)).sort();
  const c = runCli(["scan", "--root", root]);
  const r = await c.exited;
  assert.equal(r.code, 0, c.err());
  assert.ok(!c.err().includes("no permission model"));
  const doc = JSON.parse(await fsp.readFile(path.join(root, ".dftp", "tokens.json"), "utf8"));
  assert.ok(doc.tokens.some((t) => t.id === "color.brand"));
  assert.ok(!JSON.stringify(doc).toLowerCase().includes(MARK));
  assert.deepEqual((await fsp.readdir(root)).sort(), [...before, ".dftp"].sort());
  assert.deepEqual(await fsp.readdir(outside), ["secret.css"]);
}));
