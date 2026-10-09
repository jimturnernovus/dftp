// Requests to the FRAME listener (http://127.0.0.1:P+1). It has no write API.
//
//   /__dftp/overlay.js   boot module generated at startup (settings baked in)
//   /__dftp/blank/<id>   a blank page (--blank), and /__dftp/tokens.css its
//                        style sheet from the style scan (blank.mjs)
//   /__dftp/...          fixed static list (static.mjs LAYER_FILES); never proxied
//   demo mode:  /  the demo page, stamped with source locations; /demo.css, /demo.js
//   proxy mode: everything else goes to proxy.mjs
//   blank mode: nothing else (there is no dev server)
//
// A request marked "Service-Worker: script" is refused in both modes, so no
// page can install a worker over this shared origin.

import path from "node:path";
import { splitTarget, hostMatches, send, sendFrameError, headers, TYPES } from "./guard.mjs";
import { LAYER_PREFIX, DEMO_PAGE, readRegularFile } from "./static.mjs";
import { stampHtml } from "./demo-stamp.mjs";
import { blankPageHtml, tokenStylesheet, TOKENS_CSS } from "./blank.mjs";

const CSS_WAIT_MS = 4000;

// The settings the layer may know, as a JSON literal that is safe inside a
// script: "<", U+2028 and U+2029 are escaped.
export function layerConfig(ctx) {
  const { cfg } = ctx;
  return {
    ns: "dftp",
    shellOrigin: ctx.shellOrigin,
    frameOrigin: ctx.frameOrigin,
    layerBase: `${ctx.frameOrigin}${LAYER_PREFIX}`,
    rootSelector: cfg.rootSelector,
    libraryPrefixes: [...cfg.libraryPrefixes],
    locAttr: cfg.locAttr,
    captureText: cfg.captureText,
    theme: cfg.theme ? { ...cfg.theme } : null,
    debug: cfg.debug,
  };
}

export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function bootModuleSource(ctx) {
  return [
    `import { startLayer } from "${LAYER_PREFIX}core/overlay.js";`,
    `import { boot } from "${LAYER_PREFIX}boot.js";`,
    `boot(startLayer, ${scriptJson(layerConfig(ctx))});`,
    "",
  ].join("\n");
}

export function createFrameApp(ctx) {
  const bootSource = Buffer.from(bootModuleSource(ctx));
  const demoFile = path.join(ctx.cfg.root, DEMO_PAGE);
  const blankPages = new Map(ctx.cfg.pages.filter((p) => p.blank === true).map((p) => [p.path, p]));

  // A blank page, or the style sheet blank pages load. False when the path
  // is neither (or there are no blank pages).
  async function blank(req, res, target) {
    if (!blankPages.size) return false;
    if (target.pathname === TOKENS_CSS) {
      // A first scan that is still running is waited for briefly; past that
      // the page gets the plain look, and Reload or Rescan (which has the
      // page load this sheet again) brings the tokens in.
      let timer = null;
      const got = ctx.tokens
        ? await Promise.race([
          ctx.tokens.get().catch(() => null),
          new Promise((r) => {
            timer = setTimeout(() => r(null), CSS_WAIT_MS);
          }),
        ])
        : null;
      clearTimeout(timer);
      send(req, res, 200, tokenStylesheet(got ? got.doc : null, { theme: ctx.cfg.theme, devices: ctx.cfg.devices }), headers.layerAsset(TYPES.css));
      return true;
    }
    const page = blankPages.get(target.pathname);
    if (!page) return false;
    send(req, res, 200, blankPageHtml({ id: page.id, scriptSrc: ctx.layerScript }), headers.frameDocument(ctx.shellOrigin));
    return true;
  }

  async function serveFile(req, res, entry, hdrs) {
    let buf;
    try {
      buf = await readRegularFile(entry.file);
    } catch {
      sendFrameError(req, res, 404, ctx.shellOrigin);
      return;
    }
    send(req, res, 200, buf, hdrs(entry.type));
  }

  async function layer(req, res, target) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendFrameError(req, res, 405, ctx.shellOrigin, { Allow: "GET, HEAD" });
      return;
    }
    if (target.pathname === `${LAYER_PREFIX}overlay.js`) {
      send(req, res, 200, bootSource, headers.layerAsset(TYPES.js));
      return;
    }
    if (await blank(req, res, target)) return;
    const entry = ctx.layerStatic.get(target.pathname);
    if (!entry) {
      sendFrameError(req, res, 404, ctx.shellOrigin);
      return;
    }
    await serveFile(req, res, entry, headers.layerAsset);
  }

  async function demo(req, res, target) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendFrameError(req, res, 405, ctx.shellOrigin, { Allow: "GET, HEAD" });
      return;
    }
    if (target.pathname === "/") {
      let html;
      try {
        html = (await readRegularFile(demoFile)).toString("utf8");
      } catch {
        sendFrameError(req, res, 404, ctx.shellOrigin);
        return;
      }
      const out = stampHtml(html, { file: DEMO_PAGE, attr: ctx.cfg.locAttr, scriptSrc: ctx.layerScript });
      send(req, res, 200, out, headers.frameDocument(ctx.shellOrigin));
      return;
    }
    const entry = ctx.demoStatic && ctx.demoStatic.get(target.pathname);
    if (!entry) {
      sendFrameError(req, res, 404, ctx.shellOrigin);
      return;
    }
    await serveFile(req, res, entry, headers.frameAsset);
  }

  return async function handle(req, res) {
    const target = splitTarget(req.url);
    if (ctx.logRequest) ctx.logRequest(req, res, target ? target.pathname : "-");
    try {
      if (req.socket.localPort !== ctx.framePort) {
        sendFrameError(req, res, 421, ctx.shellOrigin);
        return;
      }
      if (!target) {
        sendFrameError(req, res, 400, ctx.shellOrigin);
        return;
      }
      if (!hostMatches(req, ctx.frameHost)) {
        sendFrameError(req, res, 403, ctx.shellOrigin);
        return;
      }
      if (String(req.headers["service-worker"] || "").toLowerCase() === "script") {
        sendFrameError(req, res, 404, ctx.shellOrigin);
        return;
      }
      if (target.pathname === LAYER_PREFIX.slice(0, -1) || target.pathname.startsWith(LAYER_PREFIX)) {
        await layer(req, res, target);
        return;
      }
      if (ctx.cfg.mode === "demo") {
        await demo(req, res, target);
        return;
      }
      if (ctx.cfg.mode === "blank") {
        sendFrameError(req, res, 404, ctx.shellOrigin);
        return;
      }
      await ctx.proxy.handle(req, res, target);
    } catch {
      if (!res.headersSent) sendFrameError(req, res, 500, ctx.shellOrigin);
      else res.destroy();
    }
  };
}

// WebSocket upgrades on the frame listener: only in proxy mode, only with the
// exact Host and the frame's own Origin; the proxy does the rest.
export function createFrameUpgrade(ctx) {
  return function upgrade(req, socket, head) {
    socket.on("error", () => socket.destroy());
    const target = splitTarget(req.url);
    if (
      ctx.cfg.mode !== "proxy" ||
      !target ||
      req.socket.localPort !== ctx.framePort ||
      !hostMatches(req, ctx.frameHost) ||
      req.headers.origin !== ctx.frameOrigin ||
      target.pathname.startsWith(LAYER_PREFIX)
    ) {
      socket.destroy();
      return;
    }
    ctx.proxy.upgrade(req, socket, head, target);
  };
}
