// The optional data-loc stamping plugins: Babel (JSX/TSX), the Vite wrapper
// and the Vue template transform.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TOOL_DIR } from "../helpers.mjs";
import { isLoc } from "../../client/core/schema.js";
import viteDataLoc, { MISSING_BABEL, loadProjectBabel } from "../../plugins/vite-plugin-data-loc.mjs";
import vueDataLoc from "../../plugins/vue-data-loc.mjs";

const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const dataLoc = require("../../plugins/babel-plugin-data-loc.cjs");

// A project root that only needs to exist as a path.
const ROOT = path.join(os.tmpdir(), "dftp-plugin-root");

const JSX = [
  "import { Button } from \"./components/ui/button\";",
  "export function App({ items }) {",
  "  return (",
  "    <main className=\"app\">",
  "      <h1>Hello</h1>",
  "      <Button variant=\"primary\">Go</Button>",
  "      <ui.Card />",
  "      <svg:rect />",
  "      <section data-loc=\"keep/me.jsx:1:1\"><span>x</span></section>",
  "      {items.map((i) => <li key={i}>{i}</li>)}",
  "      <my-widget />",
  "      <>",
  "        <p>in a fragment</p>",
  "      </>",
  "    </main>",
  "  );",
  "}",
].join("\n");

const TSX = [
  "type Props = { title: string };",
  "const id = <T,>(a: T): T => a;",
  "export default function Page(props: Props) {",
  "  return <div title={props.title as string}>",
  "    <p>{id<string>(props.title)}</p>",
  "  </div>;",
  "}",
].join("\n");

function stamp(code, filename, { ts = false, opts = { root: ROOT } } = {}) {
  return babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { plugins: ["jsx", ...(ts ? ["typescript"] : [])] },
    plugins: [[dataLoc, opts]],
    retainLines: true,
  }).code;
}

function stampsIn(code, attr = "data-loc") {
  return [...code.matchAll(new RegExp(`<([A-Za-z][\\w.:-]*)[^>]*?\\s${attr}="([^"]+)"`, "g"))].map((m) => ({ tag: m[1], loc: m[2] }));
}

function sourceAt(src, loc) {
  const [, l, c] = /:(\d+):(\d+)$/.exec(loc);
  const line = src.split("\n")[Number(l) - 1];
  return line.slice(Number(c) - 1);
}

