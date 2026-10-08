// No response from either listener ever carries an Access-Control-* header,
// and preflights are refused.

import test from "node:test";
import assert from "node:assert/strict";
import { startApp, request, readHeaders, writeHeaders, randomPort } from "../helpers.mjs";

const PREFLIGHT = {
  origin: "http://evil.example",
  "access-control-request-method": "POST",
  "access-control-request-headers": "content-type, x-dftp-token",
  "access-control-request-private-network": "true",
};

function noCors(r, label) {
  for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith("access-control-"), `${label}: ${k}`);
}

async function sweep(t) {
  const paths = ["/", "/api/session", "/api/changes", "/api/code", "/api/changes-md", "/shell.js", "/__dftp/overlay.js", "/__dftp/core/schema.js", "/demo.css", "/nope"];
  for (const port of [t.shellPort, t.framePort]) {
    for (const p of paths) {
      const pre = await request(port, { method: "OPTIONS", path: p, headers: PREFLIGHT });
      noCors(pre, `OPTIONS ${port}${p}`);
      assert.ok(pre.status === 405 || pre.status === 501, `OPTIONS ${port}${p} -> ${pre.status}`);
      for (const headers of [{ origin: "http://evil.example" }, { origin: t.frameOrigin }, readHeaders(t, { origin: t.shellOrigin })]) {
        noCors(await request(port, { path: p, headers }), `GET ${port}${p}`);
      }
      noCors(await request(port, { method: "POST", path: p, headers: writeHeaders(t, { origin: "http://evil.example" }), body: "{}" }), `POST ${port}${p}`);
      noCors(await request(port, { method: "POST", path: p, headers: writeHeaders(t), body: '{"files":[]}' }), `POST ok ${port}${p}`);
    }
  }
}

test("no Access-Control headers in demo mode", async () => {
  const t = await startApp();
  try {
    await sweep(t);
  } finally {
    await t.close();
  }
});

test("no Access-Control headers in proxy mode", async () => {
  const t = await startApp({ flags: { demo: false, target: `http://127.0.0.1:${randomPort() + 1}` } });
  try {
    await sweep(t);
  } finally {
    await t.close();
  }
});
