// Adds the layer's module script to an HTML document coming back through the
// proxy. Works on bytes: the document is viewed as latin1 (one character per
// byte) only to find positions, and the tag is spliced in as ASCII, so any
// ASCII-compatible charset comes out untouched apart from the new tag.
//
// Also holds the Content-Security-Policy helpers the proxy needs: dropping
// frame-ancestors from an upstream policy and finding a nonce to reuse.

import zlib from "node:zlib";
import { promisify } from "node:util";

// Documents larger than this (encoded or decoded) pass through without the layer.
export const INJECT_LIMIT = 8 * 1024 * 1024;

const LAYER_SRC_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}\/__dftp\/overlay\.js$/;
// CSP nonce-source value (base64 or base64url, optional padding). Nothing in
// it can end an HTML attribute.
const NONCE_RE = /^[A-Za-z0-9+/_-]{1,256}={0,2}$/;
const WS_RE = /\s/;
const LETTER_RE = /[A-Za-z]/;
const NAME_CHAR_RE = /[^\s/>]/;
// Elements whose content is text, not markup, while scanning the head.
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "noscript", "xmp", "noembed", "noframes"]);
// Start tags that may appear in a head without ending it.
const HEAD_TAGS = new Set(["meta", "link", "title", "style", "script", "noscript", "base", "template"]);

// ---------------------------------------------------------------- media type

export function mediaType(contentType) {
  if (typeof contentType !== "string") return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

export function isHtmlType(contentType) {
  return mediaType(contentType) === "text/html";
}

function charsetOf(contentType) {
  if (typeof contentType !== "string") return "";
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : "";
}

// Byte order marks of encodings that are not ASCII-compatible.
function wideEncoding(buf, contentType) {
  if (/^utf-?(16|32)/.test(charsetOf(contentType))) return true;
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) return true;
  return false;
}

// ---------------------------------------------------------------- decoding

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);
const zstd = typeof zlib.zstdDecompress === "function" ? promisify(zlib.zstdDecompress) : null;

// Content-Encoding header value -> list of codings in the order they were
// applied ("identity" left out). null when the header is not understood.
export function parseEncodings(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const c of list) {
    if (c === "identity") continue;
    if (c === "gzip" || c === "x-gzip") out.push("gzip");
    else if (c === "deflate" || c === "br") out.push(c);
    else if (c === "zstd" && zstd) out.push(c);
    else return null;
  }
  return out;
}

// Undo the codings (last applied first). Resolves to the decoded bytes, or
// null when a coding is unknown, the data is broken, or the result would be
// larger than `limit`.
export async function decodeBody(buf, encodings, limit = INJECT_LIMIT) {
  if (!Array.isArray(encodings)) return null;
  let data = buf;
  const opts = { maxOutputLength: limit };
  try {
    for (let i = encodings.length - 1; i >= 0; i--) {
      const c = encodings[i];
      if (c === "gzip") data = await gunzip(data, opts);
      else if (c === "br") data = await brotli(data, opts);
      else if (c === "zstd" && zstd) data = await zstd(data, opts);
      else if (c === "deflate") {
        try {
          data = await inflate(data, opts);
        } catch (e) {
          if (e instanceof RangeError) throw e;
          data = await inflateRaw(data, opts);
        }
      } else return null;
    }
  } catch {
    return null;
  }
  return data.length > limit ? null : data;
}

// ---------------------------------------------------------------- CSP

// Header values (string or list of strings) -> list of single policies.
export function splitPolicies(values) {
  const list = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
  const out = [];
  for (const v of list) {
    for (const p of String(v).split(",")) if (p.trim()) out.push(p.trim());
  }
  return out;
}

function directives(policy) {
  return policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const parts = d.split(/[\t\n\f\r ]+/);
    return { name: parts[0].toLowerCase(), tokens: parts.slice(1), text: d };
  });
}

// Every policy with its frame-ancestors directive removed; policies left
// empty are dropped. Returns a list of policy strings (possibly empty).
export function withoutFrameAncestors(values) {
  const out = [];
  for (const p of splitPolicies(values)) {
    const kept = directives(p).filter((d) => d.name !== "frame-ancestors").map((d) => d.text);
    if (kept.length) out.push(kept.join("; "));
  }
  return out;
}

