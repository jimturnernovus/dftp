#!/usr/bin/env node
// DFTP (Designer for the Page) command line.
//
//   dftp [serve] --demo | --target <url>   start the designer
//   dftp [serve] --blank [name]            design a new page from an empty canvas
//   dftp done <id...>                      remove changes that were applied in code
//   dftp where                             print where CHANGES.md is written
//   dftp scan                              read the project's styles into .dftp/tokens.json
//
// When this Node supports the permission model, the command runs itself again
// inside it (read: the tool and the project; write: the project's .dftp).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseArgs, loadConfig, resolveRoot, readVersion, readConfigFile, checkFileConfig,
  ConfigError, DEMO_PAGE_DEF,
} from "../server/config.mjs";
import { startServers } from "../server/main.mjs";
import { probeTarget, connectHostsOf } from "../server/proxy.mjs";
import { openStore, prepareDirs, StoreError, DATA_DIR } from "../server/store.mjs";
import { permissionSupported, permissionArgs } from "../server/permission.mjs";
import { DEMO_PAGE } from "../server/static.mjs";
import { openBrowser } from "../server/open-browser.mjs";
import { scanProject, summaryLines } from "../server/scan/scanner.mjs";
import { isChangeId } from "../client/core/schema.js";
import { BUILT_IN_DEVICES } from "../client/core/devices.js";

const SCRIPT = fs.realpathSync(fileURLToPath(import.meta.url));
const TOOL_DIR = path.dirname(path.dirname(SCRIPT));
const SANDBOX_ENV = "DFTP_SANDBOXED";
const inSandbox = process.env[SANDBOX_ENV] === "1";

const out = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`dftp: ${s}\n`);

const USAGE = `DFTP (Designer for the Page): a drag-and-drop layout designer for almost any web page

Usage:
  dftp [serve] --demo [--open]
  dftp [serve] --target http://localhost:5173 [--root DIR] [options]
  dftp [serve] --blank [NAME] [--root DIR] [options]
  dftp done [--root DIR] [--demo] <id> [<id> ...]
  dftp where [--root DIR] [--demo]
  dftp scan [--root DIR] [--demo]

Options:
  --demo          show the built-in demo page instead of a dev server
  --target URL    your dev server as it prints its address: http on 127.0.0.1,
                  [::1] or localhost, scheme, host and port only
  --root DIR      project folder (default: the current folder; with --demo, the DFTP folder)
  --port N        designer port, 1024-65534 (default 7450); the page is served on N+1
  --page PATH     a page of your app to offer (repeatable)
  --blank [NAME]  add a blank page styled from your project's tokens, to build a
                  new page on (repeatable; NAME makes its id blank-NAME); with
                  no --target and no --demo, blank pages are the only pages
  --open          open the designer in your browser
  --no-text       do not record any text from the page
  --debug         log each request (method, path, status, time); debug handle in the page
  --relax-csp     drop the dev page's Content-Security-Policy (dev servers only)
  --host H        127.0.0.1 (default) or ::1
  -h, --help      show this help
  -v, --version   show the version`;

function fail(e) {
  if (e instanceof ConfigError) {
    warn(e.message);
    return 2;
  }
  if (e instanceof StoreError && e.code === "unsafe") {
    warn(`refusing to start: ${e.message}`);
    return 2;
  }
  if (e instanceof StoreError) {
    warn(e.error);
    return 1;
  }
  if (e && e.code === "NO_PORT") {
    warn("no free pair of ports found; try --port with another number");
    return 1;
  }
  if (e && e.code === "ERR_ACCESS_DENIED") {
    warn("blocked by the Node permission model");
    return 1;
  }
  warn("unexpected error");
  return 1;
}

const NO_SANDBOX_NOTE = "this Node has no permission model (Node 22.13+ or 23.5+ has one); running without it";

// The same arguments with --root replaced by the resolved project folder, so
// the sandboxed run never has to resolve a path outside what it may read.
function withRoot(argv, root) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") i++;
    else if (!argv[i].startsWith("--root=")) out.push(argv[i]);
  }
  return [...out, `--root=${root}`];
}

