// The docs for the style scan, the live sample and blank pages stay in step
// with the code: the version, the adapters, the fields of tokens.json, the
// scan's limits and the blank style sheet's filter are read from the code
// and looked up in the docs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DIR, runCli } from "../helpers.mjs";
import { ADAPTERS } from "../../server/scan/registry.mjs";
import { scanProject } from "../../server/scan/scanner.mjs";
import { applyLive, LIVE_MIN } from "../../server/scan/live.mjs";
import { WALK_LIMITS, SKIP_DIRS } from "../../server/scan/walk.mjs";
import { safeCssValue } from "../../server/blank.mjs";
import {
  validateTokensDoc, TOKEN_TYPES, ROLES, TOKEN_LIMITS, SAMPLE_PROPS, OBJECT_PROP_LIST, LIVE_VARIANTS,
} from "../../client/core/tokens.js";
import { OBJECT_KINDS } from "../../client/core/schema.js";
import { NEW_PAGE_NOTE } from "../../client/core/spec.js";

const read = (rel) => fs.readFileSync(path.join(TOOL_DIR, rel), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const FIXTURES = path.join(TOOL_DIR, "test", "fixtures", "projects");

// The text of one Markdown section, from its heading to the next heading of
// the same or a higher level.
function section(doc, heading) {
  const lines = doc.split("\n");
  const at = lines.indexOf(heading);
  assert.ok(at !== -1, `heading found: ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  let end = at + 1;
  while (end < lines.length && !(/^#+ /.test(lines[end]) && /^#+/.exec(lines[end])[0].length <= level)) end++;
  return lines.slice(at + 1, end).join("\n");
}

test("the version is the same in package.json, the lockfile, --version and the newest changelog entry", async () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  const newest = /^## (\S+)/m.exec(read("CHANGELOG.md"));
  assert.ok(newest, "CHANGELOG.md has a release heading");
  assert.equal(newest[1], pkg.version, "the newest CHANGELOG entry is the released version");
  const c = runCli(["--version"]);
  assert.equal((await c.exited).code, 0);
  assert.equal(c.out().trim(), pkg.version);
});

test("the README lists every style adapter, what is planned, and CONTRIBUTING says how to add one", () => {
  const readme = read("README.md");
  const reads = section(readme, "### What it reads in this release");
  for (const a of ADAPTERS) assert.match(reads, new RegExp(`^\\| \`${a.id}\` \\|`, "m"), `README table has a row for ${a.id}`);
  const rows = reads.split("\n").filter((l) => /^\| `[a-z0-9-]+` \|/.test(l));
  assert.equal(rows.length, ADAPTERS.length, "no row for an adapter that does not exist");
  const planned = flat(section(readme, "### Planned"));
  for (const s of ["SCSS", "LESS", "Tailwind CSS v3", "classes in your code", "styled-components", "Emotion", "style objects", "SVG", "canvas"]) {
    assert.ok(planned.includes(s), `README planned list names ${s}`);
  }
  // Object styles are built: no longer planned.
  assert.ok(!planned.includes("object styles"), "object styles are not listed as planned");
  const contributing = flat(section(read("CONTRIBUTING.md"), "## Adding a style source"));
  for (const s of ["server/scan/registry.mjs", "server/scan/adapters/", "extract({path, text, helpers})", "test/fixtures/projects/"]) {
    assert.ok(contributing.includes(s), `CONTRIBUTING.md: ${s}`);
  }
});

