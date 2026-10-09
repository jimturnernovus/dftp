// Project content that tries to make the scan slow, invalid or stuck: long
// runs of white space or "&" in style attributes, long values with many
// themes, references nested inside fallbacks, values out of every range, and
// special files where a .gitignore is expected. The scan must stay fast,
// keep a valid document and always finish; the designer must keep serving.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scanProject } from "../../server/scan/scanner.mjs";
import { parseDeclList, parseCss } from "../../server/scan/css-parse.mjs";
import { normalizeValue } from "../../client/core/css-values.js";
import { usageValues } from "../../server/scan/usage.mjs";
import { helpers } from "../../server/scan/helpers.mjs";
import html from "../../server/scan/adapters/html.mjs";
import { validateTokensDoc } from "../../client/core/tokens.js";
import { createTokens, CLOSE_WAIT_MS } from "../../server/tokens.mjs";
import { buildDoc } from "../../server/scan/build.mjs";
import { openStore } from "../../server/store.mjs";
import { BUILT_IN_DEVICES } from "../../client/core/devices.js";
import { tempRoot, removeRoot, runCli, startApp, request, readHeaders, writeHeaders, randomPort } from "../helpers.mjs";

const MB = 1024 * 1024;
const THEMES = [".dark", ".theme-a", ".theme-b", ".theme-c", ".theme-d", ".theme-e", ".theme-f"].map((s) => `${s}{--z:1px}`).join("\n");

async function within(ms, fn) {
  const t0 = Date.now();
  const out = await fn();
  const took = Date.now() - t0;
  assert.ok(took < ms, `took ${took} ms (limit ${ms})`);
  return out;
}

async function project(files) {
  const root = await tempRoot({ demo: false });
  for (const [rel, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), text);
  }
  return root;
}

test("style attributes: a megabyte of spaces or of \"&\" is read in linear time", async () => {
  await within(1500, () => parseDeclList(`color: red${" ".repeat(MB)}x`));
  await within(1500, () => parseDeclList("&".repeat(MB)));
  await within(1500, () => parseDeclList(`a:b;${"&amp".repeat(MB / 4)}`));
  const out = await within(1500, () => html.extract({ path: "i.html", text: `<p style="color: red${" ".repeat(MB)}x">hi</p>`, helpers }));
  assert.deepEqual(out.usages, [], "a declaration longer than any value is dropped");
  // Values just inside the limit keep !important handling.
  assert.deepEqual(parseDeclList("color: red !important").map((d) => d.value), ["red"]);
  assert.deepEqual(parseDeclList(`color: red${" ".repeat(1500)}!important`).map((d) => d.value), ["red"]);
});

test("values: trailing white space before !important never costs quadratic time", async () => {
  const long = `#fff${" ".repeat(1990)}x`;
  await within(1500, () => {
    for (let i = 0; i < 4500; i++) normalizeValue("color", long);
  });
  await within(1500, () => {
    for (let i = 0; i < 4500; i++) usageValues("color", long);
  });
  assert.deepEqual(normalizeValue("color", "#ffffff   !important  "), { hex: "#ffffff", alpha: 1 });
  assert.equal(usageValues("color", "red !IMPORTANT")[0].value.hex, "#ff0000");
  const p = await within(1500, () => parseCss(`a { color: red${" ".repeat(MB)}x !important; }`));
  assert.equal(p.decls[0].tooLong, true);
});

test("a megabyte of long theme values with eight modes scans in well under the time budget", async () => {
  let css = "@theme{";
  for (let i = 0; css.length < MB; i++) css += `--color-t${i}:#fff${" ".repeat(1990)}x;`;
  css += `}\n${THEMES}`;
  const root = await project({ "a.css": css, "index.html": `<p style="color: red${" ".repeat(200 * 1024)}x">hi</p>` });
  try {
    const doc = await within(5000, () => scanProject({ root }));
    assert.ok(validateTokensDoc(doc).ok);
    assert.equal(doc.scan.truncated, false);
  } finally {
    await removeRoot(root);
  }
});

