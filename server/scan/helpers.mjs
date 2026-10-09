// Pure utilities handed to every adapter as `helpers`. Nothing here touches
// the file system, the network or project code.

import { parseCss, parseDeclList, stripComments } from "./css-parse.mjs";
import { parseJsonTree, getKey, plain, JsonError } from "./json-parse.mjs";
import { parseColor, parseDimension, splitTop, fnCall } from "../../client/core/css-values.js";
import { isStyleProp, wholeVarRef, wholeBraceRef } from "./usage.mjs";

// offset -> {line, col}, both 1-based, for one text. The line starts are
// found once; each lookup is a binary search.
export function positions(text) {
  const s = String(text);
  const starts = [0];
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    const o = Math.max(0, Math.min(s.length, offset | 0));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: o - starts[lo] + 1 };
  };
}

// A theme marker in a selector: the .dark / .light class, .theme-<name>, or
// a data-theme style attribute with a value.
const THEME_MARK_RE = /\.(dark|light)(?![\w-])|\.theme-([a-z0-9-]{1,24})(?![\w-])|\[\s*data-(?:theme|mode|color-scheme|color-mode|bs-theme)\s*=\s*["']?([a-z0-9-]{1,24})["']?\s*(?:i\s*)?\]/;
// What may sit around a theme marker in a selector that still targets the
// whole page: :root, html, body, :host, wrappers (:where, :is, and :global
// of Svelte and CSS modules) and combinators.
const ROOTISH_RE = /:root|:host|\bhtml\b|\bbody\b|:where\(|:is\(|:global\(|[()*&>~+\s]/g;
// ":not(.light)", ":not([data-theme])", ":not([data-theme=light])": the page
// root whenever another theme is not switched on, as written inside
// @media (prefers-color-scheme: dark) so a switch can still override it.
const NOT_THEME_RE = /:not\(\s*(?:\.(?:dark|light)|\.theme-[a-z0-9-]{1,24}|\[\s*data-(?:theme|mode|color-scheme|color-mode|bs-theme)\s*(?:=\s*["']?[a-z0-9-]{1,24}["']?\s*(?:i\s*)?)?\])\s*\)/g;

function classifyItem(item) {
  let s = item.toLowerCase().trim().replace(NOT_THEME_RE, " ");
  let mode = null;
  const m = THEME_MARK_RE.exec(s);
  if (m) {
    mode = m[1] || m[2] || m[3];
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  }
  if (s.replace(ROOTISH_RE, "") !== "") return { kind: "scoped" };
  if (mode === null || mode === "light") return { kind: "base" };
  return { kind: "mode", mode };
}

// Where a custom property defined in this block applies:
//   {kind: "base"}            the whole page (:root, html, @theme, a light theme)
//   {kind: "mode", mode}      a theme (.dark, [data-theme="dark"],
//                             @media (prefers-color-scheme: dark))
//   {kind: "scoped"}          anything narrower (a component, a width range)
export function themeScope(ctx) {
  let mediaMode = null;
  for (const q of ctx.media || []) {
    const m = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(q);
    if (!m) return { kind: "scoped" };
    if (m[1].toLowerCase() === "dark") mediaMode = "dark";
  }
  const rules = ctx.rules || [];
  let mode = null;
  for (const rule of rules) {
    const items = splitTop(rule, ",");
    if (items.length === 0) return { kind: "scoped" };
    const kinds = items.map(classifyItem);
    if (kinds.some((k) => k.kind === "scoped")) return { kind: "scoped" };
    const modes = new Set(kinds.map((k) => (k.kind === "mode" ? k.mode : "")));
    if (modes.size !== 1) return { kind: "scoped" };
    const only = [...modes][0];
    if (only) {
      if (mode && mode !== only) return { kind: "scoped" };
      mode = only;
    }
  }
  if (rules.length === 0 && !ctx.theme) return { kind: "scoped" };
  const final = mode || mediaMode;
  return final ? { kind: "mode", mode: final } : { kind: "base" };
}

const MQ_RE = /\(\s*(min|max)-width\s*:\s*([0-9.]{1,12}[a-z]{0,4})\s*\)/gi;
const RANGE_RE = /\(\s*width\s*(>=|<=|>|<)\s*([0-9.]{1,12}[a-z]{0,4})\s*\)/gi;
const RANGE_REV_RE = /\(\s*([0-9.]{1,12}[a-z]{0,4})\s*(>=|<=|>|<)\s*width\s*\)/gi;

// The width boundaries a media query names: [{prop: "media-min" | "media-max", raw}].
// "width < X" starts the next range at X, so it counts as a minimum.
export function mediaWidths(prelude) {
  const q = String(prelude).slice(0, 300);
  const out = [];
  for (const m of q.matchAll(MQ_RE)) out.push({ prop: m[1].toLowerCase() === "min" ? "media-min" : "media-max", raw: m[2] });
  for (const m of q.matchAll(RANGE_RE)) out.push({ prop: m[1] === "<=" ? "media-max" : "media-min", raw: m[2] });
  for (const m of q.matchAll(RANGE_REV_RE)) out.push({ prop: m[2] === ">=" ? "media-max" : "media-min", raw: m[1] });
  return out;
}

export const helpers = Object.freeze({
  parseCss,
  parseDeclList,
  stripComments,
  parseJsonTree,
  getKey,
  plain,
  JsonError,
  parseColor,
  parseDimension,
  splitTop,
  fnCall,
  isStyleProp,
  wholeVarRef,
  wholeBraceRef,
  positions,
  lineCol: positions,
  themeScope,
  mediaWidths,
});