test("CLAUDE.md documents every field of tokens.json the scan and the live sample write", async () => {
  const docs = [];
  for (const name of fs.readdirSync(FIXTURES).sort()) docs.push(await scanProject({ root: path.join(FIXTURES, name) }));
  // A live sample adds usage.live, the live list and live sources.
  const sample = { page: "home", device: "desktop", theme: "light", elements: 9, values: [{ prop: "color", value: "rgb(1, 2, 3)", count: LIVE_MIN }] };
  docs.push(applyLive(docs[0], [{ ...sample, sampled_at: "2026-01-01T00:00:00.000Z" }]));
  const keys = { doc: new Set(), token: new Set(), source: new Set(), usage: new Set(), adapter: new Set() };
  for (const raw of docs) {
    const r = validateTokensDoc(raw);
    assert.ok(r.ok, r.error);
    for (const k of Object.keys(r.value)) keys.doc.add(k);
    for (const t of r.value.tokens) {
      for (const k of Object.keys(t)) keys.token.add(k);
      for (const k of Object.keys(t.usage)) keys.usage.add(k);
      for (const s of t.sources) {
        for (const k of Object.keys(s)) keys.source.add(k);
        keys.adapter.add(s.adapter);
      }
    }
  }
  assert.ok(keys.doc.has("live") && keys.usage.has("live") && keys.source.has("page") && keys.adapter.has("live"));
  const claude = read("CLAUDE.md");
  const part = section(claude, "### Reading `.dftp/tokens.json`");
  const table = part.split("\n").filter((l) => l.startsWith("| `"));
  const rowFor = (k) => table.find((l) => l.startsWith(`| \`${k}\` |`));
  for (const k of [...keys.doc, ...keys.token]) {
    if (["format", "version", "generated_at", "root", "tokens"].includes(k)) assert.ok(part.includes(`"${k}"`), `CLAUDE.md example shows ${k}`);
    else assert.ok(rowFor(k), `CLAUDE.md has a row for ${k}`);
  }
  for (const k of keys.source) assert.ok(rowFor("sources").includes(`\`${k}\``), `the sources row explains ${k}`);
  for (const k of keys.usage) assert.ok(rowFor("usage").includes(`\`${k}\``), `the usage row explains ${k}`);
  for (const a of keys.adapter) assert.ok(rowFor("sources").includes(`\`${a}\``), `the sources row names the ${a} adapter`);
  for (const t of TOKEN_TYPES) assert.ok(rowFor("type").includes(`\`${t}\``), `the type row lists ${t}`);
  for (const r of ROLES) assert.ok(rowFor("role").includes(`\`${r}\``), `the role row lists ${r}`);
  // The example in that section is a valid tokens document.
  const ex = /```json\n([\s\S]*?)\n```/.exec(part);
  assert.ok(ex, "the section has a JSON example");
  const parsed = validateTokensDoc(JSON.parse(ex[1]));
  assert.ok(parsed.ok, parsed.error);
});

test("CLAUDE.md says how to use tokens and how to build a blank page, where CHANGES.md points", () => {
  const claude = read("CLAUDE.md");
  const five = section(claude, "## 5. Applying changes (never as fixed offsets)");
  const use = flat(section(claude, "### Using the project's tokens"));
  assert.ok(five.includes("### Using the project's tokens") && five.includes("### Building a page from blank-page changes"));
  for (const s of ["never the raw number or hex code", "`--color-brand-600` → `bg-brand-600`", "`modes.dark`", "nearest step in `scales`", "`live`", "`components`"]) {
    assert.ok(use.includes(s), `Using the project's tokens: ${s}`);
  }
  const blank = flat(section(claude, "### Building a page from blank-page changes"));
  for (const s of ["The page's main container", "Using the project's tokens", "use the current token of the same type and role", "pick the variant"]) {
    assert.ok(blank.includes(s), `Building a page from blank-page changes: ${s}`);
  }
  // CHANGES.md sends readers to that section by name.
  assert.match(NEW_PAGE_NOTE, /"Building a page from blank-page changes" in CLAUDE\.md/);
  assert.match(claude, /`breakpoints` in `\.dftp\/tokens\.json` lists the ones the scan\nfound/);
});

