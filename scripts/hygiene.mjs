#!/usr/bin/env node
// Public, generic checks run in CI and before every release:
//
//   - no HTML or code-from-string sinks, no wildcard postMessage, no CORS
//     headers, and only loopback URLs in shipped code;
//   - no personal paths, no real email addresses, no secret-looking strings;
//   - no runtime dependencies, pinned development dependencies, no install
//     scripts;
//   - `npm pack` ships exactly the intended files, including every file the
//     server serves;
//   - skills/dftp/SKILL.md matches CLAUDE.md, and CLAUDE.md still has the
//     section CHANGES.md points readers to;
//   - CI workflows: read-only permissions, actions pinned to commit hashes,
//     no privileged triggers and no secrets;
//   - relative links in the Markdown docs point at files that exist.
//
// Prints category and file:line only, never the text that matched. Exit code
// 1 when anything is found.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skillState, TARGET as SKILL_FILE } from "./build-skill.mjs";
import { SHELL_FILES, SHELL_INDEX, LAYER_FILES, DEMO_PAGE, DEMO_FILES } from "../server/static.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", ".dftp", "test-results", "playwright-report"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".txt", ".yml", ".yaml", ".command", ".bat", ".sh", ".svg", ".ts", ".tsx", ".jsx", ".vue"]);
const TEXT_NAMES = new Set([".gitignore", ".gitattributes", ".npmrc", "LICENSE", ".editorconfig"]);
const CODE_DIRS = ["client/", "layer/", "server/", "bin/", "demo/", "plugins/"];
const isGenerated = (rel) => rel === "package-lock.json" || rel.endsWith("/package-lock.json");

// What `npm pack` may ship: these folders (everything in them) and these
// files at the top level. Nothing else.
const PACK_DIRS = ["bin/", "server/", "client/", "layer/", "demo/", "plugins/", "skills/"];
const PACK_TOP = ["package.json", "README.md", "CLAUDE.md", "SECURITY.md", "LICENSE", "CHANGELOG.md"];

// Patterns are assembled from pieces so this file does not match itself.
const j = (...parts) => parts.join("");
const RULES = {
  sink: new RegExp(j("\\.(inner", "HTML|outer", "HTML)\\b|insertAdjacent", "HTML|document\\.write|\\bsrc", "doc\\b|setHTML", "Unsafe|createContextual", "Fragment")),
  wildcardMessage: new RegExp(j("post", "Message\\([^)]*,\\s*[\"'`]\\*[\"'`]")),
  cors: new RegExp(j("Access-Control-", "Allow"), "i"),
  codeString: new RegExp(j("\\be", "val\\(|new\\s+Func", "tion\\b|set(Timeout|Interval)\\(\\s*[\"'`]")),
  personalPath: new RegExp(j("/Us", "ers/|[A-Za-z]:\\\\Us", "ers\\\\|/ho", "me/[a-z]")),
  email: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g,
  url: /\bhttps?:\/\/(\$\{[^}]*\}|\[[^\]]*\]|[^/\s"'`)<>\]?#]+)/g,
  secret: new RegExp(j(
    "\\bAK", "IA[0-9A-Z]{16}\\b|sk-a", "nt-[A-Za-z0-9_-]{16,}|\\bgh", "[pousr]_[A-Za-z0-9]{30,}|github_p", "at_[A-Za-z0-9_]{40,}|GOC", "SPX-[A-Za-z0-9_-]{16,}",
    "|\\bAI", "za[0-9A-Za-z_-]{30,}|\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    "|-----BEGIN [A-Z ]*PRIVATE ", "KEY-----|\\bxox[abprs]-[A-Za-z0-9-]{10,}|\\bsk_li", "ve_[A-Za-z0-9]{16,}",
  )),
  urlCredentials: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`]+:[^/\s@"'`]+@/i,
  privilegedTrigger: new RegExp(j("pull_request", "_target|workflow", "_run\\b")),
  secretsRef: new RegExp(j("\\bsecre", "ts\\.")),
};
// Reserved names (RFC 2606 / 6761) and the GitHub no-reply domain.
const EMAIL_OK = /(@example\.(com|org|net)|\.example|\.test|\.invalid|\.localhost|@users\.noreply\.github\.com)$/i;
// "name@file.jsx" in a source location is not an address.
const NOT_EMAIL = /\.(m?js|cjs|jsx|tsx?|vue|svelte|html|css|json|md)$/i;
// Hostnames only; ports do not matter. A template placeholder (${...}) is
// built from checked settings at run time.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|\$\{[^}]*\})$/;
const CODE_HOST_OK = (h) => LOOPBACK_HOST.test(h) || h === "www.w3.org";
// Tests may also name reserved example domains and bare IP literals (which
// the code under test must refuse); never a real host name.
const TEST_HOST_OK = (h) => CODE_HOST_OK(h) ||
  /(^|\.)(example|test|invalid|localhost)$/.test(h) ||
  /^example\.(com|org|net)$/.test(h) ||
  /^[0-9.]+$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h);

