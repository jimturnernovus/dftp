// Tailwind CSS v4 theme variables: the custom properties inside @theme
// blocks. The namespace in front of a name sets the token's type
// (--color-*, --font-*, --text-*, --spacing, --radius-*, --breakpoint-* ...);
// the rest of the name becomes its path.

// [prefix, type, group]; the longest matching prefix wins, so the list is
// kept longest first within each family.
const NAMESPACES = [
  ["--font-weight-", "fontWeight"],
  ["--font-", "fontFamily"],
  ["--color-", "color"],
  ["--text-", "fontSize"],
  ["--tracking-", "letterSpacing"],
  ["--leading-", "lineHeight"],
  ["--radius-", "radius"],
  ["--inset-shadow-", "shadow", "inset-shadow"],
  ["--drop-shadow-", "shadow", "drop-shadow"],
  ["--shadow-", "shadow"],
  ["--breakpoint-", "breakpoint"],
  ["--container-", "dimension", "container"],
  ["--spacing-", "dimension", "spacing"],
  ["--blur-", "dimension", "blur"],
  ["--ease-", "easing"],
];
const EXACT = {
  "--spacing": ["dimension", "spacing", ["default"]],
  "--radius": ["radius", null, ["default"]],
  "--default-transition-duration": ["duration", null, ["default"]],
  "--default-transition-timing-function": ["easing", null, ["default"]],
  "--default-font-family": ["fontFamily", null, ["default"]],
  "--default-mono-font-family": ["fontFamily", null, ["default-mono"]],
};
// Parts of --text-<size>--<part> that describe the size's companions.
const TEXT_PARTS = { "line-height": "lineHeight", "letter-spacing": "letterSpacing", "font-weight": "fontWeight" };

// {type, group, path} for a theme variable, or null for one DFTP does not
// keep (animations, perspectives, aspect ratios).
export function themeVar(name) {
  if (Object.prototype.hasOwnProperty.call(EXACT, name)) {
    const [type, group, path] = EXACT[name];
    return { type, group, path };
  }
  for (const [prefix, type, group] of NAMESPACES) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest) return null;
    if (type === "fontSize" && rest.includes("--")) {
      const [size, part] = rest.split("--", 2);
      const t = TEXT_PARTS[part];
      return t ? { type: t, group: null, path: [`text-${size}`] } : null;
    }
    return { type, group: group || null, path: rest.split(/-(?=[^-])/).filter(Boolean) };
  }
  return name.startsWith("--animate-") || name.startsWith("--perspective-") || name.startsWith("--aspect-") ? null : { type: null, group: null, path: null };
}

export function collectTheme(parsed, pos, helpers, out) {
  for (const d of parsed.decls) {
    if (!d.prop.startsWith("--") || !d.ctx.theme) continue;
    const { line, col } = pos(d.offset);
    if (d.tooLong) {
      out.diagnostics.push({ code: "value-too-long", line });
      continue;
    }
    // "--color-*: initial" clears a namespace; nothing to keep.
    if (d.value === "initial" || d.prop.endsWith("-*")) continue;
    const info = themeVar(d.prop);
    if (!info) continue;
    const t = { name: d.prop, raw: d.value, line, col };
    if (info.type) t.type = info.type;
    if (info.group) t.group = info.group;
    if (info.path) t.path = info.path;
    const ref = helpers.wholeVarRef(d.value);
    if (ref) t.aliasRef = ref.name;
    out.tokens.push(t);
  }
}

export default {
  id: "tailwind-v4",
  rank: 20,
  match: (relPath) => /\.css$/i.test(relPath),
  extract({ text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    if (!/@theme\b/.test(text)) return out;
    collectTheme(helpers.parseCss(text), helpers.positions(text), helpers, out);
    return out;
  },
};
