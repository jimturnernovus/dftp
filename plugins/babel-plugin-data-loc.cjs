"use strict";
// Babel plugin: stamps each host element in JSX/TSX with
//   data-loc="<path from the project root>:<line>:<column>"
// pointing at the element's "<" in the source file. Development only: it does
// nothing when NODE_ENV is "production", and never stamps files outside the
// project root or inside node_modules. Components (<Button>, <ui.Card>) are
// left alone; the elements they render are stamped in their own files.
//
// Options: { root = process.cwd(), attr = "data-loc" }

const path = require("node:path");

const ATTR_RE = /^data-[a-z0-9-]{1,30}$/;
// The characters a change file accepts in a source path.
const FILE_RE = /^[A-Za-z0-9_@$./+()[\]-]{1,300}$/;

// Project-relative POSIX path of `filename`, or null when the file must not
// be stamped (outside the root, under node_modules, or an unusual name).
function relativeFile(root, filename) {
  if (typeof filename !== "string" || filename === "" || filename.startsWith("\0")) return null;
  const clean = filename.split("?")[0];
  if (!path.isAbsolute(clean)) return null;
  const rel = path.relative(root, clean);
  if (rel === "" || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  const parts = posix.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p === "node_modules")) return null;
  return FILE_RE.test(posix) ? posix : null;
}

function dataLoc(api, options) {
  const t = api.types;
  const opts = options || {};
  const root = path.resolve(opts.root || process.cwd());
  const attr = opts.attr === undefined ? "data-loc" : opts.attr;
  if (typeof attr !== "string" || !ATTR_RE.test(attr)) throw new Error("data-loc plugin: attr must look like data-loc");

  return {
    name: "dftp-data-loc",
    visitor: {
      JSXOpeningElement(p, state) {
        if (process.env.NODE_ENV === "production") return;
        const node = p.node;
        if (!node.loc || !t.isJSXIdentifier(node.name) || !/^[a-z]/.test(node.name.name)) return;
        const has = node.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attr);
        if (has) return;
        const rel = relativeFile(root, state.filename || (state.file && state.file.opts && state.file.opts.filename));
        if (!rel) return;
        const value = `${rel}:${node.loc.start.line}:${node.loc.start.column + 1}`;
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(attr), t.stringLiteral(value)));
      },
    },
  };
}

module.exports = dataLoc;
module.exports.default = dataLoc;
module.exports.relativeFile = relativeFile;
