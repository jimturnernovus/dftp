// The dev-server proxy against the fake dev server in fixtures/upstream.mjs:
// header policy in both directions, redirects, service workers, body limits,
// timeouts, target pinning and WebSocket upgrades.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startApp, request, rawRequest, statusOf, randomPort, sleep } from "../helpers.mjs";
import { startUpstream, wsConnect } from "../fixtures/upstream.mjs";
import { startCapture } from "../fixtures/capture.mjs";
import { createProxy, pinnedTarget, classifyLocation, interstitialHtml, probeTarget } from "../../server/proxy.mjs";
import { validateTarget, ConfigError } from "../../server/config.mjs";
import { splitTarget } from "../../server/guard.mjs";

let up;
let app;
let F;

before(async () => {
  up = await startUpstream();
  app = await startApp({ flags: { demo: false, target: up.origin } });
  F = app.framePort;
});

after(async () => {
  await app.close();
  await up.close();
});

const get = (p, headers = {}, extra = {}) => request(F, { path: p, headers, ...extra });

// POST just over 1 MiB, with a declared length or chunked. With a declared
// length the headers go first and the answer is awaited before any body is
// sent. A chunked body has to be sent to be counted; the server may answer
// and close while it is still going out, which the client can see as a
// write error instead of the 413.
function postBig(p, { declared }) {
  const size = 1024 * 1024 + 1;
  return new Promise((resolve) => {
    const headers = { host: `127.0.0.1:${F}`, "content-type": "text/plain" };
    if (declared) headers["content-length"] = String(size);
    else headers["transfer-encoding"] = "chunked";
    const req = http.request({ host: "127.0.0.1", port: F, method: "POST", path: p, agent: false, setHost: false, headers });
    let answered = false;
    req.on("response", (res) => {
      answered = true;
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < size && !answered) {
        const part = chunk.subarray(0, Math.min(chunk.length, size - sent));
        sent += part.length;
        if (!req.write(part)) {
          req.once("drain", pump);
          return;
        }
      }
      if (!answered) req.end();
    };
    if (declared) {
      req.flushHeaders();
      setTimeout(pump, 1000);
    } else {
      pump();
    }
  });
}
const upstreamHost = () => new URL(up.origin).host;

// ---------------------------------------------------------------- response headers

test("framing, CORS, caching and hop-by-hop headers from the dev server are removed", async () => {
  const r = await get("/page");
  assert.equal(r.status, 200);
  for (const h of [
    "x-frame-options", "access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers",
    "etag", "keep-alive", "x-secret-hop", "service-worker-allowed", "content-security-policy-report-only",
  ]) {
    assert.equal(r.headers[h], undefined, h);
  }
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-kept"], "yes", "other headers pass");
  assert.deepEqual(r.headers["set-cookie"], ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"], "cookies pass unchanged");
  // The upstream policy loses only frame-ancestors; ours is added as a second policy.
  assert.equal(r.headers["content-security-policy"], `default-src 'self'; img-src 'self' data:, frame-ancestors ${app.shellOrigin}`);
  assert.equal(Number(r.headers["content-length"]), r.body.length);
  // Snapshot of every header the browser gets for a proxied page.
  const names = Object.keys(r.headers).filter((k) => !["date", "connection", "content-length"].includes(k)).sort();
  assert.deepEqual(names, ["cache-control", "content-security-policy", "content-type", "set-cookie", "x-kept"]);
});

test("CORS headers never reach the browser, even on non-HTML responses", async () => {
  const r = await get("/json", { origin: "http://evil.example" });
  assert.equal(r.status, 200);
  assert.equal(r.text, "{\"ok\":true}");
  for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith("access-control-"), k);
  assert.equal(r.headers["content-security-policy"], `frame-ancestors ${app.shellOrigin}`);
});

test("a 204 passes with its headers and no body", async () => {
  const r = await get("/no-content");
  assert.equal(r.status, 204);
  assert.equal(r.headers["x-kept"], "yes");
  assert.equal(r.body.length, 0);
});