function hostnameOf(authority) {
  const a = authority.replace(/^[^@]*@/, "").toLowerCase();
  if (a.startsWith("[")) return a.slice(0, a.indexOf("]") + 1);
  if (a.startsWith("${")) return a.slice(0, a.indexOf("}") + 1);
  return a.split(":")[0];
}

const findings = [];
const report = (category, file, line) => findings.push(`${category}: ${file}:${line}`);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile() || ent.isSymbolicLink()) out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  return out;
}

const files = walk(ROOT, []);
const fileSet = new Set(files);

// ---------------------------------------------------------------- files

for (const rel of files) {
  const base = path.basename(rel);
  if (base === ".DS_Store" || /^\.env/.test(base) || /\.(zip|tgz|log)$/i.test(base)) report("forbidden file", rel, 0);
  if (fs.lstatSync(path.join(ROOT, rel)).isSymbolicLink()) report("symbolic link", rel, 0);
}

for (const rel of ["bin/dftp.mjs", "start-demo.command"]) {
  if (!fileSet.has(rel)) report("missing file", rel, 0);
  else if (process.platform !== "win32" && !(fs.statSync(path.join(ROOT, rel)).mode & 0o100)) report("not executable", rel, 0);
}

// ---------------------------------------------------------------- text rules

for (const rel of files) {
  if (rel === SELF) continue;
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext) && !TEXT_NAMES.has(path.basename(rel))) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const isCode = CODE_DIRS.some((d) => rel.startsWith(d)) && /\.(m?js|cjs|html)$/.test(rel);
  const isTest = rel.startsWith("test/");
  const isWorkflow = rel.startsWith(".github/");
  const generated = isGenerated(rel);
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (isCode) {
      if (RULES.sink.test(line)) report("HTML sink", rel, n);
      if (RULES.codeString.test(line)) report("code from a string", rel, n);
    }
    if (!isTest && RULES.wildcardMessage.test(line)) report("postMessage to any origin", rel, n);
    if (isCode && RULES.cors.test(line)) report("CORS header", rel, n);
    if (RULES.personalPath.test(line)) report("personal path", rel, n);
    if (isWorkflow) {
      if (RULES.privilegedTrigger.test(line)) report("privileged workflow trigger", rel, n);
      if (RULES.secretsRef.test(line)) report("secrets in a workflow", rel, n);
    }
    if (!generated) {
      for (const m of line.matchAll(RULES.email)) {
        if (!EMAIL_OK.test(m[0]) && !NOT_EMAIL.test(m[0])) report("email address", rel, n);
      }
      for (const m of line.matchAll(RULES.url)) {
        const host = hostnameOf(m[1]);
        if (isCode && !CODE_HOST_OK(host)) report("non-loopback URL in code", rel, n);
        if (isTest && !TEST_HOST_OK(host)) report("real host name in a test", rel, n);
      }
      if (RULES.secret.test(line)) report("secret-looking string", rel, n);
      if (!isTest && RULES.urlCredentials.test(line)) report("credentials in a URL", rel, n);
    }
  });
}

