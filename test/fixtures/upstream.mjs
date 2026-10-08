// A fake dev server for proxy tests, on a random loopback port. It records
// every request and WebSocket upgrade it sees, and answers with the kinds of
// responses real dev servers send: HTML with framing and CORS headers, gzip /
// brotli / deflate HTML it was not asked to compress, CSP with nonces,
// redirects on its own origin and to other hosts, very large pages, a
// service-worker script, server-sent events and a WebSocket echo.
//
// Also exports wsConnect(), a tiny WebSocket client over a raw socket that
// can send any handshake headers (browsers and Node's WebSocket cannot set
// Origin).

import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const BIG = 8 * 1024 * 1024 + 4096;
export const NONCE = "R4nd0m+/Nonce_-9=";
export const META_NONCE = "m3taN0nce";

export function page(title = "Upstream page", head = "", body = "") {
  return `<!doctype html>\n<html lang="en">\n<head data-x="a > b"><meta charset="utf-8">${head}<title>${title}</title></head>\n<body><h1 id="t">${title}</h1>${body}</body>\n</html>\n`;
}

// A tiny single-page app: one HTML shell for /spa and every path under it,
// and a script that draws its view late and moves between views with
// history.pushState. It sends the framing rules many dev servers send by
// default, which the proxy removes.
export const SPA_CSP = "default-src 'self'; frame-ancestors 'none'";

function spaPage() {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"utf-8\"><title>Small app</title><script src=\"/spa.js\" defer></script></head>",
    "<body><div id=\"app\">",
    "<header class=\"top\"><h1 id=\"t\">Small app</h1>",
    "<nav><a href=\"/spa\" data-spa id=\"start\">Start</a> <a href=\"/spa/other\" data-spa id=\"other\">Other view</a></nav></header>",
    "<main id=\"view\"></main>",
    "</div></body>",
    "</html>",
    "",
  ].join("\n");
}

const SPA_SCRIPT = `(() => {
  const SPA_FIRST_RENDER_MS = 600;
  const view = document.getElementById("view");
  function render() {
    const p = document.createElement("p");
    p.className = "lead";
    p.textContent = location.pathname === "/spa/other" ? "The other view." : "The start view.";
    view.replaceChildren(p);
  }
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-spa]") : null;
    if (!a) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    render();
  });
  window.addEventListener("popstate", render);
  // The first view arrives a moment after the page, as if its data had to
  // be fetched first.
  setTimeout(render, SPA_FIRST_RENDER_MS);
})();
`;

function bigPage() {
  const filler = `<p>${"x".repeat(1000)}</p>\n`;
  let out = page("Big page", "", "");
  while (out.length < BIG) out += filler;
  return out;
}

// ---------------------------------------------------------------- WebSocket framing

function encodeFrame(opcode, payload, mask = false) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = (mask ? 0x80 : 0) | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = (mask ? 0x80 : 0) | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  return Buffer.concat([head, key, body]);
}

// Pull complete frames off `buf`. Returns {frames:[{opcode, payload}], rest}.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const key = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    frames.push({ opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

// ---------------------------------------------------------------- the server

