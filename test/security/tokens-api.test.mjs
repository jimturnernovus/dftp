// The token routes: GET /api/tokens, POST /api/tokens/scan and
// POST /api/tokens/sample. Reads need the token; writes need the exact
// Origin, the token and a JSON body; samples are validated and merged; the
// file on disk is trusted only after validation.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { startApp, request, readHeaders, writeHeaders, tempRoot, removeRoot, mtimeOf, sleep } from "../helpers.mjs";
import { validateTokensDoc } from "../../client/core/tokens.js";

const INERT = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";
const tokensFile = (root) => path.join(root, ".dftp", "tokens.json");

function sample(over = {}) {
  return {
    page: "active-clients",
    device: "desktop",
    theme: "light",
    elements: 25,
    values: [
      { prop: "color", value: "rgb(10, 20, 30)", count: 12 },
      { prop: "font-size", value: "15px", count: 8 },
      { prop: "padding", value: "6px 14px", count: 5 },
    ],
    ...over,
  };
}

const post = (t, p, body, headers = writeHeaders(t)) => request(t.shellPort, {
  method: "POST", path: p, headers, body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = (t, headers = readHeaders(t)) => request(t.shellPort, { path: "/api/tokens", headers });

test("GET /api/tokens: the scan result for readers with the token, nothing for anyone else", async () => {
  const t = await startApp();
  try {
    const r = await get(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers["content-security-policy"], INERT);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(r.headers["content-type"], /^application\/json/);
    assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("access-control-")));
    const body = JSON.parse(r.text);
    assert.equal(body.scanning, false);
    const v = validateTokensDoc(body.doc);
    assert.ok(v.ok, v.error);
    assert.ok(body.doc.tokens.length > 0);
    assert.ok(body.doc.tokens.every((tok) => tok.sources.every((s) => !s.file || s.file.startsWith("demo/"))), "the demo scans demo/ only");
    assert.ok(!r.text.includes(t.root), "no absolute paths");
    assert.deepEqual(JSON.parse(await fsp.readFile(tokensFile(t.root), "utf8")), body.doc, "the same document is on disk");

    const refused = [
      ["no token", { "sec-fetch-site": "same-origin" }],
      ["wrong token", readHeaders(t, { "x-dftp-token": "0".repeat(64) })],
      ["cross-site", readHeaders(t, { "sec-fetch-site": "cross-site" })],
      ["foreign Origin", readHeaders(t, { origin: "http://evil.example" })],
      ["frame Origin", readHeaders(t, { origin: t.frameOrigin })],
    ];
    for (const [name, headers] of refused) assert.equal((await get(t, headers)).status, 403, name);
    assert.equal((await request(t.shellPort, { path: "/api/tokens", headers: readHeaders(t), host: "evil.example" })).status, 403, "Host");
    assert.equal((await request(t.framePort, { path: "/api/tokens", headers: readHeaders(t) })).status, 404, "the frame listener has no API");
    const wrongMethod = await request(t.shellPort, { method: "DELETE", path: "/api/tokens", headers: readHeaders(t) });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, "GET");
  } finally {
    await t.close();
  }
});

test("POST /api/tokens/scan: the write gate holds, and a rescan sees new files", async () => {
  const t = await startApp();
  try {
    await t.app.tokens.get();
    const file = tokensFile(t.root);
    const m0 = await mtimeOf(file);
    await sleep(20);
    const cases = [
      ["no Origin", writeHeaders(t, { origin: undefined }), 403],
      ["frame Origin", writeHeaders(t, { origin: t.frameOrigin }), 403],
      ["no token", writeHeaders(t, { "x-dftp-token": undefined }), 403],
      ["text/plain", writeHeaders(t, { "content-type": "text/plain" }), 415],
      ["cross-site", writeHeaders(t, { "sec-fetch-site": "cross-site" }), 403],
    ];
    for (const [name, headers, want] of cases) {
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      assert.equal((await post(t, "/api/tokens/scan", {}, headers)).status, want, name);
    }
    assert.equal((await post(t, "/api/tokens/scan", [])).status, 400);
    assert.equal((await post(t, "/api/tokens/scan", "{bad")).status, 400);
    assert.equal((await request(t.shellPort, { path: "/api/tokens/scan", headers: readHeaders(t) })).status, 405);
    assert.equal(await mtimeOf(file), m0, "refused requests write nothing");

    await fsp.writeFile(path.join(t.root, "demo", "extra.css"), ":root { --rescan-mark: #0f0e0d; }");
    await fsp.writeFile(path.join(t.root, "outside-demo.css"), ":root { --not-in-demo: #0d0e0f; }");
    const r = await post(t, "/api/tokens/scan", {});
    assert.equal(r.status, 200, r.text);
    const doc = JSON.parse(r.text).doc;
    assert.ok(doc.tokens.some((tok) => tok.id === "color.rescan.mark"));
    assert.ok(!doc.tokens.some((tok) => tok.id === "color.not.in.demo"));
    assert.ok((await mtimeOf(file)) > m0);
  } finally {
    await t.close();
  }
});