// ---------------------------------------------------------------- package.json

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) report("runtime dependencies in package.json", "package.json", 0);
for (const k of ["optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
  if (pkg[k] && Object.keys(pkg[k]).length) report(`${k} in package.json`, "package.json", 0);
}
for (const [name, v] of Object.entries(pkg.devDependencies || {})) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) report(`devDependency not pinned (${name})`, "package.json", 0);
}
if (pkg.scripts) {
  for (const k of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
    if (pkg.scripts[k]) report(`lifecycle script "${k}"`, "package.json", 0);
  }
}
const npmrc = fileSet.has(".npmrc") ? fs.readFileSync(path.join(ROOT, ".npmrc"), "utf8") : "";
if (!/^ignore-scripts\s*=\s*true\s*$/m.test(npmrc)) report("install scripts not turned off", ".npmrc", 0);

// ---------------------------------------------------------------- npm pack

function packList() {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 60000,
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return parsed[0].files.map((f) => f.path.split(path.sep).join("/"));
  } catch {
    return null;
  }
}

const packed = packList();
if (!packed) {
  report("npm pack --dry-run did not run", "package.json", 0);
} else {
  const shipped = new Set(packed);
  const allowed = (p) => PACK_TOP.includes(p) || PACK_DIRS.some((d) => p.startsWith(d));
  for (const p of packed) if (!allowed(p)) report("npm pack ships a file outside the allowlist", p, 0);
  for (const p of files) if (allowed(p) && !shipped.has(p)) report("npm pack leaves out a file", p, 0);
  const served = [SHELL_INDEX, DEMO_PAGE, ...[...SHELL_FILES, ...LAYER_FILES, ...DEMO_FILES].map(([, file]) => file)];
  for (const file of served) if (!shipped.has(file)) report("npm pack leaves out a served file", file, 0);
  for (const file of ["bin/dftp.mjs", SKILL_FILE, ...PACK_TOP]) if (!shipped.has(file)) report("npm pack leaves out a required file", file, 0);
}

// ---------------------------------------------------------------- docs

try {
  const state = skillState(ROOT);
  if (state !== "ok") report(`${SKILL_FILE} is ${state}; run node scripts/build-skill.mjs`, SKILL_FILE, 0);
} catch {
  report("CLAUDE.md cannot be turned into the skill", "CLAUDE.md", 0);
}

if (fileSet.has("CLAUDE.md")) {
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  if (!/^## [0-9. ]*Applying changes\b/m.test(claude)) report("CLAUDE.md has no \"Applying changes\" section (CHANGES.md points to it)", "CLAUDE.md", 0);
} else {
  report("missing file", "CLAUDE.md", 0);
}

for (const rel of ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "start-demo.bat"]) {
  if (!fileSet.has(rel)) report("missing file", rel, 0);
}

// Relative links and images in Markdown must point at files that exist.
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
for (const rel of files.filter((f) => f.endsWith(".md") && !f.startsWith("test/"))) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const clean = decodeURIComponent(target.split("#")[0]);
      if (!clean) continue;
      const abs = path.resolve(ROOT, path.dirname(rel), clean);
      if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs)) report("broken relative link", rel, i + 1);
    }
  });
}

// ---------------------------------------------------------------- CI workflows

const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
for (const rel of workflows) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
  if (!lines.some((l) => /^permissions:\s*(read-all|\{\s*\}|$)/.test(l))) report("workflow without top-level read-only permissions", rel, 0);
  lines.forEach((line, i) => {
    if (/permissions:/.test(line) && /write-all/.test(line)) report("workflow with write-all permissions", rel, i + 1);
    if (/^\s+[a-z-]+:\s*write\s*$/.test(line)) report("workflow with a write permission", rel, i + 1);
    const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith("./")) return;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(ref)) report("action not pinned to a commit hash", rel, i + 1);
  });
}

// ---------------------------------------------------------------- result

if (findings.length) {
  for (const f of findings) process.stdout.write(`${f}\n`);
  process.stdout.write(`hygiene: ${findings.length} finding(s)\n`);
  process.exit(1);
}
process.stdout.write(`hygiene: ok (${files.length} files)\n`);
