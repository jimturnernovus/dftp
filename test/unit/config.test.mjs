import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseArgs, loadConfig, validateTarget, checkFileConfig, ConfigError, CONFIG_FILE, DEFAULT_PORT,
} from "../../server/config.mjs";
import { TOOL_DIR, tempRoot, removeRoot, baseFlags } from "../helpers.mjs";

const isConfigError = (e) => e instanceof ConfigError && e.exitCode === 2;

async function withRoot(fn, { demo = false } = {}) {
  const root = await tempRoot({ demo });
  try {
    await fn(root);
  } finally {
    await removeRoot(root);
  }
}

const load = (root, flags) => loadConfig({ flags: baseFlags({ demo: false, root, port: 7450, ...flags }), cwd: root, toolDir: TOOL_DIR });
const writeConfig = (root, obj) => fsp.writeFile(path.join(root, CONFIG_FILE), typeof obj === "string" ? obj : JSON.stringify(obj));

test("argument parsing", () => {
  const a = parseArgs(["--demo", "--open", "--port", "8000", "--page", "/a", "--page=/b", "--no-text", "--debug", "--relax-csp"]);
  assert.equal(a.cmd, "serve");
  assert.deepEqual(a.flags.pages, ["/a", "/b"]);
  assert.equal(a.flags.port, 8000);
  assert.ok(a.flags.demo && a.flags.open && a.flags.noText && a.flags.debug && a.flags.relaxCsp);
  const d = parseArgs(["done", "--root", ".", "abcd1234", "efgh5678"]);
  assert.equal(d.cmd, "done");
  assert.deepEqual(d.ids, ["abcd1234", "efgh5678"]);
  assert.equal(parseArgs(["where"]).cmd, "where");
  assert.ok(parseArgs(["help"]).flags.help);
  for (const bad of [["--nope"], ["deploy"], ["--port"], ["--port", "abc"], ["--demo=1"], ["serve", "extra"], ["--target"]]) {
    assert.throws(() => parseArgs(bad), isConfigError, bad.join(" "));
  }
});

test("demo mode defaults", async () => {
  const cfg = await loadConfig({ flags: baseFlags({ demo: true, root: null, port: null }), cwd: "/", toolDir: TOOL_DIR });
  assert.equal(cfg.mode, "demo");
  assert.equal(cfg.root, TOOL_DIR, "the demo writes into the tool folder unless --root is given");
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.equal(cfg.host, "127.0.0.1");
  assert.deepEqual(cfg.pages.map((p) => p.id), ["active-clients"]);
  assert.deepEqual(cfg.devices.map((d) => d.id), ["desktop", "tablet", "phone"]);
  assert.ok(cfg.theme && cfg.theme.attribute === "data-theme");
  assert.equal(cfg.target, null);
  assert.ok(Object.isFrozen(cfg));
  await assert.rejects(loadConfig({ flags: baseFlags({ demo: true, target: "http://127.0.0.1:5173" }), cwd: "/", toolDir: TOOL_DIR }), isConfigError);
});

test("proxy mode needs a target on this computer", () => withRoot(async (root) => {
  await assert.rejects(load(root, {}), isConfigError);
  const ten = ["10", "0", "0", "1"].join(".");
  for (const bad of [
    "http://example.com", `http://${ten}`, "http://10.1:3000", "https://127.0.0.1:1", "http://u:p@127.0.0.1:3000",
    "http://127.0.0.1:7451", "http://127.0.0.1:7450", "ftp://127.0.0.1:21", "http://127.2:3000",
    "http://[fe80::1]:3000", "http://2852039166/", "http://127.0.0.1:3000/app", "http://127.0.0.1:3000/?x=1",
    "not a url", "http://127.0.0.1:99999",
  ]) {
    await assert.rejects(load(root, { target: bad }), isConfigError, bad);
  }
  const a = await load(root, { target: "http://127.0.0.1:5173" });
  assert.deepEqual({ ...a.target }, { origin: "http://127.0.0.1:5173", hostname: "127.0.0.1", port: 5173, hostHeader: "127.0.0.1:5173", connectHost: "127.0.0.1" });
  const b = await load(root, { target: "http://localhost:3000/" });
  assert.equal(b.target.hostHeader, "localhost:3000");
  assert.equal(b.target.connectHost, "127.0.0.1");
  const c = await load(root, { target: "http://[::1]:8080" });
  assert.equal(c.target.connectHost, "::1");
  assert.equal(validateTarget("http://127.0.0.1").port, 80);
  assert.deepEqual(a.pages.map((p) => p.id), ["home"]);
}));

test("host and port", () => withRoot(async (root) => {
  const t = { target: "http://127.0.0.1:5173" };
  await assert.rejects(load(root, { ...t, host: "0.0.0.0" }), isConfigError);
  await assert.rejects(load(root, { ...t, host: "fe80::1" }), isConfigError);
  await assert.rejects(load(root, { ...t, host: "localhost" }), isConfigError);
  assert.equal((await load(root, { ...t, host: "::1" })).hostLiteral, "[::1]");
  await assert.rejects(load(root, { ...t, port: 80 }), isConfigError);
  await assert.rejects(load(root, { ...t, port: 65535 }), isConfigError);
  await assert.rejects(load(root, { ...t, root: path.join(root, "missing") }), isConfigError);
}));

