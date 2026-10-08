// scripts/hygiene.mjs passes on this repository and catches each kind of
// problem it is meant to catch, without printing what it found.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { TOOL_DIR } from "../helpers.mjs";

const SKIP = new Set(["node_modules", ".git", ".dftp", "test-results", "playwright-report"]);
const HYGIENE_MS = 90000;

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dftp-hygiene-"));
  fs.cpSync(TOOL_DIR, dir, {
    recursive: true,
    filter: (src) => !SKIP.has(path.basename(src)),
  });
  return dir;
}

function runHygiene(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "hygiene.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("hygiene passes on the repository as it is", { timeout: HYGIENE_MS }, async () => {
  const r = await runHygiene(TOOL_DIR);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^hygiene: ok \(\d+ files\)/m);
});

test("hygiene reports each planted problem by category and place only", { timeout: HYGIENE_MS }, async () => {
  const root = copyRepo();
  try {
    const add = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    const j = (...p) => p.join("");
    const secret = j("AKIA", "ABCDEFGHIJKLMNOP");
    add("client/planted.js", [
      j("document.body.inner", "HTML = location.hash;"),
      j("parent.post", "Message({}, \"*\");"),
      j("set", "Timeout(\"go()\", 5);"),
      j("fetch(\"https://", "tracker.invalid-host.net/x\");"),
      `const key = "${secret}";`,
      "",
    ].join("\n"));
    add("docs/notes.md", [
      j("Contact me at someone@", "real-company.net for access."),
      j("Saved under /Us", "ers/someone/project."),
      "See [the guide](missing-guide.md).",
      "",
    ].join("\n"));
    add(".github/workflows/extra.yml", [
      "on:",
      j("  pull_request", "_target:"),
      "permissions: write-all",
      "jobs:",
      "  x:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v6",
      j("      - run: echo ${{ secre", "ts.TOKEN }}"),
      "",
    ].join("\n"));
    const pkgFile = path.join(root, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { "left-pad": "^1.3.0" };
    pkg.devDependencies.eslint = "^10.0.0";
    pkg.files = pkg.files.filter((f) => f !== "skills/" && f !== "demo/");
    pkg.files.push("docs/");
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    const claude = path.join(root, "CLAUDE.md");
    fs.writeFileSync(claude, fs.readFileSync(claude, "utf8").replace("## 6. Verify", "## 6. Check"));
    add(".env.local", "X=1\n");

    const r = await runHygiene(root);
    assert.equal(r.code, 1);
    const expect = [
      ["HTML sink", "client/planted.js:1"],
      ["postMessage to any origin", "client/planted.js:2"],
      ["code from a string", "client/planted.js:3"],
      ["non-loopback URL in code", "client/planted.js:4"],
      ["secret-looking string", "client/planted.js:5"],
      ["email address", "docs/notes.md:1"],
      ["personal path", "docs/notes.md:2"],
      ["broken relative link", "docs/notes.md:3"],
      ["privileged workflow trigger", ".github/workflows/extra.yml:2"],
      ["workflow with write-all permissions", ".github/workflows/extra.yml:3"],
      ["action not pinned to a commit hash", ".github/workflows/extra.yml:8"],
      ["secrets in a workflow", ".github/workflows/extra.yml:9"],
      ["runtime dependencies in package.json", "package.json:0"],
      ["devDependency not pinned (eslint)", "package.json:0"],
      ["npm pack ships a file outside the allowlist", "docs/notes.md:0"],
      ["npm pack leaves out a served file", "demo/active-clients.html:0"],
      ["npm pack leaves out a required file", "skills/dftp/SKILL.md:0"],
      ["skills/dftp/SKILL.md is stale", "skills/dftp/SKILL.md:0"],
      ["forbidden file", ".env.local:0"],
    ];
    for (const [category, where] of expect) {
      const line = r.out.split("\n").find((l) => l.startsWith(category) && l.endsWith(where));
      assert.ok(line, `expected "${category}" at ${where}\n${r.out}`);
    }
    for (const value of [secret, "real-company.net", "someone", "location.hash", "left-pad"]) {
      assert.ok(!r.out.includes(value), "hygiene never prints what it matched");
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
