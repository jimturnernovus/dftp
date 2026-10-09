// Change documents on disk, under <root>/.dftp/:
//
//   changes/<page>__<device>.json   the current document for a page and device
//   history/<page>__<device>.<time>.json   earlier versions (30 kept per pair)
//   CHANGES.md                       rebuilt after every save and every "done"
//   .lock                            held while writing (server and CLI)
//   .gitignore                       "*" so nothing here is committed by default
//   fingerprint.key                  secret for source fingerprints (owner-only)
//   tokens.json                      the style scan's result (see client/core/tokens.js)
//
// File names are built only from validated ids. Writes go to a fresh
// temporary file that is then renamed into place. A file that cannot be read
// or does not pass validation is an error, never "no changes".
//
// The three folders are identified (device and inode) when the store opens
// and checked again before each read and write, so a folder replaced by a
// link while the server runs (a branch switch can do that) is refused instead
// of followed.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { FORMAT_ID, FORMAT_VERSION, isId, isChangeId, safeParse, validateDoc } from "../client/core/schema.js";
import { validateTokensDoc, OBJECT_PROP_LIST } from "../client/core/tokens.js";
import { formatObjectValue } from "../client/core/css-values.js";
import { objectRef } from "../client/core/schema.js";
import { changesMd } from "../client/core/spec.js";
import { filesOf, createFingerprinter } from "./fingerprint.mjs";

export const DATA_DIR = ".dftp";
export const HISTORY_KEEP = 30;
export const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;
const DOC_LIMIT = 8 * 1024 * 1024;
const DOC_NAME_RE = /^([a-z0-9][a-z0-9-]{0,47})__([a-z0-9][a-z0-9-]{0,47})\.json$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
export const KEY_FILE = "fingerprint.key";
export const TOKENS_FILE = "tokens.json";
const KEY_RE = /^[0-9a-f]{64}$/;
const DIR_KEYS = ["dir", "changes", "history"];

