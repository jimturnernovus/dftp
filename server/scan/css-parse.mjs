// A small, forgiving CSS reader for the style scan. It walks the text once
// (comments, strings and escapes are skipped as units), so its time grows
// linearly with the input whatever the input holds. It does not build a full
// tree: it returns every declaration with the chain of rules and at-rules
// around it, and every at-rule block it opened.
//
// Nesting deeper than CSS_LIMITS.depth is counted (so braces stay matched)
// but nothing inside it is reported.

import { stripImportant } from "../../client/core/css-values.js";

export const CSS_LIMITS = Object.freeze({ decls: 20000, depth: 64, prelude: 300, value: 2000 });

const PROP_RE = /^-{0,2}[A-Za-z_][A-Za-z0-9_-]{0,200}$/;
const AT_NAME_RE = /^@([A-Za-z-]{1,40})/;

const ROOT = Object.freeze({ kind: "root", rules: Object.freeze([]), media: Object.freeze([]), at: Object.freeze([]), theme: false, depth: 0 });

// Comments out, white space collapsed, at most `max` characters.
function tidy(s, max) {
  let t = s;
  if (t.includes("/*")) t = stripComments(t);
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function stripComments(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("/*", i);
    if (a === -1) return out + s.slice(i);
    out += `${s.slice(i, a)} `;
    const b = s.indexOf("*/", a + 2);
    if (b === -1) return out;
    i = b + 2;
  }
}

function child(parent, prelude) {
  const m = AT_NAME_RE.exec(prelude);
  if (m) {
    const name = m[1].toLowerCase();
    const rest = prelude.slice(m[0].length).trim();
    return Object.freeze({
      kind: "at",
      name,
      prelude: rest,
      rules: parent.rules,
      media: name === "media" ? Object.freeze([...parent.media, rest]) : parent.media,
      at: Object.freeze([...parent.at, name]),
      theme: parent.theme || name === "theme",
      depth: parent.depth + 1,
    });
  }
  return Object.freeze({
    kind: "rule",
    prelude,
    rules: Object.freeze([...parent.rules, prelude]),
    media: parent.media,
    at: parent.at,
    theme: parent.theme,
    depth: parent.depth + 1,
  });
}

// The index of the first ":" outside parentheses and strings, or -1.
function topColon(s) {
  let depth = 0;
  let quote = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (quote) {
      if (c === 92) i++;
      else if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 40) depth++;
    else if (c === 41) depth = Math.max(0, depth - 1);
    else if (c === 58 && depth === 0) return i;
  }
  return -1;
}

