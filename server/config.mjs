// Command-line flags and the optional dftp.config.json, checked once at
// startup. Anything unknown or out of range stops startup with a clear
// message (exit code 2); nothing from here is ever taken from a request.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { safeParse, isId } from "../client/core/schema.js";
import { BUILT_IN_DEVICES, validateDevice, pageIdFromPath, DEVICE_LIMITS } from "../client/core/devices.js";

export const CONFIG_FILE = "dftp.config.json";
export const DEFAULT_PORT = 7450;
export const DEFAULT_LIBRARY_PREFIXES = Object.freeze(["src/components/ui/"]);
export const DEFAULT_LOC_ATTR = "data-loc";
export const DEMO_PAGE_DEF = Object.freeze({ id: "active-clients", label: "Active Clients", path: "/", keep: Object.freeze([]) });
export const DEMO_THEME = Object.freeze({ selector: "html", attribute: "data-theme", dark: "dark", light: "light" });
const CONFIG_LIMIT = 64 * 1024;
const MAX_PAGES = 100;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

const COMMANDS = new Set(["serve", "done", "where", "help"]);
const VALUE_FLAGS = new Set(["--target", "--root", "--port", "--page", "--host"]);
const BOOL_FLAGS = new Set(["--demo", "--open", "--no-text", "--debug", "--relax-csp", "--help", "-h", "--version", "-v"]);

// argv without the node binary and script. Returns
// {cmd, ids[], flags:{demo, target, root, port, pages[], open, noText, debug, relaxCsp, host, help, version}}.
export function parseArgs(argv) {
  const flags = {
    demo: false, target: null, root: null, port: null, pages: [], open: false,
    noText: false, debug: false, relaxCsp: false, host: null, help: false, version: false,
  };
  const ids = [];
  let cmd = "serve";
  let i = 0;
  if (argv.length && !argv[0].startsWith("-")) {
    if (!COMMANDS.has(argv[0])) throw new ConfigError(`unknown command "${clip(argv[0])}" (use serve, done or where)`);
    cmd = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      if (cmd !== "done") throw new ConfigError(`unexpected argument "${clip(a)}"`);
      ids.push(a);
      continue;
    }
    let name = a;
    let value = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1) {
      name = a.slice(0, eq);
      value = a.slice(eq + 1);
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === null) {
        if (i + 1 >= argv.length) throw new ConfigError(`${name} needs a value`);
        value = argv[++i];
      }
      if (name === "--target") flags.target = value;
      else if (name === "--root") flags.root = value;
      else if (name === "--host") flags.host = value;
      else if (name === "--page") flags.pages.push(value);
      else if (name === "--port") {
        if (!/^\d{1,5}$/.test(value)) throw new ConfigError("--port must be a whole number");
        flags.port = Number(value);
      }
    } else if (BOOL_FLAGS.has(name)) {
      if (value !== null) throw new ConfigError(`${name} takes no value`);
      if (name === "--demo") flags.demo = true;
      else if (name === "--open") flags.open = true;
      else if (name === "--no-text") flags.noText = true;
      else if (name === "--debug") flags.debug = true;
      else if (name === "--relax-csp") flags.relaxCsp = true;
      else if (name === "--help" || name === "-h") flags.help = true;
      else flags.version = true;
    } else {
      throw new ConfigError(`unknown option "${clip(name)}"; dftp --help lists the options`);
    }
  }
  if (cmd === "help") flags.help = true;
  return { cmd, ids, flags };
}

function clip(s) {
  return String(s).replace(/[^\x20-\x7E]/g, "?").slice(0, 40);
}

// ---------------------------------------------------------------- pieces

export function checkPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65534) {
    throw new ConfigError("--port must be between 1024 and 65534");
  }
  return port;
}

export function checkHost(host) {
  const h = host === null || host === undefined ? "127.0.0.1" : String(host);
  if (h === "127.0.0.1" || h === "::1") return h;
  if (h === "[::1]") return "::1";
  throw new ConfigError("--host must be 127.0.0.1 or ::1; this tool only listens on this computer");
}

