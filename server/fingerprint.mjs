// Fingerprints of project source files named by change locations. A
// fingerprint is the first 12 hex characters of an HMAC-SHA256 of the file,
// keyed with a per-project secret kept in .dftp/ (see store.mjs). Without the
// key the value cannot be compared against guesses of a file's contents, and
// file contents themselves never leave this module.
//
// Only ordinary source files are fingerprinted: no path segment may start
// with "." (so .env, .git/ and .dftp/ are out) or be node_modules, and the
// extension must be a known source or style type. Anything else, a file
// outside the project root (after resolving links), a missing file or one
// too large to hash gives null, and the caller cannot tell these apart.

import { createHmac } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { isFilePath, splitLoc } from "../client/core/schema.js";

export const HASH_LIMIT = 8 * 1024 * 1024;
const CACHE_MAX = 5000;

export const SOURCE_EXTENSIONS = Object.freeze([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ".html", ".htm", ".css", ".scss", ".less", ".mdx",
]);
const SOURCE_SET = new Set(SOURCE_EXTENSIONS);

// A project-relative path that may be fingerprinted.
export function isSourcePath(file) {
  if (!isFilePath(file)) return false;
  const segs = file.split("/");
  if (segs.some((s) => s.startsWith(".") || s.toLowerCase() === "node_modules")) return false;
  return SOURCE_SET.has(path.posix.extname(file).toLowerCase());
}

// key: a Buffer of at least 16 bytes (store.loadFingerprintKey).
export function createFingerprinter(root, { key, limit = HASH_LIMIT } = {}) {
  if (!Buffer.isBuffer(key) || key.length < 16) throw new TypeError("a fingerprint key is required");
  const secret = Buffer.from(key);
  const base = path.resolve(root);
  const cache = new Map();

  async function hash(file) {
    if (!isSourcePath(file)) return null;
    const abs = path.join(base, file);
    let real;
    let st;
    try {
      real = await fsp.realpath(abs);
      if (!real.startsWith(base + path.sep)) return null;
      // The resolved file must pass the same test: a link named "a.js" that
      // points at ".env" inside the project is refused too.
      if (!isSourcePath(path.relative(base, real).split(path.sep).join("/"))) return null;
      st = await fsp.stat(real);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > limit) return null;
    const hit = cache.get(real);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
    let buf;
    try {
      buf = await fsp.readFile(real);
    } catch {
      return null;
    }
    const sha = createHmac("sha256", secret).update(buf).digest("hex").slice(0, 12);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(real, { mtimeMs: st.mtimeMs, size: st.size, sha });
    return sha;
  }

  // {file: sha|null} for each distinct valid path, a few at a time.
  async function hashMany(files) {
    const list = [...new Set(files)].filter(isFilePath);
    const shas = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        shas[i] = await hash(list[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    const out = Object.create(null);
    list.forEach((f, i) => {
      out[f] = shas[i];
    });
    return out;
  }

  return { hash, hashMany };
}

// The source files a list of changes points at.
export function filesOf(list) {
  const files = new Set();
  for (const c of list || []) {
    for (const loc of [c.loc, c.used_in]) {
      const m = splitLoc(loc);
      if (m) files.add(m.file);
    }
  }
  return [...files];
}
