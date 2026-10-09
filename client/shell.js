// Start-up for the designer window: reads the per-launch token from the page,
// builds the transport (same-origin fetch carrying the token header), asks
// the server for the session settings and hands over to createShell().

import { createShell } from "./core/shell-ui.js";

const TOKEN_HEADER = "X-DFTP-Token";
const STORAGE_KEY = "dftp-prefs";
const ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const meta = document.querySelector("meta[name=\"dftp-token\"]");
const token = meta ? meta.getAttribute("content") || "" : "";

async function call(method, path, body, opts = {}) {
  const init = {
    method,
    headers: { [TOKEN_HEADER]: token },
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (opts.keepalive) init.keepalive = true;
  return fetch(path, init);
}

const transport = {
  async getJson(path) {
    const r = await call("GET", path);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async postJson(path, body, opts) {
    const r = await call("POST", path, body, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async getText(path) {
    const r = await call("GET", path);
    return { status: r.status, text: await r.text() };
  },
};

function fail(text) {
  const box = document.getElementById("boot-error");
  if (box) {
    box.textContent = text;
    box.hidden = false;
  }
}

function validSession(s) {
  return !!s && typeof s === "object" &&
    s.ns === "dftp" &&
    typeof s.frameOrigin === "string" && ORIGIN_RE.test(s.frameOrigin) &&
    Array.isArray(s.pages) && s.pages.length > 0 &&
    s.pages.every((p) => p && ID_RE.test(p.id) && typeof p.label === "string" && typeof p.path === "string" && p.path.startsWith("/") && Array.isArray(p.keep)) &&
    Array.isArray(s.devices) && s.devices.length > 0 &&
    s.devices.every((d) => d && ID_RE.test(d.id) && typeof d.label === "string" && Number.isInteger(d.width) && Number.isInteger(d.height));
}

(async () => {
  let session;
  try {
    const r = await transport.getJson("/api/session");
    if (r.status !== 200) throw new Error(String(r.status));
    session = r.body;
  } catch {
    fail("The dftp server is not answering. If it was stopped, start it again and open the link it prints.");
    return;
  }
  if (!validSession(session)) {
    fail("The server's session settings were not in the expected shape. Reload this page.");
    return;
  }
  createShell({
    transport,
    el: document,
    ns: session.ns,
    storageKey: STORAGE_KEY,
    devices: session.devices,
    pages: session.pages,
    features: {
      frameOrigin: session.frameOrigin,
      themeToggle: !!(session.theme && session.theme.toggle),
      libraryPrefixes: Array.isArray(session.libraryPrefixes) ? session.libraryPrefixes : [],
      changesPath: typeof session.changesPath === "string" ? session.changesPath : ".dftp/CHANGES.md",
      version: typeof session.version === "string" ? session.version : "",
      start: typeof session.start === "string" ? session.start : "",
    },
  });
})();