// The only link the fenced run may ask this side to open: the designer's own
// loopback address.
const OPEN_LINK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}\/\?k=[0-9a-f]{16,128}$/;

// Run this command again inside Node's permission model and resolve to the
// child's exit code. Callers check permissionSupported() first. The fenced
// run may not start programs, so with --open it sends its link over the IPC
// channel and this side opens the browser.
function runSandboxed(argv, { root, open }) {
  const args = [...permissionArgs({ toolDir: TOOL_DIR, root }), SCRIPT, ...withRoot(argv, root)];
  const child = spawn(process.execPath, args, { stdio: ["inherit", "inherit", "inherit", "ipc"], cwd: root, env: { ...process.env, [SANDBOX_ENV]: "1" } });
  let opened = false;
  child.on("message", (m) => {
    if (!open || opened || !m || m.type !== "open") return;
    opened = true;
    const fail = () => warn("could not open a browser; open the Designer link above");
    if (typeof m.url !== "string" || !OPEN_LINK.test(m.url)) fail();
    else openBrowser(m.url, fail);
  });
  const forward = (sig) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(code === null ? (signal ? 1 : 0) : code));
  });
}

// Warn (never fail) when the dev server answers on none of the addresses the
// proxy would try.
async function checkTarget(target) {
  if (await probeTarget(target)) return;
  const tried = connectHostsOf(target).map((h) => (h.includes(":") ? `[${h}]` : h)).join(" and ");
  warn(`nothing answered at ${target.origin} (tried ${tried}, port ${target.port}). If your dev server is not running, start it and reload the designer; if it is, use the exact address it prints (often http://localhost:<port>).`);
}

