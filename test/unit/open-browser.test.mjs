// The browser opener: only the designer's loopback address (with or without
// its one-time key), run without a shell.

import test from "node:test";
import assert from "node:assert/strict";
import { openCommand } from "../../server/open-browser.mjs";

const KEY = "a".repeat(48);

test("opens the designer link with its one-time key", () => {
  assert.deepEqual(openCommand(`http://127.0.0.1:7450/?k=${KEY}`, "darwin"), { cmd: "open", args: [`http://127.0.0.1:7450/?k=${KEY}`] });
  assert.equal(openCommand(`http://[::1]:7450/?k=${KEY}`, "linux").cmd, "xdg-open");
  assert.equal(openCommand("http://127.0.0.1:7450/", "win32").cmd, "rundll32");
});

test("refuses anything else", () => {
  for (const u of [
    "https://127.0.0.1:7450/", "http://localhost:7450/", "http://example.com/", `http://127.0.0.1:7450/?k=${KEY}&x=1`,
    "http://127.0.0.1:7450/?k=ZZZZ", "http://127.0.0.1:7450/path", "http://127.0.0.1:7450/?k=$(touch /tmp/x)", "file:///etc/passwd",
  ]) assert.equal(openCommand(u, "darwin"), null, u);
});
