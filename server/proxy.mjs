// The dev-server proxy (proxy mode). Every frame-listener path outside
// /__dftp/ is sent to the user's dev server, which is fixed at startup and
// always on this computer. Responses come back with the headers that would
// stop framing or open the page to other sites taken out, and HTML documents
// get the layer's script tag (inject.mjs).
//
// createProxy(ctx) -> { handle(req, res, target), upgrade(req, socket, head, target), close() }
//   ctx.cfg          frozen settings from config.mjs (ctx.cfg.target holds
//                    {origin, hostname, port, hostHeader, connectHost})
//   ctx.shellOrigin  "http://127.0.0.1:P"
//   ctx.frameOrigin  "http://127.0.0.1:P+1"
//   ctx.framePort    P+1
//   ctx.layerScript  absolute URL of the layer boot module
//   target           {pathname, search} from guard.splitTarget(req.url)
//
// The caller (frame-app.mjs) has already checked the Host header, refused
// service-worker script requests and, for WebSocket upgrades, the Origin.

import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  BODY_LIMIT, BASE_HEADERS, TOKEN_HEADER, TYPES, readBody, send, sendFrameError, withoutCookie, setCookieName,
} from "./guard.mjs";
import {
  INJECT_LIMIT, isHtmlType, mediaType, parseEncodings, decodeBody, injectLayer, withoutFrameAncestors,
} from "./inject.mjs";

export const UPSTREAM_TIMEOUT = 30000;
export const WS_HANDSHAKE_TIMEOUT = 10000;
const WS_HEAD_LIMIT = 16 * 1024;
const NO_TIMEOUT = 0;

// Headers that belong to one connection and are never passed on.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "http2-settings"]);
// Request headers this proxy sets itself or never forwards.
const REQUEST_DROP = new Set(["host", TOKEN_HEADER, "accept-encoding", "content-length", "expect", "origin", "referer"]);
// Response headers that are dropped or replaced.
const RESPONSE_DROP = new Set([
  "x-frame-options", "etag", "content-length", "cache-control", "service-worker-allowed",
  "content-security-policy", "content-security-policy-report-only", "location", "refresh",
]);
// Integrity headers that no longer match once the body is rewritten.
const BODY_DIGESTS = ["content-md5", "digest", "content-digest", "repr-digest", "accept-ranges"];

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DOCUMENT_DEST = new Set(["document", "iframe", "frame"]);
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CONNECT_HOSTS = new Set(["127.0.0.1", "::1"]);
const HOST_HEADER_RE = /^[A-Za-z0-9.:[\]-]{1,300}$/;
const LENGTH_RE = /^\d{1,15}$/;

function isHopByHop(name) {
  return HOP_BY_HOP.has(name) || name.startsWith("proxy-");
}

// Header names a Connection header marks as hop-by-hop.
function connectionTokens(value) {
  const out = new Set();
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const v of list) for (const t of String(v).split(",")) if (t.trim()) out.add(t.trim().toLowerCase());
  return out;
}

const single = (values) => (values.length === 1 ? values[0] : values);

// ---------------------------------------------------------------- target

// The dev server address, checked again here: plain http, on this computer,
// never one of the designer's own ports. Returns null when there is none
// (demo mode); throws on anything else.
//
// connectHosts lists the addresses to dial, in order. A target written as
// "localhost" may be listening on IPv4 or IPv6 only, so both loopback
// addresses are tried; no name is ever looked up.
export function connectHostsOf(t) {
  const other = t.connectHost === "127.0.0.1" ? "::1" : "127.0.0.1";
  return t.hostname === "localhost" ? [t.connectHost, other] : [t.connectHost];
}

// Whether the dev server answers a HEAD request on any of the addresses the
// proxy would dial (the start-up check). Resolves true or false, never throws.
export function probeTarget(target, { timeoutMs = 2000 } = {}) {
  const hosts = connectHostsOf(target);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= hosts.length) {
        resolve(false);
        return;
      }
      const host = hosts[i++];
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(true);
        else next();
      };
      let req;
      try {
        req = http.request({ host, port: target.port, method: "HEAD", path: "/", headers: { host: target.hostHeader }, timeout: timeoutMs, agent: false });
      } catch {
        done(false);
        return;
      }
      req.on("response", (res) => {
        res.resume();
        done(true);
      });
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
      req.end();
    };
    next();
  });
}

