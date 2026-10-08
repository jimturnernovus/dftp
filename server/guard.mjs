// Request checks shared by both listeners: request target and Host checks,
// the cross-site write gate, response header sets, a byte-counted body
// reader and a JSON parser that refuses prototype keys. Replies never echo
// anything from the request.

import { createHash, timingSafeEqual } from "node:crypto";
import { safeParse } from "../client/core/schema.js";

export const BODY_LIMIT = 1024 * 1024;
export const TOKEN_HEADER = "x-dftp-token";

export class HttpError extends Error {
  constructor(status, error = statusText(status)) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

const TEXTS = {
  400: "bad request",
  403: "forbidden",
  404: "not found",
  405: "method not allowed",
  413: "request too large",
  415: "content type must be application/json",
  421: "misdirected request",
  500: "internal error",
  501: "not implemented",
  502: "upstream error",
  503: "busy, try again",
};

export function statusText(status) {
  return TEXTS[status] || "error";
}

// ---------------------------------------------------------------- request line

// Only origin-form targets ("/path?query") are accepted. A full URL in the
// request line (absolute-form) and the asterisk form are refused. A path starting with
// "//" is still a path here and is never parsed as an authority.
export function splitTarget(url) {
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  const i = url.indexOf("?");
  return {
    pathname: i === -1 ? url : url.slice(0, i),
    search: i === -1 ? "" : url.slice(i),
  };
}

export function hostLiteral(host) {
  return host.includes(":") ? `[${host}]` : host;
}

export function hostMatches(req, expected) {
  const h = req.headers.host;
  return typeof h === "string" && h.toLowerCase() === expected;
}

// ---------------------------------------------------------------- token + CSRF

const digest = (s) => createHash("sha256").update(String(s)).digest();

export function tokenMatches(given, token) {
  if (typeof given !== "string" || typeof token !== "string" || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(token));
}

const JSON_TYPE_RE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;

export function isJsonType(ct) {
  return typeof ct === "string" && JSON_TYPE_RE.test(ct.trim());
}

// Every API request: Sec-Fetch-Site (when sent) is same-origin, an Origin
// (when sent) is the shell's own, and the per-launch token matches.
// Writes also need an Origin that is exactly the shell's and a JSON body type.
// Returns null when the request may go on, else an HttpError.
export function checkApi(req, { shellOrigin, token, write }) {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs !== undefined && sfs !== "same-origin") return new HttpError(403);
  const origin = req.headers.origin;
  if (write) {
    if (origin !== shellOrigin) return new HttpError(403);
  } else if (origin !== undefined && origin !== shellOrigin) {
    return new HttpError(403);
  }
  if (!tokenMatches(req.headers[TOKEN_HEADER], token)) return new HttpError(403);
  if (write && !isJsonType(req.headers["content-type"])) return new HttpError(415);
  return null;
}

// The designer page itself may be opened by the user (Sec-Fetch-Site "none")
// or reloaded from itself; a navigation started by another site is refused.
export function documentFetchAllowed(req) {
  const sfs = req.headers["sec-fetch-site"];
  return sfs === undefined || sfs === "none" || sfs === "same-origin";
}

// ---------------------------------------------------------------- session cookie

// The designer page (which carries the token) is served only to a browser
// holding this launch's session cookie. The cookie is set by opening the
// link printed at start-up (/?k=<key>). Cookies ignore the port, so the name
// carries the shell port and the frame listener never passes it on.
export const sessionCookieName = (shellPort) => `dftp_s${shellPort}`;

// Every value the Cookie header holds for `name`.
export function cookieValues(header, name) {
  const out = [];
  const list = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  for (const h of list) {
    for (const part of h.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
    }
  }
  return out;
}

// The Cookie header without `name`; null when nothing else is left.
export function withoutCookie(header, name) {
  const kept = [];
  const list = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  for (const h of list) {
    for (const part of h.split(";")) {
      const i = part.indexOf("=");
      const n = i > 0 ? part.slice(0, i).trim() : part.trim();
      if (n === name || part.trim() === "") continue;
      kept.push(part.trim());
    }
  }
  return kept.length ? kept.join("; ") : null;
}