test("server-sent events stream through without being held back", async () => {
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: F, path: "/sse", headers: { host: `127.0.0.1:${F}` }, agent: false }, (res) => {
      res.once("data", (d) => {
        resolve({ type: res.headers["content-type"], data: d.toString() });
        req.destroy();
      });
    });
    req.on("error", reject);
  });
  assert.equal(first.type, "text/event-stream");
  assert.equal(first.data, "data: hello\n\n");
});

// ---------------------------------------------------------------- request headers

test("request headers: Host pinned, token never forwarded, identity encoding, own Origin rewritten", async () => {
  const r = await get("/echo/a?b=1", {
    "x-dftp-token": "should-never-arrive",
    origin: app.frameOrigin,
    referer: `${app.frameOrigin}/page?q=1`,
    "accept-encoding": "gzip, br",
    connection: "keep-alive, x-private-hop",
    "x-private-hop": "1",
    "keep-alive": "timeout=5",
    te: "trailers",
    "proxy-authorization": "Basic Zm9vOmJhcg==",
    "proxy-connection": "keep-alive",
    expect: "100-continue",
    cookie: "a=1",
    authorization: "Bearer dev-only",
    "x-other": "kept",
  });
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.text);
  assert.equal(seen.url, "/echo/a?b=1");
  assert.equal(seen.headers.host, upstreamHost());
  assert.equal(seen.headers["accept-encoding"], "identity");
  assert.equal(seen.headers.origin, up.origin);
  assert.equal(seen.headers.referer, `${up.origin}/page?q=1`);
  for (const h of ["x-dftp-token", "x-private-hop", "keep-alive", "te", "proxy-authorization", "proxy-connection", "expect"]) {
    assert.equal(seen.headers[h], undefined, h);
  }
  assert.ok(!seen.rawHeaders.some((h) => /dftp/i.test(h)), "no trace of the token anywhere");
  assert.equal(seen.headers.cookie, "a=1");
  assert.equal(seen.headers.authorization, "Bearer dev-only");
  assert.equal(seen.headers["x-other"], "kept");
});

test("the designer's session cookie never reaches the dev server, and the dev server cannot set it", async () => {
  const [name] = app.cookie.split("=");
  const both = JSON.parse((await get("/echo/c", { cookie: `a=1; ${app.cookie}; b=2` })).text);
  assert.equal(both.headers.cookie, "a=1; b=2");
  const only = JSON.parse((await get("/echo/c", { cookie: app.cookie })).text);
  assert.equal(only.headers.cookie, undefined);
  const ws = await wsConnect(F, { headers: { Origin: app.frameOrigin, Cookie: `${app.cookie}; hmr=1` } });
  try {
    assert.equal(ws.status, 101);
    assert.equal(up.upgrades.at(-1).headers.cookie, "hmr=1");
    assert.ok(!up.upgrades.at(-1).rawHeaders.join("\n").includes(app.cookie.split("=")[1]));
  } finally {
    ws.close();
  }
  const set = await get(`/set-cookie?name=${name}`);
  assert.deepEqual(set.headers["set-cookie"], ["kept=1; Path=/"]);
});

test("another site's Origin and Referer pass unchanged, so the dev server's own checks still work", async () => {
  const seen = JSON.parse((await get("/echo", { origin: "http://evil.example", referer: "http://evil.example/x" })).text);
  assert.equal(seen.headers.origin, "http://evil.example");
  assert.equal(seen.headers.referer, "http://evil.example/x");
  const opaque = JSON.parse((await get("/echo", { origin: "null" })).text);
  assert.equal(opaque.headers.origin, "null");
});

test("GET //evil.example/x reaches the dev server as a path, never as a host", async () => {
  const r = await get("//evil.example/x?y=1");
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.text);
  assert.equal(seen.url, "//evil.example/x?y=1");
  assert.equal(seen.headers.host, upstreamHost());
  assert.equal(up.requests.at(-1).url, "//evil.example/x?y=1");
});