test("README and SECURITY.md state the scan's and the live sample's real limits", () => {
  const readme = flat(section(read("README.md"), "## Style scan"));
  const security = flat(section(read("SECURITY.md"), "## The style scan and the live sample"));
  const mib = (b) => `${b / (1024 * 1024)} MiB`;
  for (const [doc, text] of [["README.md", readme], ["SECURITY.md", security]]) {
    for (const d of SKIP_DIRS) assert.ok(text.includes(`\`${d}\``), `${doc} names the skipped folder ${d}`);
    assert.ok(text.includes(`${WALK_LIMITS.files} files`), `${doc}: file budget`);
    assert.ok(text.includes(mib(WALK_LIMITS.totalBytes)), `${doc}: byte budget`);
    assert.ok(text.includes(mib(WALK_LIMITS.fileBytes)), `${doc}: file size cap`);
    assert.ok(text.includes(`${WALK_LIMITS.ms / 1000} seconds`), `${doc}: time budget`);
    assert.ok(text.includes(`${TOKEN_LIMITS.sampleElements} `), `${doc}: elements per sample`);
    assert.ok(text.includes(`${TOKEN_LIMITS.sampleValues} distinct values of up to ${TOKEN_LIMITS.sampleValue} characters`), `${doc}: values per sample`);
    assert.ok(text.includes(`${TOKEN_LIMITS.liveSamples} samples`), `${doc}: samples kept`);
    assert.ok(text.includes("`data-dftp-private`"), `${doc}: private regions are skipped`);
  }
  assert.ok(security.includes(`${WALK_LIMITS.entries} directory entries`) && security.includes(`${WALK_LIMITS.depth} levels`));
  assert.ok(security.includes(`${SAMPLE_PROPS.length} style properties`), "SECURITY.md counts the sampled properties");
  assert.ok(security.includes(`at most ${TOKEN_LIMITS.raw} characters`), "SECURITY.md: value length cap");
  const overlay = read("layer/core/overlay.js");
  const visits = Number(/\n {4}visits: (\d+),\n/.exec(overlay)[1]);
  const ms = Number(/\n {4}ms: (\d+),\n/.exec(overlay)[1]);
  assert.ok(security.includes(`${visits} visited nodes or ${ms} ms`), "SECURITY.md: the sample's time and visit budget");
  assert.ok(readme.includes(`appears on ${["zero", "one", "two", "three", "four", "five"][LIVE_MIN]} elements or more`), "README: how often a value must appear");
  assert.match(security, /never runs anything/);
});

test("the docs describe the blank style sheet's filter as the code applies it", () => {
  // Font names keep their double quotes; single quotes never pass.
  assert.equal(safeCssValue("\"Inter\", sans-serif"), "\"Inter\", sans-serif");
  assert.equal(safeCssValue("a\"b"), "");
  assert.equal(safeCssValue("x'y"), "");
  for (const s of ["url(x)", "red !important", "a;b", "a}b", "a/*b*/"]) assert.equal(safeCssValue(s), "", s);
  const readme = flat(read("README.md"));
  const security = flat(read("SECURITY.md"));
  for (const [doc, text] of [["README.md", readme], ["SECURITY.md", security]]) {
    assert.ok(/double quotes only in pairs/.test(text), `${doc}: double quotes only in pairs`);
    assert.doesNotMatch(text, /no quotes, braces/, `${doc}: no claim that quotes never pass`);
  }
  assert.doesNotMatch(read("server/blank.mjs"), /no quote, brace/);
});

test("the blank-page build steps cover components that drop a className, heading levels, unnamed tokens and sizes never edited", () => {
  const claude = read("CLAUDE.md");
  const blank = flat(section(claude, "### Building a page from blank-page changes"));
  for (const s of [
    "check that it passes `className` / `style` on and merges them with its own",
    "put the class on a wrapper element, or ask",
    "the tag shown for a heading (`<h2>`) is the palette's default",
    "the page's main heading is an `<h1>` when the project's other pages have one",
    "Each item of the page's main container spans its full width",
    "A token without a name (an id with `.auto.`",
    "\"Screen sizes not edited\"",
  ]) assert.ok(blank.includes(s), `Building a page from blank-page changes: ${s}`);
  assert.ok(flat(section(claude, "## 4. Reading changes")).includes("**\"Screen sizes not edited\"**"));
  // The example app's shared Button is the model projects copy: it merges a className.
  const button = read("examples/vite-react/src/components/ui/button.jsx");
  assert.match(button, /className=\{\[`btn btn-\$\{variant\}`, className\]\.filter\(Boolean\)\.join\(" "\)\}/);
  assert.ok(button.indexOf("{...rest}") < button.indexOf("className={["), "rest props cannot replace the merged className");
});

