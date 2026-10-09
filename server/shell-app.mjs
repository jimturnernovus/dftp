// Requests to the SHELL listener (http://127.0.0.1:P): the designer page, its
// static files, and the only API that can write anything.
//
//   GET  /?k=<key>         the start-up link: sets the session cookie, then
//                          redirects to /
//   GET  /                 designer page, token placed in <meta name="dftp-token">;
//                          only with the session cookie
//   GET  /shell.js ...     fixed static list (static.mjs SHELL_FILES)
//   GET  /api/session      settings the designer needs (no absolute paths)
//   GET  /api/changes      ?page=&device=  -> {doc|null, rev, code}
//   POST /api/changes      {page, device, theme, list, tab, seq, base}
//   POST /api/code         {files:[...]}   -> {code:{file: sha12|null}}
//   GET  /api/changes-md   CHANGES.md as text
//   GET  /api/tokens       -> {doc|null, scanning}  the style scan (.dftp/tokens.json)
//   POST /api/tokens/scan  {}  -> {doc}  scan the project again
//   POST /api/tokens/sample {page, device, theme, elements, values}  -> {ok, doc}
//                          merge computed styles from the page (validateSample)
//
// Every /api request needs the token header; writes also need the exact shell
// Origin and a JSON body type (guard.checkApi). No CORS headers are ever sent.

import fsp from "node:fs/promises";
import path from "node:path";
import { isId, validateSave, validateFiles } from "../client/core/schema.js";
import { validateSample } from "../client/core/tokens.js";
import {
  HttpError, splitTarget, hostMatches, checkApi, documentFetchAllowed, readBody, parseJsonBody,
  send, sendJson, sendApiError, sendShellError, headers, TYPES, cookieValues, tokenMatches,
} from "./guard.mjs";
import { SHELL_INDEX, readRegularFile } from "./static.mjs";
import { filesOf } from "./fingerprint.mjs";
import { StoreError } from "./store.mjs";

const NEED_LINK = "This designer opens from the link dftp prints when it starts (the \"Designer:\" line, ending in ?k=...). Open that link in this browser.\n";
const KEY_QUERY_RE = /^\?k=[0-9a-f]{1,128}$/;

const API_ROUTES = {
  "/api/session": ["GET"],
  "/api/changes": ["GET", "POST"],
  "/api/code": ["POST"],
  "/api/changes-md": ["GET"],
  "/api/tokens": ["GET"],
  "/api/tokens/scan": ["POST"],
  "/api/tokens/sample": ["POST"],
};

export function sessionInfo(ctx) {
  const { cfg } = ctx;
  return {
    ns: "dftp",
    mode: cfg.mode,
    frameOrigin: ctx.frameOrigin,
    pages: cfg.pages.map((p) => ({ id: p.id, label: p.label, path: p.path, keep: [...p.keep], ...(p.blank === true ? { blank: true } : {}) })),
    // The page the designer opens on (the first blank page with --blank).
    start: cfg.startPage || cfg.pages[0].id,
    devices: cfg.devices.map((d) => ({ id: d.id, label: d.label, width: d.width, height: d.height })),
    theme: { toggle: !!cfg.theme },
    libraryPrefixes: [...cfg.libraryPrefixes],
    locAttr: cfg.locAttr,
    captureText: cfg.captureText,
    version: cfg.version,
    root: ".",
    changesPath: ctx.store.paths.md,
  };
}