test("absolute-form request lines are refused before the proxy", async () => {
  const before = up.requests.length;
  const raw = await rawRequest(F, `GET http://127.0.0.1:${up.port}/echo HTTP/1.1\r\nHost: 127.0.0.1:${F}\r\n\r\n`);
  assert.equal(statusOf(raw), 400);
  assert.equal(up.requests.length, before);
});

test("request bodies are forwarded with an exact length; over 1 MiB is refused before the dev server", async () => {
  const small = "x".repeat(5000);
  const ok = JSON.parse((await get("/upload", { "content-type": "text/plain" }, { method: "POST", body: small })).text);
  assert.equal(ok.body, small);
  assert.equal(ok.headers["content-length"], "5000");
  assert.equal(ok.headers["transfer-encoding"], undefined);

  assert.equal(await postBig("/upload-big", { declared: true }), 413);
  assert.ok([413, "EPIPE", "ECONNRESET"].includes(await postBig("/upload-big", { declared: false })));
  assert.equal(up.seen("/upload-big").length, 0, "the dev server never saw either");

  const viaChunks = JSON.parse((await get("/upload-chunked", { "content-type": "text/plain" }, { method: "POST", body: small })).text);
  assert.equal(viaChunks.body, small, "a chunked body arrives whole");
  assert.equal(viaChunks.headers["content-length"], "5000", "and is sent on with a length, not chunked");
  assert.equal(viaChunks.headers["transfer-encoding"], undefined);

  const empty = JSON.parse((await get("/upload-empty", { "content-length": "0" }, { method: "POST" })).text);
  assert.equal(empty.headers["content-length"], "0");
});

// ---------------------------------------------------------------- redirects

test("redirects on the dev server's origin point back at the frame origin", async () => {
  const same = await get("/redirect/same");
  assert.equal(same.status, 302);
  assert.equal(same.headers.location, `${app.frameOrigin}/landing?from=same#top`);
  const alias = await get("/redirect/alias");
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.location, `${app.frameOrigin}/landing`, "localhost on the same port is the same dev server");
  const rel = await get("/redirect/relative");
  assert.equal(rel.status, 307);
  assert.equal(rel.headers.location, "/landing?x=1", "a relative Location is left alone");
  const refresh = await get("/refresh");
  assert.equal(refresh.headers.refresh, `0; url=${app.frameOrigin}/landing`);
  const away = await get(`/refresh?u=${encodeURIComponent("http://evil.example/")}`);
  assert.equal(away.headers.refresh, undefined);
});

test("redirects to any other host get a plain page; nothing follows them", async () => {
  const cap = await startCapture();
  try {
    const cases = [
      [`${cap.origin}/steal?c=1`, `127.0.0.1:${cap.port}`],
      [`//127.0.0.1:${cap.port}/x`, `127.0.0.1:${cap.port}`],
      [`/\\127.0.0.1:${cap.port}/x`, `127.0.0.1:${cap.port}`],
      ["http://evil.example/oauth?x=<script>alert(1)</script>", "evil.example"],
      ["https://evil.example:8443/", "evil.example:8443"],
      [["javascript", "alert(1)"].join(":"), "an address"],
      [`http://127.0.0.1:${app.shellPort}/`, `127.0.0.1:${app.shellPort}`],
    ];
    for (const [to, shown] of cases) {
      const r = await get(`/redirect/to?u=${encodeURIComponent(to)}`);
      assert.equal(r.status, 200, to);
      assert.equal(r.headers.location, undefined, to);
      assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
      const csp = r.headers["content-security-policy"];
      assert.match(csp, /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; frame-ancestors /);
      assert.ok(csp.endsWith(`frame-ancestors ${app.shellOrigin}`));
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["cache-control"], "no-store");
      assert.deepEqual(r.headers["set-cookie"], ["state=xyz; Path=/"]);
      assert.ok(r.text.includes(`This page tried to go to <code>${shown}</code>, outside your dev server.`), to);
      assert.ok(!/<a[\s>]|<script|http-equiv|<form|<iframe|<img/i.test(r.text), `no link or active content for ${to}`);
    }
    const created = await get(`/created?u=${encodeURIComponent("http://evil.example/x")}`);
    assert.equal(created.status, 201);
    assert.equal(created.headers.location, undefined, "a Location to elsewhere on a non-redirect is dropped");
    await sleep(100);
    assert.equal(cap.connections(), 0, "the other host saw no connection");
    assert.equal(cap.requests.length, 0);
  } finally {
    await cap.close();
  }
});

