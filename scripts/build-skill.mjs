#!/usr/bin/env node
// Builds skills/dftp/SKILL.md from CLAUDE.md, so the two never say different
// things. CLAUDE.md is the source; never edit SKILL.md by hand.
//
//   node scripts/build-skill.mjs           write skills/dftp/SKILL.md
//   node scripts/build-skill.mjs --check   exit 1 when the file is out of date

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "CLAUDE.md";
export const TARGET = "skills/dftp/SKILL.md";

const FRONT = [
  "---",
  "name: dftp",
  "description: Set up DFTP (Designer for the Page) in a web project, and apply the layout and text changes recorded in .dftp/CHANGES.md as real code. Use when the user asks to integrate, start or troubleshoot DFTP, or to apply, review or finish DFTP layout changes.",
  "---",
  "",
  "<!-- Generated from CLAUDE.md by scripts/build-skill.mjs. Edit CLAUDE.md, then run that script. -->",
  "",
  "# DFTP (Designer for the Page)",
  "",
];

// The skill keeps the paragraph that explains <dftp> and every numbered
// section; the opening lines about this repository are left out.
export function buildSkill(source) {
  const text = String(source).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const intro = lines.findIndex((l) => l.startsWith("In the commands below, `<dftp>`"));
  const first = lines.findIndex((l) => /^## 1\. /.test(l));
  if (intro === -1 || first === -1 || intro > first) {
    throw new Error(`${SOURCE} must hold the "<dftp>" paragraph before "## 1."`);
  }
  let end = intro;
  while (end < first && lines[end].trim() !== "") end++;
  const body = [...lines.slice(intro, end), "", ...lines.slice(first)];
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return `${[...FRONT, ...body].join("\n")}\n`;
}

export function expectedSkill(root = ROOT) {
  return buildSkill(fs.readFileSync(path.join(root, SOURCE), "utf8"));
}

// "ok", "missing" or "stale".
export function skillState(root = ROOT) {
  const want = expectedSkill(root);
  let have;
  try {
    have = fs.readFileSync(path.join(root, TARGET), "utf8");
  } catch {
    return "missing";
  }
  return have === want ? "ok" : "stale";
}

function main(argv) {
  if (argv.includes("--check")) {
    const state = skillState();
    if (state !== "ok") {
      process.stderr.write(`${TARGET} is ${state}; run: node scripts/build-skill.mjs\n`);
      return 1;
    }
    process.stdout.write(`${TARGET} matches ${SOURCE}\n`);
    return 0;
  }
  const file = path.join(ROOT, TARGET);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expectedSkill());
  process.stdout.write(`wrote ${TARGET}\n`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