// The nonce a <script> element needs under these policies: from the first
// policy whose script-src-elem, else script-src, else default-src lists a
// valid 'nonce-...'. null when there is none.
export function nonceFromPolicies(values) {
  for (const p of splitPolicies(values)) {
    const ds = directives(p);
    const pickDirective = ["script-src-elem", "script-src", "default-src"]
      .map((n) => ds.find((d) => d.name === n))
      .find(Boolean);
    if (!pickDirective) continue;
    for (const tok of pickDirective.tokens) {
      const m = /^'nonce-(.+)'$/i.exec(tok);
      if (m && NONCE_RE.test(m[1])) return m[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------- scanning

// Index of the ">" that ends a start tag whose attributes begin at `from`.
// A quote opens a value only right after "=".
function tagEnd(text, from) {
  let quote = "";
  let afterEq = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
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
  }
  return -1;
}

function closeTagAt(text, name, from) {
  let i = from;
  for (;;) {
    const at = text.indexOf("</", i);
    if (at === -1) return -1;
    const after = text.charAt(at + 2 + name.length);
    if (text.slice(at + 2, at + 2 + name.length).toLowerCase() === name && (after === "" || after === ">" || after === "/" || WS_RE.test(after))) {
      return at;
    }
    i = at + 2;
  }
}

// Walk markup tokens from `from`. Calls visit({kind, name, start, nameEnd, end})
// for each start tag ("tag"), end tag ("end") and doctype ("doctype");
// comments and processing instructions are skipped. visit returns true to
// stop, or "skip" on a raw-text start tag (script, style, ...) to jump over
// its contents.
function walk(text, from, visit) {
  let i = from;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) return;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    const next = text.charAt(lt + 1);
    if (next === "!" || next === "?") {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) return;
      if (/^<!doctype/i.test(text.slice(lt, lt + 9)) && visit({ kind: "doctype", start: lt, end })) return;
      i = end + 1;
      continue;
    }
    if (next === "/") {
      let j = lt + 2;
      while (j < text.length && NAME_CHAR_RE.test(text[j])) j++;
      const end = text.indexOf(">", lt + 2);
      if (end === -1) return;
      if (visit({ kind: "end", name: text.slice(lt + 2, j).toLowerCase(), start: lt, end })) return;
      i = end + 1;
      continue;
    }
    if (!LETTER_RE.test(next)) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < text.length && NAME_CHAR_RE.test(text[j])) j++;
    const name = text.slice(lt + 1, j).toLowerCase();
    const end = tagEnd(text, j);
    if (end === -1) return;
    const r = visit({ kind: "tag", name, start: lt, nameEnd: j, end });
    if (r === true) return;
    i = end + 1;
    if (r === "skip" && RAW_TEXT.has(name)) {
      const close = closeTagAt(text, name, i);
      if (close === -1) return;
      i = close;
    }
  }
}

// Attributes of a start tag: [{name, value, nameStart, nameEnd}] with
// absolute indexes into `text`.
export function attributesOf(text, nameEnd, end) {
  const out = [];
  let i = nameEnd;
  while (i < end) {
    while (i < end && (WS_RE.test(text[i]) || text[i] === "/")) i++;
    if (i >= end) break;
    const nameStart = i;
    while (i < end && !WS_RE.test(text[i]) && text[i] !== "=" && text[i] !== ">" && !(text[i] === "/" && i > nameStart)) i++;
    if (i === nameStart) i++;
    const name = text.slice(nameStart, i).toLowerCase();
    const nameStop = i;
    let value = "";
    let k = i;
    while (k < end && WS_RE.test(text[k])) k++;
    if (text[k] === "=") {
      k++;
      while (k < end && WS_RE.test(text[k])) k++;
      const q = text[k];
      if (q === "\"" || q === "'") {
        const close = text.indexOf(q, k + 1);
        const stop = close === -1 || close > end ? end : close;
        value = text.slice(k + 1, stop);
        i = stop + 1;
      } else {
        let e = k;
        while (e < end && !WS_RE.test(text[e])) e++;
        value = text.slice(k, e);
        i = e;
      }
    }
    out.push({ name, value, nameStart, nameEnd: nameStop });
  }
  return out;
}

