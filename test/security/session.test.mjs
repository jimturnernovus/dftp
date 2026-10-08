// The designer page holds the per-launch token, so it is served only to a
// browser that opened the start-up link: other local users and other local
// programs that can reach 127.0.0.1 get nothing from GET /.

import test from "node:test";
import assert from "node:assert/strict";
import { startApp, request, openWithLink } from "../helpers.mjs";

const TOKEN_RE = /[0-9a-f]{64}/;

test("GET / without the session cookie gives 403 and no token", async () => {
  const t = await startApp();
  try {
    for (const headers of [{}, { "sec-fetch-site": "none" }, { cookie: `${t.cookie.split("=")[0]}=${"0".repeat(64)}` }, { cookie: `dftp_s1=${t.cookie.split("=")[1]}` }]) {
      const r = await request(t.shellPort, { path: "/", headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.ok(!TOKEN_RE.test(r.text), "no token in the refusal");
      assert.ok(!r.text.includes(t.token));
      assert.match(r.text, /link dftp prints when it starts/);
    }
    const head = await request(t.shellPort, { method: "HEAD", path: "/" });
    assert.equal(head.status, 403);
  } finally {
    await t.close();
  }
});

test("the start-up link sets an HttpOnly, SameSite=Strict cookie and opens the designer", async () => {
  const t = await startApp();
  try {
    const linkPath = t.link.slice(t.shellOrigin.length);
    assert.match(linkPath, /^\/\?k=[0-9a-f]{48}$/);
    const r = await request(t.shellPort, { path: linkPath });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    assert.ok(!r.text.includes(t.token));
    const [cookie] = r.headers["set-cookie"];
    assert.equal(cookie, `${t.cookie}; Path=/; HttpOnly; SameSite=Strict`);
    const page = await request(t.shellPort, { path: "/", headers: { cookie: `other=1; ${t.cookie}` } });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`content="${t.token}"`));
    // The printed link keeps working (a browser restart loses the cookie).
    assert.equal((await request(t.shellPort, { path: linkPath })).status, 303);
    // A visit with the cookie and any key just goes to the page.
    const again = await request(t.shellPort, { path: `/?k=${"0".repeat(48)}`, headers: { cookie: t.cookie } });
    assert.equal(again.status, 303);
    assert.equal(again.headers["set-cookie"], undefined);
  } finally {
    await t.close();
  }
});

test("wrong, malformed or another launch's keys are refused", async () => {
  const t = await startApp();
  const other = await startApp();
  try {
    const otherKey = other.link.slice(other.link.indexOf("?"));
    for (const q of [`?k=${"a".repeat(48)}`, "?k=", "?k=xyz", `?k=${t.link.split("k=")[1]}0`, otherKey, `?k=${t.link.split("k=")[1].toUpperCase()}`]) {
      const r = await request(t.shellPort, { path: `/${q}` });
      assert.equal(r.status, 403, q);
      assert.equal(r.headers["set-cookie"], undefined, q);
    }
  } finally {
    await other.close();
    await t.close();
  }
});

test("a browser-launch link works once", async () => {
  const t = await startApp();
  try {
    const once = t.app.openLink();
    const p = once.slice(t.shellOrigin.length);
    assert.notEqual(once, t.link);
    assert.equal((await request(t.shellPort, { method: "HEAD", path: p })).status, 403, "a HEAD does not spend it");
    const first = await request(t.shellPort, { path: p });
    assert.equal(first.status, 303);
    assert.equal(first.headers["set-cookie"][0].split(";")[0], t.cookie);
    assert.equal((await request(t.shellPort, { path: p })).status, 403, "used up");
  } finally {
    await t.close();
  }
});

test("the session cookie alone opens nothing on the API: the token is still required", async () => {
  const t = await startApp();
  try {
    const { cookie, token } = await openWithLink(t.shellPort, t.link.slice(t.shellOrigin.length));
    assert.equal(token, t.token);
    const r = await request(t.shellPort, { path: "/api/session", headers: { cookie, "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 403);
  } finally {
    await t.close();
  }
});