async function serve(flags, argv) {
  const cfg = await loadConfig({ flags, cwd: process.cwd(), toolDir: TOOL_DIR });
  if (cfg.mode === "demo" && !fs.existsSync(path.join(cfg.root, DEMO_PAGE))) {
    throw new ConfigError(`--demo shows ${DEMO_PAGE} from the project folder, and this --root has none; leave out --root to use the demo in the DFTP folder`);
  }
  if (!inSandbox) {
    if (permissionSupported()) {
      // The sandboxed run may write only inside .dftp, so make it first.
      await prepareDirs(cfg.root, { create: true });
      return runSandboxed(argv, { root: cfg.root, open: cfg.open });
    }
    warn(NO_SANDBOX_NOTE);
  }
  const app = await startServers(cfg, { log: (line) => out(line) });
  out(`DFTP (Designer for the Page) ${cfg.version}`);
  out(`  Designer:  ${app.link}`);
  if (cfg.mode === "demo") out(`  Page:      the demo page (${DEMO_PAGE_DEF.label})`);
  else if (cfg.mode === "proxy") out(`  Page:      your dev server at ${cfg.target.origin}`);
  const blanks = cfg.pages.filter((p) => p.blank).map((p) => p.id);
  if (blanks.length) out(`  Blank:     ${blanks.join(", ")} (new pages, styled from your project's tokens)`);
  out(`  Changes:   ${DATA_DIR}/CHANGES.md in ${cfg.root === cfg.toolDir ? "the DFTP folder" : "the project folder"} (dftp where prints the full path)`);
  out("  Stop:      Ctrl+C");
  if (cfg.open) {
    if (inSandbox && typeof process.send === "function") process.send({ type: "open", url: app.openLink() });
    else openBrowser(app.openLink(), () => warn("could not open a browser; open the Designer link above"));
  }
  if (cfg.mode === "proxy") checkTarget(cfg.target).catch(() => {});
  await new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      app.close().then(resolve, resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

async function projectSettings(root, demo) {
  if (demo) return { pages: [DEMO_PAGE_DEF], devices: BUILT_IN_DEVICES, libraryPrefixes: [] };
  try {
    const file = await readConfigFile(root);
    const fc = checkFileConfig(file || {});
    return { pages: fc.pages || [], devices: fc.devices, libraryPrefixes: fc.libraryPrefixes };
  } catch (e) {
    warn(`${e.message}; using built-in settings for CHANGES.md`);
    return { pages: [], devices: BUILT_IN_DEVICES, libraryPrefixes: [] };
  }
}

async function done(flags, ids, argv) {
  if (flags.target || flags.port !== null || flags.pages.length || flags.open || flags.host !== null || flags.blank.length) {
    throw new ConfigError("done takes only --root (and --demo) and change ids");
  }
  if (ids.length === 0) throw new ConfigError("done needs at least one change id");
  for (const id of ids) {
    if (!isChangeId(id)) throw new ConfigError("change ids are 8 lower-case letters or digits, as shown in CHANGES.md");
  }
  const root = await resolveRoot(flags.root, { cwd: process.cwd(), toolDir: TOOL_DIR, demo: flags.demo });
  if (!fs.existsSync(path.join(root, DATA_DIR))) {
    out(`Nothing to do: there is no ${DATA_DIR} folder in this project.`);
    return 1;
  }
  if (!inSandbox) {
    if (permissionSupported()) {
      await prepareDirs(root, { create: true });
      return runSandboxed(argv, { root, open: false });
    }
    warn(NO_SANDBOX_NOTE);
  }
  const settings = await projectSettings(root, flags.demo);
  const store = await openStore({
    root,
    ...settings,
    version: readVersion(TOOL_DIR),
    create: true,
  });
  const r = await store.done(ids);
  out(`Removed ${r.removed.length} of ${new Set(ids).size} change(s)${r.removed.length ? `: ${r.removed.join(", ")}` : ""}.`);
  if (r.notFound.length) out(`Not found: ${r.notFound.join(", ")}`);
  if (r.unreadable.length) out(`Could not read (left as they are): ${r.unreadable.join(", ")}`);
  out(`Rebuilt ${DATA_DIR}/CHANGES.md`);
  return r.notFound.length || r.unreadable.length ? 1 : 0;
}

async function where(flags) {
  const root = await resolveRoot(flags.root, { cwd: process.cwd(), toolDir: TOOL_DIR, demo: flags.demo });
  const md = path.join(root, DATA_DIR, "CHANGES.md");
  out(md);
  if (!fs.existsSync(md)) warn("not written yet; it appears after the first save");
  return 0;
}

// Reads the project's styles (CSS, custom properties, Tailwind v4 theme
// variables, token files, HTML) into .dftp/tokens.json and prints a summary.
async function scan(flags, argv) {
  if (flags.target || flags.port !== null || flags.pages.length || flags.open || flags.host !== null || flags.blank.length) {
    throw new ConfigError("scan takes only --root (and --demo)");
  }
  const root = await resolveRoot(flags.root, { cwd: process.cwd(), toolDir: TOOL_DIR, demo: flags.demo });
  if (!inSandbox) {
    if (permissionSupported()) {
      await prepareDirs(root, { create: true });
      return runSandboxed(argv, { root, open: false });
    }
    warn(NO_SANDBOX_NOTE);
  }
  const settings = await projectSettings(root, flags.demo);
  const store = await openStore({ root, ...settings, version: readVersion(TOOL_DIR), create: true, noFingerprint: true });
  const before = await store.readTokens();
  const doc = await scanProject({
    root,
    libraryPrefixes: settings.libraryPrefixes,
    only: flags.demo ? ["demo/"] : null,
    live: before && before.live ? before.live : [],
  });
  await store.writeTokens(doc);
  for (const line of summaryLines(doc)) out(line);
  out(`Wrote ${DATA_DIR}/tokens.json`);
  return 0;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return fail(e);
  }
  const { cmd, ids, flags } = parsed;
  if (flags.help) {
    out(USAGE);
    return 0;
  }
  if (flags.version) {
    out(readVersion(TOOL_DIR));
    return 0;
  }
  try {
    if (cmd === "where") return await where(flags);
    if (cmd === "done") return await done(flags, ids, argv);
    if (cmd === "scan") return await scan(flags, argv);
    return await serve(flags, argv);
  } catch (e) {
    return fail(e);
  }
}

// Anything unexpected ends the run with a short message; the stack is shown
// only with --debug.
const showStack = process.argv.includes("--debug");
const crash = (e) => {
  if (showStack && e && e.stack) process.stderr.write(`${e.stack}\n`);
  process.exit(fail(e));
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

main(process.argv.slice(2)).then((code) => {
  process.exit(code ?? 0);
});
