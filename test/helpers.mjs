// Shared test helpers: temporary project folders, in-process servers on
// random ports, raw HTTP requests with full control over every header, and
// running the command line as a child process.

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.mjs";
import { startServers } from "../server/main.mjs";

export const TOOL_DIR = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
export const BIN = path.join(TOOL_DIR, "bin", "dftp.mjs");
export const NO_NET = path.join(TOOL_DIR, "test", "no-net.mjs");

export function randomPort() {
  const p = 20000 + Math.floor(Math.random() * 20000) * 2;
  return Math.min(p, 61998);
}

// A fresh project folder (real path). With demo, a copy of demo/ goes in it.
export async function tempRoot({ demo = true } = {}) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "dftp-test-")));
  if (demo) await fsp.cp(path.join(TOOL_DIR, "demo"), path.join(dir, "demo"), { recursive: true });
  return dir;
}

export async function removeRoot(dir) {
  if (dir && dir.startsWith(fs.realpathSync(os.tmpdir()))) await fsp.rm(dir, { recursive: true, force: true });
}

export function baseFlags(over = {}) {
  return {
    demo: true, target: null, root: null, port: randomPort(), pages: [], open: false,
    noText: false, debug: false, relaxCsp: false, host: null, help: false, version: false, ...over,
  };
}

// Start both listeners in this process. Returns {app, cfg, root, token, link,
// cookie, shellOrigin, frameOrigin, shellPort, framePort, close()}.
// cookie is the session cookie ("name=value") that opening `link` sets.
export async function startApp({ flags = {}, root, log, keepRoot = false, setup } = {}) {
  const dir = root || (await tempRoot({ demo: flags.demo !== false }));
  if (setup) await setup(dir);
  const cfg = await loadConfig({ flags: baseFlags({ root: dir, ...flags }), cwd: dir, toolDir: TOOL_DIR });
  const app = await startServers(cfg, { log });
  return {
    app,
    cfg,
    root: dir,
    token: app.token,
    link: app.link,
    cookie: app.sessionCookie,
    shellOrigin: app.shellOrigin,
    frameOrigin: app.frameOrigin,
    shellPort: app.shellPort,
    framePort: app.framePort,
    async close() {
      await app.close();
      if (!keepRoot && !root) await removeRoot(dir);
    },
  };
}

// One HTTP request with exactly the headers given (Host included; pass
// host: null to send none). Resolves {status, headers, body (Buffer), text}.
export function request(port, { method = "GET", path: p = "/", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== null) h.host = host === undefined ? `127.0.0.1:${port}` : host;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, setHost: false, agent: false });
    let done = false;
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        done = true;
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString("utf8") });
      });
      res.on("error", (e) => {
        if (!done) reject(e);
      });
    });
    req.on("error", (e) => {
      if (!done) reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Send raw bytes and collect the reply until the server closes or 1.5 s pass.
export function rawRequest(port, text, waitMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let out = "";
    const finish = () => {
      sock.destroy();
      resolve(out);
    };
    const timer = setTimeout(finish, waitMs);
    sock.on("data", (d) => {
      out += d.toString("latin1");
      if (/\r\n\r\n/.test(out)) {
        const m = /content-length:\s*(\d+)/i.exec(out);
        const head = out.indexOf("\r\n\r\n") + 4;
        if (m && out.length - head >= Number(m[1])) {
          clearTimeout(timer);
          finish();
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    sock.write(text);
  });
}

export function statusOf(raw) {
  const m = /^HTTP\/1\.1 (\d{3})/.exec(raw);
  return m ? Number(m[1]) : 0;
}

// Headers a correct write from the designer page carries.
export function writeHeaders(t, over = {}) {
  return {
    origin: t.shellOrigin,
    "x-dftp-token": t.token,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    ...over,
  };
}

// The "Designer:" line the command prints: {port, link (path + query)}.
export const DESIGNER_LINE = /Designer:\s+http:\/\/127\.0\.0\.1:(\d+)(\/\?k=[0-9a-f]{48})/;

// Open the start-up link as a browser would: returns {cookie, token, html}.
export async function openWithLink(port, linkPath) {
  const first = await request(port, { path: linkPath });
  if (first.status !== 303) throw new Error(`the start-up link answered ${first.status}`);
  const cookie = String(first.headers["set-cookie"][0]).split(";")[0];
  const page = await request(port, { path: "/", headers: { cookie } });
  const m = /name="dftp-token" content="([0-9a-f]{64})"/.exec(page.text);
  if (!m) throw new Error(`no token in the designer page (${page.status})`);
  return { cookie, token: m[1], html: page.text };
}

// Headers of a browser that opened the start-up link (for GET /).
export function pageHeaders(t, over = {}) {
  return { cookie: t.cookie, ...over };
}

export function readHeaders(t, over = {}) {
  return { "x-dftp-token": t.token, "sec-fetch-site": "same-origin", ...over };
}

export function sampleChange(over = {}) {
  return {
    id: "abcd1234",
    key: "demo/active-clients.html:1:102#0",
    loc: "demo/active-clients.html:1:102",
    occ: 0,
    tag: "h1",
    text: "Active Clients",
    dx: 12,
    dy: -4,
    base: { x: 10, y: 20, w: 300, h: 40 },
    at: "2026-01-02T03:04:05Z",
    ...over,
  };
}

export function saveBody(over = {}) {
  return {
    page: "active-clients",
    device: "desktop",
    theme: "light",
    list: [sampleChange()],
    tab: "tab-one",
    seq: 1,
    base: 0,
    ...over,
  };
}

export async function save(t, over = {}, headers) {
  return request(t.shellPort, {
    method: "POST",
    path: "/api/changes",
    headers: headers || writeHeaders(t),
    body: JSON.stringify(saveBody(over)),
  });
}

export function docPath(root, page = "active-clients", device = "desktop") {
  return path.join(root, ".dftp", "changes", `${page}__${device}.json`);
}

export async function mtimeOf(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run the CLI as a child process. Returns {child, out(), err(), waitFor(re, ms), exit()}.
export function runCli(args, { cwd = TOOL_DIR, env = {}, noNet = true } = {}) {
  const nodeOptions = noNet ? `--import=${NO_NET}` : "";
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: nodeOptions, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // Signals go to the whole process group, so a sandboxed child started by
  // the command is stopped with it.
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    out: () => stdout,
    err: () => stderr,
    exited,
    async waitFor(re, ms = 8000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = re.exec(stdout);
        if (m) return m;
        if (child.exitCode !== null) break;
        await sleep(25);
      }
      throw new Error(`timed out waiting for output; exit=${child.exitCode} stderr=${stderr.slice(0, 300)}`);
    },
    async stop() {
      signal("SIGTERM");
      const r = await Promise.race([exited, sleep(5000).then(() => null)]);
      signal("SIGKILL");
      return r || exited;
    },
  };
}
