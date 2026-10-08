// Response header snapshots, one per route class. A change to any security
// header has to be made here on purpose.

import test from "node:test";
import assert from "node:assert/strict";
import { startApp, request, readHeaders, writeHeaders, pageHeaders, randomPort } from "../helpers.mjs";

const IGNORE = new Set(["date", "connection", "keep-alive", "content-length", "transfer-encoding"]);
const pick = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !IGNORE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));

const BASE = {
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const INERT = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";
const sorted = (o) => pick(o);

test("header snapshots per route class", async () => {
  const t = await startApp();
  const S = t.shellPort;
  const F = t.framePort;
  const frameErr = `default-src 'none'; frame-ancestors ${t.shellOrigin}; base-uri 'none'; form-action 'none'; sandbox`;
  try {
    const cases = [
      ["shell document", S, { path: "/", headers: pageHeaders(t) }, 200, {
        ...BASE, "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src ${t.frameOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`,
      }],
      ["shell script", S, { path: "/shell.js" }, 200, { ...BASE, "content-type": "text/javascript; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell core module", S, { path: "/core/schema.js" }, 200, { ...BASE, "content-type": "text/javascript; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell style", S, { path: "/shell.css" }, 200, { ...BASE, "content-type": "text/css; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["api json", S, { path: "/api/session", headers: readHeaders(t) }, 200, { ...BASE, "content-type": "application/json; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["api text", S, { path: "/api/changes-md", headers: readHeaders(t) }, 200, { ...BASE, "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["api write", S, { method: "POST", path: "/api/code", headers: writeHeaders(t), body: '{"files":[]}' }, 200, { ...BASE, "content-type": "application/json; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["api refused", S, { path: "/api/session" }, 403, { ...BASE, "content-type": "application/json; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["api method", S, { method: "DELETE", path: "/api/changes", headers: readHeaders(t) }, 405, { ...BASE, allow: "GET, POST", "content-type": "application/json; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell document without the session", S, { path: "/" }, 403, { ...BASE, "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell start-up link", S, { path: t.link.slice(t.shellOrigin.length) }, 303, {
        ...BASE, "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT,
        location: "/", "set-cookie": [`${t.cookie}; Path=/; HttpOnly; SameSite=Strict`],
      }],
      ["shell not found", S, { path: "/nope" }, 404, { ...BASE, "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell options", S, { method: "OPTIONS", path: "/api/changes" }, 405, { ...BASE, allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["shell bad host", S, { path: "/", host: "evil.example" }, 403, { ...BASE, "content-type": "text/plain; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": INERT }],
      ["layer boot module", F, { path: "/__dftp/overlay.js" }, 200, { ...BASE, "content-type": "text/javascript; charset=utf-8", "content-security-policy": INERT }],
      ["layer file", F, { path: "/__dftp/core/protocol.js" }, 200, { ...BASE, "content-type": "text/javascript; charset=utf-8", "content-security-policy": INERT }],
      ["layer css", F, { path: "/__dftp/layer.css" }, 200, { ...BASE, "content-type": "text/css; charset=utf-8", "content-security-policy": INERT }],
      ["layer not found", F, { path: "/__dftp/nope.js" }, 404, { ...BASE, "content-type": "text/plain; charset=utf-8", "content-security-policy": frameErr }],
      ["demo document", F, { path: "/" }, 200, {
        ...BASE, "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${t.shellOrigin}`,
      }],
      ["frame not found", F, { path: "/missing" }, 404, { ...BASE, "content-type": "text/plain; charset=utf-8", "content-security-policy": frameErr }],
      ["frame method", F, { method: "PUT", path: "/" }, 405, { ...BASE, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "content-security-policy": frameErr }],
      ["frame service worker", F, { path: "/sw.js", headers: { "service-worker": "script" } }, 404, { ...BASE, "content-type": "text/plain; charset=utf-8", "content-security-policy": frameErr }],
    ];
    for (const [name, port, req, status, want] of cases) {
      const r = await request(port, req);
      assert.equal(r.status, status, name);
      assert.deepEqual(pick(r.headers), sorted(want), name);
      assert.ok(!("x-powered-by" in r.headers), name);
    }
  } finally {
    await t.close();
  }
});

test("the demo document is never framed-blocked by X-Frame-Options", async () => {
  const t = await startApp();
  try {
    const r = await request(t.framePort, { path: "/" });
    assert.equal(r.headers["x-frame-options"], undefined);
  } finally {
    await t.close();
  }
});

test("proxy mode with the dev server down answers 502 with frame error headers", async () => {
  const t = await startApp({ flags: { demo: false, target: `http://127.0.0.1:${randomPort() + 1}` } });
  try {
    const r = await request(t.framePort, { path: "/anything" });
    assert.equal(r.status, 502);
    assert.equal(r.text, "upstream error\n");
    assert.equal(r.headers["content-security-policy"], `default-src 'none'; frame-ancestors ${t.shellOrigin}; base-uri 'none'; form-action 'none'; sandbox`);
    const layer = await request(t.framePort, { path: "/__dftp/overlay.js" });
    assert.equal(layer.status, 200, "the layer is still served in proxy mode");
    const sw = await request(t.framePort, { path: "/sw.js", headers: { "service-worker": "script" } });
    assert.equal(sw.status, 404);
  } finally {
    await t.close();
  }
});

test("HEAD works where GET does and sends no body", async () => {
  const t = await startApp();
  try {
    const r = await request(t.shellPort, { method: "HEAD", path: "/shell.js" });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
    assert.ok(Number(r.headers["content-length"]) > 0);
  } finally {
    await t.close();
  }
});

test("the designer page carries a fresh token and no placeholder", async () => {
  const t = await startApp();
  try {
    const r = await request(t.shellPort, { path: "/", headers: pageHeaders(t) });
    assert.ok(r.text.includes(`<meta name="dftp-token" content="${t.token}">`));
    assert.ok(!r.text.includes("%TOKEN%"));
    assert.match(t.token, /^[0-9a-f]{64}$/);
    const other = await startApp();
    try {
      assert.notEqual(other.token, t.token, "one token per launch");
    } finally {
      await other.close();
    }
  } finally {
    await t.close();
  }
});