export function pinnedTarget(target, framePort) {
  if (target === null || target === undefined) return null;
  const t = target;
  if (typeof t !== "object") throw new Error("proxy target is invalid");
  if (!CONNECT_HOSTS.has(t.connectHost)) throw new Error("proxy target must be on this computer");
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error("proxy target port is invalid");
  if (t.port === framePort || t.port === framePort - 1) throw new Error("proxy target is the designer's own port");
  if (typeof t.origin !== "string" || !t.origin.startsWith("http://")) throw new Error("proxy target must use http");
  if (typeof t.hostHeader !== "string" || !HOST_HEADER_RE.test(t.hostHeader)) throw new Error("proxy target host is invalid");
  const connectHosts = connectHostsOf(t);
  return Object.freeze({
    origin: t.origin,
    port: t.port,
    hostHeader: t.hostHeader,
    connectHost: t.connectHost,
    connectHosts: Object.freeze(connectHosts),
  });
}

// Errors that mean "nothing is listening on that address", so the next
// loopback address may be tried without the request having reached anyone.
const NOT_LISTENING = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"]);

// ---------------------------------------------------------------- URLs

function isTargetUrl(u, target) {
  return u.protocol === "http:" && LOOPBACK_NAMES.has(u.hostname) && (u.port === "" ? 80 : Number(u.port)) === target.port;
}

// A host name worth showing on the "left the dev server" page: only what a
// parsed URL can hold, so the page can never carry markup.
function displayHost(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const h = u.host;
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(h) || /^\[[0-9a-f:.]{2,45}\](:\d{1,5})?$/.test(h) ? h : "";
}