// The cookie name a Set-Cookie line sets.
export function setCookieName(line) {
  const s = String(line);
  const i = s.indexOf("=");
  const semi = s.indexOf(";");
  const end = i === -1 || (semi !== -1 && semi < i) ? (semi === -1 ? s.length : semi) : i;
  return s.slice(0, end).trim();
}

// ---------------------------------------------------------------- body

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    if (declared !== undefined && !(Number(declared) <= limit)) {
      reject(new HttpError(413));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish(new HttpError(413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks, size)));
    req.on("error", () => finish(new HttpError(400)));
    req.on("close", () => finish(new HttpError(400)));
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function parseJsonBody(buf) {
  let text;
  try {
    text = utf8.decode(buf);
  } catch {
    throw new HttpError(400, "body is not valid UTF-8");
  }
  try {
    return safeParse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

// ---------------------------------------------------------------- headers

const PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

export const BASE_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": PERMISSIONS,
  "Cache-Control": "no-store",
});

// Responses that are not documents (scripts, styles, JSON, errors on the
// shell) can never be framed or run anything if opened directly.
const INERT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

export function shellCsp(frameOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

export function demoCsp(shellOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${shellOrigin}`,
  ].join("; ");
}

// Error pages on the frame listener may show inside the designer's frame.
function frameErrorCsp(shellOrigin) {
  return `default-src 'none'; frame-ancestors ${shellOrigin}; base-uri 'none'; form-action 'none'; sandbox`;
}

export const TYPES = Object.freeze({
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  text: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
});

export const headers = {
  shellDocument: (frameOrigin) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": shellCsp(frameOrigin),
    "X-Frame-Options": "DENY",
    "Content-Type": TYPES.html,
  }),
  shellAsset: (type) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": INERT_CSP,
    "X-Frame-Options": "DENY",
    "Content-Type": type,
  }),
  api: (type = TYPES.json) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": INERT_CSP,
    "X-Frame-Options": "DENY",
    "Content-Type": type,
  }),
  shellError: () => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": INERT_CSP,
    "X-Frame-Options": "DENY",
    "Content-Type": TYPES.text,
  }),
  layerAsset: (type) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": INERT_CSP,
    "Content-Type": type,
  }),
  frameDocument: (shellOrigin) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": demoCsp(shellOrigin),
    "Content-Type": TYPES.html,
  }),
  frameAsset: (type) => ({
    ...BASE_HEADERS,
    "Content-Type": type,
  }),
  frameError: (shellOrigin) => ({
    ...BASE_HEADERS,
    "Content-Security-Policy": frameErrorCsp(shellOrigin),
    "Content-Type": TYPES.text,
  }),
};

// ---------------------------------------------------------------- replies

export function send(req, res, status, body, hdrs, extra = {}) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const buf = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const out = { ...hdrs, ...extra, "Content-Length": String(buf.length) };
  // A body that was not read in full cannot be followed by another request on
  // the same connection: close it rather than drain an unknown amount.
  if (status === 413 || req.complete === false) out.Connection = "close";
  res.writeHead(status, out);
  res.end(req.method === "HEAD" ? undefined : buf);
  if (status === 413) res.on("finish", () => req.destroy());
}

export function sendJson(req, res, status, obj, extra = {}) {
  send(req, res, status, `${JSON.stringify(obj)}\n`, headers.api(), extra);
}

export function sendApiError(req, res, err, extra = {}) {
  const status = err && err.status ? err.status : 500;
  sendJson(req, res, status, { error: err && err.error ? err.error : statusText(status) }, extra);
}

export function sendShellError(req, res, status, extra = {}) {
  send(req, res, status, `${statusText(status)}\n`, headers.shellError(), extra);
}

export function sendFrameError(req, res, status, shellOrigin, extra = {}) {
  send(req, res, status, `${statusText(status)}\n`, headers.frameError(shellOrigin), extra);
}

// ---------------------------------------------------------------- logging

// One line per request: method, path without the query, status, time.
export function requestLogger(log) {
  return (req, res, pathname) => {
    if (!log) return;
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const p = typeof pathname === "string" ? pathname.slice(0, 200) : "-";
      log(`${req.method} ${p} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
  };
}