export function createShellApp(ctx) {
  const indexFile = path.join(ctx.cfg.toolDir, SHELL_INDEX);

  const hasSession = (req) => cookieValues(req.headers.cookie, ctx.session.cookieName).some((v) => tokenMatches(v, ctx.session.cookieValue));

  async function serveIndex(req, res, target) {
    if (!documentFetchAllowed(req)) {
      sendShellError(req, res, 403);
      return;
    }
    const k = new URLSearchParams(target.search.replace(/^\?/, "")).get("k");
    if (k !== null) {
      // Only a real page load spends a key; a HEAD (a link preview, a
      // checker) must not use up a one-time key meant for the browser.
      if (req.method === "GET" && ctx.session.takeKey(k)) {
        send(req, res, 303, "", headers.shellError(), {
          Location: "/",
          "Set-Cookie": `${ctx.session.cookieName}=${ctx.session.cookieValue}; Path=/; HttpOnly; SameSite=Strict`,
        });
        return;
      }
      if (hasSession(req)) {
        send(req, res, 303, "", headers.shellError(), { Location: "/" });
        return;
      }
      send(req, res, 403, NEED_LINK, headers.shellError());
      return;
    }
    if (!hasSession(req)) {
      send(req, res, 403, NEED_LINK, headers.shellError());
      return;
    }
    let html;
    try {
      html = (await readRegularFile(indexFile)).toString("utf8");
    } catch {
      sendShellError(req, res, 500);
      return;
    }
    send(req, res, 200, html.replace("%TOKEN%", ctx.token), headers.shellDocument(ctx.frameOrigin));
  }

  async function serveStatic(req, res, pathname) {
    const entry = ctx.shellStatic.get(pathname);
    if (!entry) {
      sendShellError(req, res, 404);
      return;
    }
    let buf;
    try {
      buf = await readRegularFile(entry.file);
    } catch {
      sendShellError(req, res, 404);
      return;
    }
    send(req, res, 200, buf, headers.shellAsset(entry.type));
  }

  function pageAndDevice(searchParams) {
    const page = searchParams.get("page");
    const device = searchParams.get("device");
    if (!isId(page) || !isId(device)) throw new HttpError(400, "invalid page or device");
    if (!ctx.cfg.pages.some((p) => p.id === page) || !ctx.cfg.devices.some((d) => d.id === device)) {
      throw new HttpError(400, "unknown page or device");
    }
    return { page, device };
  }

  async function api(req, res, target) {
    const methods = API_ROUTES[target.pathname];
    if (!methods) throw new HttpError(404);
    if (!methods.includes(req.method)) {
      sendApiError(req, res, new HttpError(405), { Allow: methods.join(", ") });
      return;
    }
    const write = req.method === "POST";
    const denied = checkApi(req, { shellOrigin: ctx.shellOrigin, token: ctx.token, write });
    if (denied) throw denied;
    const body = write ? parseJsonBody(await readBody(req)) : undefined;
    const params = new URLSearchParams(target.search.replace(/^\?/, ""));

    switch (`${req.method} ${target.pathname}`) {
      case "GET /api/session":
        sendJson(req, res, 200, sessionInfo(ctx));
        return;
      case "GET /api/changes": {
        const { page, device } = pageAndDevice(params);
        const doc = await ctx.store.read(page, device);
        const code = await ctx.fingerprint.hashMany(doc ? filesOf(doc.list) : []);
        sendJson(req, res, 200, { doc, rev: doc ? doc.rev : 0, code });
        return;
      }
      case "POST /api/changes": {
        const r = validateSave(body);
        if (!r.ok) throw new HttpError(400, r.error);
        // New elements exist only on blank pages.
        if (r.value.list.some((c) => c.kind === "insert") && !ctx.cfg.pages.some((p) => p.id === r.value.page && p.blank === true)) {
          throw new HttpError(400, "new elements belong on blank pages");
        }
        const out = await ctx.store.save(r.value);
        sendJson(req, res, out.status, out.body);
        return;
      }
      case "POST /api/code": {
        const files = body && typeof body === "object" && !Array.isArray(body) ? body.files : undefined;
        const r = validateFiles(files);
        if (!r.ok) throw new HttpError(400, r.error);
        sendJson(req, res, 200, { code: await ctx.fingerprint.hashMany(r.value) });
        return;
      }
      case "GET /api/changes-md":
        send(req, res, 200, await ctx.store.buildMd(), headers.api(TYPES.text));
        return;
      case "GET /api/tokens":
        sendJson(req, res, 200, await ctx.tokens.get());
        return;
      case "POST /api/tokens/scan": {
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body: must be an object");
        const doc = await ctx.tokens.rescan();
        // CHANGES.md names where the tokens of new elements are defined.
        if (ctx.cfg.pages.some((p) => p.blank === true)) await ctx.store.rebuildMd().catch(() => {});
        sendJson(req, res, 200, { doc });
        return;
      }
      case "POST /api/tokens/sample": {
        const r = validateSample(body);
        if (!r.ok) throw new HttpError(400, r.error);
        if (!ctx.cfg.pages.some((p) => p.id === r.value.page) || !ctx.cfg.devices.some((d) => d.id === r.value.device)) {
          throw new HttpError(400, "unknown page or device");
        }
        // A blank page shows the tokens back; sampling it would count them twice.
        if (ctx.cfg.pages.some((p) => p.id === r.value.page && p.blank === true)) throw new HttpError(400, "blank pages are not sampled");
        sendJson(req, res, 200, { ok: true, doc: await ctx.tokens.addSample(r.value) });
        return;
      }
      default:
        throw new HttpError(404);
    }
  }

  async function route(req, res, target) {
    if (req.method === "OPTIONS") {
      sendShellError(req, res, 405, { Allow: "GET, HEAD, POST" });
      return;
    }
    if (target.pathname.startsWith("/api/") || target.pathname === "/api") {
      try {
        await api(req, res, target);
      } catch (e) {
        if (e instanceof StoreError) sendApiError(req, res, new HttpError(e.status, e.error));
        else if (e instanceof HttpError) sendApiError(req, res, e);
        else sendApiError(req, res, new HttpError(500));
      }
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendShellError(req, res, 405, { Allow: "GET, HEAD" });
      return;
    }
    if (target.pathname === "/") await serveIndex(req, res, target);
    else await serveStatic(req, res, target.pathname);
  }

  return async function handle(req, res) {
    const target = splitTarget(req.url);
    if (ctx.logRequest) ctx.logRequest(req, res, target ? target.pathname : "-");
    try {
      if (req.socket.localPort !== ctx.shellPort) {
        sendShellError(req, res, 421);
        return;
      }
      if (!target) {
        sendShellError(req, res, 400);
        return;
      }
      if (!hostMatches(req, ctx.shellHost)) {
        // "localhost" reaches the same loopback socket; send the browser to
        // the one address every check expects instead of serving it there.
        if (req.headers.host === `localhost:${ctx.shellPort}` && req.method === "GET" && target.pathname === "/") {
          const keep = KEY_QUERY_RE.test(target.search) ? target.search : "";
          send(req, res, 308, "", headers.shellError(), { Location: `${ctx.shellOrigin}/${keep}` });
          return;
        }
        sendShellError(req, res, 403);
        return;
      }
      await route(req, res, target);
    } catch {
      if (!res.headersSent) sendShellError(req, res, 500);
      else res.destroy();
    }
  };
}

// For tests: the index template must hold exactly one token placeholder.
export async function indexHasPlaceholder(toolDir) {
  const html = await fsp.readFile(path.join(toolDir, SHELL_INDEX), "utf8");
  return html.split("%TOKEN%").length === 2;
}