test("classifyLocation and the page text only ever show a plain host", () => {
  const where = { target: { origin: "http://127.0.0.1:5173", port: 5173 }, frameOrigin: "http://127.0.0.1:7451", pathname: "/a/b" };
  assert.deepEqual(classifyLocation("c?d=1", where), { kind: "target", value: "http://127.0.0.1:7451/a/c?d=1" });
  assert.deepEqual(classifyLocation("/x", where), { kind: "keep" });
  assert.deepEqual(classifyLocation("?q", where), { kind: "keep" });
  assert.deepEqual(classifyLocation("http://127.0.0.1:7451/z", where), { kind: "keep" });
  assert.deepEqual(classifyLocation("http://[::1]:5173/z", where), { kind: "target", value: "http://127.0.0.1:7451/z" });
  assert.equal(classifyLocation("http://127.0.0.1:5174/", where).kind, "external");
  assert.equal(classifyLocation("https://127.0.0.1:5173/", where).kind, "external");
  assert.deepEqual(classifyLocation("data:text/html,<b>x</b>", where), { kind: "external", display: "" });
  assert.deepEqual(classifyLocation(["http:", "//[bad"].join(""), where), { kind: "external", display: "" }, "unparsable");
  assert.equal(classifyLocation("http://xn--e1afmkfd.example/", where).display, "xn--e1afmkfd.example");
  const page = interstitialHtml("<img src=x>");
  assert.ok(!page.includes("<img"), "text is escaped even if a caller passes markup");
});

// ---------------------------------------------------------------- refusals

test("service-worker script requests are refused and never reach the dev server", async () => {
  const r = await get("/sw.js", { "service-worker": "script" });
  assert.equal(r.status, 404);
  assert.equal(up.seen("/sw.js").length, 0);
  const plain = await get("/sw.js");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["service-worker-allowed"], undefined);
});

test("CORS preflights and TRACE are answered here, never forwarded", async () => {
  const n = up.requests.length;
  const pre = await get("/echo", { origin: "http://evil.example", "access-control-request-method": "POST" }, { method: "OPTIONS" });
  assert.equal(pre.status, 405);
  for (const k of Object.keys(pre.headers)) assert.ok(!k.startsWith("access-control-"), k);
  const trace = await get("/echo", {}, { method: "TRACE" });
  assert.equal(trace.status, 405);
  assert.equal(up.requests.length, n);
  const options = await get("/echo-options", {}, { method: "OPTIONS" });
  assert.equal(options.status, 200, "a plain OPTIONS still reaches the dev server");
});

test("a dev server that is not running gives a generic 502", async () => {
  const t = await startApp({ flags: { demo: false, target: `http://127.0.0.1:${randomPort() + 1}` } });
  try {
    const r = await request(t.framePort, { path: "/anything?secret=1" });
    assert.equal(r.status, 502);
    assert.equal(r.text, "upstream error\n");
    assert.equal(r.headers["content-security-policy"], `default-src 'none'; frame-ancestors ${t.shellOrigin}; base-uri 'none'; form-action 'none'; sandbox`);
    const layer = await request(t.framePort, { path: "/__dftp/overlay.js" });
    assert.equal(layer.status, 200, "the layer is still served");
    const ws = await wsConnect(t.framePort, { headers: { Origin: t.frameOrigin } });
    assert.equal(ws.status, 0, "a WebSocket is simply closed");
  } finally {
    await t.close();
  }
});