test("POST /api/tokens/sample: validated, merged, stored, and kept across restarts", async () => {
  const root = await tempRoot();
  const t = await startApp({ root });
  try {
    await t.app.tokens.get();
    const r = await post(t, "/api/tokens/sample", sample());
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.ok, true);
    const live = body.doc.tokens.find((tok) => tok.id === "color.auto.0a141e");
    assert.ok(live, "a frequent value the scan did not have becomes a token");
    assert.deepEqual(live.usage, { count: 0, seenLive: true, live: 12 });
    assert.deepEqual(live.sources, [{ adapter: "live", page: "active-clients", device: "desktop" }]);
    assert.equal(body.doc.live.length, 1);
    const onDisk = JSON.parse(await fsp.readFile(tokensFile(root), "utf8"));
    assert.deepEqual(onDisk, body.doc);

    const no = async (over, want = 400) => {
      const res = await post(t, "/api/tokens/sample", typeof over === "string" ? over : sample(over));
      assert.equal(res.status, want, JSON.stringify(over).slice(0, 80));
      return res;
    };
    await no({ page: "elsewhere" });
    await no({ device: "watch" });
    await no({ page: "../x" });
    await no({ elements: 99999 });
    const echo = await no({ values: [{ prop: "color", value: "red<script>", count: 1 }] });
    assert.ok(!echo.text.includes("script"), "the reply never repeats the value");
    await no({ values: [{ prop: "content", value: "x", count: 1 }] });
    await no("[]");
    await no("{\"__proto__\": {}}");
    const huge = JSON.stringify({ ...sample(), pad: "x".repeat(1024 * 1024 + 10) });
    assert.equal((await post(t, "/api/tokens/sample", huge)).status, 413);
    const noToken = writeHeaders(t);
    delete noToken["x-dftp-token"];
    assert.equal((await post(t, "/api/tokens/sample", sample(), noToken)).status, 403);
    assert.equal((await post(t, "/api/tokens/sample", sample(), writeHeaders(t, { origin: t.frameOrigin }))).status, 403, "the page cannot post samples itself");
  } finally {
    await t.close();
  }
  const again = await startApp({ root });
  try {
    const { doc } = await again.app.tokens.get();
    assert.equal(doc.live.length, 1, "samples are merged again after a restart");
    assert.ok(doc.tokens.some((tok) => tok.id === "color.auto.0a141e" && tok.usage.seenLive));
  } finally {
    await again.close();
    await removeRoot(root);
  }
});

test("a tampered tokens file is not trusted: its samples are dropped and it is rewritten", async () => {
  const root = await tempRoot();
  try {
    const t0 = await startApp({ root });
    await t0.app.tokens.get();
    await t0.close();
    const doc = JSON.parse(await fsp.readFile(tokensFile(root), "utf8"));
    doc.live = [{ ...sample(), sampled_at: "2026-01-01T00:00:00Z", values: [{ prop: "color", value: "<img src=x>", count: 9 }] }];
    await fsp.writeFile(tokensFile(root), JSON.stringify(doc));
    const t = await startApp({ root });
    try {
      const r = await get(t);
      const body = JSON.parse(r.text);
      assert.equal(body.doc.live, undefined);
      assert.ok(!r.text.includes("<img"));
      assert.ok(validateTokensDoc(JSON.parse(await fsp.readFile(tokensFile(root), "utf8"))).ok);
    } finally {
      await t.close();
    }
  } finally {
    await removeRoot(root);
  }
});

test("a linked tokens file makes startup refuse, and nothing is written through it", { skip: process.platform === "win32" && "symbolic links need extra rights on Windows" }, async () => {
  const outside = await tempRoot({ demo: false });
  const root = await tempRoot();
  const target = path.join(outside, "target.json");
  await fsp.writeFile(target, "keep");
  try {
    await fsp.mkdir(path.join(root, ".dftp"));
    await fsp.symlink(target, tokensFile(root));
    await assert.rejects(startApp({ root }), (e) => e.code === "unsafe" && /tokens\.json is not a regular file/.test(e.message));
    assert.equal(await fsp.readFile(target, "utf8"), "keep");
  } finally {
    await removeRoot(outside);
    await removeRoot(root);
  }
});
