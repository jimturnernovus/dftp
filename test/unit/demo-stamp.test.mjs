import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { stampHtml, scanStartTags } from "../../server/demo-stamp.mjs";
import { TOOL_DIR } from "../helpers.mjs";

const FILE = "demo/active-clients.html";
const SCRIPT = "http://127.0.0.1:7451/__dftp/overlay.js";

const FIXTURE = [
  "<!DOCTYPE html>",
  "<html lang=\"en\">",
  "<head>",
  "  <meta charset=\"utf-8\">",
  "  <title>Has <b>no</b> tags</title>",
  "  <style>div > p { color: red } /* <span> */</style>",
  "</head>",
  "<body class=\"x\">",
  "  <!-- <div>not a tag</div> -->",
  "  <main id=\"m\" title=\"a > b\" data-x='c > d'>",
  "    <DIV",
  "      class=\"multi-line\"",
  "    >text</DIV>",
  "\t<p>tab <em>first</em></p>",
  "    <section data-loc=\"keep/me.html:1:1\"><span>x</span></section>",
  "    <img src=\"data:,\" alt=\"\"/><br>",
  "    <script>if (a < b) { document.title = \"<p>\"; }</script>",
  "    <textarea><div>raw</div></textarea>",
  "    <svg viewBox=\"0 0 1 1\"><path d=\"M0 0\"/></svg>",
  "  </main>",
  "</body>",
  "</html>",
].join("\r\n");

function locsOf(out) {
  return [...out.matchAll(/<([A-Za-z][^\s/>]*)\s+data-loc="([^"]+)"/g)].map((m) => ({ name: m[1], loc: m[2] }));
}

function indexOf(src, line, col) {
  let i = 0;
  for (let l = 1; l < line; l++) i = src.indexOf("\n", i) + 1;
  return i + col - 1;
}

function checkAllPointAtTheirTag(src, out) {
  const stamped = locsOf(out).filter((s) => s.loc.startsWith(`${FILE}:`));
  assert.ok(stamped.length > 0);
  for (const { name, loc } of stamped) {
    const [, l, c] = /:(\d+):(\d+)$/.exec(loc);
    const at = indexOf(src, Number(l), Number(c));
    assert.equal(src.slice(at, at + 1 + name.length).toLowerCase(), `<${name.toLowerCase()}`, `${name} at ${loc}`);
  }
  return stamped;
}

test("every stamp points at its '<tag' in the source as written", () => {
  const out = stampHtml(FIXTURE, { file: FILE, scriptSrc: SCRIPT });
  const stamped = checkAllPointAtTheirTag(FIXTURE, out);
  const names = stamped.map((s) => s.name.toLowerCase());
  assert.deepEqual(names, ["body", "main", "div", "p", "em", "span", "img", "br", "textarea", "svg", "path"]);
});

test("comments, raw text, head elements and existing stamps are left alone", () => {
  const out = stampHtml(FIXTURE, { file: FILE, scriptSrc: SCRIPT });
  assert.ok(out.includes("<!-- <div>not a tag</div> -->"));
  assert.ok(out.includes("<title>Has <b>no</b> tags</title>"));
  assert.ok(out.includes("/* <span> */</style>"));
  assert.ok(out.includes("document.title = \"<p>\""));
  assert.ok(out.includes("<textarea data-loc=") && out.includes("><div>raw</div></textarea>"));
  assert.ok(out.includes("<section data-loc=\"keep/me.html:1:1\">"));
  assert.equal((out.match(/data-loc=/g) || []).length, 12);
  assert.ok(!/<meta[^>]*data-loc/.test(out));
});

test("the layer script is the first child of <head>", () => {
  const out = stampHtml(FIXTURE, { file: FILE, scriptSrc: SCRIPT });
  assert.ok(out.includes(`<head><script type="module" src="${SCRIPT}"></script>\r\n  <meta`));
  const noHead = stampHtml("<!doctype html><p>x</p>", { file: FILE, scriptSrc: SCRIPT });
  assert.ok(noHead.startsWith(`<!doctype html><script type="module" src="${SCRIPT}"></script><p`));
  assert.throws(() => stampHtml("<p>", { file: FILE, scriptSrc: "http://evil.example/x.js" }));
  assert.throws(() => stampHtml("<p>", { file: "../x.html" }));
  assert.throws(() => stampHtml("<p>", { file: FILE, attr: "onclick" }));
});

test("the real demo page stamps accurately", async () => {
  const src = await fsp.readFile(path.join(TOOL_DIR, FILE), "utf8");
  const out = stampHtml(src, { file: FILE, scriptSrc: SCRIPT });
  checkAllPointAtTheirTag(src, out);
  assert.equal((out.match(/<script type="module" src="http:\/\/127\.0\.0\.1:7451\/__dftp\/overlay\.js"><\/script>/g) || []).length, 1);
});

test("scanner positions", () => {
  const tags = scanStartTags("a\n  <b x='>'>\n<c>");
  assert.deepEqual(tags.map((t) => [t.name, t.line, t.col]), [["b", 2, 3], ["c", 3, 1]]);
  assert.deepEqual(scanStartTags("<a b=c\"d>x</a><e>").map((t) => t.name), ["a", "e"], "a quote inside an unquoted value opens nothing");
  assert.deepEqual(scanStartTags("1 < 2 <3 <p>").map((t) => t.name), ["p"]);
});
