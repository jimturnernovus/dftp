// Plain CSS: style declarations as usages (colors, fonts, spacing, radii,
// shadows, borders, z-index, opacity, transitions) and the width boundaries
// of @media queries. Custom property definitions are left to css-vars and
// @theme blocks to tailwind-v4.

// At-rules whose declarations describe something other than an element's
// look (a font file, a printed page, a counter, a registered property).
const DESCRIPTOR_AT = new Set(["font-face", "page", "counter-style", "property", "font-feature-values", "font-palette-values"]);

// Usages from a parsed style sheet, appended to out.
export function collectUsages(parsed, pos, helpers, out) {
  for (const d of parsed.decls) {
    if (d.prop.startsWith("--") || !helpers.isStyleProp(d.prop)) continue;
    if (d.ctx.at.some((a) => DESCRIPTOR_AT.has(a))) continue;
    const { line, col } = pos(d.offset);
    if (d.tooLong) {
      out.diagnostics.push({ code: "value-too-long", line });
      continue;
    }
    out.usages.push({ prop: d.prop, raw: d.value, line, col, selector: d.ctx.rules.length ? d.ctx.rules[d.ctx.rules.length - 1] : "" });
  }
  for (const b of parsed.blocks) {
    if (b.name !== "media") continue;
    const { line, col } = pos(b.offset);
    for (const w of helpers.mediaWidths(b.prelude)) out.usages.push({ prop: w.prop, raw: w.raw, line, col });
  }
  if (parsed.truncated) out.diagnostics.push({ code: "too-many-items" });
}

export default {
  id: "css",
  rank: 10,
  match: (relPath) => /\.css$/i.test(relPath),
  extract({ text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    collectUsages(helpers.parseCss(text), helpers.positions(text), helpers, out);
    return out;
  },
};