test("references nested in fallbacks: a megabyte file with eight modes stays inside the build's work budget", async () => {
  let css = ":root{\n";
  for (let i = 0; i < 560; i++) css += `--t${i}:${"var(--m,".repeat(200)}1px${")".repeat(200)};\n`;
  css += `}\n${THEMES}`;
  assert.ok(css.length > MB - 50000);
  const root = await project({ "app.css": css });
  try {
    const t0 = Date.now();
    const doc = await within(5000, () => scanProject({ root }));
    const took = Date.now() - t0;
    assert.ok(validateTokensDoc(doc).ok);
    assert.equal(doc.scan.truncated, true, "running out of work is reported");
    assert.ok(doc.diagnostics.some((d) => d.adapter === "scan" && d.code === "budget-build"));
    assert.ok(doc.scan.ms >= took - 50, `scan.ms (${doc.scan.ms}) counts the build too (${took} ms in all)`);
  } finally {
    await removeRoot(root);
  }
  // A short chain of fallbacks still resolves.
  const ok = buildDoc({ results: [{ file: "a.css", adapter: { id: "css-vars", rank: 20 }, out: { tokens: [{ name: "--x", raw: "var(--a, var(--b, var(--c, 4px)))", line: 1 }], usages: [], components: [], diagnostics: [] } }] });
  assert.equal(ok.tokens.find((t) => t.id === "size.x").value.px, 4);
});

const OUT_OF_RANGE = [
  "p{font-size:2000in}",
  "@theme{--breakpoint-huge: 2000in}",
  ":root{--space-x: 1000000in}",
  "p{font-size:100001px}",
  ":root{--ease-x: cubic-bezier(0, 1e9, 1, -1e9)}",
  ".a{padding: 1000000in}",
  ".b{border: 1000000in solid #000}",
  ".c{background-image: linear-gradient(#f00 0%, #00f 1e9%)}",
  ":root{--r: calc(1000000in + 1px)}",
  "@media (min-width: 1000000in){.d{color:red}}",
  ":root{--lh: 1e6; --fs: 999999rem; --bw: 1000000px}",
];

test("values out of range never make the document invalid, from files or from the page", async () => {
  for (const line of OUT_OF_RANGE) {
    const root = await project({ "app.css": `:root{--color-primary:#2563eb}\n${line}` });
    try {
      const doc = await scanProject({ root });
      const r = validateTokensDoc(doc);
      assert.ok(r.ok, `${line}: ${r.error}`);
      assert.ok(doc.tokens.some((t) => t.id === "color.primary"), `${line}: the rest of the project is still read`);
    } finally {
      await removeRoot(root);
    }
  }
  // A live sample with a size beyond the scale's limit.
  const root = await project({ "app.css": ":root{--color-primary:#2563eb}" });
  try {
    const live = [{ page: "home", device: "desktop", theme: "light", elements: 9, sampled_at: "2026-01-01T00:00:00Z", values: [{ prop: "font-size", value: "100001px", count: 5 }, { prop: "padding", value: "9999999px", count: 5 }] }];
    const doc = await scanProject({ root, live });
    assert.ok(validateTokensDoc(doc).ok);
  } finally {
    await removeRoot(root);
  }
});

test("dftp scan writes tokens.json for a project with out-of-range values (no store error)", async () => {
  const root = await project({ "app.css": `:root{--color-primary:#2563eb}\n${OUT_OF_RANGE.join("\n")}` });
  try {
    const c = runCli(["scan", "--root", root]);
    const r = await c.exited;
    assert.equal(r.code, 0, c.err());
    assert.doesNotMatch(c.err(), /store error/);
    const doc = JSON.parse(await fsp.readFile(path.join(root, ".dftp", "tokens.json"), "utf8"));
    assert.ok(validateTokensDoc(doc).ok);
  } finally {
    await removeRoot(root);
  }
});

