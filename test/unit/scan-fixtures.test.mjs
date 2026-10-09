// The whole scan on the four fixture projects, and the scan command.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { scanProject, summaryLines } from "../../server/scan/scanner.mjs";
import { validateTokensDoc } from "../../client/core/tokens.js";
import { TOOL_DIR, tempRoot, removeRoot, runCli } from "../helpers.mjs";

const FIXTURES = path.join(TOOL_DIR, "test", "fixtures", "projects");
const scan = (name, opts = {}) => scanProject({ root: path.join(FIXTURES, name), ...opts });
const find = (doc, id) => doc.tokens.find((t) => t.id === id);
const hex = (doc, id) => find(doc, id) && find(doc, id).value && find(doc, id).value.hex;

async function checked(name, opts) {
  const doc = await scan(name, opts);
  const r = validateTokensDoc(doc);
  assert.ok(r.ok, r.error);
  const json = JSON.stringify(doc);
  assert.ok(!json.includes(TOOL_DIR), "no absolute paths");
  return { doc, json };
}

test("css-vars-dark: custom properties, dark modes from three kinds of selector, aliases and usage", async () => {
  const { doc, json } = await checked("css-vars-dark");
  assert.equal(hex(doc, "color.brand.600"), "#2f5bd8");
  assert.equal(hex(doc, "color.brand.400"), "#6b8cff");
  const primary = find(doc, "color.primary");
  assert.equal(primary.aliasOf, "color.brand.600");
  assert.equal(primary.role, "primary");
  assert.equal(primary.modes.dark.hex, "#6b8cff", ".dark");
  assert.equal(find(doc, "color.muted.foreground").modes.dark.hex, "#9aa3b5", "[data-theme=dark]");
  assert.equal(find(doc, "color.border").modes.dark.hex, "#262b3a", "prefers-color-scheme: dark");
  assert.equal(hex(doc, "color.text"), "#0f1729");
  assert.equal(find(doc, "color.text").role, "text");
  assert.equal(find(doc, "color.surface").role, "surface");
  assert.equal(find(doc, "color.danger").role, "danger");
  assert.equal(find(doc, "color.brand.600").usage.count, 1, "the hard-coded hover color counts towards the token");
  assert.equal(find(doc, "spacing.4").usage.count, 3);
  assert.deepEqual(find(doc, "font.sans").value.families, ["Inter", "system-ui", "sans-serif"]);
  assert.equal(find(doc, "shadow.sm").value[0].color.alpha, 0.08);
  assert.deepEqual(find(doc, "easing.out").value.bezier, [0.16, 1, 0.3, 1]);
  assert.equal(find(doc, "duration.fast").value.ms, 120);
  assert.equal(find(doc, "z-index.modal").value.value, 50);
  assert.equal(find(doc, "size.card.pad").confidence, 0.6, "defined inside .card only");
  assert.deepEqual(doc.scales, { spacing: [4, 8, 16], fontSize: [22, 28], radius: [8, 12] });
  assert.deepEqual(doc.breakpoints.map((b) => [b.name, b.min]), [["md", 768], ["lg", 1024]]);
  assert.deepEqual(doc.diagnostics.map((d) => [d.code, d.line]), [["alias-missing", 20], ["alias-cycle", 21], ["alias-cycle", 22]]);
  const src = find(doc, "color.surface").sources;
  assert.deepEqual(src.map((s) => `${s.file}:${s.line}`), ["src/styles/tokens.css:6", "src/styles/tokens.css:26"]);
  for (const words of ["A sample heading", "Continue", "Sample page"]) assert.ok(!json.includes(words), words);
});