export class StoreError extends Error {
  // code: "unsafe" (refuse to start), "unreadable", "busy", "bad-id", "invalid"
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.status = code === "unreadable" ? 500 : code === "busy" ? 503 : code === "bad-id" ? 400 : 500;
    this.error = code === "unreadable" ? "changes file unreadable" : code === "busy" ? "busy, try again" : code === "bad-id" ? "invalid page or device" : "store error";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stamp = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Check (and with create, make) the data folders. Any part that is a
// symbolic link, is not a folder, or resolves elsewhere makes this throw.
export async function prepareDirs(rootIn, { create = true } = {}) {
  const root = await fsp.realpath(rootIn);
  const rel = {
    dir: DATA_DIR,
    changes: `${DATA_DIR}/changes`,
    history: `${DATA_DIR}/history`,
  };
  const abs = {
    root,
    dir: path.join(root, DATA_DIR),
    changes: path.join(root, DATA_DIR, "changes"),
    history: path.join(root, DATA_DIR, "history"),
    md: path.join(root, DATA_DIR, "CHANGES.md"),
    lock: path.join(root, DATA_DIR, ".lock"),
    gitignore: path.join(root, DATA_DIR, ".gitignore"),
    key: path.join(root, DATA_DIR, KEY_FILE),
    tokens: path.join(root, DATA_DIR, TOKENS_FILE),
  };
  let exists = true;
  const ids = {};
  for (const key of DIR_KEYS) {
    let st = await lstatOrNull(abs[key]);
    if (!st) {
      if (!create) {
        exists = false;
        continue;
      }
      try {
        await fsp.mkdir(abs[key], { mode: 0o755 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      st = await fsp.lstat(abs[key]);
    }
    if (st.isSymbolicLink()) throw new StoreError("unsafe", `${rel[key]} is a symbolic link`);
    if (!st.isDirectory()) throw new StoreError("unsafe", `${rel[key]} is not a folder`);
    if ((await fsp.realpath(abs[key])) !== abs[key]) throw new StoreError("unsafe", `${rel[key]} resolves outside the project`);
    ids[key] = { dev: st.dev, ino: st.ino };
  }
  for (const key of ["md", "lock", "gitignore", "key", "tokens"]) {
    const st = await lstatOrNull(abs[key]);
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      throw new StoreError("unsafe", `${DATA_DIR}/${path.basename(abs[key])} is not a regular file`);
    }
  }
  if (create && !(await lstatOrNull(abs.gitignore))) {
    try {
      await fsp.writeFile(abs.gitignore, "*\n", { flag: "wx", mode: 0o644 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return { ...abs, exists, ids: Object.freeze(ids) };
}

// The folders must still be the ones prepareDirs saw: real folders (not
// links), with the same device and inode, resolving to the same place.
export async function checkDirs(dirs) {
  for (const key of DIR_KEYS) {
    const want = dirs.ids && dirs.ids[key];
    let st;
    try {
      st = await fsp.lstat(dirs[key]);
    } catch {
      throw new StoreError("unsafe", `${DATA_DIR} changed while running`);
    }
    if (!want || st.isSymbolicLink() || !st.isDirectory() || st.dev !== want.dev || st.ino !== want.ino) {
      throw new StoreError("unsafe", `${DATA_DIR} changed while running`);
    }
    let real;
    try {
      real = await fsp.realpath(dirs[key]);
    } catch {
      real = "";
    }
    if (real !== dirs[key]) throw new StoreError("unsafe", `${DATA_DIR} changed while running`);
  }
}

// The secret that keys source fingerprints, made on first use (32 random
// bytes, hex, readable by the owner only). A link or anything odd in its place
// refuses; deleting the file makes a new one (every saved fingerprint then
// reads as "changed" once).
export async function loadFingerprintKey(dirs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fh = null;
    try {
      fh = await fsp.open(dirs.key, fs.constants.O_RDONLY | NOFOLLOW);
      const st = await fh.stat();
      if (!st.isFile() || st.size > 200) throw new StoreError("unsafe", `${DATA_DIR}/${KEY_FILE} is not a key file; delete it to make a new one`);
      const text = (await fh.readFile({ encoding: "utf8" })).trim();
      if (!KEY_RE.test(text)) throw new StoreError("unsafe", `${DATA_DIR}/${KEY_FILE} is not a key file; delete it to make a new one`);
      return Buffer.from(text, "hex");
    } catch (e) {
      if (e instanceof StoreError) throw e;
      if (e.code !== "ENOENT") throw new StoreError("unsafe", `${DATA_DIR}/${KEY_FILE} cannot be read`);
    } finally {
      if (fh) await fh.close();
    }
    if (dirs.ids) await checkDirs(dirs);
    try {
      await fsp.writeFile(dirs.key, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (e.code !== "EEXIST") throw new StoreError("unsafe", `${DATA_DIR}/${KEY_FILE} cannot be written`);
    }
  }
  throw new StoreError("unsafe", `${DATA_DIR}/${KEY_FILE} cannot be read`);
}

async function readText(file) {
  let fh;
  try {
    if (!NOFOLLOW) {
      const st = await lstatOrNull(file);
      if (!st) return null;
      if (!st.isFile()) throw new StoreError("unreadable");
    }
    fh = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new StoreError("unreadable");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > DOC_LIMIT) throw new StoreError("unreadable");
    return await fh.readFile({ encoding: "utf8" });
  } catch (e) {
    throw e instanceof StoreError ? e : new StoreError("unreadable");
  } finally {
    await fh.close();
  }
}

// check: optional async function run before the temporary file is made and
// again just before it is renamed into place; it throws to stop the write.
export async function writeAtomic(file, text, check) {
  if (check) await check();
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  try {
    if (check) await check();
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

function parseDoc(text, page, device) {
  let raw;
  try {
    raw = safeParse(text);
  } catch {
    throw new StoreError("unreadable");
  }
  const r = validateDoc(raw, { page, device });
  if (!r.ok) throw new StoreError("unreadable");
  return r.value;
}

const docText = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

// opts: {root, pages:[{id,label,path,keep}], devices:[{id,label,width,height}],
//        libraryPrefixes, version, fingerprint, noFingerprint, create, now}
// Without opts.fingerprint the store makes its own from the project's key
// (store.fingerprint); the server uses that one for /api/code as well.
// noFingerprint: no key is made (a command that only writes tokens.json).
export async function openStore(opts) {
  const dirs = await prepareDirs(opts.root, { create: opts.create !== false });
  if (!opts.fingerprint && !opts.noFingerprint && dirs.exists) {
    opts = { ...opts, fingerprint: createFingerprinter(dirs.root, { key: await loadFingerprintKey(dirs) }) };
  }
  const pages = opts.pages || [];
  const devices = opts.devices || [];
  const pageIds = new Set(pages.map((p) => p.id));
  const deviceMap = new Map(devices.map((d) => [d.id, d]));
  const now = opts.now || (() => new Date());
  const version = opts.version || "0.0.0";
  let chain = Promise.resolve();
  const verify = () => checkDirs(dirs);
  const write = (file, text) => writeAtomic(file, text, verify);

  function fileFor(page, device) {
    if (!isId(page) || !isId(device)) throw new StoreError("bad-id");
    const file = path.join(dirs.changes, `${page}__${device}.json`);
    if (path.dirname(file) !== dirs.changes) throw new StoreError("bad-id");
    return file;
  }

  // The lock file names its holder, so a holder whose lock was broken as
  // stale never removes the next holder's lock.
  async function acquireLock() {
    const mark = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fsp.writeFile(dirs.lock, mark, { flag: "wx", mode: 0o644 });
        return mark;
      } catch (e) {
        if (e.code !== "EEXIST") throw new StoreError("busy");
      }
      const st = await lstatOrNull(dirs.lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.unlink(dirs.lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new StoreError("busy");
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }

  // One writer at a time: in this process by a promise chain, across
  // processes by the lock file.
  function withLock(fn) {
    const run = chain.then(async () => {
      await verify();
      const mark = await acquireLock();
      try {
        await verify();
        return await fn();
      } finally {
        const held = await fsp.readFile(dirs.lock, "utf8").catch(() => null);
        if (held === mark) await fsp.unlink(dirs.lock).catch(() => {});
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  async function writeHistory(page, device, text) {
    // 2026-01-02T03-04-05-678Z; a second save in the same millisecond gets
    // "-1" before the Z. Sorting ignores the trailing "Z.json" so such a name
    // sorts after the first one.
    const time = now().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    const base = `${page}__${device}.${time}`;
    let name = `${base}Z.json`;
    await verify();
    for (let n = 1; ; n++) {
      try {
        await fsp.writeFile(path.join(dirs.history, name), text, { flag: "wx", mode: 0o644 });
        break;
      } catch (e) {
        if (e.code !== "EEXIST" || n > 50) throw e;
        name = `${base}-${n}Z.json`;
      }
    }
    const re = new RegExp(`^${page}__${device}\\.\\d{4}-[\\dT-]+Z?\\.json$`);
    const sortKey = (f) => f.replace(/Z?\.json$/, "");
    const names = (await fsp.readdir(dirs.history))
      .filter((f) => re.test(f))
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    for (const old of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) {
      await fsp.unlink(path.join(dirs.history, old)).catch(() => {});
    }
  }

  async function docNames() {
    await verify();
    let names;
    try {
      names = await fsp.readdir(dirs.changes);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const name of names.sort()) {
      const m = DOC_NAME_RE.exec(name);
      if (m && isId(m[1]) && isId(m[2])) out.push({ name, page: m[1], device: m[2] });
    }
    return out;
  }

  async function readAll() {
    const docs = [];
    const unreadable = [];
    for (const { name, page, device } of await docNames()) {
      try {
        const text = await readText(path.join(dirs.changes, name));
        if (text !== null) docs.push(parseDoc(text, page, device));
      } catch {
        unreadable.push(`${DATA_DIR}/changes/${name}`);
      }
    }
    return { docs, unreadable };
  }

  // The tokens document on disk, or null when there is none or it does not
  // pass validation.
  async function loadTokens() {
    try {
      const text = await readText(dirs.tokens);
      if (text === null) return null;
      const r = validateTokensDoc(safeParse(text));
      return r.ok ? r.value : null;
    } catch {
      return null;
    }
  }

  // Where each token is defined, for the styles of new elements in
  // CHANGES.md: {id: [{name, file, line}]} from tokens.json, or undefined
  // when no change file holds a new element or there is no valid scan.
  function tokenSources(docs, doc) {
    if (!doc || !docs.some((d) => d.list.some((c) => c.kind === "insert"))) return undefined;
    const out = Object.create(null);
    for (const t of doc.tokens) {
      // Each name once (a variable defined for light and dark is one name),
      // at most three.
      const list = [];
      for (const s of t.sources) {
        if (!s.name && !s.file) continue;
        if (s.name && list.some((x) => x.name === s.name)) continue;
        list.push({ name: s.name || "", file: s.file || "", line: s.line });
        if (list.length === 3) break;
      }
      if (list.length) out[t.id] = list;
    }
    return out;
  }

  // The object styles new elements copy, for CHANGES.md: {name: {count,
  // found: [{name, file, line}], look: [{prop, text, token}], screens:
  // [{device, look}]}} from tokens.json (only the names the change files
  // use), {} when the scan has none of them, or undefined when no new
  // element copies one or there is no valid scan. token: the text is a
  // token id (CHANGES.md quotes every other value).
  function objectInfo(docs, doc) {
    const refs = new Set();
    for (const d of docs) for (const c of d.list) if (c.kind === "insert" && c.object) refs.add(objectRef(c.object));
    refs.delete("");
    if (!refs.size || !doc) return undefined;
    const out = Object.create(null);
    for (const o of doc.objects || []) {
      const ref = objectRef(o);
      if (!refs.has(ref)) continue;
      const found = o.sources.filter((x) => x.file).slice(0, 3).map((x) => ({ name: x.name || "", file: x.file, line: x.line }));
      const lookOf = (style) => OBJECT_PROP_LIST.filter((p) => Object.prototype.hasOwnProperty.call(style, p)).map((p) => {
        const v = style[p];
        return typeof v === "string" ? { prop: p, text: v, token: true } : { prop: p, text: formatObjectValue(p, v), token: false };
      }).filter((x) => x.text);
      const screens = Object.keys(o.screens || {}).map((device) => ({ device, look: lookOf(o.screens[device]) })).filter((x) => x.look.length);
      out[ref] = { count: o.count, found, look: lookOf(o.style), screens };
    }
    return out;
  }

  async function buildMd() {
    const { docs, unreadable } = await readAll();
    const files = filesOf(docs.flatMap((d) => d.list));
    const code = opts.fingerprint ? await opts.fingerprint.hashMany(files) : undefined;
    const scan = docs.some((d) => d.list.some((c) => c.kind === "insert")) ? await loadTokens() : null;
    const tokens = tokenSources(docs, scan);
    const objects = objectInfo(docs, scan);
    return changesMd(docs, {
      tokens,
      objects,
      notes: [
        `Rewritten on every save by DFTP (Designer for the Page) ${version} at ${stamp(now())}. Do not edit by hand.`,
        "How to apply them: see CLAUDE.md in the DFTP folder, \"Applying changes\". Paths are relative to the project root.",
      ],
      devices,
      pages,
      libraryPrefixes: opts.libraryPrefixes || [],
      code,
      unreadable,
    });
  }

  async function rebuildMd() {
    await write(dirs.md, await buildMd());
  }

  return {
    paths: Object.freeze({ dir: DATA_DIR, changes: `${DATA_DIR}/changes`, history: `${DATA_DIR}/history`, md: `${DATA_DIR}/CHANGES.md`, tokens: `${DATA_DIR}/${TOKENS_FILE}` }),
    abs: dirs,
    verify,
    fingerprint: opts.fingerprint || null,
    fileFor,
    withLock,
    readAll,
    buildMd,
    rebuildMd: () => withLock(rebuildMd),

    // The last tokens document, or null when there is none or it does not
    // pass validation (a scan then writes a new one).
    async readTokens() {
      await verify();
      return loadTokens();
    },

    // Write a tokens document; only a document that passes validation is
    // written, and what is written is the validated copy.
    async writeTokens(doc) {
      const r = validateTokensDoc(doc);
      if (!r.ok) throw new StoreError("invalid", `tokens: ${r.error}`);
      await withLock(() => write(dirs.tokens, `${JSON.stringify(r.value, null, 2)}\n`));
      return r.value;
    },

    // The current document for a page and device, or null when none is saved.
    async read(page, device) {
      const file = fileFor(page, device);
      await verify();
      const text = await readText(file);
      return text === null ? null : parseDoc(text, page, device);
    },

    // Save a validated body ({page, device, theme, list, tab, seq, base}).
    // Returns {status, body} for the HTTP reply.
    async save(v) {
      if (!v.tab) return { status: 409, body: { legacy: true } };
      if (!pageIds.has(v.page) || !deviceMap.has(v.device)) return { status: 400, body: { error: "unknown page or device" } };
      return withLock(async () => {
        const file = fileFor(v.page, v.device);
        const curText = await readText(file);
        const cur = curText === null ? null : parseDoc(curText, v.page, v.device);
        const rev = cur ? cur.rev : 0;
        const same = !!cur && cur.writer === v.tab;
        if (same && v.seq <= cur.seq) return { status: 200, body: { ok: true, stale: true, rev } };
        if (cur && !same && v.base !== rev) return { status: 409, body: { conflict: true, rev } };
        const dev = deviceMap.get(v.device);
        const doc = {
          format: FORMAT_ID,
          version: FORMAT_VERSION,
          page: v.page,
          device: v.device,
          viewport: { width: dev.width, height: dev.height },
          theme: v.theme,
          saved_at: stamp(now()),
          rev: rev + 1,
          writer: v.tab,
          seq: v.seq,
          list: v.list,
        };
        if (curText !== null) await writeHistory(v.page, v.device, curText);
        await write(file, docText(doc));
        let md = true;
        try {
          await rebuildMd();
        } catch {
          md = false;
        }
        return { status: 200, body: md ? { ok: true, rev: rev + 1 } : { ok: true, rev: rev + 1, md: false } };
      });
    },

    // Remove changes by id from every document. Each touched document gets a
    // new rev, so a designer window that still holds the old list is told to
    // reload on its next save.
    async done(ids) {
      const want = new Set(ids.filter(isChangeId));
      return withLock(async () => {
        const found = new Set();
        const unreadable = [];
        for (const { name, page, device } of await docNames()) {
          const file = path.join(dirs.changes, name);
          let text;
          let doc;
          try {
            text = await readText(file);
            if (text === null) continue;
            doc = parseDoc(text, page, device);
          } catch {
            unreadable.push(`${DATA_DIR}/changes/${name}`);
            continue;
          }
          const keep = doc.list.filter((c) => !want.has(c.id));
          if (keep.length === doc.list.length) continue;
          for (const c of doc.list) if (want.has(c.id)) found.add(c.id);
          await writeHistory(page, device, text);
          await write(file, docText({ ...doc, list: keep, rev: doc.rev + 1, writer: "cli", seq: 0, saved_at: stamp(now()) }));
        }
        await rebuildMd();
        return {
          removed: [...want].filter((id) => found.has(id)),
          notFound: [...want].filter((id) => !found.has(id)),
          unreadable,
        };
      });
    },
  };
}
