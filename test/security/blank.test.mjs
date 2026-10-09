// Blank pages on the frame listener: the generated document and its style
// sheet carry the demo page's policy and the layer's asset headers, only
// their exact paths answer, nothing is proxied in blank mode, hostile
// project styles never reach the style sheet as anything but filtered
// values, and the write API keeps new elements to blank pages.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { startApp, request, readHeaders, writeHeaders, rawRequest, statusOf, saveBody } from "../helpers.mjs";

const INERT = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";
const demoCsp = (shell) => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${shell}`;

const HOSTILE_CSS = [
  ":root {",
  "  --color-primary: #2f5bd8;",
  "  --evil-url: url(javascript:alert(1));",
  "  --evil-expr: expression(alert(1));",
  "  --evil-import: \"@import url(x)\";",
  "  --evil-break: red;} body { background: url(//x) } :root{--x: 1;",
  "  --font-evil: \"Inter\\\"; } body{x:y\", sans-serif;",
  "  --space-evil: calc(1px + 2px);",
  "}",
  "",
].join("\n");
const HOSTILE_JSON = JSON.stringify({
  color: { evil: { $value: "red;}*{background:url(x)}", $type: "color" }, ok: { $value: "#112233", $type: "color" } },
  font: { odd: { $value: ["Inter</style><script>x</script>", "serif"], $type: "fontFamily" } },
});

async function hostileProject(dir) {
  await fsp.mkdir(path.join(dir, "src"), { recursive: true });
  await fsp.writeFile(path.join(dir, "src", "evil.css"), HOSTILE_CSS);
  await fsp.writeFile(path.join(dir, "design-tokens.json"), HOSTILE_JSON);
}

const blankFlags = { demo: false, blank: [null, "pricing"] };

test("the blank document and its style sheet: exact paths, fixed headers, GET and HEAD only", async () => {
  const t = await startApp({ flags: blankFlags });
  const F = t.framePort;
  try {
    const doc = await request(F, { path: "/__dftp/blank/blank" });
    assert.equal(doc.status, 200);
    assert.equal(doc.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(doc.headers["content-security-policy"], demoCsp(t.shellOrigin));
    assert.equal(doc.headers["x-content-type-options"], "nosniff");
    assert.equal(doc.headers["cache-control"], "no-store");
    assert.ok(doc.text.includes("<main data-dftp-scaffold></main>"));
    assert.equal((doc.text.match(/<script/g) || []).length, 1);
    assert.ok(doc.text.includes(`<script type="module" src="${t.frameOrigin}/__dftp/overlay.js"></script>`));
    assert.equal((await request(F, { path: "/__dftp/blank/blank-pricing" })).status, 200);
    const css = await request(F, { path: "/__dftp/tokens.css" });
    assert.equal(css.status, 200);
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(css.headers["content-security-policy"], INERT);
    assert.equal(css.headers["x-content-type-options"], "nosniff");
    for (const p of ["/__dftp/blank/", "/__dftp/blank/other", "/__dftp/blank/blank/", "/__dftp/blank/../blank/blank", "/__dftp/blank/%62lank", "/__dftp/tokens.css/x", "/__dftp/blank"]) {
      assert.equal((await request(F, { path: p })).status, 404, p);
    }
    assert.equal((await request(F, { method: "POST", path: "/__dftp/blank/blank", body: "x" })).status, 405);
    assert.equal((await request(F, { method: "PUT", path: "/__dftp/tokens.css", body: "x" })).status, 405);
    assert.equal((await request(F, { path: "/__dftp/blank/blank", host: "evil.example" })).status, 403);
    // Only the frame listener serves them.
    assert.equal((await request(t.shellPort, { path: "/__dftp/blank/blank" })).status, 404);
    assert.equal((await request(t.shellPort, { path: "/__dftp/tokens.css" })).status, 404);
  } finally {
    await t.close();
  }
});

test("blank mode proxies nothing and takes no WebSocket", async () => {
  const t = await startApp({ flags: blankFlags });
  try {
    for (const p of ["/", "/index.html", "/src/evil.css", "/api/x"]) assert.equal((await request(t.framePort, { path: p })).status, 404, p);
    const raw = await rawRequest(t.framePort, [
      "GET /socket HTTP/1.1", `Host: 127.0.0.1:${t.framePort}`, "Upgrade: websocket", "Connection: Upgrade",
      `Origin: ${t.frameOrigin}`, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", "",
    ].join("\r\n"), 800);
    assert.notEqual(statusOf(raw), 101);
  } finally {
    await t.close();
  }
});

test("without --blank there is no blank page and no token style sheet", async () => {
  const t = await startApp();
  try {
    assert.equal((await request(t.framePort, { path: "/__dftp/blank/blank" })).status, 404);
    assert.equal((await request(t.framePort, { path: "/__dftp/tokens.css" })).status, 404);
    const s = await request(t.shellPort, { path: "/api/session", headers: readHeaders(t) });
    assert.ok(JSON.parse(s.text).pages.every((p) => p.blank === undefined));
  } finally {
    await t.close();
  }
});

test("hostile project styles reach the style sheet only as filtered values", async () => {
  const t = await startApp({ flags: blankFlags, setup: hostileProject });
  try {
    const { text } = await request(t.framePort, { path: "/__dftp/tokens.css" });
    assert.ok(text.includes(": #2f5bd8;"), "an ordinary value is there");
    assert.ok(text.includes(": #112233;"));
    for (const bad of ["url(", "expression", "@import", "javascript", "}*{", "</style", "<script", "\\", "calc(", "body{x"]) {
      assert.ok(!text.includes(bad), bad);
    }
    // Every custom property line is one declaration.
    for (const line of text.split("\n").filter((l) => /^ {2}--/.test(l))) {
      assert.match(line, /^ {2}--[A-Za-z0-9_-]+: [^;{}\\]+;$/, line);
    }
    assert.equal((text.match(/\{/g) || []).length, (text.match(/\}/g) || []).length, "braces balance");
  } finally {
    await t.close();
  }
});

test("the session marks blank pages; samples of them and new elements elsewhere are refused", async () => {
  const t = await startApp({ flags: { demo: true, blank: [null] } });
  try {
    const s = JSON.parse((await request(t.shellPort, { path: "/api/session", headers: readHeaders(t) })).text);
    assert.deepEqual(s.pages.map((p) => [p.id, p.blank === true]), [["active-clients", false], ["blank", true]]);
    const post = (p, body) => request(t.shellPort, { method: "POST", path: p, headers: writeHeaders(t), body: JSON.stringify(body) });
    const sample = await post("/api/tokens/sample", { page: "blank", device: "desktop", elements: 3, values: [{ prop: "color", value: "rgb(1, 2, 3)", count: 3 }] });
    assert.equal(sample.status, 400);
    assert.match(sample.text, /blank pages are not sampled/);
    const insert = {
      id: "abcd1234", key: "ins:abcd1234", kind: "insert", element: "button", tag: "button", parent: "scaffold", index: 0,
      text: "Button", styles: { background: "color.primary" }, at: "2026-01-02T03:04:05Z",
    };
    const ok = await post("/api/changes", saveBody({ page: "blank", list: [insert] }));
    assert.equal(ok.status, 200, ok.text);
    const elsewhere = await post("/api/changes", saveBody({ page: "active-clients", list: [insert] }));
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.text, /new elements belong on blank pages/);
    const forged = await post("/api/changes", saveBody({ page: "blank", tab: "tab-two", list: [{ ...insert, styles: { background: "red;}" } }] }));
    assert.equal(forged.status, 400);
    const md = (await request(t.shellPort, { path: "/api/changes-md", headers: readHeaders(t) })).text;
    assert.ok(md.includes("### New elements"));
    assert.ok(md.includes("[abcd1234] new button <button> \"Button\""));
  } finally {
    await t.close();
  }
});

test("a rescan reaches the blank page's style sheet and the token sources CHANGES.md names", async () => {
  const css = (value, pad = "") => `${pad}:root {\n  --color-primary: ${value};\n}\n`;
  const t = await startApp({
    flags: { demo: false, blank: [null] },
    setup: async (dir) => {
      await fsp.mkdir(path.join(dir, "src"), { recursive: true });
      await fsp.writeFile(path.join(dir, "src", "theme.css"), css("#2f5bd8"));
    },
  });
  try {
    const post = (p, body) => request(t.shellPort, { method: "POST", path: p, headers: writeHeaders(t), body: JSON.stringify(body) });
    // The file the assistant reads (the API builds its text fresh each time).
    const md = () => fsp.readFile(path.join(t.root, ".dftp", "CHANGES.md"), "utf8");
    const sheet = async () => (await request(t.framePort, { path: "/__dftp/tokens.css?v=2" })).text;
    // The first scan is done before anything is saved.
    assert.equal((await request(t.shellPort, { path: "/api/tokens", headers: readHeaders(t) })).status, 200);
    const insert = {
      id: "abcd1234", key: "ins:abcd1234", kind: "insert", element: "button", tag: "button", parent: "scaffold", index: 0,
      text: "Button", styles: { background: "color.primary" }, at: "2026-01-02T03:04:05Z",
    };
    assert.equal((await post("/api/changes", saveBody({ page: "blank", list: [insert] }))).status, 200);
    assert.ok((await sheet()).includes("--dftp-t-color_dprimary: #2f5bd8;"));
    assert.ok((await md()).includes("background = color.primary (\"--color-primary\" in src/theme.css:2)"));

    // The value changes and moves down a line; a rescan brings both in.
    await fsp.writeFile(path.join(t.root, "src", "theme.css"), css("#ff7a00", "/* moved */\n"));
    const r = await post("/api/tokens/scan", {});
    assert.equal(r.status, 200, r.text);
    assert.ok((await sheet()).includes("--dftp-t-color_dprimary: #ff7a00;"), "the style sheet the page loads again");
    const text = await md();
    assert.ok(text.includes("background = color.primary (\"--color-primary\" in src/theme.css:3)"), "CHANGES.md is rebuilt");
    assert.ok(!text.includes("src/theme.css:2"));
  } finally {
    await t.close();
  }
});
