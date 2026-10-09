// CSS custom properties as named tokens. A definition on :root (or html,
// body, :host) is the token's value; one under .dark, [data-theme="dark"]
// or @media (prefers-color-scheme: dark) is its value in that mode; one in
// any narrower rule is kept only as a fallback. @theme blocks belong to the
// tailwind-v4 adapter.

export function collectVars(parsed, pos, helpers, out) {
  for (const d of parsed.decls) {
    if (!d.prop.startsWith("--") || d.ctx.theme) continue;
    const { line, col } = pos(d.offset);
    if (d.tooLong) {
      out.diagnostics.push({ code: "value-too-long", line });
      continue;
    }
    const scope = helpers.themeScope(d.ctx);
    const t = { name: d.prop, raw: d.value, line, col };
    if (scope.kind === "mode") t.mode = scope.mode;
    else if (scope.kind === "scoped") t.scoped = true;
    const ref = helpers.wholeVarRef(d.value);
    if (ref) t.aliasRef = ref.name;
    out.tokens.push(t);
  }
}

export default {
  id: "css-vars",
  rank: 20,
  match: (relPath) => /\.css$/i.test(relPath),
  extract({ text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    collectVars(helpers.parseCss(text), helpers.positions(text), helpers, out);
    return out;
  },
};