export async function startUpstream({ host = "127.0.0.1" } = {}) {
  const requests = [];
  const upgrades = [];
  const sockets = new Set();
  const server = http.createServer();
  let origin = "";

  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra });
    res.end(body);
  };

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  server.on("request", (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://upstream.invalid");
      const pathname = req.url.startsWith("//") ? req.url.split("?")[0] : url.pathname;
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders], body: body.toString("utf8") });

      if (pathname === "/spa" || pathname.startsWith("/spa/")) {
        html(res, 200, spaPage(), { "X-Frame-Options": "DENY", "Content-Security-Policy": SPA_CSP });
        return;
      }

      switch (pathname) {
        case "/spa.js":
          res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": Buffer.byteLength(SPA_SCRIPT) });
          res.end(SPA_SCRIPT);
          return;
        case "/":
        case "/page":
          res.setHeader("Set-Cookie", ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
          html(res, 200, page(), {
            "X-Frame-Options": "DENY",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "X-Kept",
            "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; img-src 'self' data:",
            "Content-Security-Policy-Report-Only": "frame-ancestors 'none'",
            ETag: "\"v1\"",
            "Cache-Control": "public, max-age=600",
            Connection: "keep-alive, X-Secret-Hop",
            "Keep-Alive": "timeout=5",
            "X-Secret-Hop": "drop me",
            "X-Kept": "yes",
            "Service-Worker-Allowed": "/",
          });
          return;
        case "/landing":
          html(res, 200, page("Landing"));
          return;
        case "/gzip": {
          const enc = zlib.gzipSync(page("Gzip page"));
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip", "Content-Length": enc.length, ETag: "\"g\"" });
          res.end(enc);
          return;
        }
        case "/br": {
          const enc = zlib.brotliCompressSync(page("Brotli page"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "br" });
          res.end(enc);
          return;
        }
        case "/deflate-raw": {
          const enc = zlib.deflateRawSync(page("Deflate page"));
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "deflate" });
          res.end(enc);
          return;
        }
        case "/gzip-bomb": {
          const enc = zlib.gzipSync(Buffer.alloc(BIG + 1024 * 1024, 0x61));
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip", "Content-Length": enc.length });
          res.end(enc);
          return;
        }
        case "/gzip-script": {
          const enc = zlib.gzipSync("console.log(1);\n");
          res.writeHead(200, { "Content-Type": "text/javascript", "Content-Encoding": "gzip" });
          res.end(enc);
          return;
        }
        case "/nonce":
          html(res, 200, page("Nonce page", `<script nonce="${NONCE}">document.documentElement.dataset.inline = "ran";</script>`), {
            "Content-Security-Policy": `script-src 'nonce-${NONCE}' 'strict-dynamic'; object-src 'none'; frame-ancestors 'self'`,
          });
          return;
        case "/nonce-elem":
          html(res, 200, page("Nonce elem"), {
            "Content-Security-Policy": "default-src 'nonce-fromdefault'; script-src-elem 'nonce-fromelem'; script-src 'nonce-fromscript'",
          });
          return;
        case "/nonce-bad":
          html(res, 200, page("Bad nonce"), { "Content-Security-Policy": "script-src 'nonce-a\"b'" });
          return;
        case "/nonce-report-only":
          html(res, 200, page("Report only"), { "Content-Security-Policy-Report-Only": "script-src 'nonce-reportonly'" });
          return;
        case "/meta-nonce":
          html(res, 200, page("Meta nonce", `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${META_NONCE}' 'self'">`));
          return;
        case "/hash-only":
          html(res, 200, page("Hash only", "<meta http-equiv=\"content-security-policy\" content=\"script-src 'sha256-AAAA'\">"), {
            "Content-Security-Policy": "script-src 'sha256-AAAA'; frame-ancestors 'none'",
          });
          return;
        case "/redirect/same":
          res.writeHead(302, { Location: `${origin}/landing?from=same#top`, "Content-Length": 0 });
          res.end();
          return;
        case "/redirect/alias":
          res.writeHead(301, { Location: `http://localhost:${server.address().port}/landing`, "Content-Length": 0 });
          res.end();
          return;
        case "/redirect/relative":
          res.writeHead(307, { Location: "/landing?x=1", "Content-Length": 0 });
          res.end();
          return;
        case "/set-cookie": {
          const name = /^[A-Za-z0-9_]{1,40}$/.test(url.searchParams.get("name") || "") ? url.searchParams.get("name") : "x";
          res.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": [`${name}=from-dev-server; Path=/`, "kept=1; Path=/"], "Content-Length": 2 });
          res.end("ok");
          return;
        }
        case "/redirect/to":
          res.writeHead(302, { Location: url.searchParams.get("u") || "/", "Set-Cookie": "state=xyz; Path=/", "Content-Length": 0 });
          res.end();
          return;
        case "/created":
          res.writeHead(201, { Location: url.searchParams.get("u") || "/", "Content-Type": "application/json" });
          res.end("{}");
          return;
        case "/refresh":
          res.writeHead(200, { Refresh: `0; url=${url.searchParams.get("u") || `${origin}/landing`}`, "Content-Type": "text/plain" });
          res.end("refresh");
          return;
        case "/big": {
          const big = Buffer.from(bigPage());
          res.writeHead(200, { "Content-Type": "text/html", "Content-Length": big.length });
          res.end(big);
          return;
        }
        case "/big-chunked": {
          const big = Buffer.from(bigPage());
          res.writeHead(200, { "Content-Type": "text/html" });
          for (let i = 0; i < big.length; i += 256 * 1024) res.write(big.subarray(i, i + 256 * 1024));
          res.end();
          return;
        }
        case "/latin1": {
          const body = Buffer.concat([Buffer.from("<html><head><title>Caf"), Buffer.from([0xe9]), Buffer.from("</title></head><body>na"), Buffer.from([0xef]), Buffer.from("ve</body></html>")]);
          res.writeHead(200, { "Content-Type": "text/html; charset=windows-1252", "Content-Length": body.length });
          res.end(body);
          return;
        }
        case "/utf16": {
          const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><head></head><body>wide</body></html>", "utf16le")]);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-16le", "Content-Length": body.length });
          res.end(body);
          return;
        }
        case "/missing-html":
          html(res, 404, page("Not here"));
          return;
        case "/json":
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end("{\"ok\":true}");
          return;
        case "/sw.js":
          res.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/" });
          res.end("self.addEventListener('fetch', () => {});\n");
          return;
        case "/sse":
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.write("data: hello\n\n");
          return;
        case "/slow":
          // Never answers; the proxy's timeout has to end it.
          return;
        case "/no-content":
          res.writeHead(204, { "X-Kept": "yes" });
          res.end();
          return;
        default:
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: body.toString("utf8") }));
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ url: req.url, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] });
    socket.on("error", () => socket.destroy());
    if (req.url.startsWith("/ws-silent")) return; // never answers
    if (req.url.startsWith("/ws-refuse")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "Access-Control-Allow-Origin: *",
      "X-Upstream: ws",
      "",
      "",
    ].join("\r\n"));
    let buf = Buffer.from(head || []);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 1 || f.opcode === 2) socket.write(encodeFrame(f.opcode, Buffer.concat([Buffer.from("echo:"), f.payload])));
        else if (f.opcode === 9) socket.write(encodeFrame(10, f.payload));
        else if (f.opcode === 8) {
          socket.end(encodeFrame(8, f.payload));
          return;
        }
      }
    };
    if (head && head.length) onData(Buffer.alloc(0));
    socket.on("data", onData);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    port,
    origin,
    requests,
    upgrades,
    seen: (p) => requests.filter((r) => r.url === p || r.url.startsWith(`${p}?`)),
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------- WebSocket client

