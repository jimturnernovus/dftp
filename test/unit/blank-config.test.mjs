// --blank on the command line: parsing, the pages it adds, the modes it
// gives with and without a dev server, and what the commands that do not
// serve make of it.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseArgs, loadConfig, blankPagesFrom, ConfigError, CONFIG_FILE, BLANK_THEME, MAX_BLANK_PAGES,
} from "../../server/config.mjs";
import { blankPath } from "../../server/blank.mjs";
import { sessionInfo } from "../../server/shell-app.mjs";
import { TOOL_DIR, tempRoot, removeRoot, baseFlags, runCli, randomPort } from "../helpers.mjs";

const isConfigError = (e) => e instanceof ConfigError && e.exitCode === 2;
const load = (root, flags) => loadConfig({ flags: baseFlags({ demo: false, root, port: 7460, ...flags }), cwd: root, toolDir: TOOL_DIR });

async function withRoot(fn) {
  const root = await tempRoot({ demo: false });
  try {
    await fn(root);
  } finally {
    await removeRoot(root);
  }
}

test("--blank takes an optional name in every spelling, and repeats", () => {
  assert.deepEqual(parseArgs(["--blank"]).flags.blank, [null]);
  assert.deepEqual(parseArgs(["--blank", "pricing", "--open"]).flags.blank, ["pricing"]);
  assert.deepEqual(parseArgs(["--blank=pricing", "--blank", "--blank", "about"]).flags.blank, ["pricing", null, "about"]);
  assert.deepEqual(parseArgs(["--blank", "--root", "."]).flags.blank, [null], "a following option is not a name");
  assert.deepEqual(parseArgs(["--demo"]).flags.blank, []);
  // Only serve takes a name after the flag; done keeps its ids.
  const d = parseArgs(["done", "--blank", "abcd1234"]);
  assert.deepEqual(d.flags.blank, [null]);
  assert.deepEqual(d.ids, ["abcd1234"]);
});

test("blank pages: ids, labels and paths, and bad names", () => {
  const pages = blankPagesFrom([null, "pricing"]);
  assert.deepEqual(pages.map((p) => p.id), ["blank", "blank-pricing"]);
  assert.deepEqual(pages.map((p) => p.path), [blankPath("blank"), blankPath("blank-pricing")]);
  assert.ok(pages.every((p) => p.blank === true && p.keep.length === 0 && Object.isFrozen(p)));
  assert.equal(pages[1].label, "Blank: pricing");
  for (const bad of [[""], ["Pricing"], ["a b"], ["../x"], ["-x"], ["x".repeat(43)], [null, null], ["a", "a"], [7]]) {
    assert.throws(() => blankPagesFrom(bad), isConfigError, JSON.stringify(bad));
  }
  assert.throws(() => blankPagesFrom(Array.from({ length: MAX_BLANK_PAGES + 1 }, (_, i) => `p${i}`)), isConfigError);
  assert.deepEqual(blankPagesFrom(undefined), []);
});

test("without a dev server, blank pages are the only pages", () => withRoot(async (root) => {
  const cfg = await load(root, { blank: [null, "pricing"] });
  assert.equal(cfg.mode, "blank");
  assert.equal(cfg.target, null);
  assert.deepEqual(cfg.pages.map((p) => p.id), ["blank", "blank-pricing"]);
  assert.deepEqual(cfg.theme, BLANK_THEME, "a Light / Dark switch of its own");
  await assert.rejects(load(root, { blank: [null], pages: ["/x"] }), isConfigError);
  await assert.rejects(load(root, {}), isConfigError, "still a target, --demo or --blank");
  // A theme setting in the config file is used for blank pages too.
  await fsp.writeFile(path.join(root, CONFIG_FILE), JSON.stringify({ theme: { selector: "html", darkClass: "dark" } }));
  assert.deepEqual((await load(root, { blank: [null] })).theme, { selector: "html", darkClass: "dark" });
}));

test("with a dev server or the demo, blank pages come after the app's pages", () => withRoot(async (root) => {
  const proxy = await load(root, { blank: [null], target: "http://127.0.0.1:5173" });
  assert.equal(proxy.mode, "proxy");
  assert.deepEqual(proxy.pages.map((p) => p.id), ["home", "blank"]);
  assert.equal(proxy.theme, null);
  await fsp.writeFile(path.join(root, CONFIG_FILE), JSON.stringify({ pages: [{ id: "blank-a", path: "/a" }] }));
  await assert.rejects(load(root, { blank: ["a"], target: "http://127.0.0.1:5173" }), isConfigError, "an id used twice");
  const demo = await loadConfig({ flags: baseFlags({ demo: true, root: null, port: 7460, blank: ["x"] }), cwd: "/", toolDir: TOOL_DIR });
  assert.equal(demo.mode, "demo");
  assert.deepEqual(demo.pages.map((p) => p.id), ["active-clients", "blank-x"]);
}));

test("the help lists --blank; done and scan refuse it", async () => {
  const h = runCli(["--help"]);
  assert.equal((await h.exited).code, 0);
  assert.match(h.out(), /--blank \[NAME\]/);
  for (const args of [["done", "--blank", "--demo", "abcd1234"], ["scan", "--blank", "--demo"]]) {
    const c = runCli(args);
    const r = await c.exited;
    assert.equal(r.code, 2, args.join(" "));
    assert.match(c.err(), /takes only --root/);
  }
  const bad = runCli(["--blank=Bad", "--port", String(randomPort())]);
  assert.equal((await bad.exited).code, 2);
  assert.match(bad.err(), /--blank NAME/);
});

test("--blank starts on the first blank page, also when the config file names a target", () => withRoot(async (root) => {
  await fsp.writeFile(path.join(root, CONFIG_FILE), JSON.stringify({ target: "http://127.0.0.1:5173", pages: [{ id: "home", label: "Home", path: "/" }] }));
  const cfg = await load(root, { blank: [null] });
  assert.equal(cfg.mode, "proxy", "a target in the config file keeps the app's pages");
  assert.deepEqual(cfg.pages.map((p) => p.id), ["home", "blank"], "listed first");
  assert.equal(cfg.startPage, "blank");
  const info = sessionInfo({ cfg, frameOrigin: "http://127.0.0.1:7461", store: { paths: { md: ".dftp/CHANGES.md" } } });
  assert.equal(info.start, "blank");
  const plain = await load(root, {});
  assert.equal(plain.startPage, "home");
  assert.equal(sessionInfo({ cfg: plain, frameOrigin: "http://127.0.0.1:7461", store: { paths: { md: ".dftp/CHANGES.md" } } }).start, "home");
}));

test("the designer window opens on the start page it is given, before the page it showed last", async () => {
  const src = await fsp.readFile(path.join(TOOL_DIR, "client", "core", "shell-ui.js"), "utf8");
  assert.match(src, /features\.start && features\.start !== pages\[0\]\.id && pageById\(features\.start\) \? features\.start :/);
  const boot = await fsp.readFile(path.join(TOOL_DIR, "client", "shell.js"), "utf8");
  assert.match(boot, /start: typeof session\.start === "string" \? session\.start : ""/);
});
