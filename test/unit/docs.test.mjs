// The docs stay in step with the code: the skill is generated from
// CLAUDE.md, every command-line flag and setting is documented, and the
// section CHANGES.md points readers to exists.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DIR, runCli } from "../helpers.mjs";
import { buildSkill, skillState, expectedSkill, TARGET } from "../../scripts/build-skill.mjs";

const read = (rel) => fs.readFileSync(path.join(TOOL_DIR, rel), "utf8");

test("skills/dftp/SKILL.md is exactly what build-skill makes from CLAUDE.md", () => {
  assert.equal(skillState(TOOL_DIR), "ok", "run: node scripts/build-skill.mjs");
  assert.equal(read(TARGET), expectedSkill(TOOL_DIR));
});

test("the skill has front matter and every numbered section, and drift is detected", () => {
  const skill = read(TARGET);
  assert.match(skill, /^---\nname: dftp\ndescription: [^\n]{40,}\n---\n/);
  for (let n = 1; n <= 8; n++) assert.match(skill, new RegExp(`^## ${n}\\. `, "m"));
  assert.match(skill, /`<dftp>` is the folder/);
  assert.doesNotMatch(skill, /scripts\/build-skill\.mjs`; edit this file/);
  const claude = read("CLAUDE.md");
  assert.notEqual(buildSkill(claude.replace("## 6. Verify", "## 6. Check")), skill);
  assert.throws(() => buildSkill("# no sections here\n"), /must hold/);
  assert.equal(buildSkill(claude.replace(/\n/g, "\r\n")), skill);
});

test("CLAUDE.md has the section that CHANGES.md and the Copy button point to", () => {
  assert.match(read("CLAUDE.md"), /^## 5\. Applying changes\b/m);
  assert.match(read("server/store.mjs"), /CLAUDE\.md in the DFTP folder, \\"Applying changes\\"/);
  assert.match(read("client/core/shell-ui.js"), /CLAUDE\.md in the DFTP folder, \\"Applying changes\\"/);
});

test("every command-line flag is in the README, and the ones a project needs are in CLAUDE.md", async () => {
  const c = runCli(["--help"]);
  assert.equal((await c.exited).code, 0);
  const flags = [...new Set(c.out().match(/--[a-z][a-z-]+/g))];
  assert.ok(flags.length >= 10);
  const readme = read("README.md");
  const claude = read("CLAUDE.md");
  for (const f of flags) assert.ok(readme.includes(`\`${f}`), `README.md does not mention ${f}`);
  for (const f of ["--root", "--target", "--open", "--port", "--page", "--no-text", "--debug", "--relax-csp", "--demo", "--host"]) {
    assert.ok(claude.includes(f), `CLAUDE.md does not mention ${f}`);
  }
  for (const cmd of ["done --root .", "where --root .", "scan --root ."]) {
    assert.ok(readme.includes(cmd) && claude.includes(cmd), `both docs show "${cmd}"`);
  }
});

test("every dftp.config.json setting is documented in the README and CLAUDE.md", () => {
  const m = /const FILE_KEYS = new Set\(\[([^\]]+)\]\)/.exec(read("server/config.mjs"));
  assert.ok(m, "FILE_KEYS list found in server/config.mjs");
  const keys = [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
  assert.ok(keys.length >= 8);
  for (const k of keys) {
    assert.ok(read("README.md").includes(`\`${k}\``), `README.md does not document ${k}`);
    assert.ok(read("CLAUDE.md").includes(`"${k}"`), `CLAUDE.md example does not show ${k}`);
  }
});

test("name, subtitle and license lines are exact", () => {
  const readme = read("README.md");
  assert.match(readme, /^# DFTP — Designer for the Page\n\n\*\*A drag-and-drop layout designer for almost any web page\*\*\n/);
  const license = read("LICENSE");
  const m = /^MIT License\n\nCopyright \(c\) (\d{4}) ([^\n]+)\n/.exec(license);
  assert.ok(m, "LICENSE starts with the MIT title and one copyright line");
  // The README's license line names the same year and holder as LICENSE.
  assert.ok(readme.split("\n").includes(`MIT © ${m[1]} ${m[2]}. See [LICENSE](LICENSE).`));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.dependencies, undefined);
});

