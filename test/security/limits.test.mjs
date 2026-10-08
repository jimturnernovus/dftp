// Size limits, prototype pollution, change-schema refusals and server limits
// over real HTTP.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import { startApp, request, writeHeaders, readHeaders, save, saveBody, sampleChange, docPath } from "../helpers.mjs";
import { BODY_LIMIT } from "../../server/guard.mjs";
import { LIMITS } from "../../server/main.mjs";

test("bodies over 1 MiB get 413 (declared or streamed)", async () => {
  const t = await startApp();
  try {
    const big = Buffer.alloc(BODY_LIMIT + 1, 0x20);
    const declared = await request(t.shellPort, { method: "POST", path: "/api/changes", headers: writeHeaders(t), body: big }).catch((e) => ({ status: e.code }));
    assert.equal(declared.status, 413);
    const streamed = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port: t.shellPort, method: "POST", path: "/api/changes", agent: false, setHost: false,
        headers: { ...writeHeaders(t), host: `127.0.0.1:${t.shellPort}`, "transfer-encoding": "chunked" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on("error", (e) => resolve({ status: e.code }));
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent <= BODY_LIMIT + chunk.length) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    assert.equal(streamed.status, 413);
    const ok = await request(t.shellPort, { method: "POST", path: "/api/code", headers: writeHeaders(t), body: JSON.stringify({ files: [], pad: "x".repeat(BODY_LIMIT - 40) }) });
    assert.equal(ok.status, 200, "just under the limit is accepted");
    assert.equal((await request(t.shellPort, { path: "/api/session", headers: readHeaders(t) })).status, 200, "server still answers");
  } finally {
    await t.close();
  }
});

test("prototype-polluting payloads get 400 and pollute nothing", async () => {
  const t = await startApp();
  try {
    const bodies = [
      '[{"__proto__":{"polluted":1},"key":"a"}]',
      '{"constructor":{"prototype":{"polluted":1}}}',
      JSON.stringify(saveBody()).replace('"list":[', '"list":[{"__proto__":{"polluted":1}},'),
      '{"files":{"__proto__":["a.js"]}}',
    ];
    for (const body of bodies) {
      for (const p of ["/api/changes", "/api/code"]) {
        const r = await request(t.shellPort, { method: "POST", path: p, headers: writeHeaders(t), body });
        assert.equal(r.status, 400, `${p} ${body.slice(0, 40)}`);
      }
    }
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    await t.close();
  }
});

test("schema refusals over HTTP", async () => {
  const t = await startApp();
  try {
    const many = Array.from({ length: 2001 }, (_, i) => sampleChange({ id: `a${String(i).padStart(7, "0")}`, key: `k${i}` }));
    assert.equal((await save(t, { list: many })).status, 400);
    assert.equal((await save(t, { list: [sampleChange({ loc: "../../.ssh/id_rsa:1:1" })] })).status, 400);
    assert.equal((await save(t, { list: [sampleChange({ text: "x".repeat(501) })] })).status, 400);
    assert.equal((await save(t, { list: [sampleChange({ dx: 1e9 })] })).status, 400);
    assert.equal((await save(t, { page: "../../x" })).status, 400);
    assert.equal((await save(t, { device: "watch" })).status, 400);
    const bad = await request(t.shellPort, { method: "POST", path: "/api/changes", headers: writeHeaders(t), body: "{not json" });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes("not json"), "the error never echoes the body");
    assert.equal(await fsp.stat(docPath(t.root)).catch(() => null), null);
  } finally {
    await t.close();
  }
});

test("control and bidi characters are stripped before saving", async () => {
  const t = await startApp();
  try {
    const r = await save(t, { list: [sampleChange({ text: "Pay‮txt.exe\u0000", text_to: "a⁦b\nc" })] });
    assert.equal(r.status, 200, r.text);
    const g = await request(t.shellPort, { path: "/api/changes?page=active-clients&device=desktop", headers: readHeaders(t) });
    const { doc } = JSON.parse(g.text);
    assert.equal(doc.list[0].text, "Paytxt.exe");
    assert.equal(doc.list[0].text_to, "ab\nc");
  } finally {
    await t.close();
  }
});

test("listener limits are set", async () => {
  const t = await startApp();
  try {
    for (const s of [t.app.servers.shell, t.app.servers.frame]) {
      assert.equal(s.headersTimeout, LIMITS.headersTimeout);
      assert.equal(s.requestTimeout, LIMITS.requestTimeout);
      assert.equal(s.maxConnections, LIMITS.maxConnections);
    }
    assert.equal(LIMITS.headersTimeout, 10000);
    assert.equal(LIMITS.requestTimeout, 30000);
    assert.equal(LIMITS.maxConnections, 64);
  } finally {
    await t.close();
  }
});