const TARGET_HOSTS = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["[::1]", "::1"],
  ["localhost", "127.0.0.1"],
]);

// The address of the user's dev server. Only plain http on this computer.
// avoidPorts: ports the target may not use (the designer's own pair).
export function validateTarget(str, { avoidPorts = [] } = {}) {
  let u;
  try {
    u = new URL(String(str));
  } catch {
    throw new ConfigError("target must be a URL such as http://127.0.0.1:5173");
  }
  if (u.protocol === "https:") throw new ConfigError("https targets are not supported yet; use the dev server's http address");
  if (u.protocol !== "http:") throw new ConfigError("target must start with http://");
  if (u.username || u.password) throw new ConfigError("target must not contain a user name or password");
  const connectHost = TARGET_HOSTS.get(u.hostname);
  if (!connectHost) throw new ConfigError("target must be on this computer: 127.0.0.1, [::1] or localhost");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    throw new ConfigError("target must be only scheme, host and port, such as http://127.0.0.1:5173");
  }
  const port = u.port ? Number(u.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("target port must be 1-65535");
  if (avoidPorts.includes(port)) throw new ConfigError("target port is the designer's own port; pick another --port");
  return Object.freeze({
    origin: u.origin,
    hostname: u.hostname,
    port,
    hostHeader: u.host,
    connectHost,
  });
}

const PAGE_PATH_RE = /^\/(?!\/)[\x21-\x7E]{0,199}$/;
const KEEP_RE = /^[A-Za-z0-9_.-]{1,40}$/;
// eslint-disable-next-line no-control-regex
const LABEL_BAD_RE = /[\u0000-\u001F\u007F-\u009F]/;

export function checkPagePath(p, where = "page path") {
  if (typeof p !== "string" || !PAGE_PATH_RE.test(p) || p.includes("\\")) {
    throw new ConfigError(`${where} must start with a single "/" and be at most 200 plain characters`);
  }
  return p;
}

function checkPage(p, i) {
  const where = `pages[${i}]`;
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw new ConfigError(`${where} must be an object`);
  for (const k of Object.keys(p)) {
    if (!["id", "label", "path", "keep"].includes(k)) throw new ConfigError(`${where}: unknown key "${clip(k)}"`);
  }
  const pth = checkPagePath(p.path, `${where}.path`);
  const id = p.id === undefined ? pageIdFromPath(pth) : p.id;
  if (!isId(id)) throw new ConfigError(`${where}.id must be lower-case letters, digits and "-" (at most 48)`);
  const label = p.label === undefined ? pth : p.label;
  if (typeof label !== "string" || label.length === 0 || label.length > 60 || LABEL_BAD_RE.test(label)) {
    throw new ConfigError(`${where}.label must be 1-60 printable characters`);
  }
  const keep = p.keep === undefined ? [] : p.keep;
  if (!Array.isArray(keep) || keep.length > 20 || !keep.every((k) => typeof k === "string" && KEEP_RE.test(k))) {
    throw new ConfigError(`${where}.keep must be a list of query parameter names`);
  }
  return Object.freeze({ id, label, path: pth, keep: Object.freeze([...keep]) });
}

export function checkPages(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PAGES) {
    throw new ConfigError(`pages must be a list of 1-${MAX_PAGES} pages`);
  }
  const out = list.map(checkPage);
  const ids = new Set();
  for (const p of out) {
    if (ids.has(p.id)) throw new ConfigError(`page id "${p.id}" is used twice`);
    ids.add(p.id);
  }
  return Object.freeze(out);
}

// Pages from repeated --page flags: id made from the path, made unique.
export function pagesFromFlags(paths) {
  const ids = new Set();
  return Object.freeze(paths.map((p) => {
    const pth = checkPagePath(p, "--page");
    const baseId = pageIdFromPath(pth);
    let id = baseId;
    for (let n = 2; ids.has(id); n++) id = `${baseId.slice(0, 44)}-${n}`;
    ids.add(id);
    return Object.freeze({ id, label: pth, path: pth, keep: Object.freeze([]) });
  }));
}