test("the docs say --blank opens on the blank page, also next to a target from the config file", () => {
  const readme = flat(read("README.md"));
  assert.ok(readme.includes("With `--target`, or a `target` in `dftp.config.json`, your app's pages are listed first and the designer still opens on the blank page."));
  assert.ok(readme.includes("or a `target` in `dftp.config.json`: blank pages are listed after the app's pages, and the designer opens on the first blank page"));
  assert.doesNotMatch(readme, /`--blank` alone: blank pages only, no `--target` needed\.\s*- With `--target` or `--demo`: blank pages are listed after the app's pages\./);
  const claude = flat(read("CLAUDE.md"));
  assert.ok(claude.includes("the designer opens on it; without `--target` or a `target` in `dftp.config.json` it needs no dev server, and with one the app's pages are listed first"));
});

test("the docs list single-file component style blocks as read and SCSS blocks in them as not read", () => {
  const claude = flat(section(read("CLAUDE.md"), "### Reading `.dftp/tokens.json`"));
  assert.ok(claude.includes("the `<style>` blocks of `.vue`, `.svelte` and `.astro` files"));
  assert.ok(claude.includes("`lang=\"scss\"` / `lang=\"less\"` blocks in components"));
  const planned = flat(section(read("README.md"), "### Planned"));
  assert.ok(planned.includes("`lang=\"scss\"` or `lang=\"less\"` style blocks in components"));
  const security = flat(section(read("SECURITY.md"), "## The style scan and the live sample"));
  assert.ok(security.includes("the `<style>` blocks of `*.vue`, `*.svelte` and `*.astro` files"));
  assert.ok(security.includes("runs on a fixed work budget"), "SECURITY.md describes the build's bound, not only the readers'");
  assert.ok(flat(read("README.md")).includes("`color-mix()` and relative colors whose channels are names or numbers"), "the README lists the color syntaxes rather than claiming all");
});

test("the docs describe object styles as the code records and uses them", async () => {
  const claude = read("CLAUDE.md");
  const part = section(claude, "### Reading `.dftp/tokens.json`");
  const row = part.split("\n").find((l) => l.startsWith("| `objects` |"));
  assert.ok(row, "CLAUDE.md has a row for objects");
  for (const k of OBJECT_KINDS) assert.ok(row.includes(`\`${k}\``), `the objects row names the kind ${k}`);
  for (const p of OBJECT_PROP_LIST) assert.ok(row.includes(`\`${p}\``), `the objects row names the property ${p}`);
  for (const k of ["kind", "variant", "style", "source", "count", "sources"]) assert.ok(row.includes(`\`${k}\``), `the objects row explains ${k}`);
  for (const v of new Set(Object.values(LIVE_VARIANTS).flat())) assert.ok(row.includes(`\`${v}\``), `the objects row names the variant ${v}`);
  // The scan's own object records have exactly the documented fields.
  const doc = await scanProject({ root: path.join(FIXTURES, "objects") });
  for (const o of doc.objects) assert.deepEqual(Object.keys(o).sort(), ["count", "kind", "source", "sources", "style", "variant"]);
  // The change field and the CHANGES.md lines.
  assert.match(claude, /^\| `object` \| for an insert: the object style it copies/m);
  const four = flat(section(claude, "## 4. Reading changes"));
  for (const s of ["object style: copies the project's button look", "found in:", "look:"]) assert.ok(four.includes(s), `section 4 shows ${s}`);
  const blank = flat(section(claude, "### Building a page from blank-page changes"));
  assert.ok(blank.includes("Copy the object style the project's way.") && blank.includes("do not write new CSS that repeats the `look` values"));
  assert.ok(flat(section(claude, "### Using the project's tokens")).includes("**Object styles**"));
  // README: the kinds, the variants and the limits, as the code has them.
  const readme = flat(section(read("README.md"), "### Object styles"));
  for (const k of OBJECT_KINDS) assert.ok(readme.includes(`| \`${k}\` |`), `README table row for ${k}`);
  for (const [k, list] of Object.entries(LIVE_VARIANTS)) assert.ok(readme.includes(list.map((v) => `\`${v}\``).join(", ")), `README variants of ${k}`);
  assert.ok(readme.includes(`at most ${TOKEN_LIMITS.sampleObjects} looks, three per kind and variant`) && TOKEN_LIMITS.objectVariants === 3);
  assert.ok(readme.includes(`keeps at most ${TOKEN_LIMITS.objects} of them under \`objects\``));
  const security = flat(section(read("SECURITY.md"), "## The style scan and the live sample"));
  assert.ok(security.includes(`at most ${TOKEN_LIMITS.sampleObjects} looks of up to ${OBJECT_PROP_LIST.length} values each and three per kind and variant`));
  assert.ok(security.includes("none of these is sent or kept"));
  assert.ok(flat(read("CHANGELOG.md")).includes("Object styles: the whole look of the project's buttons"));
});
