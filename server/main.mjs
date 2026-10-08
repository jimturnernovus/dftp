// Starts the two loopback listeners as a port pair: SHELL on P (designer page
// and write API) and FRAME on P+1 (the page being designed). If either port
// is taken the next pair is tried, up to 20 pairs. Each request's role comes
// from the socket's local port, never from its Host header.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { openStore } from "./store.mjs";
import { createStatic, SHELL_FILES, LAYER_FILES, DEMO_FILES, LAYER_PREFIX } from "./static.mjs";
import { createShellApp } from "./shell-app.mjs";
import { createFrameApp, createFrameUpgrade } from "./frame-app.mjs";
import { createProxy } from "./proxy.mjs";
import { requestLogger, sessionCookieName } from "./guard.mjs";

export const PAIR_TRIES = 20;
export const LIMITS = Object.freeze({ headersTimeout: 10000, requestTimeout: 30000, keepAliveTimeout: 5000, maxConnections: 64, maxHeaderSize: 16384 });

// Ports another local tool is known to trust; never bind them.
const AVOID_PORTS = new Set([0x12a9, 0x12b3]);

function makeServer() {
  const server = http.createServer({
    requireHostHeader: false,
    maxHeaderSize: LIMITS.maxHeaderSize,
    headersTimeout: LIMITS.headersTimeout,
    requestTimeout: LIMITS.requestTimeout,
    keepAliveTimeout: LIMITS.keepAliveTimeout,
    connectionsCheckingInterval: 2000,
  });
  server.maxConnections = LIMITS.maxConnections;
  server.headersTimeout = LIMITS.headersTimeout;
  server.requestTimeout = LIMITS.requestTimeout;
  server.on("clientError", (err, socket) => {
    if (socket.writable && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// Bind a free pair (p, p+1) starting at `start`, skipping pairs that touch
// `avoid`. Returns {shell, frame, port}.
export async function listenPair(host, start, avoid = []) {
  const skip = new Set([...AVOID_PORTS, ...avoid]);
  let p = start;
  for (let tries = 0; tries < PAIR_TRIES && p + 1 <= 65535; tries++, p += 2) {
    if (skip.has(p) || skip.has(p + 1)) continue;
    const shell = makeServer();
    const frame = makeServer();
    try {
      await listen(shell, p, host);
    } catch (e) {
      if (e.code === "EADDRINUSE" || e.code === "EACCES") continue;
      throw e;
    }
    try {
      await listen(frame, p + 1, host);
    } catch (e) {
      await closeServer(shell);
      if (e.code === "EADDRINUSE" || e.code === "EACCES") continue;
      throw e;
    }
    return { shell, frame, port: p };
  }
  const err = new Error("no free port pair found");
  err.code = "NO_PORT";
  throw err;
}

const ONE_TIME_MS = 2 * 60 * 1000;

// cfg: frozen settings from config.mjs. opts.log: (line) => void for request
// lines (only used when cfg.debug). opts.token: fixed token (tests only).
// Returns {shellOrigin, frameOrigin, shellPort, framePort, token, link,
// openLink(), sessionCookie, store, servers, close()}.
//
// link: the address to print. Its key works for as long as the server runs,
// so the same link opens the designer again after a browser restart.
// openLink(): a link whose key works once, for handing to a browser launcher
// (its arguments are briefly visible to other local users).
export async function startServers(cfg, opts = {}) {
  const token = opts.token || randomBytes(32).toString("hex");
  const linkKey = randomBytes(24).toString("hex");
  const cookieValue = randomBytes(32).toString("hex");
  const oneTime = new Map();
  const store = await openStore({
    root: cfg.root,
    pages: cfg.pages,
    devices: cfg.devices,
    libraryPrefixes: cfg.libraryPrefixes,
    version: cfg.version,
    create: true,
  });
  const fingerprint = store.fingerprint;
  const shellStatic = await createStatic(cfg.toolDir, SHELL_FILES);
  const layerStatic = await createStatic(cfg.toolDir, LAYER_FILES);
  const demoStatic = cfg.mode === "demo" ? await createStatic(cfg.root, DEMO_FILES) : null;

  const avoid = cfg.target ? [cfg.target.port] : [];
  const { shell, frame, port } = await listenPair(cfg.host, cfg.port, avoid);
  const shellPort = port;
  const framePort = port + 1;
  const shellHost = `${cfg.hostLiteral}:${shellPort}`;
  const frameHost = `${cfg.hostLiteral}:${framePort}`;
  const shellOrigin = `http://${shellHost}`;
  const frameOrigin = `http://${frameHost}`;

  const ctx = {
    cfg,
    token,
    store,
    fingerprint,
    shellStatic,
    layerStatic,
    demoStatic,
    shellPort,
    framePort,
    shellHost,
    frameHost,
    shellOrigin,
    frameOrigin,
    layerScript: `${frameOrigin}${LAYER_PREFIX}overlay.js`,
    logRequest: cfg.debug && opts.log ? requestLogger(opts.log) : null,
    session: {
      cookieName: sessionCookieName(shellPort),
      cookieValue,
      // true when `k` opens the designer; a one-time key is used up here.
      takeKey(k) {
        if (typeof k !== "string" || !/^[0-9a-f]{48}$/.test(k)) return false;
        if (k === linkKey) return true;
        const until = oneTime.get(k);
        if (until === undefined) return false;
        oneTime.delete(k);
        return Date.now() <= until;
      },
    },
  };
  ctx.proxy = createProxy({ cfg, shellOrigin, frameOrigin, framePort, layerScript: ctx.layerScript, sessionCookie: ctx.session.cookieName });

  const shellHandler = createShellApp(ctx);
  const frameHandler = createFrameApp(ctx);
  shell.on("request", shellHandler);
  frame.on("request", frameHandler);
  shell.on("upgrade", (req, socket) => socket.destroy());
  frame.on("upgrade", createFrameUpgrade(ctx));

  let closing = null;
  return {
    shellOrigin,
    frameOrigin,
    shellPort,
    framePort,
    token,
    link: `${shellOrigin}/?k=${linkKey}`,
    openLink() {
      const k = randomBytes(24).toString("hex");
      const t = Date.now();
      for (const [old, until] of oneTime) if (until < t) oneTime.delete(old);
      oneTime.set(k, t + ONE_TIME_MS);
      return `${shellOrigin}/?k=${k}`;
    },
    sessionCookie: `${ctx.session.cookieName}=${cookieValue}`,
    store,
    servers: { shell, frame },
    close() {
      if (!closing) {
        closing = (async () => {
          ctx.proxy.close();
          await Promise.all([closeServer(shell), closeServer(frame)]);
        })();
      }
      return closing;
    },
  };
}