export function checkDevices(v) {
  if (v === undefined || v === "default") return Object.freeze(BUILT_IN_DEVICES.map((d) => Object.freeze({ ...d })));
  if (!Array.isArray(v) || v.length === 0 || v.length > DEVICE_LIMITS.maxCount) {
    throw new ConfigError(`devices must be "default" or a list of 1-${DEVICE_LIMITS.maxCount} devices`);
  }
  const ids = new Set();
  return Object.freeze(v.map((d, i) => {
    const r = validateDevice(d);
    if (!r.ok) throw new ConfigError(`devices[${i}]: ${r.error}`);
    if (ids.has(r.value.id)) throw new ConfigError(`device id "${r.value.id}" is used twice`);
    ids.add(r.value.id);
    return Object.freeze(r.value);
  }));
}

const PREFIX_RE = /^[A-Za-z0-9_@$./+()[\]-]{1,200}$/;

export function checkLibraryPrefixes(v) {
  if (v === undefined) return DEFAULT_LIBRARY_PREFIXES;
  if (!Array.isArray(v) || v.length > 10) throw new ConfigError("libraryPrefixes must be a list of at most 10 folder paths");
  for (const p of v) {
    if (typeof p !== "string" || !PREFIX_RE.test(p) || p.startsWith("/") || p.split("/").includes("..")) {
      throw new ConfigError("libraryPrefixes entries must be project-relative folder paths such as \"src/components/ui/\"");
    }
  }
  return Object.freeze([...v]);
}

export function checkLocAttr(v) {
  if (v === undefined) return DEFAULT_LOC_ATTR;
  if (typeof v !== "string" || !/^data-[a-z0-9-]{1,30}$/.test(v)) throw new ConfigError("locAttribute must look like data-loc");
  return v;
}

// eslint-disable-next-line no-control-regex
const SELECTOR_BAD_RE = /[\u0000-\u001F\u007F<>`\\]/;

export function checkRootSelector(v) {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > 100 || SELECTOR_BAD_RE.test(v)) {
    throw new ConfigError("rootSelector must be a CSS selector of at most 100 characters");
  }
  return v;
}

export function checkTheme(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError("theme must be an object");
  for (const k of Object.keys(v)) {
    if (!["selector", "darkClass", "attribute", "dark", "light"].includes(k)) throw new ConfigError(`theme: unknown key "${clip(k)}"`);
  }
  const selector = v.selector === undefined ? "html" : v.selector;
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 100 || SELECTOR_BAD_RE.test(selector)) {
    throw new ConfigError("theme.selector must be a CSS selector of at most 100 characters");
  }
  const word = /^[A-Za-z0-9_-]{1,40}$/;
  if (v.darkClass !== undefined) {
    if (v.attribute !== undefined || v.dark !== undefined || v.light !== undefined) {
      throw new ConfigError("theme: use either darkClass, or attribute with dark and light");
    }
    if (typeof v.darkClass !== "string" || !word.test(v.darkClass)) throw new ConfigError("theme.darkClass must be a class name");
    return Object.freeze({ selector, darkClass: v.darkClass });
  }
  if (typeof v.attribute !== "string" || !/^data-[a-z0-9-]{1,30}$/.test(v.attribute)) {
    throw new ConfigError("theme needs darkClass, or attribute (data-*) with dark and light values");
  }
  const dark = v.dark === undefined ? "dark" : v.dark;
  const light = v.light === undefined ? "light" : v.light;
  if (typeof dark !== "string" || !word.test(dark) || typeof light !== "string" || !word.test(light)) {
    throw new ConfigError("theme.dark and theme.light must be plain words");
  }
  return Object.freeze({ selector, attribute: v.attribute, dark, light });
}

const FILE_KEYS = new Set(["target", "pages", "devices", "libraryPrefixes", "locAttribute", "rootSelector", "theme", "captureText"]);

// The parsed contents of dftp.config.json, checked. Returns the checked parts.
export function checkFileConfig(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new ConfigError(`${CONFIG_FILE} must hold a JSON object`);
  for (const k of Object.keys(obj)) {
    if (!FILE_KEYS.has(k)) throw new ConfigError(`unknown setting "${clip(k)}" in ${CONFIG_FILE}`);
  }
  if (obj.target !== undefined && typeof obj.target !== "string") throw new ConfigError("target must be a string");
  if (obj.captureText !== undefined && typeof obj.captureText !== "boolean") throw new ConfigError("captureText must be true or false");
  return {
    target: obj.target,
    pages: obj.pages === undefined ? undefined : checkPages(obj.pages),
    devices: checkDevices(obj.devices),
    libraryPrefixes: checkLibraryPrefixes(obj.libraryPrefixes),
    locAttr: checkLocAttr(obj.locAttribute),
    rootSelector: checkRootSelector(obj.rootSelector),
    theme: checkTheme(obj.theme),
    captureText: obj.captureText === undefined ? true : obj.captureText,
  };
}

export async function readConfigFile(root) {
  const file = path.join(root, CONFIG_FILE);
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new ConfigError(`cannot read ${CONFIG_FILE}`);
  }
  if (!st.isFile()) throw new ConfigError(`${CONFIG_FILE} is not a regular file`);
  if (st.size > CONFIG_LIMIT) throw new ConfigError(`${CONFIG_FILE} is larger than 64 KiB`);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    throw new ConfigError(`cannot read ${CONFIG_FILE}`);
  }
  try {
    return safeParse(text);
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON`);
  }
}

