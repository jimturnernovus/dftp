// A tiny static dev server for browser tests: serves the files of one
// folder on a random loopback port (GET and HEAD only, "/" is index.html),
// so a fixture project can be shown through the proxy as a real one would.
// Paths are decoded once and must stay inside the folder.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function startStaticSite(dir) {
  const base = await fsp.realpath(dir);
  const server = http.createServer(async (req, res) => {
    const fail = (code) => {
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(code));
    };
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return fail(400);
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(base, `.${rel}`);
    if (!file.startsWith(base + path.sep)) return fail(403);
    let real;
    try {
      real = await fsp.realpath(file);
      if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) return fail(404);
    } catch {
      return fail(404);
    }
    const body = await fsp.readFile(real);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(real)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
