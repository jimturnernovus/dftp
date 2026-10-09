// The browser loads the shell's and the layer's modules from fixed lists
// (server/static.mjs). Every module a served module imports must be on the
// same list at the URL the import resolves to, or the designer (or the
// layer) never starts. The Styles tab and the live sample need the token
// modules on both lists.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SHELL_FILES, LAYER_FILES } from "../../server/static.mjs";
import { TOOL_DIR } from "../helpers.mjs";

const IMPORT_RE = /^\s*import\s[^;]*?from\s+"(\.{1,2}\/[^"]+)";?\s*$/gm;

// A listed file that does not exist is left out of the table at startup
// (static.mjs createStatic), so it counts as not served.
function missingImports(list) {
  const byUrl = new Map(list.filter(([, file]) => fs.existsSync(path.join(TOOL_DIR, file))));
  const missing = [];
  for (const [url, file] of byUrl) {
    if (!file.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(TOOL_DIR, file), "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = path.posix.resolve(path.posix.dirname(url), m[1]);
      if (!byUrl.has(target)) missing.push(`${url} imports ${target}`);
    }
  }
  return missing;
}

test("the token modules and the Styles tab are served to the designer, and the token module to the layer", () => {
  const shell = new Map(SHELL_FILES);
  const layer = new Map(LAYER_FILES);
  assert.equal(shell.get("/core/styles-panel.js"), "client/core/styles-panel.js");
  assert.equal(shell.get("/core/tokens.js"), "client/core/tokens.js");
  assert.equal(shell.get("/core/css-values.js"), "client/core/css-values.js");
  assert.equal(layer.get("/__dftp/core/tokens.js"), "client/core/tokens.js");
});

test("every relative import of a served module is served at the address it resolves to", () => {
  assert.deepEqual(missingImports(SHELL_FILES), []);
  assert.deepEqual(missingImports(LAYER_FILES), []);
  // The check itself finds a missing module.
  const without = missingImports(SHELL_FILES.filter(([url]) => url !== "/core/tokens.js"));
  for (const m of ["/core/protocol.js imports /core/tokens.js", "/core/styles-panel.js imports /core/tokens.js"]) assert.ok(without.includes(m), m);
});