test("tailwind-v4: @theme variables, inline theme aliases joined to their targets, components", async () => {
  const { doc } = await checked("tailwind-v4");
  const bg = find(doc, "color.background");
  assert.equal(bg.value.hex, "#ffffff");
  assert.equal(bg.modes.dark.hex, "#0a0a0a");
  assert.deepEqual(bg.sources.map((s) => s.name), ["--background", "--background", "--color-background"]);
  assert.equal(bg.role, "background");
  assert.equal(bg.usage.count, 1);
  assert.equal(find(doc, "color.primary").role, "primary");
  assert.equal(find(doc, "color.foreground").role, "text");
  assert.equal(find(doc, "color.brand.600").role, null, "a shade gives way to color.primary");
  assert.equal(find(doc, "font-size.sm").value.px, 14);
  assert.equal(find(doc, "line-height.text-sm").value.px, 20);
  assert.equal(find(doc, "radius.lg").aliasOf, "radius.default");
  assert.equal(find(doc, "breakpoint.3xl").value.px, 1920);
  assert.equal(doc.tokens.some((t) => t.sources.some((s) => s.name === "--animate-spin-slow")), false);
  assert.deepEqual(doc.scales.spacing, [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96]);
  assert.deepEqual(doc.breakpoints.map((b) => [b.name, b.min]), [["md", 768], ["3xl", 1920]]);
  assert.deepEqual(doc.components, [
    { kind: "button", file: "src/components/ui/button.jsx", export: "Button" },
    { kind: "card", file: "src/components/ui/card.jsx", export: "Card" },
  ]);
  const none = await checked("tailwind-v4", { libraryPrefixes: [] });
  assert.deepEqual(none.doc.components, []);
});

test("dtcg-json: token files, references, modes, composites, Style Dictionary and theme objects", async () => {
  const { doc } = await checked("dtcg-json");
  assert.equal(find(doc, "color.brand.600").sources[0].file, "tokens/color.tokens.json");
  assert.equal(hex(doc, "color.brand.400"), "#6b8cff");
  assert.equal(find(doc, "color.text").aliasOf, "color.neutral.900");
  assert.equal(find(doc, "color.background").modes.dark.hex, "#111827");
  assert.equal(find(doc, "color.danger").value.clipped, true);
  assert.equal(find(doc, "color.link").aliasOf, "color.accent");
  assert.equal(find(doc, "color.highlight").modes.dark.hex, "#fbbf24");
  assert.equal(hex(doc, "color.ink"), "#1f2937");
  assert.equal(find(doc, "font.heading").aliasOf, "font.body");
  assert.equal(find(doc, "font-size.heading").value.px, 32);
  assert.equal(find(doc, "font-size.small").value.px, 12, "a real name wins over a list position for the same value");
  assert.equal(find(doc, "radius.md").type, "radius");
  assert.equal(find(doc, "breakpoint.md").type, "breakpoint");
  assert.equal(find(doc, "duration.motion.fast").value.ms, 120);
  assert.equal(find(doc, "color.loop-a").value, null);
  assert.deepEqual(doc.diagnostics.map((d) => d.code), ["alias-cycle", "alias-cycle"]);
  assert.deepEqual(doc.scales.spacing, [4, 8, 16, 24, 32]);
  assert.equal(doc.scan.adapters["tokens-json"], 4);
  assert.equal(doc.tokens.some((t) => t.sources.some((s) => s.file === "package.json")), false);
});

test("plain-html: inline styles and style blocks, roles from usage, and none of the page's words", async () => {
  const { doc, json } = await checked("plain-html");
  assert.equal(find(doc, "color.accent").usage.count, 3);
  assert.equal(find(doc, "color.auto.1f2937").role, "text");
  assert.equal(find(doc, "color.auto.fafaf9").role, "background");
  assert.equal(find(doc, "color.auto.e5e7eb").role, "border");
  assert.deepEqual(find(doc, "font.auto.b9638a4a").value.families, ["Fira Sans", "sans-serif"]);
  assert.equal(find(doc, "letter-spacing.auto.m0_02em").value.value, -0.02);
  assert.deepEqual(doc.breakpoints.map((b) => [b.name, b.min]), [["sm", 640]]);
  assert.equal(doc.scan.classes, 7);
  for (const s of ["#ff00ff", "#ff0000", "#00ff00", "Sample Studio", "Get started", "never read", "More words"]) assert.ok(!json.includes(s), s);
});

