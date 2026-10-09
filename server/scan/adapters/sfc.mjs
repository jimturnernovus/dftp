// Single-file components (.vue, .svelte, .astro): their <style> blocks, read
// like an HTML page's (the CSS adapters' rules, a media attribute included).
// A block written in another language (lang="scss", "less", "stylus" ...)
// is skipped with a diagnostic. Templates, scripts and front matter are not
// read.

import { readAttrs, styleBlock, isSpace } from "./html.mjs";

const OTHER_LANG = new Set(["scss", "sass", "less", "stylus", "styl"]);

export default {
  id: "sfc",
  rank: 15,
  match: (relPath) => /\.(vue|svelte|astro)$/i.test(relPath),
  extract({ text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    const s = String(text);
    const lower = s.toLowerCase();
    const pos = helpers.positions(s);
    let i = 0;
    while (i < s.length) {
      const at = lower.indexOf("<style", i);
      if (at === -1) break;
      const next = lower.charCodeAt(at + 6);
      // "<styled-thing>" is another tag.
      if (!(isSpace(next) || next === 62 || next === 47)) {
        i = at + 6;
        continue;
      }
      const { attrs, end } = readAttrs(s, at + 6);
      const close = lower.indexOf("</style", end);
      const stop = close === -1 ? s.length : close;
      const lang = attrs.find((a) => a.name === "lang");
      if (lang && OTHER_LANG.has(lang.value.trim().toLowerCase())) out.diagnostics.push({ code: "parse-skip", line: pos(at).line });
      else styleBlock(s, end, stop, attrs, pos, helpers, out);
      i = Math.max(stop, at + 6);
    }
    return out;
  },
};
