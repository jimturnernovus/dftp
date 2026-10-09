// HTML files: <style> blocks (read with the CSS adapters; a media="..."
// attribute holds the whole block, so media="(prefers-color-scheme: dark)"
// gives dark values), inline style="" declarations, and class lists (kept
// as usages for a later class-name adapter). Text between tags is never
// read; script, textarea and similar raw-text elements are stepped over
// whole.

import { collectUsages } from "./css.mjs";
import { collectVars } from "./css-vars.mjs";
import { collectTheme } from "./tailwind-v4.mjs";

const RAW_TEXT = new Set(["script", "textarea", "title", "xmp", "noscript", "iframe", "noembed", "noframes", "plaintext"]);
const CLASS_RE = /^[A-Za-z0-9_:\-/[\].%#!@()&,*+=~]{1,100}$/;
const ENTITY = { quot: "\"", apos: "'", amp: "&", lt: "<", gt: ">", "#34": "\"", "#39": "'", "#x27": "'", "#x22": "\"" };
const decode = (s) => s.replace(/&(quot|apos|amp|lt|gt|#34|#39|#x27|#x22);/gi, (m, k) => ENTITY[k.toLowerCase()] || m);
const MAX_CLASSES = 20000;

const isNameChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 58 || c === 95;
export const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
// Media attributes that cover every screen, so the block is not narrowed.
const ANY_MEDIA_RE = /^(?:all|screen)$/i;

// The <style> element's content s[from, to), read with the CSS adapters'
// rules into out.
export function styleBlock(s, from, to, attrs, pos, helpers, out) {
  const m = attrs.find((a) => a.name === "media");
  const q = m ? decode(m.value).trim() : "";
  const media = q && !ANY_MEDIA_RE.test(q) ? [q] : [];
  const parsed = helpers.parseCss(s.slice(from, to), { base: from, media });
  collectUsages(parsed, pos, helpers, out);
  collectVars(parsed, pos, helpers, out);
  collectTheme(parsed, pos, helpers, out);
}

// Attributes of the tag whose name ends at i: {attrs: [{name, value, at}], end}
// where at is the offset of the value and end is just past ">".
export function readAttrs(s, i) {
  const attrs = [];
  let j = i;
  const n = s.length;
  while (j < n) {
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j >= n) break;
    const c = s[j];
    if (c === ">") return { attrs, end: j + 1 };
    if (c === "/") {
      j++;
      continue;
    }
    const nameStart = j;
    while (j < n && !isSpace(s.charCodeAt(j)) && s[j] !== "=" && s[j] !== ">" && s[j] !== "/") j++;
    const name = s.slice(nameStart, j).toLowerCase();
    if (j === nameStart) {
      j++;
      continue;
    }
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (s[j] !== "=") {
      attrs.push({ name, value: "", at: j });
      continue;
    }
    j++;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    const q = s[j];
    if (q === "\"" || q === "'") {
      const close = s.indexOf(q, j + 1);
      const end = close === -1 ? n : close;
      attrs.push({ name, value: s.slice(j + 1, end), at: j + 1 });
      j = end + 1;
    } else {
      const vs = j;
      while (j < n && !isSpace(s.charCodeAt(j)) && s[j] !== ">") j++;
      attrs.push({ name, value: s.slice(vs, j), at: vs });
    }
  }
  return { attrs, end: n };
}

export default {
  id: "html",
  rank: 15,
  match: (relPath) => /\.html?$/i.test(relPath),
  extract({ text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    const s = String(text);
    const lower = s.toLowerCase();
    const pos = helpers.positions(s);
    let classes = 0;
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf("<", i);
      if (lt === -1) break;
      if (s.startsWith("<!--", lt)) {
        const end = s.indexOf("-->", lt + 4);
        i = end === -1 ? s.length : end + 3;
        continue;
      }
      if (s[lt + 1] === "!" || s[lt + 1] === "?" || s[lt + 1] === "/") {
        const end = s.indexOf(">", lt + 1);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      let j = lt + 1;
      while (j < s.length && isNameChar(s.charCodeAt(j))) j++;
      if (j === lt + 1) {
        i = lt + 1;
        continue;
      }
      const tag = lower.slice(lt + 1, j);
      const { attrs, end } = readAttrs(s, j);
      for (const a of attrs) {
        if (a.name === "style" && a.value) {
          for (const d of helpers.parseDeclList(a.value, { base: a.at, decode })) {
            if (d.prop.startsWith("--") || !helpers.isStyleProp(d.prop)) continue;
            const p = pos(d.offset);
            out.usages.push({ prop: d.prop, raw: d.value, line: p.line, col: p.col, selector: "[style]" });
          }
        } else if (a.name === "class" && a.value) {
          const p = pos(a.at);
          for (const c of a.value.split(/[ \t\n\r\f]+/)) {
            if (!c || !CLASS_RE.test(c)) continue;
            if (++classes > MAX_CLASSES) break;
            out.usages.push({ prop: "class", raw: c, line: p.line, col: p.col });
          }
        }
      }
      i = end;
      if (tag === "style") {
        const close = lower.indexOf("</style", end);
        const stop = close === -1 ? s.length : close;
        styleBlock(s, end, stop, attrs, pos, helpers, out);
        i = stop;
      } else if (RAW_TEXT.has(tag)) {
        const close = lower.indexOf(`</${tag}`, end);
        i = close === -1 ? s.length : close;
      }
    }
    return out;
  },
};