// text: the style sheet. base: added to every offset (for style sheets that
// sit inside a larger file). media: media queries that hold the whole sheet
// (a <style media="..."> element). Returns {decls, blocks, truncated}:
//   decls:  [{prop, value, important, offset, ctx, tooLong?}]
//   blocks: [{name, prelude, offset}] for every at-rule block opened
//   ctx:    {rules: [selector text, outer first], media: [media query text],
//            at: [at-rule names], theme: inside @theme}
export function parseCss(text, { base = 0, maxDecls = CSS_LIMITS.decls, media = [] } = {}) {
  const s = String(text);
  const n = s.length;
  const decls = [];
  const blocks = [];
  const outer = Array.isArray(media) ? media.filter((m) => typeof m === "string" && m.trim()).slice(0, 4).map((m) => tidy(m, CSS_LIMITS.prelude)) : [];
  const stack = [outer.length ? Object.freeze({ ...ROOT, media: Object.freeze(outer) }) : ROOT];
  let start = 0;
  let paren = 0;
  let overflow = 0;
  let truncated = false;

  const flush = (from, to) => {
    const ctx = stack[stack.length - 1];
    if (ctx.kind === "root" || overflow > 0) return;
    let raw = s.slice(from, to);
    if (raw.includes("/*")) raw = stripComments(raw);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) return;
    const colon = topColon(body);
    if (colon <= 0) return;
    const prop = body.slice(0, colon).trim();
    if (!PROP_RE.test(prop)) return;
    let value = body.slice(colon + 1).trim();
    let important = false;
    const bang = value.toLowerCase().lastIndexOf("!important");
    if (bang !== -1 && value.slice(bang + 10).trim() === "") {
      important = true;
      value = value.slice(0, bang).trim();
    }
    if (decls.length >= maxDecls) {
      truncated = true;
      return;
    }
    const d = { prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value, important, offset: base + from + lead, ctx };
    if (value.length > CSS_LIMITS.value) {
      d.value = "";
      d.tooLong = true;
    }
    decls.push(d);
  };

  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 47 && s.charCodeAt(i + 1) === 42) {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === 34 || c === 39) {
      let j = i + 1;
      for (; j < n; j++) {
        const d = s.charCodeAt(j);
        if (d === 92) j++;
        else if (d === c || d === 10) break;
      }
      i = j;
      continue;
    }
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 123) {
      const top = stack[stack.length - 1];
      if (overflow > 0 || top.depth >= CSS_LIMITS.depth) {
        // Too deep: keep braces matched, report nothing inside.
        overflow++;
        truncated = true;
      } else {
        const head = s.slice(start, i);
        const ctx = child(top, tidy(head, CSS_LIMITS.prelude));
        if (ctx.kind === "at" && blocks.length < maxDecls) {
          blocks.push({ name: ctx.name, prelude: ctx.prelude, offset: base + start + (head.length - head.trimStart().length) });
        }
        stack.push(ctx);
      }
      start = i + 1;
      paren = 0;
      continue;
    }
    if (c === 125) {
      if (overflow > 0) overflow--;
      else {
        flush(start, i);
        if (stack.length > 1) stack.pop();
      }
      start = i + 1;
      paren = 0;
      continue;
    }
    if (c === 40) paren++;
    else if (c === 41) paren = Math.max(0, paren - 1);
    else if (c === 59 && paren === 0) {
      flush(start, i);
      start = i + 1;
    }
  }
  flush(start, n);
  return { decls, blocks, truncated };
}

// Declarations of a style attribute ("color: red; padding: 4px"), with the
// same rules as inside a block. Entities such as &quot; are skipped as a
// unit so their ";" does not end a declaration; decode() is applied to each
// value afterwards. A declaration longer than a value may be (plus room for
// its name) is dropped before anything else is done with it. Returns
// [{prop, value, offset}].
export function parseDeclList(text, { base = 0, decode = (v) => v, max = 500 } = {}) {
  const s = String(text);
  const out = [];
  let start = 0;
  let paren = 0;
  let quote = 0;
  const flush = (from, to) => {
    if (out.length >= max || to - from > CSS_LIMITS.value + CSS_LIMITS.prelude) return;
    const raw = s.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const body = decode(raw.trim());
    const colon = topColon(body);
    if (colon <= 0) return;
    const prop = body.slice(0, colon).trim();
    if (!PROP_RE.test(prop)) return;
    let value = stripImportant(body.slice(colon + 1).trim());
    if (value.length > CSS_LIMITS.value) value = "";
    if (value) out.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value, offset: base + from + lead });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (quote) {
      if (c === 92) i++;
      else if (c === quote) quote = 0;
      continue;
    }
    if (c === 34 || c === 39) quote = c;
    else if (c === 38) {
      // "&name;" or "&#123;": step over it whole when it closes within 10
      // characters. Only those 11 characters are looked at, so a long run of
      // "&" stays linear.
      const w = s.slice(i, i + 11);
      const k = w.indexOf(";");
      if (k > 0 && /^&#?[A-Za-z0-9]{1,8};$/.test(w.slice(0, k + 1))) i += k;
    } else if (c === 40) paren++;
    else if (c === 41) paren = Math.max(0, paren - 1);
    else if (c === 59 && paren === 0) {
      flush(start, i);
      start = i + 1;
    }
  }
  flush(start, s.length);
  return out;
}