test("a dev server that never answers is cut off by the timeout", async () => {
  const framePort = randomPort() + 1;
  const ctx = {
    cfg: { target: Object.freeze({ origin: up.origin, hostname: "127.0.0.1", port: up.port, hostHeader: upstreamHost(), connectHost: "127.0.0.1" }), relaxCsp: false },
    shellOrigin: `http://127.0.0.1:${framePort - 1}`,
    frameOrigin: `http://127.0.0.1:${framePort}`,
    framePort,
    layerScript: `http://127.0.0.1:${framePort}/__dftp/overlay.js`,
  };
  const proxy = createProxy(ctx, { timeoutMs: 300, handshakeTimeoutMs: 300 });
  const server = http.createServer((req, res) => proxy.handle(req, res, splitTarget(req.url)));
  server.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head, splitTarget(req.url)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    const r = await request(server.address().port, { path: "/slow" });
    assert.equal(r.status, 502);
    assert.ok(Date.now() - t0 < 3000);
    const t1 = Date.now();
    const ws = await wsConnect(server.address().port, { path: "/ws-silent", headers: { Origin: ctx.frameOrigin } });
    assert.equal(ws.status, 0, "a silent WebSocket handshake is closed");
    assert.ok(Date.now() - t1 < 3000);
  } finally {
    proxy.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- target

test("the target must be plain http on this computer and not the designer's ports", () => {
  for (const bad of ["http://example.com", "http://10.0.0.1", "https://127.0.0.1:1", "http://u:p@127.0.0.1:3000", "ftp://127.0.0.1:21", "http://127.0.0.1:5173/app"]) {
    assert.throws(() => validateTarget(bad, { avoidPorts: [7450, 7451] }), ConfigError, bad);
  }
  assert.throws(() => validateTarget("http://127.0.0.1:7451", { avoidPorts: [7450, 7451] }), ConfigError);
  const good = validateTarget("http://localhost:5173");
  assert.equal(pinnedTarget(good, 7451).connectHost, "127.0.0.1");
  // Checked again by the proxy itself.
  const base = { origin: "http://127.0.0.1:5173", port: 5173, hostHeader: "127.0.0.1:5173", connectHost: "127.0.0.1" };
  assert.throws(() => pinnedTarget({ ...base, connectHost: "10.0.0.1" }, 7451));
  assert.throws(() => pinnedTarget({ ...base, connectHost: "localhost" }, 7451));
  assert.throws(() => pinnedTarget({ ...base, port: 7451 }, 7451));
  assert.throws(() => pinnedTarget({ ...base, port: 7450 }, 7451));
  assert.throws(() => pinnedTarget({ ...base, origin: "https://127.0.0.1:5173" }, 7451));
  assert.throws(() => pinnedTarget({ ...base, hostHeader: "a\r\nX-Injected: 1" }, 7451));
  assert.equal(pinnedTarget(null, 7451), null);
});

test("a target written as localhost is found on IPv6 too; an IP target is dialled as written", async (t) => {
  let v6;
  try {
    v6 = await startUpstream({ host: "::1" });
  } catch {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  const viaName = await startApp({ flags: { demo: false, target: `http://localhost:${v6.port}` } });
  const viaIp = await startApp({ flags: { demo: false, target: `http://127.0.0.1:${v6.port}` } });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await request(viaName.framePort, { path: "/echo" });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.text).headers.host, `localhost:${v6.port}`);
    }
    const ws = await wsConnect(viaName.framePort, { headers: { Origin: viaName.frameOrigin } });
    assert.equal(ws.status, 101);
    ws.send("v6");
    assert.equal(await ws.next(), "echo:v6");
    ws.close();
    assert.equal((await request(viaIp.framePort, { path: "/echo" })).status, 502, "127.0.0.1 means 127.0.0.1 only");
    // The start-up check tries the same addresses as the proxy.
    assert.equal(await probeTarget(validateTarget(`http://localhost:${v6.port}`)), true);
    assert.equal(await probeTarget(validateTarget(`http://[::1]:${v6.port}`)), true);
    assert.equal(await probeTarget(validateTarget(`http://127.0.0.1:${v6.port}`), { timeoutMs: 500 }), false);
  } finally {
    await viaName.close();
    await viaIp.close();
    await v6.close();
  }
});