async function withEnv(value, fn) {
  const before = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

// ---------------------------------------------------------------- Babel

test("babel: host elements get a relative POSIX file:line:col that points at their '<'", () => withEnv("development", () => {
  const out = stamp(JSX, path.join(ROOT, "src", "App.jsx"));
  const stamps = stampsIn(out).filter((s) => s.loc.startsWith("src/"));
  assert.deepEqual(stamps.map((s) => s.tag), ["main", "h1", "span", "li", "my-widget", "p"]);
  for (const s of stamps) {
    assert.ok(s.loc.startsWith("src/App.jsx:"), s.loc);
    assert.ok(isLoc(s.loc), `${s.loc} is a valid change location`);
    assert.ok(sourceAt(JSX, s.loc).startsWith(`<${s.tag}`), `${s.loc} points at <${s.tag}`);
  }
  assert.ok(!/<Button[^>]*data-loc/.test(out), "components are not stamped");
  assert.ok(!/<ui\.Card[^>]*data-loc/.test(out), "member-expression components are not stamped");
  assert.ok(!/<svg:rect[^>]*data-loc/.test(out), "namespaced names are not stamped");
  assert.equal((out.match(/data-loc=/g) || []).length, stamps.length + 1, "an existing data-loc is kept, not doubled");
  assert.ok(out.includes("data-loc=\"keep/me.jsx:1:1\""));
}));

test("babel: TSX with generics and type assertions", () => withEnv("development", () => {
  const out = stamp(TSX, path.join(ROOT, "src", "views", "page.tsx"), { ts: true });
  const stamps = stampsIn(out);
  assert.deepEqual(stamps.map((s) => s.tag), ["div", "p"]);
  for (const s of stamps) {
    assert.ok(s.loc.startsWith("src/views/page.tsx:"));
    assert.ok(sourceAt(TSX, s.loc).startsWith(`<${s.tag}`));
  }
  assert.ok(out.includes("props.title as string"), "type syntax is kept for the next plugin");
}));

test("babel: nothing outside the root, under node_modules, without a file name, or in production", () => withEnv("development", async () => {
  assert.equal(stampsIn(stamp(JSX, path.join(ROOT, "node_modules", "lib", "App.jsx"))).length, 1, "only the hand-written one");
  assert.equal(stampsIn(stamp(JSX, path.join(ROOT, "src", "node_modules", "App.jsx"))).length, 1);
  assert.equal(stampsIn(stamp(JSX, path.join(ROOT, "..", "elsewhere", "App.jsx"))).length, 1);
  assert.equal(stampsIn(stamp(JSX, path.join(ROOT, "src", "has space.jsx"))).length, 1, "names a change file would refuse");
  assert.equal(stampsIn(stamp(JSX, undefined)).length, 1);
  await withEnv("production", () => {
    assert.equal(stampsIn(stamp(JSX, path.join(ROOT, "src", "App.jsx"))).length, 1);
  });
}));

test("babel: options", () => withEnv("development", () => {
  const out = stamp("const a = <div />;", path.join(ROOT, "a.jsx"), { opts: { root: ROOT, attr: "data-src" } });
  assert.ok(out.includes("data-src=\"a.jsx:1:11\""));
  assert.throws(() => stamp("<div />", path.join(ROOT, "a.jsx"), { opts: { root: ROOT, attr: "onclick" } }), /attr/);
  assert.equal(dataLoc.relativeFile(ROOT, path.join(ROOT, "src", "x.jsx?v=3")), "src/x.jsx");
  assert.equal(dataLoc.relativeFile(ROOT, "\0virtual.jsx"), null);
  assert.equal(dataLoc.relativeFile(ROOT, "src/relative.jsx"), null);
  assert.equal(dataLoc.relativeFile(ROOT, ROOT), null);
}));

// ---------------------------------------------------------------- Vite

test("vite plugin: serve only, before other plugins; stamps .jsx/.tsx with a source map", () => withEnv("development", async () => {
  const plugin = viteDataLoc();
  assert.equal(plugin.name, "dftp-data-loc");
  assert.equal(plugin.apply, "serve");
  assert.equal(plugin.enforce, "pre");
  plugin.configResolved({ root: TOOL_DIR });
  const r = await plugin.transform(TSX, path.join(TOOL_DIR, "src", "Page.tsx?v=12"));
  assert.ok(r && r.map, "returns code and a map");
  const stamps = stampsIn(r.code);
  assert.deepEqual(stamps.map((s) => s.tag), ["div", "p"]);
  assert.ok(stamps.every((s) => s.loc.startsWith("src/Page.tsx:") && sourceAt(TSX, s.loc).startsWith(`<${s.tag}`)));
  assert.equal(await plugin.transform("export const a = 1;", path.join(TOOL_DIR, "src", "a.js")), null);
  assert.equal(await plugin.transform(JSX, path.join(TOOL_DIR, "node_modules", "x", "App.jsx")), null);
  assert.equal(await plugin.transform(JSX, "\0virtual:App.jsx"), null);
  await withEnv("production", async () => {
    assert.equal(await plugin.transform(JSX, path.join(TOOL_DIR, "src", "App.jsx")), null);
  });
}));

test("vite plugin: a clear error when the project has no @babel/core", async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "dftp-nobabel-")));
  try {
    await fsp.writeFile(path.join(dir, "package.json"), "{\"name\":\"x\",\"private\":true}\n");
    const plugin = viteDataLoc();
    assert.throws(() => plugin.configResolved({ root: dir }), (e) => e.message === MISSING_BABEL);
    assert.match(MISSING_BABEL, /@babel\/core/);
    assert.match(MISSING_BABEL, /devDependency/);
    assert.throws(() => loadProjectBabel(dir), (e) => e.message === MISSING_BABEL);
    assert.ok(loadProjectBabel(TOOL_DIR).transformAsync, "found when the project has it");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Vue

function vueNode(over = {}) {
  const loc = { start: { line: 3, column: 5, offset: 40 }, end: { line: 3, column: 20, offset: 55 }, source: "<div class=\"a\">" };
  return { type: 1, tagType: 0, tag: "div", loc, props: [], children: [], ...over };
}

test("vue transform: plain elements get data-loc; components, slots, templates do not", () => withEnv("development", () => {
  const t = vueDataLoc({ root: ROOT });
  const ctx = { filename: path.join(ROOT, "src", "App.vue") };
  const el = vueNode();
  t(el, ctx);
  assert.equal(el.props.length, 1);
  assert.deepEqual({ type: el.props[0].type, name: el.props[0].name, value: el.props[0].value.content }, { type: 6, name: "data-loc", value: "src/App.vue:3:5" });
  assert.ok(isLoc(el.props[0].value.content));
  for (const tagType of [1, 2, 3]) {
    const other = vueNode({ tagType });
    t(other, ctx);
    assert.equal(other.props.length, 0, `tagType ${tagType}`);
  }
  const text = { type: 2, content: "x", loc: el.loc };
  t(text, ctx);
  assert.equal(text.props, undefined);
}));

test("vue transform: no double stamps, nothing outside the root or in production", () => withEnv("development", async () => {
  const t = vueDataLoc(ROOT);
  const has = vueNode({ props: [{ type: 6, name: "data-loc", value: { type: 2, content: "x.vue:1:1" } }] });
  t(has, { filename: path.join(ROOT, "App.vue") });
  assert.equal(has.props.length, 1);
  const bound = vueNode({ props: [{ type: 7, name: "bind", arg: { content: "data-loc" } }] });
  t(bound, { filename: path.join(ROOT, "App.vue") });
  assert.equal(bound.props.length, 1);
  for (const filename of [path.join(ROOT, "node_modules", "a", "A.vue"), path.join(ROOT, "..", "B.vue"), undefined]) {
    const n = vueNode();
    t(n, { filename });
    assert.equal(n.props.length, 0, String(filename));
  }
  await withEnv("production", () => {
    const n = vueNode();
    t(n, { filename: path.join(ROOT, "App.vue") });
    assert.equal(n.props.length, 0);
  });
  assert.throws(() => vueDataLoc({ root: ROOT, attr: "class" }));
}));
