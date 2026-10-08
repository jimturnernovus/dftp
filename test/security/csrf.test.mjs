// Cross-site write attempts over real HTTP. Every refused request must leave
// the saved file untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import {
  startApp, request, rawRequest, statusOf, writeHeaders, readHeaders, pageHeaders, save, saveBody, docPath, mtimeOf, sleep,
} from "../helpers.mjs";

test("no-net preload is active", () => {
  assert.equal(globalThis.__dftpNoNet, true);
});

test("write gate matrix over HTTP; refused writes change nothing", async () => {
  const t = await startApp();
  try {
    const first = await save(t);
    assert.equal(first.status, 200, first.text);
    const file = docPath(t.root);
    const before = await fsp.readFile(file, "utf8");
    const m0 = await mtimeOf(file);
    await sleep(20);
    const body = JSON.stringify(saveBody({ seq: 2, list: [] }));
    const post = (headers) => request(t.shellPort, { method: "POST", path: "/api/changes", headers, body });
    const cases = [
      ["Origin evil", writeHeaders(t, { origin: "http://evil.example" }), 403],
      ["no Origin", writeHeaders(t, { origin: undefined }), 403],
      ["Origin null", writeHeaders(t, { origin: "null" }), 403],
      ["Origin is the frame", writeHeaders(t, { origin: t.frameOrigin }), 403],
      ["Origin other port", writeHeaders(t, { origin: `http://127.0.0.1:${t.shellPort + 2}` }), 403],
      ["Origin localhost", writeHeaders(t, { origin: `http://localhost:${t.shellPort}` }), 403],
      ["text/plain", writeHeaders(t, { "content-type": "text/plain" }), 415],
      ["form encoded", writeHeaders(t, { "content-type": "application/x-www-form-urlencoded" }), 415],
      ["wrong token", writeHeaders(t, { "x-dftp-token": "0".repeat(64) }), 403],
      ["missing token", writeHeaders(t, { "x-dftp-token": undefined }), 403],
      ["token in query only", writeHeaders(t, { "x-dftp-token": undefined }), 403],
      ["Sec-Fetch-Site cross-site", writeHeaders(t, { "sec-fetch-site": "cross-site" }), 403],
      ["Sec-Fetch-Site same-site", writeHeaders(t, { "sec-fetch-site": "same-site" }), 403],
    ];
    for (const [name, headers, want] of cases) {
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      const r = name === "token in query only"
        ? await request(t.shellPort, { method: "POST", path: `/api/changes?token=${t.token}`, headers, body })
        : await post(headers);
      assert.equal(r.status, want, name);
      assert.ok(!r.text.includes(t.token), `${name}: reply never holds the token`);
    }
    assert.equal(await mtimeOf(file), m0, "mtime unchanged");
    assert.equal(await fsp.readFile(file, "utf8"), before);
    const okNow = await post(writeHeaders(t));
    assert.equal(okNow.status, 200, "all correct gives 200");
  } finally {
    await t.close();
  }
});

test("Host must be exact on both listeners", async () => {
  const t = await startApp();
  try {
    for (const port of [t.shellPort, t.framePort]) {
      for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 7}`, "127.0.0.1", `[::1]:${port}`]) {
        const r = await request(port, { path: "/", host });
        assert.equal(r.status, 403, `${port} ${host}`);
      }
      const none = await request(port, { path: "/", host: null, headers: {} });
      assert.equal(none.status, 403, `${port} missing Host`);
    }
    const local = await request(t.shellPort, { path: "/", host: `localhost:${t.shellPort}` });
    assert.equal(local.status, 308);
    assert.equal(local.headers.location, `${t.shellOrigin}/`);
    const localLink = await request(t.shellPort, { path: t.link.slice(t.shellOrigin.length), host: `localhost:${t.shellPort}` });
    assert.equal(localLink.status, 308);
    assert.equal(localLink.headers.location, t.link, "the start-up link keeps its key on the way to 127.0.0.1");
    const localApi = await request(t.shellPort, { path: "/api/session", host: `localhost:${t.shellPort}`, headers: readHeaders(t) });
    assert.equal(localApi.status, 403);
    const rebinding = await request(t.shellPort, { path: "/api/session", host: `attacker.example:${t.shellPort}`, headers: readHeaders(t) });
    assert.equal(rebinding.status, 403);
  } finally {
    await t.close();
  }
});

test("absolute-form and asterisk request targets give 400", async () => {
  const t = await startApp();
  try {
    for (const port of [t.shellPort, t.framePort]) {
      const abs = await rawRequest(port, `GET http://evil.example/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      assert.equal(statusOf(abs), 400, `absolute-form on ${port}`);
      const star = await rawRequest(port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      assert.equal(statusOf(star), 400, `asterisk on ${port}`);
    }
  } finally {
    await t.close();
  }
});

test("API reads need the token and a same-origin fetch", async () => {
  const t = await startApp();
  try {
    const get = (headers, p = "/api/session") => request(t.shellPort, { path: p, headers });
    assert.equal((await get(readHeaders(t))).status, 200);
    assert.equal((await get({})).status, 403);
    assert.equal((await get({ "x-dftp-token": "f".repeat(64) })).status, 403);
    assert.equal((await get(readHeaders(t, { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await get(readHeaders(t, { "sec-fetch-site": "same-site" }))).status, 403);
    assert.equal((await get(readHeaders(t, { "sec-fetch-site": "none" }))).status, 403);
    assert.equal((await get(readHeaders(t, { origin: "http://evil.example" }))).status, 403);
    assert.equal((await get({}, "/api/changes?page=active-clients&device=desktop")).status, 403);
    assert.equal((await get({}, "/api/changes-md")).status, 403);
    assert.equal((await get(readHeaders(t), "/api/changes-md")).status, 200);
  } finally {
    await t.close();
  }
});

test("the designer page refuses navigations started by other sites", async () => {
  const t = await startApp();
  try {
    assert.equal((await request(t.shellPort, { path: "/", headers: pageHeaders(t, { "sec-fetch-site": "none" }) })).status, 200);
    assert.equal((await request(t.shellPort, { path: "/", headers: pageHeaders(t, { "sec-fetch-site": "cross-site" }) })).status, 403);
    assert.equal((await request(t.shellPort, { path: "/", headers: pageHeaders(t, { "sec-fetch-site": "same-site" }) })).status, 403);
    const link = t.link.slice(t.shellOrigin.length);
    assert.equal((await request(t.shellPort, { path: link, headers: { "sec-fetch-site": "cross-site" } })).status, 403, "another site cannot use the link");
  } finally {
    await t.close();
  }
});

test("the frame listener has no write API", async () => {
  const t = await startApp();
  try {
    const body = JSON.stringify(saveBody());
    for (const p of ["/api/changes", "/api/code", "/", "/__dftp/overlay.js"]) {
      const r = await request(t.framePort, {
        method: "POST", path: p, body,
        headers: { origin: t.frameOrigin, "content-type": "application/json", "x-dftp-token": t.token, host: `127.0.0.1:${t.framePort}` },
      });
      assert.ok([403, 404, 405].includes(r.status), `${p} -> ${r.status}`);
    }
    assert.equal(await mtimeOf(docPath(t.root)), null, "nothing saved");
  } finally {
    await t.close();
  }
});
