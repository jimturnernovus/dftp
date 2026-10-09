// The walk over a project for the style scan. It reads only inside the
// project root (after resolving links), never follows a link to a folder,
// and leaves out:
//
//   - every name starting with "." (.env files, .git, .dftp, editor folders),
//   - node_modules, dist, build, out, coverage and other output folders,
//   - key, certificate and credential files and folders (*.pem, *.key,
//     id_rsa, anything named for secrets or credentials),
//   - whatever the project's .gitignore files exclude,
//   - files no adapter asks for, binary files and files over 1 MiB.
//
// It stops at fixed budgets (files read, entries seen, bytes, time, depth)
// and reports why with a diagnostic code; it never reports file contents.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isFilePath } from "../../client/core/schema.js";
import { createIgnore, IGNORE_LIMITS } from "./ignore.mjs";

export const WALK_LIMITS = Object.freeze({
  files: 5000,
  entries: 50000,
  depth: 24,
  ms: 10000,
  fileBytes: 1024 * 1024,
  totalBytes: 48 * 1024 * 1024,
});

export const SKIP_DIRS = Object.freeze(["node_modules", "dist", "build", "out", "coverage", "bower_components", "jspm_packages", "vendor"]);
const SKIP_DIR_SET = new Set(SKIP_DIRS);
const SECRET_EXT_RE = /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|asc|gpg|ppk)$/;
const SSH_KEY_RE = /^id_(rsa|dsa|ecdsa|ed25519)/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// Opening a FIFO (or another special file) for reading would wait for a
// writer that never comes; with O_NONBLOCK the open returns at once and the
// type check that follows skips it.
const OPEN_FLAGS = fs.constants.O_RDONLY | NOFOLLOW | (fs.constants.O_NONBLOCK || 0);
const utf8 = new TextDecoder("utf-8");

// A file name that may hold a key or a secret, read or not.
export function isSecretName(name) {
  const n = String(name).toLowerCase();
  return n.startsWith(".env") || SECRET_EXT_RE.test(n) || SSH_KEY_RE.test(n) || n.includes("secret") || n.includes("credential");
}

// A path (relative, "/"-separated) the walk may read at all.
export function isScannablePath(rel) {
  if (!isFilePath(rel)) return false;
  const segs = rel.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.startsWith(".") || isSecretName(s)) return false;
    if (i < segs.length - 1 && SKIP_DIR_SET.has(s.toLowerCase())) return false;
  }
  return true;
}

async function readSmall(abs, limit) {
  let fh;
  try {
    // Only an ordinary file is opened at all.
    const pre = await fsp.lstat(abs);
    if (!pre.isFile()) return null;
    fh = await fsp.open(abs, OPEN_FLAGS);
    const st = await fh.stat();
    if (!st.isFile() || st.size > limit) return null;
    return await fh.readFile({ encoding: "utf8" });
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Yields {rel, text} for every file `wants(rel)` accepts, in a fixed order.
// state: {diagnostics: [], stats: {files, skipped, truncated}} is filled in.
// signal: an AbortSignal that ends the walk early (truncated).
export async function* walkProject(root, { wants, limits: over = {}, signal, state, now = () => Date.now() }) {
  const limits = { ...WALK_LIMITS, ...over };
  const base = await fsp.realpath(root);
  const started = now();
  const diag = (code, rel) => {
    const d = { adapter: "scan", code };
    if (rel && isFilePath(rel)) d.file = rel;
    state.diagnostics.push(d);
  };
  const stop = (code) => {
    state.stats.truncated = true;
    if (code) diag(code);
  };
  const ignore = createIgnore();
  const seen = new Set();
  let entries = 0;
  let bytes = 0;
  const stack = [{ abs: base, rel: "", depth: 0 }];

  // Reads one file already known to be inside the root. Returns the text,
  // null to skip it, or false to end the walk.
  async function read(abs, rel) {
    if (state.stats.files >= limits.files) {
      stop("budget-files");
      return false;
    }
    let fh;
    try {
      fh = await fsp.open(abs, OPEN_FLAGS);
    } catch {
      diag("unreadable", rel);
      return null;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const id = `${st.dev}:${st.ino}`;
      if (seen.has(id)) return null;
      seen.add(id);
      if (st.size > limits.fileBytes) {
        diag("too-large", rel);
        return null;
      }
      if (bytes + st.size > limits.totalBytes) {
        stop("budget-bytes");
        return false;
      }
      const buf = await fh.readFile();
      bytes += buf.length;
      state.stats.files++;
      if (buf.subarray(0, 8192).includes(0)) {
        diag("binary", rel);
        return null;
      }
      return utf8.decode(buf);
    } catch {
      diag("unreadable", rel);
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  while (stack.length) {
    const dir = stack.pop();
    // A folder swapped for a link after it was listed resolves elsewhere;
    // it is skipped rather than followed.
    let realDir;
    try {
      realDir = await fsp.realpath(dir.abs);
    } catch {
      realDir = "";
    }
    if (realDir !== dir.abs) {
      diag("symlink-skip", dir.rel);
      continue;
    }
    const gi = await readSmall(path.join(dir.abs, ".gitignore"), IGNORE_LIMITS.file);
    if (gi !== null) ignore.add(gi, dir.rel);
    let list;
    try {
      list = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      diag("unreadable", dir.rel);
      continue;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const ent of list) {
      if (signal && signal.aborted) {
        stop(null);
        return;
      }
      if (++entries > limits.entries) {
        stop("budget-entries");
        return;
      }
      if (now() - started > limits.ms) {
        stop("budget-time");
        return;
      }
      const name = ent.name;
      if (name.startsWith(".")) continue;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const abs = path.join(dir.abs, name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_SET.has(name.toLowerCase()) || isSecretName(name) || dir.depth + 1 > limits.depth) continue;
        if (ignore.ignored(rel, true)) continue;
        subdirs.push({ abs, rel, depth: dir.depth + 1 });
        continue;
      }
      if (isSecretName(name) || !wants(rel)) continue;
      if (ignore.ignored(rel, false)) continue;
      if (!isFilePath(rel)) {
        state.stats.skipped++;
        continue;
      }
      let target = abs;
      if (ent.isSymbolicLink()) {
        // A link is read only when it ends at an ordinary file inside the
        // root that the walk would read under its own name too.
        let real;
        try {
          real = await fsp.realpath(abs);
        } catch {
          diag("symlink-outside", rel);
          continue;
        }
        if (!real.startsWith(base + path.sep)) {
          diag("symlink-outside", rel);
          continue;
        }
        const realRel = path.relative(base, real).split(path.sep).join("/");
        let st;
        try {
          st = await fsp.lstat(real);
        } catch {
          diag("unreadable", rel);
          continue;
        }
        if (!st.isFile() || !isScannablePath(realRel) || ignore.ignored(realRel, false)) {
          diag("symlink-skip", rel);
          continue;
        }
        target = real;
      } else if (!ent.isFile()) continue;
      const text = await read(target, rel);
      if (text === false) return;
      if (text !== null) yield { rel, text };
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  if (ignore.capped) diag("ignore-rules-capped");
}