test("without a target (demo mode) the proxy answers 404 and closes upgrades", async () => {
  const proxy = createProxy({ cfg: { target: null }, shellOrigin: "http://127.0.0.1:7450", frameOrigin: "http://127.0.0.1:7451", framePort: 7451, layerScript: "http://127.0.0.1:7451/__dftp/overlay.js" });
  const server = http.createServer((req, res) => proxy.handle(req, res, splitTarget(req.url)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal((await request(server.address().port, { path: "/" })).status, 404);
  } finally {
    proxy.close();
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- WebSocket

test("WebSocket with the frame's own Origin is passed through, Origin and Host rewritten, no token", async () => {
  const ws = await wsConnect(F, { path: "/ws?token=hmr", headers: { Origin: app.frameOrigin, "X-DFTP-Token": "never-forwarded", Cookie: "a=1" } });
  try {
    assert.equal(ws.status, 101);
    assert.equal(ws.accept, ws.expectedAccept);
    assert.ok(!/access-control-/i.test(ws.head), "no CORS headers on the handshake");
    assert.match(ws.head, /\r\nX-Upstream: ws/);
    ws.send("hello");
    assert.equal(await ws.next(), "echo:hello");
    const seen = up.upgrades.at(-1);
    assert.equal(seen.url, "/ws?token=hmr");
    assert.equal(seen.headers.origin, up.origin);
    assert.equal(seen.headers.host, upstreamHost());
    assert.equal(seen.headers.cookie, "a=1");
    assert.equal(seen.headers["x-dftp-token"], undefined);
    assert.ok(!seen.rawHeaders.some((h) => /dftp/i.test(h)));
  } finally {
    ws.close();
  }
});

test("WebSocket from any other Origin, Host, path or port is closed and never reaches the dev server", async () => {
  const n = up.upgrades.length;
  const refused = [
    [F, { headers: { Origin: "http://evil.example" } }],
    [F, { headers: {} }],
    [F, { headers: { Origin: "null" } }],
    [F, { headers: { Origin: app.shellOrigin } }],
    [F, { headers: { Origin: `${app.frameOrigin}.evil.example` } }],
    [F, { headers: { Origin: app.frameOrigin }, host: `localhost:${F}` }],
    [F, { headers: { Origin: app.frameOrigin }, host: "evil.example" }],
    [F, { headers: { Origin: app.frameOrigin }, path: "/__dftp/overlay.js" }],
    [app.shellPort, { headers: { Origin: app.shellOrigin }, host: `127.0.0.1:${app.shellPort}` }],
  ];
  for (const [port, opts] of refused) {
    const ws = await wsConnect(port, opts);
    assert.equal(ws.status, 0, JSON.stringify(opts));
  }
  const h2c = await rawRequest(F, `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${F}\r\nOrigin: ${app.frameOrigin}\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n`, 800);
  assert.equal(statusOf(h2c), 0, "only websocket upgrades");
  await sleep(50);
  assert.equal(up.upgrades.length, n);
});

test("a dev server that refuses the WebSocket gives a bare 502", async () => {
  const ws = await wsConnect(F, { path: "/ws-refuse", headers: { Origin: app.frameOrigin } });
  assert.equal(ws.status, 502);
  assert.ok(!/access-control-/i.test(ws.head));
  ws.close && ws.close();
});

test("stopping the designer closes open WebSockets", async () => {
  const t = await startApp({ flags: { demo: false, target: up.origin } });
  const ws = await wsConnect(t.framePort, { headers: { Origin: t.frameOrigin } });
  assert.equal(ws.status, 101);
  ws.send("x");
  assert.equal(await ws.next(), "echo:x");
  await t.close();
  await Promise.race([ws.closed(), sleep(3000).then(() => assert.fail("socket still open"))]);
});