// Where a Location (or Refresh) URL from the dev server leads.
//   {kind:"keep"}               relative to this page, or already on the frame origin
//   {kind:"target", value}      on the dev server: rewritten to the frame origin
//   {kind:"external", display}  anywhere else
export function classifyLocation(raw, { target, frameOrigin, pathname = "/" }) {
  const base = new URL(target.origin);
  base.pathname = pathname;
  let u;
  try {
    u = new URL(String(raw), base);
  } catch {
    return { kind: "external", display: "" };
  }
  if (u.origin === frameOrigin) return { kind: "keep" };
  if (!isTargetUrl(u, target)) return { kind: "external", display: displayHost(u) };
  // A plain "/path", "?query" or "#hash" already points at this origin.
  if (/^(\/(?![/\\])|[?#])[^\\\t\n\r]*$/.test(String(raw))) return { kind: "keep" };
  return { kind: "target", value: `${frameOrigin}${u.pathname}${u.search}${u.hash}` };
}

function rewriteReferer(value, { target, frameOrigin }) {
  if (value === frameOrigin) return target.origin;
  if (value.startsWith(`${frameOrigin}/`)) return target.origin + value.slice(frameOrigin.length);
  return value;
}

// ---------------------------------------------------------------- headers

// Headers sent to the dev server. bodyLength: null when the request had no
// body framing at all. dropCookie: the designer's own session cookie, which
// the browser also sends here (cookies ignore the port) and which the dev
// server must never see.
export function upstreamRequestHeaders(req, { target, frameOrigin, bodyLength, dropCookie }) {
  const listed = connectionTokens(req.headers.connection);
  const out = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (isHopByHop(name) || listed.has(name) || REQUEST_DROP.has(name)) continue;
    if (name === "cookie") {
      const kept = dropCookie ? withoutCookie(values, dropCookie) : values.join("; ");
      if (kept) out.cookie = kept;
      continue;
    }
    out[name] = single(values);
  }
  const origin = req.headersDistinct.origin;
  if (origin) out.origin = origin.length === 1 && origin[0] === frameOrigin ? target.origin : single(origin);
  const referer = req.headersDistinct.referer;
  if (referer) out.referer = rewriteReferer(referer[0], { target, frameOrigin });
  out.host = target.hostHeader;
  out["accept-encoding"] = "identity";
  if (bodyLength !== null) out["content-length"] = String(bodyLength);
  return out;
}

// Set-Cookie lines from the dev server, without any that would set or clear
// the designer's own session cookie.
export function keptSetCookies(values, dropCookie) {
  const list = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return dropCookie ? list.filter((v) => setCookieName(v) !== dropCookie) : list;
}

// Headers sent back to the browser, before Location / Refresh handling.
export function downstreamHeaders(upRes, { shellOrigin, relaxCsp, dropCookie }) {
  const listed = connectionTokens(upRes.headers.connection);
  const src = upRes.headersDistinct;
  const out = {};
  for (const [name, values] of Object.entries(src)) {
    if (isHopByHop(name) || listed.has(name) || RESPONSE_DROP.has(name) || name.startsWith("access-control-")) continue;
    if (name === "set-cookie") {
      const kept = keptSetCookies(values, dropCookie);
      if (kept.length) out[name] = kept;
      continue;
    }
    out[name] = single(values);
  }
  const csp = relaxCsp ? [] : withoutFrameAncestors(src["content-security-policy"]);
  out["content-security-policy"] = [...csp, `frame-ancestors ${shellOrigin}`];
  if (!relaxCsp) {
    const reportOnly = withoutFrameAncestors(src["content-security-policy-report-only"]);
    if (reportOnly.length) out["content-security-policy-report-only"] = reportOnly;
  }
  out["cache-control"] = "no-store";
  return out;
}

// ---------------------------------------------------------------- the "left the dev server" page

const PAGE_STYLE = [
  "body{margin:0;padding:48px 16px;font:16px/1.5 system-ui,sans-serif;background:#f5f6f8;color:#1c2230}",
  "main{max-width:34rem;margin:0 auto}",
  "h1{margin:0 0 12px;font-size:1.25rem}",
  "code{font:inherit;font-weight:600;word-break:break-all}",
  "@media (prefers-color-scheme:dark){body{background:#14171d;color:#e4e7ec}}",
].join("");
const PAGE_STYLE_HASH = createHash("sha256").update(PAGE_STYLE).digest("base64");

const escapeText = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function interstitialHtml(display) {
  const where = display ? escapeText(display) : "an address";
  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Outside your dev server</title>",
    `<style>${PAGE_STYLE}</style></head>`,
    "<body><main><h1>Outside your dev server</h1>",
    `<p>This page tried to go to <code>${where}</code>, outside your dev server.</p>`,
    "<p>Open it in a normal browser tab.</p>",
    "</main></body></html>",
    "",
  ].join("\n");
}

function interstitialHeaders(shellOrigin) {
  return {
    ...BASE_HEADERS,
    "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${PAGE_STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors ${shellOrigin}`,
    "Content-Type": TYPES.html,
  };
}

// ---------------------------------------------------------------- helpers

function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

// Answer with a generic error, or cut the connection when the answer has
// already started. A response that went out in full is left alone.
function fail(req, res, status, shellOrigin) {
  if (res.writableFinished) return;
  if (!res.headersSent && !res.destroyed) sendFrameError(req, res, status, shellOrigin);
  else res.destroy();
}

// ---------------------------------------------------------------- proxy

export function createProxy(ctx, opts = {}) {
  const { shellOrigin, frameOrigin, framePort, layerScript } = ctx;
  const dropCookie = typeof ctx.sessionCookie === "string" && ctx.sessionCookie ? ctx.sessionCookie : null;
  const relaxCsp = !!(ctx.cfg && ctx.cfg.relaxCsp);
  const target = pinnedTarget(ctx.cfg ? ctx.cfg.target : null, framePort);
  const timeout = opts.timeoutMs || UPSTREAM_TIMEOUT;
  const handshakeTimeout = opts.handshakeTimeoutMs || WS_HANDSHAKE_TIMEOUT;
  // A fresh connection per request: a reused keep-alive socket that the dev
  // server has just closed would otherwise turn into a spurious 502.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 64 });
  const live = new Set();
  let closed = false;
  // The loopback address that answered last is dialled first next time.
  let preferred = target ? target.connectHosts[0] : null;
  const dialOrder = () => [preferred, ...target.connectHosts.filter((h) => h !== preferred)];

  const track = (x) => {
    live.add(x);
    x.once("close", () => live.delete(x));
  };

  async function relay(req, res, upReq, upRes, t) {
    const status = upRes.statusCode;
    const hdrs = downstreamHeaders(upRes, { shellOrigin, relaxCsp, dropCookie });
    const where = { target, frameOrigin, pathname: t.pathname };

    const location = upRes.headers.location;
    if (location !== undefined) {
      const c = classifyLocation(location, where);
      if (c.kind === "external") {
        if (REDIRECT_STATUS.has(status)) {
          // Never followed, and not handed to the browser either.
          upRes.resume();
          const cookies = keptSetCookies(upRes.headersDistinct["set-cookie"], dropCookie);
          const extra = cookies.length ? { "Set-Cookie": cookies } : {};
          send(req, res, 200, interstitialHtml(c.display), interstitialHeaders(shellOrigin), extra);
          return;
        }
      } else {
        hdrs.location = c.kind === "target" ? c.value : location;
      }
    }
    const refresh = upRes.headers.refresh;
    if (refresh !== undefined) {
      const m = /^\s*(\d+(?:\.\d*)?)\s*(?:[;,]\s*(?:url\s*=\s*)?["']?([^"']*)["']?\s*)?$/i.exec(refresh);
      if (m && m[2]) {
        const c = classifyLocation(m[2], where);
        if (c.kind === "keep") hdrs.refresh = refresh;
        else if (c.kind === "target") hdrs.refresh = `${m[1]}; url=${c.value}`;
      } else if (m) {
        hdrs.refresh = refresh;
      }
    }

    const type = upRes.headers["content-type"];
    const html = isHtmlType(type);
    const declaredRaw = upRes.headers["content-length"];
    const declared = typeof declaredRaw === "string" && LENGTH_RE.test(declaredRaw) ? Number(declaredRaw) : null;
    const noBody = req.method === "HEAD" || status === 204 || status === 304;
    const dest = req.headers["sec-fetch-dest"];
    const injectable = !noBody && status >= 200 && status < 300 && status !== 205 && status !== 206 &&
      html && (dest === undefined || DOCUMENT_DEST.has(dest)) && (declared === null || declared <= INJECT_LIMIT);

    if (mediaType(type) === "text/event-stream") upReq.setTimeout(NO_TIMEOUT);

    if (!injectable) {
      // Body passes unchanged. A HEAD for an HTML page has no length: the
      // GET would carry the layer and be longer.
      if (declared !== null && status !== 204 && status !== 304 && !(req.method === "HEAD" && html)) {
        hdrs["content-length"] = String(declared);
      }
      res.writeHead(status, hdrs);
      if (noBody) {
        upRes.resume();
        res.end();
        return;
      }
      res.flushHeaders();
      await pipeline(upRes, res);
      return;
    }

    const chunks = [];
    let size = 0;
    let over = false;
    for await (const chunk of upRes) {
      if (res.destroyed) {
        upRes.destroy();
        return;
      }
      if (over) {
        if (!res.write(chunk)) await drained(res);
        continue;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size > INJECT_LIMIT) {
        // Too large to hold: send what came so far and stream the rest
        // through untouched, without the layer.
        over = true;
        res.writeHead(status, hdrs);
        for (const c of chunks) res.write(c);
        chunks.length = 0;
        if (res.writableNeedDrain) await drained(res);
      }
    }
    if (over) {
      res.end();
      return;
    }
    const raw = Buffer.concat(chunks, size);
    const encodings = parseEncodings(upRes.headers["content-encoding"]);
    const decoded = encodings === null ? null : encodings.length ? await decodeBody(raw, encodings) : raw;
    const out = decoded && injectLayer(decoded, {
      contentType: type,
      scriptSrc: layerScript,
      headerCsp: relaxCsp ? undefined : upRes.headersDistinct["content-security-policy"],
      relaxCsp,
    });
    if (res.destroyed) return;
    if (out) {
      delete hdrs["content-encoding"];
      for (const h of BODY_DIGESTS) delete hdrs[h];
      hdrs["content-length"] = String(out.length);
      res.writeHead(status, hdrs);
      res.end(out);
    } else {
      hdrs["content-length"] = String(raw.length);
      res.writeHead(status, hdrs);
      res.end(raw);
    }
  }

  async function handle(req, res, t) {
    if (closed || !target) {
      sendFrameError(req, res, closed ? 503 : 404, shellOrigin);
      return;
    }
    const method = req.method;
    // TRACE echoes request headers back; CORS preflights can never pass
    // here because no Access-Control header is ever sent.
    if (method === "TRACE" || method === "TRACK" || method === "CONNECT" ||
        (method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined)) {
      sendFrameError(req, res, 405, shellOrigin, { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" });
      return;
    }
    let body;
    try {
      body = await readBody(req, BODY_LIMIT);
    } catch (e) {
      fail(req, res, e && e.status === 413 ? 413 : 400, shellOrigin);
      return;
    }
    if (closed || res.destroyed) return;
    const framed = body.length > 0 || req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
    const headers = upstreamRequestHeaders(req, { target, frameOrigin, bodyLength: framed ? body.length : null, dropCookie });
    const order = dialOrder();
    let current = null;
    res.on("close", () => {
      if (!res.writableFinished && current) current.destroy();
    });

    // Dial order[i]. When nothing listens there the request has reached no
    // one, so the next loopback address may be tried with the same body.
    const attempt = (i) => {
      let upReq;
      try {
        upReq = http.request({
          host: order[i],
          port: target.port,
          method,
          path: `${t.pathname}${t.search}`,
          headers,
          agent,
          setHost: false,
        });
      } catch {
        fail(req, res, 400, shellOrigin);
        return;
      }
      current = upReq;
      let answered = false;
      track(upReq);
      upReq.setTimeout(timeout, () => upReq.destroy(new Error("upstream timeout")));
      upReq.on("error", (e) => {
        if (!answered && e && NOT_LISTENING.has(e.code) && i + 1 < order.length && !closed && !res.destroyed) {
          attempt(i + 1);
          return;
        }
        fail(req, res, 502, shellOrigin);
      });
      upReq.on("response", (upRes) => {
        answered = true;
        preferred = order[i];
        upRes.on("error", () => {});
        relay(req, res, upReq, upRes, t).catch(() => fail(req, res, 502, shellOrigin));
      });
      upReq.end(body.length ? body : undefined);
    };
    attempt(0);
  }

  function upgrade(req, socket, head, t) {
    if (closed || !target || req.method !== "GET" || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    socket.pause();
    const listed = connectionTokens(req.headers.connection);
    const lines = [`GET ${t.pathname}${t.search} HTTP/1.1`, `Host: ${target.hostHeader}`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (isHopByHop(lower) || listed.has(lower) || REQUEST_DROP.has(lower)) continue;
      if (lower === "cookie" && dropCookie) {
        const kept = withoutCookie(req.rawHeaders[i + 1], dropCookie);
        if (kept) lines.push(`${name}: ${kept}`);
        continue;
      }
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    const referer = req.headers.referer;
    if (typeof referer === "string") lines.push(`Referer: ${rewriteReferer(referer, { target, frameOrigin })}`);
    // frame-app.mjs only lets through an Origin equal to the frame's own.
    lines.push(`Origin: ${target.origin}`, "Connection: Upgrade", "Upgrade: websocket", "", "");

    const order = dialOrder();
    let up = null;
    let done = false;
    const kill = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (up) up.destroy();
    };
    // Connecting and the dev server's handshake reply must both fit in this.
    const timer = setTimeout(kill, handshakeTimeout);
    timer.unref();
    track(socket);
    socket.setTimeout(NO_TIMEOUT);
    socket.on("error", kill);
    socket.on("close", kill);

    // Read the dev server's reply head; only a 101 is passed on.
    const readReply = (s) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buf.length > WS_HEAD_LIMIT) kill();
          return;
        }
        s.off("data", onData);
        clearTimeout(timer);
        const [statusLine, ...headerLines] = buf.subarray(0, end).toString("latin1").split("\r\n");
        if (!/^HTTP\/1\.1 101(\s|$)/.test(statusLine)) {
          done = true;
          s.destroy();
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const kept = headerLines.filter((l) => !/^access-control-/i.test(l));
        socket.setNoDelay(true);
        socket.write(`${[statusLine, ...kept].join("\r\n")}\r\n\r\n`);
        const rest = buf.subarray(end + 4);
        if (rest.length) socket.write(rest);
        s.pipe(socket);
        socket.pipe(s);
      };
      s.on("data", onData);
    };

    // Dial order[i]; when nothing listens there, try the next address.
    const dial = (i) => {
      const s = net.connect({ host: order[i], port: target.port });
      up = s;
      track(s);
      let connected = false;
      s.on("error", (e) => {
        if (!connected && e && NOT_LISTENING.has(e.code) && i + 1 < order.length && !done && !closed) {
          dial(i + 1);
          return;
        }
        kill();
      });
      s.on("close", () => {
        if (s === up) kill();
      });
      s.on("connect", () => {
        connected = true;
        preferred = order[i];
        s.setNoDelay(true);
        s.write(lines.join("\r\n"));
        if (head && head.length) s.write(head);
      });
      readReply(s);
    };
    dial(0);
  }

  return {
    handle,
    upgrade,
    close() {
      closed = true;
      for (const x of live) x.destroy();
      live.clear();
      agent.destroy();
    },
  };
}