test("--page flags and --no-text", () => withRoot(async (root) => {
  const cfg = await load(root, { target: "http://127.0.0.1:5173", pages: ["/", "/clients", "/clients/"], noText: true });
  assert.deepEqual(cfg.pages.map((p) => p.id), ["home", "clients", "clients-2"]);
  assert.equal(cfg.captureText, false);
  await assert.rejects(load(root, { target: "http://127.0.0.1:5173", pages: ["//evil.example/x"] }), isConfigError);
  await assert.rejects(load(root, { target: "http://127.0.0.1:5173", pages: ["relative"] }), isConfigError);
}));

test("config file: valid settings load", () => withRoot(async (root) => {
  await writeConfig(root, {
    target: "http://127.0.0.1:5173",
    pages: [{ id: "home", label: "Home", path: "/", keep: ["id"] }, { label: "Clients", path: "/clients?id=1" }],
    devices: [{ id: "wide", label: "Wide", width: 1920, height: 1080 }, { id: "small", width: 320, height: 640 }],
    libraryPrefixes: ["src/ui/"],
    locAttribute: "data-src-loc",
    rootSelector: "#app",
    theme: { selector: "html", darkClass: "dark" },
    captureText: false,
  });
  const cfg = await load(root, {});
  assert.equal(cfg.target.port, 5173);
  assert.deepEqual(cfg.pages.map((p) => p.id), ["home", "clients"]);
  assert.deepEqual(cfg.pages[0].keep, ["id"]);
  assert.deepEqual(cfg.devices.map((d) => d.id), ["wide", "small"]);
  assert.deepEqual([...cfg.libraryPrefixes], ["src/ui/"]);
  assert.equal(cfg.locAttr, "data-src-loc");
  assert.equal(cfg.rootSelector, "#app");
  assert.deepEqual({ ...cfg.theme }, { selector: "html", darkClass: "dark" });
  assert.equal(cfg.captureText, false);
  const flagWins = await load(root, { target: "http://127.0.0.1:4000" });
  assert.equal(flagWins.target.port, 4000);
}));

test("config file: every invalid field refuses startup", () => withRoot(async (root) => {
  const t = { target: "http://127.0.0.1:5173" };
  const bad = [
    { ...t, unknown: 1 },
    { ...t, pages: [] },
    { ...t, pages: [{ path: "//x" }] },
    { ...t, pages: [{ path: "/a", label: "x".repeat(61) }] },
    { ...t, pages: [{ path: "/a", keep: ["a b"] }] },
    { ...t, pages: [{ path: "/a", id: "A" }] },
    { ...t, pages: [{ path: "/a", extra: 1 }] },
    { ...t, pages: [{ path: "/a" }, { path: "/a" }] },
    { ...t, pages: [{ path: `/${"x".repeat(200)}` }] },
    { ...t, devices: [{ id: "w", width: 100, height: 500 }] },
    { ...t, devices: [{ id: "w", width: 500, height: 500 }, { id: "w", width: 600, height: 600 }] },
    { ...t, devices: "all" },
    { ...t, libraryPrefixes: ["../outside/"] },
    { ...t, libraryPrefixes: ["/abs/"] },
    { ...t, libraryPrefixes: "src/ui/" },
    { ...t, locAttribute: "loc" },
    { ...t, locAttribute: "data-LOC" },
    { ...t, rootSelector: "x".repeat(101) },
    { ...t, rootSelector: "<script>" },
    { ...t, theme: { darkClass: "a b" } },
    { ...t, theme: { attribute: "class" } },
    { ...t, theme: { darkClass: "dark", attribute: "data-theme" } },
    { ...t, theme: { selector: "html", other: 1 } },
    { ...t, captureText: "yes" },
    { ...t, target: 5173 },
    { ...t, target: "http://example.com" },
    [],
  ];
  for (const obj of bad) {
    await writeConfig(root, obj);
    await assert.rejects(load(root, {}), isConfigError, JSON.stringify(obj));
  }
  await writeConfig(root, "{ not json");
  await assert.rejects(load(root, {}), isConfigError);
  await writeConfig(root, '{"__proto__":{"polluted":1}}');
  await assert.rejects(load(root, {}), isConfigError);
  assert.equal(({}).polluted, undefined);
  await writeConfig(root, `{"target":"http://127.0.0.1:5173","x":"${"a".repeat(70000)}"}`);
  await assert.rejects(load(root, {}), (e) => isConfigError(e) && /64 KiB/.test(e.message));
}));

test("checkFileConfig on an empty object gives the built-in settings", () => {
  const fc = checkFileConfig({});
  assert.equal(fc.devices.length, 3);
  assert.deepEqual([...fc.libraryPrefixes], ["src/components/ui/"]);
  assert.equal(fc.locAttr, "data-loc");
  assert.equal(fc.captureText, true);
  assert.equal(fc.theme, null);
});
