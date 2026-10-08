// Paths and ids that try to leave their folder.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { startApp, request, rawRequest, statusOf, readHeaders, save } from "../helpers.mjs";

const PATHS = [
  "/%2e%2e/%2e%2e/package.json", "/..%5c..%5cserver.mjs", "/%00", "/..%2f..%2fpackage.json", "/package.json",
  "/server/main.mjs", "/client/shell.js", "/.dftp/CHANGES.md", "/.git/config", "/core/%2e%2e/%2e%2e/package.json",
  "/__dftp/%2e%2e/%2e%2e/package.json", "/__dftp/..%2f..%2fserver/main.mjs", "/__dftp/core/%2e%2e/schema.js",
  "/demo/active-clients.html", "/demo/../package.json",
];

test("static traversal attempts get 404 on both listeners", async () => {
  const t = await startApp();
  try {
    for (const port of [t.shellPort, t.framePort]) {
      for (const p of PATHS) {
        const r = await request(port, { path: p });
        assert.equal(r.status, 404, `${port} ${p}`);
        assert.ok(!r.text.includes("\"name\": \"dftp\""), "package.json never served");
      }
      for (const p of ["/../package.json", "/__dftp/../package.json", "/core/../../package.json"]) {
        const raw = await rawRequest(port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        assert.equal(statusOf(raw), 404, `raw ${port} ${p}`);
      }
    }
  } finally {
    await t.close();
  }
});

test("bad page and device ids get 400 on read and write", async () => {
  const t = await startApp();
  try {
    for (const bad of ["../../x", "..%2fx", "A", "a/b", "con", "", "a%00b", "active-clients/../x"]) {
      const q = `/api/changes?page=${encodeURIComponent(bad)}&device=desktop`;
      assert.equal((await request(t.shellPort, { path: q, headers: readHeaders(t) })).status, 400, `read page ${bad}`);
      const q2 = `/api/changes?page=active-clients&device=${encodeURIComponent(bad)}`;
      assert.equal((await request(t.shellPort, { path: q2, headers: readHeaders(t) })).status, 400, `read device ${bad}`);
      assert.equal((await save(t, { page: bad })).status, 400, `write page ${bad}`);
      assert.equal((await save(t, { device: bad })).status, 400, `write device ${bad}`);
    }
    assert.equal((await request(t.shellPort, { path: "/api/changes?page=other&device=desktop", headers: readHeaders(t) })).status, 400, "valid id, not configured");
  } finally {
    await t.close();
  }
});

test("fingerprint requests stay inside the project", async () => {
  const t = await startApp();
  try {
    const post = (files) => request(t.shellPort, {
      method: "POST", path: "/api/code",
      headers: { origin: t.shellOrigin, "x-dftp-token": t.token, "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert.equal((await post(["../package.json"])).status, 400);
    assert.equal((await post(["/etc/hosts"])).status, 400);
    assert.equal((await post(new Array(201).fill("a.js"))).status, 400);
    const ok = await post(["demo/active-clients.html", "missing.js"]);
    assert.equal(ok.status, 200);
    const { code } = JSON.parse(ok.text);
    assert.match(code["demo/active-clients.html"], /^[0-9a-f]{12}$/);
    assert.equal(code["missing.js"], null);
    assert.ok(!ok.text.includes("Active Clients"), "contents never returned");
  } finally {
    await t.close();
  }
});

test("fingerprints: secrets, git data and non-source files read as null; values are keyed per project", async () => {
  const setup = async (dir) => {
    await fsp.writeFile(path.join(dir, ".env"), "API_KEY=hunter2\n");
    await fsp.mkdir(path.join(dir, ".git"));
    await fsp.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/secret-branch\n");
    await fsp.writeFile(path.join(dir, "package.json"), "{}\n");
    await fsp.mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    await fsp.writeFile(path.join(dir, "node_modules", "x", "index.js"), "x\n");
  };
  const a = await startApp({ setup });
  const b = await startApp({ setup });
  try {
    const post = (t, files) => request(t.shellPort, {
      method: "POST", path: "/api/code",
      headers: { origin: t.shellOrigin, "x-dftp-token": t.token, "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const files = [".env", ".git/HEAD", ".dftp/fingerprint.key", "package.json", "node_modules/x/index.js", "nope.txt", "demo/active-clients.html"];
    const ra = JSON.parse((await post(a, files)).text).code;
    for (const f of files.slice(0, 6)) assert.equal(ra[f], null, f);
    const rb = JSON.parse((await post(b, files)).text).code;
    const plain = createHash("sha1").update(await fsp.readFile(path.join(a.root, "demo", "active-clients.html"))).digest("hex").slice(0, 12);
    assert.match(ra["demo/active-clients.html"], /^[0-9a-f]{12}$/);
    assert.notEqual(ra["demo/active-clients.html"], plain, "not a plain hash anyone can recompute");
    assert.notEqual(ra["demo/active-clients.html"], rb["demo/active-clients.html"], "another project's key gives another value");
    const key = await fsp.stat(path.join(a.root, ".dftp", "fingerprint.key"));
    assert.equal(key.mode & 0o777, 0o600);
  } finally {
    await a.close();
    await b.close();
  }
});

test("session info never holds an absolute path", async () => {
  const t = await startApp();
  try {
    const r = await request(t.shellPort, { path: "/api/session", headers: readHeaders(t) });
    assert.ok(!r.text.includes(t.root));
    const s = JSON.parse(r.text);
    assert.equal(s.root, ".");
    assert.equal(s.changesPath, ".dftp/CHANGES.md");
    const md = await request(t.shellPort, { path: "/api/changes-md", headers: readHeaders(t) });
    assert.ok(!md.text.includes(t.root));
  } finally {
    await t.close();
  }
});