export async function resolveRoot(rootFlag, { cwd, toolDir, demo }) {
  const given = rootFlag === null || rootFlag === undefined ? (demo ? toolDir : cwd) : path.resolve(cwd, rootFlag);
  let real;
  try {
    real = await fsp.realpath(given);
  } catch {
    throw new ConfigError("--root folder does not exist");
  }
  if (!fs.statSync(real).isDirectory()) throw new ConfigError("--root must be a folder");
  return real;
}

export function readVersion(toolDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(toolDir, "package.json"), "utf8")).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Flags + config file -> the frozen settings object used everywhere else.
export async function loadConfig({ flags, cwd = process.cwd(), toolDir }) {
  const demo = !!flags.demo;
  const host = checkHost(flags.host);
  const port = checkPort(flags.port === null || flags.port === undefined ? DEFAULT_PORT : flags.port);
  const root = await resolveRoot(flags.root, { cwd, toolDir, demo });
  const file = demo ? null : await readConfigFile(root);
  const fc = file ? checkFileConfig(file) : checkFileConfig({});

  let target = null;
  let pages;
  if (demo) {
    if (flags.target) throw new ConfigError("--demo and --target cannot be used together");
    if (flags.pages.length) throw new ConfigError("--page cannot be used with --demo");
    pages = Object.freeze([DEMO_PAGE_DEF]);
  } else {
    const t = flags.target || fc.target;
    if (!t) throw new ConfigError(`--target is required (the dev server address, such as http://127.0.0.1:5173), or use --demo`);
    target = validateTarget(t, { avoidPorts: [port, port + 1] });
    if (flags.pages.length) pages = pagesFromFlags(flags.pages);
    else pages = fc.pages || Object.freeze([Object.freeze({ id: "home", label: "Home", path: "/", keep: Object.freeze([]) })]);
  }
  const hostLit = host.includes(":") ? `[${host}]` : host;
  return Object.freeze({
    mode: demo ? "demo" : "proxy",
    host,
    hostLiteral: hostLit,
    port,
    root,
    toolDir: path.resolve(toolDir),
    target,
    pages,
    devices: fc.devices,
    libraryPrefixes: fc.libraryPrefixes,
    locAttr: fc.locAttr,
    rootSelector: fc.rootSelector,
    theme: demo ? DEMO_THEME : fc.theme,
    captureText: flags.noText ? false : fc.captureText,
    debug: !!flags.debug,
    relaxCsp: !!flags.relaxCsp,
    open: !!flags.open,
    version: readVersion(toolDir),
  });
}
