// Static files are served only from fixed lists: URL path -> file. The lists
// are resolved once at startup; a request path is looked up as an exact
// string and is never decoded, joined or normalised, so no request can reach
// a file that is not listed.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { TYPES } from "./guard.mjs";

// Files the designer window loads from the shell listener.
export const SHELL_FILES = Object.freeze([
  ["/shell.js", "client/shell.js"],
  ["/shell.css", "client/shell.css"],
  ["/favicon.svg", "client/favicon.svg"],
  ["/core/shell-ui.js", "client/core/shell-ui.js"],
  ["/core/spec.js", "client/core/spec.js"],
  ["/core/schema.js", "client/core/schema.js"],
  ["/core/protocol.js", "client/core/protocol.js"],
  ["/core/devices.js", "client/core/devices.js"],
]);

// The shell page itself; served at "/" with the token filled in.
export const SHELL_INDEX = "client/index.html";

// Files the layer loads from the frame listener, all under /__dftp/. The
// layer's own module sits beside the shared core modules so that its
// "./schema.js" style imports resolve to these URLs.
export const LAYER_PREFIX = "/__dftp/";
export const LAYER_FILES = Object.freeze([
  ["/__dftp/boot.js", "layer/boot.js"],
  ["/__dftp/layer.css", "layer/layer.css"],
  ["/__dftp/core/overlay.js", "layer/core/overlay.js"],
  ["/__dftp/core/spec.js", "client/core/spec.js"],
  ["/__dftp/core/schema.js", "client/core/schema.js"],
  ["/__dftp/core/protocol.js", "client/core/protocol.js"],
  ["/__dftp/core/devices.js", "client/core/devices.js"],
]);

// Demo page files, relative to the project root used in demo mode.
export const DEMO_PAGE = "demo/active-clients.html";
export const DEMO_FILES = Object.freeze([
  ["/demo.css", "demo/demo.css"],
  ["/demo.js", "demo/demo.js"],
]);

const EXT_TYPES = {
  ".html": TYPES.html,
  ".js": TYPES.js,
  ".mjs": TYPES.js,
  ".css": TYPES.css,
  ".json": TYPES.json,
  ".svg": TYPES.svg,
  ".png": TYPES.png,
  ".ico": TYPES.ico,
  ".woff2": TYPES.woff2,
  ".txt": TYPES.text,
};

export function contentTypeFor(file) {
  return EXT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
export const STATIC_LIMIT = 8 * 1024 * 1024;

// Read a regular file without following a final symbolic link.
export async function readRegularFile(file, limit = STATIC_LIMIT) {
  if (!NOFOLLOW) {
    const st = await fsp.lstat(file);
    if (!st.isFile()) throw new Error("not a regular file");
  }
  const fh = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > limit) throw new Error("not a regular file");
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

// Build a lookup table from [urlPath, relativeFile] pairs. Entries whose file
// is missing, is not a regular file, or resolves outside baseDir are left
// out. Returns {get(urlPath) -> {file, type} | undefined, paths()}.
export async function createStatic(baseDir, entries) {
  const base = await fsp.realpath(baseDir);
  const table = new Map();
  for (const [urlPath, rel] of entries) {
    if (typeof urlPath !== "string" || !urlPath.startsWith("/")) continue;
    const abs = path.resolve(base, rel);
    let real;
    try {
      real = await fsp.realpath(abs);
      const st = await fsp.stat(real);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (!real.startsWith(base + path.sep)) continue;
    table.set(urlPath, Object.freeze({ file: real, type: contentTypeFor(real) }));
  }
  return {
    get: (urlPath) => (typeof urlPath === "string" ? table.get(urlPath) : undefined),
    paths: () => [...table.keys()],
  };
}