const NAMED = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt);?/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[k] || all;
  });
}

// Where the layer tag goes, and the head's CSP meta tags.
// Returns {at, metas:[{policy, renameStart, renameEnd}]}.
export function findInsertPoint(text) {
  const bom = text.startsWith("ï»¿") ? 3 : 0;
  let htmlEnd = -1;
  let doctypeEnd = -1;
  let headEnd = -1;
  walk(text, bom, (t) => {
    if (t.kind === "doctype") {
      if (htmlEnd === -1) doctypeEnd = t.end + 1;
      return false;
    }
    if (t.kind === "end") return false;
    if (t.name === "html") {
      htmlEnd = t.end + 1;
      return false;
    }
    if (t.name === "head") headEnd = t.end + 1;
    return true;
  });
  const at = headEnd !== -1 ? headEnd : htmlEnd !== -1 ? htmlEnd : doctypeEnd !== -1 ? doctypeEnd : bom;

  // CSP meta tags count only inside the head; stop at its end or at the
  // first element that cannot be in a head.
  const metas = [];
  walk(text, at, (t) => {
    if (t.kind === "doctype") return false;
    if (t.kind === "end") return t.name === "head";
    if (!HEAD_TAGS.has(t.name)) return true;
    if (t.name === "meta") {
      const attrs = attributesOf(text, t.nameEnd, t.end);
      const eq = attrs.find((a) => a.name === "http-equiv");
      const content = attrs.find((a) => a.name === "content");
      if (eq && decodeEntities(eq.value).trim().toLowerCase() === "content-security-policy") {
        metas.push({ policy: content ? decodeEntities(content.value) : "", renameStart: eq.nameStart, renameEnd: eq.nameEnd });
      }
    }
    return "skip";
  });
  return { at, metas };
}

// ---------------------------------------------------------------- the tag

export function layerTag(scriptSrc, nonce) {
  if (!LAYER_SRC_RE.test(scriptSrc)) throw new Error("bad layer address");
  const n = nonce && NONCE_RE.test(nonce) ? ` nonce="${nonce}"` : "";
  return `<script type="module" src="${scriptSrc}"${n}></script>`;
}

// Add the layer tag to a decoded HTML document.
//   buf          the document bytes (no content coding)
//   contentType  the response's Content-Type (for its charset)
//   scriptSrc    absolute URL of the layer boot module
//   headerCsp    the upstream Content-Security-Policy value(s) as sent on
//                (used only to find a nonce)
//   relaxCsp     also switch off CSP <meta> tags in the head
// Returns the new bytes, or null when the document cannot take the tag
// (a UTF-16/32 document).
export function injectLayer(buf, { contentType, scriptSrc, headerCsp, relaxCsp = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length > INJECT_LIMIT) return null;
  if (wideEncoding(buf, contentType)) return null;
  const text = buf.toString("latin1");
  const { at, metas } = findInsertPoint(text);
  let nonce = null;
  if (!relaxCsp) {
    nonce = nonceFromPolicies(headerCsp);
    if (!nonce) nonce = nonceFromPolicies(metas.map((m) => m.policy));
  }
  const edits = [{ at, del: 0, text: layerTag(scriptSrc, nonce) }];
  if (relaxCsp) {
    // Renaming the attribute leaves an inert <meta>.
    for (const m of metas) edits.push({ at: m.renameStart, del: m.renameEnd - m.renameStart, text: "data-dftp-http-equiv" });
  }
  edits.sort((a, b) => a.at - b.at);
  const parts = [];
  let last = 0;
  for (const e of edits) {
    parts.push(buf.subarray(last, e.at), Buffer.from(e.text, "latin1"));
    last = e.at + e.del;
  }
  parts.push(buf.subarray(last));
  return Buffer.concat(parts);
}