test("the default devices in the docs match the code", async () => {
  const { BUILT_IN_DEVICES } = await import("../../client/core/devices.js");
  const claude = read("CLAUDE.md");
  for (const d of BUILT_IN_DEVICES) {
    assert.ok(claude.includes(`${d.width}×${d.height}`), `CLAUDE.md lists ${d.id}`);
    assert.ok(read("README.md").includes(`${d.label} ${d.width}`), `README.md lists ${d.label}`);
  }
});

test("the config examples in both docs are valid, and the page with a query is recognised", async () => {
  const { checkFileConfig } = await import("../../server/config.mjs");
  const { pageIdentity } = await import("../../client/core/devices.js");
  for (const doc of ["README.md", "CLAUDE.md"]) {
    const m = /```json\n\s*(\{\s*\n\s*"target"[\s\S]*?\n\s*\})\n\s*```/.exec(read(doc));
    assert.ok(m, `${doc} has a config example`);
    const cfg = checkFileConfig(JSON.parse(m[1]));
    const client = cfg.pages.find((p) => p.id === "client");
    assert.ok(client.path.includes("?"), `${doc}: the record page's path carries an example id`);
    const [path0, query0] = client.path.split("?");
    const own = pageIdentity(path0, query0, client.keep);
    assert.equal(pageIdentity("/clients/view", "?id=1042&tab=notes", client.keep), own, `${doc}: extra parameters are ignored`);
    assert.notEqual(pageIdentity("/clients/view", "?id=7", client.keep), own, `${doc}: another id is another address`);
    assert.match(m[1], /"target": "http:\/\/localhost:\d+"/, `${doc}: the example target is the address a dev server prints`);
  }
});