test("the scan is deterministic, and the summary names counts and ids only", async () => {
  const a = await scan("css-vars-dark", { now: () => new Date(0), clock: () => 0 });
  const b = await scan("css-vars-dark", { now: () => new Date(0), clock: () => 0 });
  assert.deepEqual(a, b);
  const lines = summaryLines(a);
  assert.match(lines[0], /^Scanned 3 file\(s\) in 0\.0 s; adapters: html \(1\), css \(2\), css-vars \(2\), tailwind-v4 \(2\)$/);
  assert.match(lines.join("\n"), /Tokens: 22 \(color 8/);
  assert.match(lines.join("\n"), /primary color\.primary #2f5bd8/);
  assert.match(lines.join("\n"), /Breakpoints: md 768, lg 1024/);
  assert.match(lines.at(-1), /^Diagnostics: 3$/);
});

const runOk = async (args, opts) => {
  const c = runCli(args, opts);
  const r = await c.exited;
  return { code: r.code, out: c.out(), err: c.err() };
};

test("dftp scan writes .dftp/tokens.json, prints a summary, and keeps earlier live samples", async () => {
  const root = await tempRoot({ demo: false });
  try {
    await fsp.cp(path.join(FIXTURES, "tailwind-v4"), root, { recursive: true });
    const r = await runOk(["scan", "--root", root]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Scanned 3 file\(s\)/m);
    assert.match(r.out, /Components: Button \(src\/components\/ui\/button\.jsx\), Card \(src\/components\/ui\/card\.jsx\)/);
    assert.match(r.out, /Wrote \.dftp\/tokens\.json$/m);
    assert.ok(!r.out.includes(root), "no absolute paths in the summary");
    const file = path.join(root, ".dftp", "tokens.json");
    const doc = JSON.parse(await fsp.readFile(file, "utf8"));
    assert.ok(validateTokensDoc(doc).ok);
    assert.deepEqual(await fsp.readdir(path.join(root, ".dftp")).then((l) => l.sort()), [".gitignore", "changes", "history", "tokens.json"], "no fingerprint key is made");

    doc.live = [{ page: "home", device: "desktop", theme: "light", elements: 5, sampled_at: "2026-01-01T00:00:00Z", values: [{ prop: "color", value: "rgb(10, 20, 30)", count: 9 }] }];
    await fsp.writeFile(file, JSON.stringify(doc));
    const again = await runOk(["scan", "--root", root]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /Live samples merged: 1/);
    const after = JSON.parse(await fsp.readFile(file, "utf8"));
    assert.equal(after.live.length, 1);
    assert.ok(after.tokens.some((t) => t.id === "color.auto.0a141e" && t.usage.seenLive));

    await fsp.writeFile(file, "{ not json");
    const repaired = await runOk(["scan", "--root", root]);
    assert.equal(repaired.code, 0, "an unreadable tokens file is replaced");
    assert.ok(validateTokensDoc(JSON.parse(await fsp.readFile(file, "utf8"))).ok);
  } finally {
    await removeRoot(root);
  }
});

test("dftp scan: --demo reads demo/ only; options it does not take stop it", async () => {
  const root = await tempRoot();
  try {
    await fsp.writeFile(path.join(root, "other.css"), ":root { --never-read: #123456; }");
    const r = await runOk(["scan", "--demo", "--root", root]);
    assert.equal(r.code, 0, r.err);
    const doc = JSON.parse(await fsp.readFile(path.join(root, ".dftp", "tokens.json"), "utf8"));
    assert.ok(doc.tokens.length > 0);
    assert.ok(doc.tokens.every((t) => t.sources.every((s) => !s.file || s.file.startsWith("demo/"))));
    const bad = await runOk(["scan", "--root", root, "--target", "http://localhost:5173"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /scan takes only --root/);
    const help = await runOk(["--help"]);
    assert.match(help.out, /dftp scan \[--root DIR\] \[--demo\]/);
    const unknown = await runOk(["scna"]);
    assert.match(unknown.err, /use serve, done, scan or where/);
  } finally {
    await removeRoot(root);
  }
});
