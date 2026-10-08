// Adds source locations to the demo page as it is served, so the demo works
// like a project whose build stamps elements. Every start tag in the body
// receives the stamping attribute, holding the file path followed by the
// 1-based line and column of its "<" in the untouched file. The layer's module script is added as the first child of
// <head>. The file on disk is never changed.

import { isFilePath } from "../client/core/schema.js";

const NO_STAMP = new Set(["html", "head", "meta", "link", "title", "script", "style", "base", "noscript", "template"]);
// Elements whose content is text, not markup.
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const NAME_CHAR_RE = /[^\s/>]/;
const LETTER_RE = /[A-Za-z]/;
const WS_RE = /\s/;

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function position(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: index - starts[lo] + 1 };
}

function findCloseTag(src, name, from) {
  let i = from;
  for (;;) {
    const at = src.indexOf("</", i);
    if (at === -1) return src.length;
    const after = src.charAt(at + 2 + name.length);
    if (src.slice(at + 2, at + 2 + name.length).toLowerCase() === name && (after === "" || after === ">" || after === "/" || WS_RE.test(after))) {
      return at;
    }
    i = at + 2;
  }
}

// Find the end ('>') of a start tag whose attributes begin at `from`. A quote
// opens a quoted value only right after "=" (spaces allowed between).
function tagEnd(src, from) {
  let i = from;
  let quote = "";
  let afterEq = false;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if ((ch === "\"" || ch === "'") && afterEq) {
      quote = ch;
      afterEq = false;
    } else if (ch === ">") {
      return i;
    } else if (ch === "=") {
      afterEq = true;
    } else if (!WS_RE.test(ch)) {
      afterEq = false;
    }
    i++;
  }
  return src.length;
}

// Every start tag outside comments, doctype and raw-text content, in order.
// Each: {name, start (index of "<"), nameEnd, end (index of ">"), line, col, attrs}.
export function scanStartTags(src) {
  const starts = lineStarts(src);
  const tags = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const next = src.charAt(lt + 1);
    if (next === "!" || next === "?" || next === "/") {
      const end = src.indexOf(">", lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (!LETTER_RE.test(next)) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < src.length && NAME_CHAR_RE.test(src[j])) j++;
    const name = src.slice(lt + 1, j).toLowerCase();
    const end = tagEnd(src, j);
    const { line, col } = position(starts, lt);
    tags.push({ name, start: lt, nameEnd: j, end, line, col, attrs: src.slice(j, end) });
    i = end + 1;
    if (RAW_TEXT.has(name)) i = findCloseTag(src, name, i);
  }
  return tags;
}

function hasAttr(attrs, attr) {
  const re = new RegExp(`(^|\\s)${attr}(\\s*=|\\s|/|$)`, "i");
  return re.test(attrs);
}

// opts: {file: "demo/active-clients.html", attr: "data-loc", scriptSrc: absolute URL of the layer boot module}
export function stampHtml(src, { file, attr = "data-loc", scriptSrc }) {
  if (!/^data-[a-z0-9-]{1,30}$/.test(attr)) throw new Error("bad attribute name");
  if (!isFilePath(file)) throw new Error("bad file name");
  if (scriptSrc !== undefined && !/^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}\/__dftp\/overlay\.js$/.test(scriptSrc)) {
    throw new Error("bad script address");
  }
  const tags = scanStartTags(src);
  const inserts = [];
  for (const t of tags) {
    if (NO_STAMP.has(t.name) || hasAttr(t.attrs, attr)) continue;
    inserts.push({ at: t.nameEnd, text: ` ${attr}="${file}:${t.line}:${t.col}"` });
  }
  if (scriptSrc) {
    const tag = `<script type="module" src="${scriptSrc}"></script>`;
    const head = tags.find((t) => t.name === "head");
    const html = tags.find((t) => t.name === "html");
    if (head) inserts.push({ at: head.end + 1, text: tag });
    else if (html) inserts.push({ at: html.end + 1, text: tag });
    else {
      const doctype = /^\s*<!doctype[^>]*>/i.exec(src);
      inserts.push({ at: doctype ? doctype[0].length : 0, text: tag });
    }
  }
  inserts.sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  for (const ins of inserts) {
    out += src.slice(last, ins.at) + ins.text;
    last = ins.at;
  }
  return out + src.slice(last);
}