test("the docs cover the dev-server address, the hand-off to the assistant and the frame's limits", () => {
  const readme = read("README.md");
  const claude = read("CLAUDE.md");
  for (const s of [
    "`.dftp/tokens.json`",
    "dftp scan [--root DIR] [--demo]",
    "--target http://localhost:5173",
    "Read /path/to/dftp/CLAUDE.md, then integrate DFTP into this project",
    "cp -R /path/to/dftp/skills/dftp ~/.claude/skills/",
    "`confirm()` returns `false`",
    "| Shift while dragging |",
    "right-click it and choose **Open**",
    "1024 and 65534",
    "scheme, host and port only",
    "dftp done [--root DIR] [--demo]",
    "dftp where [--root DIR] [--demo]",
    "must start with `data-`",
    "defaults to a slug of the path",
  ]) assert.ok(readme.includes(s), `README.md: ${s}`);
  for (const s of [
    "Use the exact address the dev server prints",
    "DFTP_PLUGINS",
    "Leave a pointer for later sessions",
    "A text edit applies on **every** device",
    "sample points, never breakpoints",
    "| `at` |",
    "| `was_loc` |",
    "merges them with its own",
    "nothing answered at",
  ]) assert.ok(claude.includes(s), `CLAUDE.md: ${s}`);
  assert.match(read("CONTRIBUTING.md"), /^# Contributing to DFTP \(Designer for the Page\)\n/);
  assert.match(read("SECURITY.md"), /only ever shown as plain text through `textContent`/);
  assert.match(read("bin/dftp.mjs"), /22\.13/);
  assert.match(read("plugins/README.md"), /process\.env\.DFTP_PLUGINS/);
});

// The capture claims in README.md and SECURITY.md must describe what the
// layer really records: no field it saves may be left out, and nothing it
// still records may be described as "never captured".
test("README and SECURITY.md describe exactly what the layer records", async () => {
  const { LIMITS } = await import("../../client/core/schema.js");
  const overlay = read("layer/core/overlay.js");
  const body = (name) => {
    const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n  \\}\\n`).exec(overlay);
    assert.ok(m, `${name}() found in overlay.js`);
    return m[1];
  };
  const textOf = body("textOf");
  const hintOf = body("hintOf");
  const label = Number(/return t\.slice\(0, (\d+)\);/.exec(textOf)[1]);
  const fallbacks = [...textOf.matchAll(/getAttribute\("([a-z-]+)"\)/g)].map((m) => m[1]);
  const hintKeys = [...new Set([...hintOf.matchAll(/\bh\.([a-z]+) = /g)].map((m) => m[1]))];
  const privateSel = /const PRIVATE_SEL = "(.*)";\n/.exec(overlay)[1];
  const noTextSel = /const NO_TEXT_SEL = "(.*)";\n/.exec(overlay)[1];

  // What the code does, so that a change to it makes this test re-checked.
  assert.equal(label, 80);
  assert.deepEqual(fallbacks, ["aria-label", "placeholder", "title", "alt"]);
  assert.deepEqual(hintKeys.sort(), ["aria", "classes", "id", "role", "selector"]);
  // Only the aria-label hint is withheld for private fields and --no-text.
  assert.match(hintOf, /if \(captureText && !isPrivate\(target\)\) \{\n\s+const aria = /);
  assert.equal(hintOf.match(/isPrivate|captureText/g).length, 2);
  assert.match(overlay, /if \(captureText\) c\.text_from = from\.slice\(0, LIMITS\.textFrom\);/);
  for (const s of ["password", "hidden", "cc-", "data-dftp-private"]) assert.ok(privateSel.includes(s), `PRIVATE_SEL has ${s}`);
  for (const s of ["textarea", "contenteditable"]) {
    assert.ok(noTextSel.includes(s), `NO_TEXT_SEL has ${s}`);
    assert.ok(!privateSel.includes(s), `${s} is not private: its aria-label, placeholder or title can be the label`);
  }

  const readme = read("README.md");
  const start = readme.indexOf("- **What is captured.**");
  assert.ok(start > 0, "README has the What is captured item");
  const end = readme.indexOf("\n- **Assistant safety.**", start);
  const r = readme.slice(start, end).replace(/\s+/g, " ");
  const sec = /\| \*\*Accidental capture of private data\*\* \|([^\n]+)\|\n/.exec(read("SECURITY.md"));
  assert.ok(sec, "SECURITY.md has the private-data row");
  const s = sec[1];

  for (const [doc, text] of [["README.md", r], ["SECURITY.md", s]]) {
    const has = (re, what) => assert.match(text, re, `${doc}: ${what}`);
    has(new RegExp(`label of up to ${label} characters`), "the label and its length");
    has(/`aria-label`, placeholder, `title` or `alt`/, "every label fallback");
    has(new RegExp(`original text \\(up to ${LIMITS.textFrom}`), "the original text of a text edit and its length");
    has(new RegExp(`\`aria-label\` \\(up to ${LIMITS.hintAria}`), "the aria-label hint and its length");
    has(/tag, `id`, classes, role,? (and )?(a )?CSS path/, "the tag, id, classes, role and CSS path");
    has(/layout context/, "the layout context");
    has(/text areas and editable regions[^;]*?(\. Their|, though their) `aria-label`, placeholder or `title` can (still )?be the label/,
      "that text areas and editable regions can still give a label");
    has(/password, hidden and card fields[^;]*?`data-dftp-private`[^;]*?no text at all|password, hidden and card fields[^;]*?`data-dftp-private`[^;]*?no label/,
      "that private fields give no text");
    has(/their tag, `id`, classes, role and CSS path are still recorded/i, "what is still recorded for private fields");
    has(/`--no-text` records no page text/, "what --no-text does");
    // The over-broad wording this replaced.
    assert.doesNotMatch(text, /never captured|never anything from/i, `${doc}: no blanket "never captured" claim`);
    assert.doesNotMatch(text, /text areas, editable regions or elements marked/, `${doc}: text areas are not grouped with private fields`);
  }
});