test("the designer serves only validated documents, and a sample that cannot be stored is not kept", async () => {
  const root = await tempRoot({ demo: false });
  try {
    const store = await openStore({ root, pages: [{ id: "home", label: "Home", path: "/", keep: [] }], devices: BUILT_IN_DEVICES, noFingerprint: true });
    const good = buildDoc({ results: [] });
    let fail = false;
    const real = store.writeTokens;
    const flaky = { ...store, readTokens: store.readTokens, writeTokens: (d) => (fail ? Promise.reject(new Error("refused")) : real(d)) };
    const tokens = createTokens({ cfg: { root, mode: "proxy", libraryPrefixes: [] }, store: flaky, scan: async () => good });
    await tokens.rescan();
    const before = (await tokens.get()).doc;
    assert.ok(validateTokensDoc(before).ok);
    fail = true;
    const sample = { page: "home", device: "desktop", theme: "light", elements: 3, values: [{ prop: "color", value: "rgb(1, 2, 3)", count: 3 }] };
    await assert.rejects(tokens.addSample(sample));
    assert.equal((await tokens.get()).doc, before, "the last good document is still the one served");
    await assert.rejects(tokens.rescan());
    assert.equal((await tokens.get()).doc, before);
    fail = false;
    const after = await tokens.rescan();
    assert.equal(after.live, undefined, "the sample that failed was not kept");
    await tokens.close();
  } finally {
    await removeRoot(root);
  }
});

const fifoOk = process.platform !== "win32" && (() => {
  try {
    execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
  } catch (e) {
    return e.code !== "ENOENT";
  }
  return true;
})();

// Opening the fifo for writing releases a reader stuck in open(), so a
// failing run cannot leave the test process hanging.
function release(fifo) {
  try {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
  } catch {
    // no reader is waiting
  }
}

test("a FIFO named .gitignore is skipped, so the scan always finishes", { skip: !fifoOk && "mkfifo is not available here", timeout: 20000 }, async () => {
  const root = await project({ "sub/a.css": ":root{--fine:#123456}" });
  const fifo = path.join(root, "sub", ".gitignore");
  execFileSync("mkfifo", [fifo]);
  const timer = setTimeout(() => release(fifo), 8000);
  try {
    const doc = await within(5000, () => scanProject({ root }));
    assert.ok(doc.tokens.some((t) => t.id === "color.fine"));
  } finally {
    clearTimeout(timer);
    release(fifo);
    await removeRoot(root);
  }
});

test("stopping the designer never waits on a scan that does not end", { timeout: 10000 }, async () => {
  const root = await tempRoot({ demo: false });
  try {
    const store = await openStore({ root, pages: [{ id: "home", label: "Home", path: "/", keep: [] }], devices: BUILT_IN_DEVICES, noFingerprint: true });
    const tokens = createTokens({ cfg: { root, mode: "proxy", libraryPrefixes: [] }, store, scan: () => new Promise(() => {}) });
    tokens.start();
    await within(CLOSE_WAIT_MS + 1500, () => tokens.close());
  } finally {
    await removeRoot(root);
  }
});

test("the designer answers while the start-up scan reads a hostile project", { timeout: 30000 }, async () => {
  const root = await project({ "index.html": `<p style="color: red${" ".repeat(200 * 1024)}x">hi</p>` });
  let app;
  try {
    app = await startApp({ root, keepRoot: true, flags: { demo: false, blank: [null], port: randomPort() } });
    const r = await within(3000, () => request(app.shellPort, { path: "/api/tokens", headers: readHeaders(app) }));
    assert.equal(r.status, 200);
    const scan = await within(3000, () => request(app.shellPort, { method: "POST", path: "/api/tokens/scan", headers: writeHeaders(app), body: "{}" }));
    assert.equal(scan.status, 200);
  } finally {
    if (app) await app.close();
    await removeRoot(root);
  }
});

test("a page that shows a huge font size does not break Rescan for the session", { timeout: 30000 }, async () => {
  const app = await startApp();
  try {
    const body = { page: "active-clients", device: "desktop", theme: "light", elements: 9, values: [{ prop: "font-size", value: "100001px", count: 5 }, { prop: "padding", value: "9999999px", count: 5 }] };
    const s = await request(app.shellPort, { method: "POST", path: "/api/tokens/sample", headers: writeHeaders(app), body: JSON.stringify(body) });
    assert.equal(s.status, 200, s.text);
    const scan = await request(app.shellPort, { method: "POST", path: "/api/tokens/scan", headers: writeHeaders(app), body: "{}" });
    assert.equal(scan.status, 200, scan.text);
    const r = await request(app.shellPort, { path: "/api/tokens", headers: readHeaders(app) });
    assert.equal(r.status, 200);
    const doc = JSON.parse(r.text).doc;
    assert.ok(validateTokensDoc(doc).ok, "the served document validates");
  } finally {
    await app.close();
  }
});
