// Vue template compiler transform: stamps each plain HTML element in a .vue
// template with data-loc="<path from the project root>:<line>:<column>".
// Components, <slot> and <template> are left alone. Use it only while
// serving:
//
//   import vue from "@vitejs/plugin-vue";
//   import dataLoc from "<path to dftp>/plugins/vue-data-loc.mjs";
//   export default defineConfig(({ command }) => ({
//     plugins: [vue({ template: { compilerOptions: {
//       nodeTransforms: command === "serve" ? [dataLoc({ root: process.cwd() })] : [],
//     } } })],
//   }));
//
// Options: { root = process.cwd(), attr = "data-loc" }. A plain string is
// taken as the root.

import path from "node:path";
import { createRequire } from "node:module";

const { relativeFile } = createRequire(import.meta.url)("./babel-plugin-data-loc.cjs");

// @vue/compiler-core node and prop type numbers.
const ELEMENT = 1;
const TEXT = 2;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;
const PLAIN_ELEMENT = 0;

export default function dataLoc(options = {}) {
  const opts = typeof options === "string" ? { root: options } : options || {};
  const root = path.resolve(opts.root || process.cwd());
  const attr = opts.attr === undefined ? "data-loc" : opts.attr;
  if (typeof attr !== "string" || !/^data-[a-z0-9-]{1,30}$/.test(attr)) throw new Error("data-loc transform: attr must look like data-loc");

  return function dataLocTransform(node, context) {
    if (process.env.NODE_ENV === "production") return;
    if (!node || node.type !== ELEMENT || node.tagType !== PLAIN_ELEMENT || !node.loc || !Array.isArray(node.props)) return;
    const taken = node.props.some((p) =>
      (p.type === ATTRIBUTE && p.name === attr) ||
      (p.type === DIRECTIVE && p.name === "bind" && p.arg && p.arg.content === attr));
    if (taken) return;
    const rel = relativeFile(root, context && context.filename);
    if (!rel) return;
    const { line, column } = node.loc.start;
    if (!Number.isInteger(line) || !Number.isInteger(column)) return;
    const value = `${rel}:${line}:${column}`;
    const loc = node.loc;
    node.props.push({
      type: ATTRIBUTE,
      name: attr,
      nameLoc: loc,
      value: { type: TEXT, content: value, loc },
      loc,
    });
  };
}