// Open a WebSocket over a raw socket with exactly the headers given.
// Resolves {status, head, send(text), next(), close(), closed()} once the
// reply head is in, or {status: 0} when the connection was closed first.
export function wsConnect(port, { path = "/ws", headers = {}, host } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const key = randomBytes(16).toString("base64");
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host === undefined ? `127.0.0.1:${port}` : host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ];
    let buf = Buffer.alloc(0);
    let headDone = false;
    let resolved = false;
    const messages = [];
    const waiters = [];
    let isClosed = false;
    const closeWaiters = [];
    const finishClose = () => {
      isClosed = true;
      while (waiters.length) waiters.shift()(null);
      while (closeWaiters.length) closeWaiters.shift()();
      if (!resolved) {
        resolved = true;
        resolve({ status: 0, head: buf.toString("latin1") });
      }
    };
    sock.on("error", () => {});
    sock.on("close", finishClose);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headDone) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        headDone = true;
        const head = buf.subarray(0, end).toString("latin1");
        buf = buf.subarray(end + 4);
        const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(head) || [])[1] || 0);
        resolved = true;
        resolve({
          status,
          head,
          accept: (/\r\nsec-websocket-accept:\s*(\S+)/i.exec(head) || [])[1],
          expectedAccept: acceptKey(key),
          send: (text) => sock.write(encodeFrame(1, Buffer.from(text), true)),
          next: (ms = 2000) => new Promise((r) => {
            if (messages.length) {
              r(messages.shift());
              return;
            }
            if (isClosed) {
              r(null);
              return;
            }
            const t = setTimeout(() => r(null), ms);
            waiters.push((m) => {
              clearTimeout(t);
              r(m);
            });
          }),
          close: () => sock.destroy(),
          closed: () => (isClosed ? Promise.resolve() : new Promise((r) => closeWaiters.push(r))),
        });
      }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const m = f.payload.toString("utf8");
        if (waiters.length) waiters.shift()(m);
        else messages.push(m);
      }
    });
    sock.write(lines.join("\r\n"));
  });
}
