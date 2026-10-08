// Both listeners bind to loopback only; any other --host is refused.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { startApp, runCli, tempRoot, removeRoot, randomPort } from "../helpers.mjs";

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && a.family === "IPv4") out.push(a.address);
  }
  return out;
}

test("listeners are bound to 127.0.0.1 only", async () => {
  const t = await startApp();
  try {
    for (const s of [t.app.servers.shell, t.app.servers.frame]) {
      const a = s.address();
      assert.equal(a.address, "127.0.0.1");
      assert.equal(a.family, "IPv4");
    }
    assert.equal(t.app.servers.frame.address().port, t.shellPort + 1);
    const lan = lanAddresses();
    if (lan.length === 0) return;
    // Connect from a separate process (this one blocks non-loopback hosts).
    const probe = `
      const net = require("node:net");
      const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
      s.on("connect", () => { console.log("CONNECTED"); s.destroy(); });
      s.on("error", (e) => { console.log(e.code); });
      setTimeout(() => process.exit(0), 1500);`;
    for (const ip of lan.slice(0, 2)) {
      for (const port of [t.shellPort, t.framePort]) {
        const r = spawnSync(process.execPath, ["-e", probe, ip, String(port)], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 5000 });
        assert.ok(!r.stdout.includes("CONNECTED"), `reachable on ${ip}:${port}`);
      }
    }
  } finally {
    await t.close();
  }
});

test("--host other than loopback exits with code 2", async () => {
  const root = await tempRoot();
  try {
    for (const host of ["0.0.0.0", "::", "fe80::1", "10.1", "localhost", "example.com"]) {
      const c = runCli(["--demo", "--root", root, "--port", String(randomPort()), "--host", host]);
      const r = await c.exited;
      assert.equal(r.code, 2, host);
      assert.match(c.err(), /--host must be 127\.0\.0\.1 or ::1/);
      assert.equal(c.out(), "");
    }
  } finally {
    await removeRoot(root);
  }
});

test("a busy port moves to the next pair", async () => {
  const a = await startApp();
  try {
    const b = await startApp({ flags: { port: a.shellPort } });
    try {
      assert.notEqual(b.shellPort, a.shellPort);
      assert.equal((b.shellPort - a.shellPort) % 2, 0);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});
