// Terminal output never holds the token, bodies, headers, cookies or query
// strings, even with --debug.

import test from "node:test";
import assert from "node:assert/strict";
import { runCli, tempRoot, removeRoot, randomPort, request, saveBody, sampleChange, DESIGNER_LINE, openWithLink } from "../helpers.mjs";

const SENTINEL = "SENTINEL-7f3a9c";

test("no secrets or page data in stdout or stderr", async () => {
  const root = await tempRoot();
  const c = runCli(["--demo", "--root", root, "--port", String(randomPort()), "--debug"]);
  try {
    const m = await c.waitFor(DESIGNER_LINE);
    const port = Number(m[1]);
    const { token, cookie } = await openWithLink(port, m[2]);
    const origin = `http://127.0.0.1:${port}`;
    const hdrs = {
      origin, "x-dftp-token": token, "content-type": "application/json", "sec-fetch-site": "same-origin",
      cookie: `session=${SENTINEL}`, authorization: `Bearer ${SENTINEL}`, "x-extra": SENTINEL,
    };
    const body = JSON.stringify(saveBody({ list: [sampleChange({ text: SENTINEL, text_to: SENTINEL })] }));
    assert.equal((await request(port, { method: "POST", path: `/api/changes?q=${SENTINEL}`, headers: hdrs, body })).status, 200);
    await request(port, { method: "POST", path: "/api/changes", headers: hdrs, body: `{"bad":"${SENTINEL}` });
    await request(port, { method: "POST", path: "/api/changes", headers: { ...hdrs, "x-dftp-token": SENTINEL }, body });
    await request(port, { path: `/api/session?token=${SENTINEL}`, headers: hdrs });
    await request(port, { path: `/nope?${SENTINEL}` });
    await request(port + 1, { path: `/?${SENTINEL}` });
    await request(port + 1, { path: "/", host: `${SENTINEL}.example` });
    const stopped = await c.stop();
    assert.equal(stopped.code, 0);
    const all = c.out() + c.err();
    assert.ok(!all.includes(SENTINEL), "sentinel never printed");
    assert.ok(!all.includes(token), "token never printed");
    assert.ok(!all.includes(cookie.split("=")[1]), "session cookie never printed");
    assert.match(c.out(), /^POST \/api\/changes 200 \d+\.\dms$/m, "request lines: method, path, status, time");
    assert.match(c.out(), /^GET \/nope 404 \d+\.\dms$/m);
  } finally {
    await c.stop();
    await removeRoot(root);
  }
});

test("without --debug no request lines are printed", async () => {
  const root = await tempRoot();
  const c = runCli(["--demo", "--root", root, "--port", String(randomPort())]);
  try {
    const m = await c.waitFor(DESIGNER_LINE);
    await request(Number(m[1]), { path: "/" });
    await c.stop();
    assert.ok(!/^GET \//m.test(c.out()));
  } finally {
    await c.stop();
    await removeRoot(root);
  }
});
