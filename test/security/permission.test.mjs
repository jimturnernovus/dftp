// The Node permission model fence, where this Node has it.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { permissionSupported, permissionArgs } from "../../server/permission.mjs";
import { TOOL_DIR, runCli, tempRoot, removeRoot, randomPort, request, saveBody, docPath, DESIGNER_LINE, openWithLink } from "../helpers.mjs";

const skip = !permissionSupported() && "this Node has no permission model";

test("flags: read tool and project, write only .dftp", () => {
  const args = permissionArgs({ toolDir: "/t", root: "/p", net: false });
  assert.deepEqual(args, ["--permission", "--allow-fs-read=/t", "--allow-fs-read=/p", `--allow-fs-write=${path.join("/p", ".dftp")}`, "--disallow-code-generation-from-strings"]);
  // Never allowed to start programs, --open or not: the unfenced side opens the browser.
  assert.ok(!permissionArgs({ toolDir: "/t", root: "/p", open: true }).includes("--allow-child-process"));
  assert.ok(!permissionArgs({ toolDir: "/t", root: "/p" }).includes("--allow-child-process"));
  assert.ok(permissionArgs({ toolDir: "/t", root: "/p", net: true }).includes("--allow-net"));
});

test("inside the fence: writes outside .dftp, child processes and eval are refused", { skip }, async () => {
  const root = await tempRoot();
  try {
    await fsp.mkdir(path.join(root, ".dftp"));
    const probe = path.join(root, "probe.mjs");
    await fsp.writeFile(probe, `
      import fs from "node:fs";
      import { execFileSync } from "node:child_process";
      const r = {};
      const tryIt = (name, fn) => { try { fn(); r[name] = "ok"; } catch (e) { r[name] = e.code || e.name; } };
      tryIt("insideDftp", () => fs.writeFileSync(${JSON.stringify(path.join(root, ".dftp", "x.txt"))}, "x"));
      tryIt("projectRoot", () => fs.writeFileSync(${JSON.stringify(path.join(root, "x.txt"))}, "x"));
      tryIt("toolDir", () => fs.writeFileSync(${JSON.stringify(path.join(TOOL_DIR, "dftp-probe.txt"))}, "x"));
      tryIt("readHome", () => fs.readdirSync(${JSON.stringify(path.dirname(TOOL_DIR))}));
      tryIt("child", () => execFileSync("true"));
      tryIt("eval", () => (0, eval)("1"));
      console.log(JSON.stringify(r));
    `);
    const r = spawnSync(process.execPath, [...permissionArgs({ toolDir: TOOL_DIR, root }), probe], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10000,
    });
    const res = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(res.insideDftp, "ok");
    assert.equal(res.projectRoot, "ERR_ACCESS_DENIED");
    assert.equal(res.toolDir, "ERR_ACCESS_DENIED");
    assert.equal(res.readHome, "ERR_ACCESS_DENIED");
    assert.equal(res.child, "ERR_ACCESS_DENIED");
    assert.equal(res.eval, "EvalError");
    await assert.rejects(fsp.stat(path.join(root, "x.txt")));
  } finally {
    await removeRoot(root);
    await fsp.rm(path.join(TOOL_DIR, "dftp-probe.txt"), { force: true });
  }
});

test("the command runs inside the fence and can still save", { skip }, async () => {
  const root = await tempRoot();
  const c = runCli(["--demo", "--root", root, "--port", String(randomPort())]);
  try {
    const m = await c.waitFor(DESIGNER_LINE);
    assert.ok(!c.err().includes("no permission model"));
    const port = Number(m[1]);
    const { token } = await openWithLink(port, m[2]);
    const r = await request(port, {
      method: "POST", path: "/api/changes", body: JSON.stringify(saveBody()),
      headers: { origin: `http://127.0.0.1:${port}`, "x-dftp-token": token, "content-type": "application/json" },
    });
    assert.equal(r.status, 200, r.text);
    assert.ok((await fsp.stat(docPath(root))).isFile());
    assert.ok((await fsp.stat(path.join(root, ".dftp", "CHANGES.md"))).isFile());
    const demo = await request(port + 1, { path: "/" });
    assert.equal(demo.status, 200);
    assert.match(demo.text, /data-loc="demo\/active-clients\.html:\d+:\d+"/);
  } finally {
    await c.stop();
    await removeRoot(root);
  }
});

test("--open: the unfenced side opens the browser with the one-time link; the fenced server cannot start programs", { skip: skip || (process.platform === "win32" && "uses a shell-script stand-in for the opener") }, async () => {
  const root = await tempRoot();
  const fakeBin = await fsp.mkdtemp(path.join(path.dirname(root), "dftp-fake-open-"));
  const log = path.join(fakeBin, "opened.txt");
  const script = `#!/bin/sh\nprintf '%s %s\\n' "$PPID" "$*" >> '${log}'\n`;
  for (const name of ["open", "xdg-open"]) await fsp.writeFile(path.join(fakeBin, name), script, { mode: 0o755 });
  const port = randomPort();
  const c = runCli(["--demo", "--root", root, "--port", String(port), "--open"], { env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` } });
  try {
    await c.waitFor(DESIGNER_LINE);
    let line = "";
    for (let i = 0; i < 80 && !line; i++) {
      line = await fsp.readFile(log, "utf8").catch(() => "");
      if (!line) await new Promise((r) => setTimeout(r, 50));
    }
    const m = /^(\d+) (http:\/\/127\.0\.0\.1:(\d+)\/\?k=([0-9a-f]{48}))$/.exec(line.trim());
    assert.ok(m, `opener got: ${JSON.stringify(line)}`);
    assert.equal(Number(m[3]), port);
    // The opener's parent is the command the user ran, not the fenced server.
    assert.equal(Number(m[1]), c.child.pid);
    // The one-time link signs the browser in once.
    const first = await request(port, { path: `/?k=${m[4]}` });
    assert.equal(first.status, 303);
    const again = await request(port, { path: `/?k=${m[4]}` });
    assert.equal(again.status, 403);
    // No permission-model warning, and the fenced server was started without
    // the right to run programs.
    assert.ok(!/SecurityWarning|allow-child-process/.test(c.err()), c.err());
    const ps = spawnSync("ps", ["-o", "args=", "-ww", "-g", String(c.child.pid)], { encoding: "utf8" });
    if (ps.status === 0 && ps.stdout.includes("--permission")) assert.ok(!ps.stdout.includes("--allow-child-process"), ps.stdout);
  } finally {
    await c.stop();
    await removeRoot(root);
    await fsp.rm(fakeBin, { recursive: true, force: true });
  }
});
