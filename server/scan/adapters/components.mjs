// Shared components a project already has: files in its library folders
// (libraryPrefixes, by default src/components/ui/) whose names say what they
// are (button, input, card, badge ...). Only the file name and the names it
// exports are read; no code is run.

const EXT_RE = /\.(jsx|tsx|js|ts|mjs|vue|svelte|astro)$/i;

// File base names (lower case, without "-" or "_") -> component kind.
const KINDS = {
  button: "button", btn: "button", iconbutton: "button",
  input: "input", textfield: "input", textinput: "input",
  textarea: "textarea",
  select: "select", combobox: "select",
  checkbox: "checkbox",
  radio: "radio", radiogroup: "radio",
  switch: "switch", toggle: "switch",
  label: "label",
  card: "card",
  badge: "badge", chip: "badge", tag: "badge", pill: "badge",
  avatar: "avatar",
  alert: "alert", callout: "alert", banner: "alert",
  dialog: "dialog", modal: "dialog", alertdialog: "dialog",
  tabs: "tabs",
  table: "table", datatable: "table",
  separator: "divider", divider: "divider",
  heading: "heading", title: "heading", typography: "heading",
  text: "text", paragraph: "text",
  image: "image", img: "image", picture: "image",
  link: "link", anchor: "link",
  container: "container", section: "container", box: "container", stack: "container",
  grid: "grid", row: "grid",
  tooltip: "tooltip", popover: "popover", sheet: "sheet", drawer: "sheet",
  toast: "toast", sonner: "toast", snackbar: "toast",
  skeleton: "skeleton", progress: "progress", slider: "slider", accordion: "accordion",
  breadcrumb: "breadcrumb", pagination: "pagination",
  nav: "nav", navbar: "nav", navigationmenu: "nav", menubar: "nav",
  form: "form", icon: "icon",
};

const PASCAL_RE = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const EXPORT_PATTERNS = [
  /\bexport\s+default\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]{0,63})/g,
  /\bexport\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]{0,63})/g,
  /\bexport\s+(?:const|let|var|class)\s+([A-Z][A-Za-z0-9_]{0,63})/g,
  /\bexport\s+default\s+([A-Z][A-Za-z0-9_]{0,63})\s*;/g,
];

// The names in every "export { A, B as C }" list, in one pass: the next "}"
// is looked up again only once it lies behind.
function exportLists(text) {
  const out = [];
  let from = 0;
  let close = -1;
  for (;;) {
    const at = text.indexOf("export", from);
    if (at === -1) return out;
    from = at + 6;
    if (at > 0 && /[\w$]/.test(text[at - 1])) continue;
    let i = from;
    while (i < text.length && /\s/.test(text[i]) && i - from < 20) i++;
    if (text[i] !== "{") continue;
    if (close < i) close = text.indexOf("}", i);
    if (close === -1) return out;
    if (close - i > 2000) continue;
    for (const part of text.slice(i + 1, close).split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const n = (bits[1] || bits[0]).trim();
      if (PASCAL_RE.test(n)) out.push({ name: n, at });
    }
  }
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(EXT_RE, "");
const pascal = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");

export function kindOf(relPath) {
  return KINDS[baseName(relPath).toLowerCase().replace(/[-_.\s]/g, "")] || null;
}

function inLibrary(relPath, prefixes) {
  return (prefixes || []).some((p) => {
    const pre = p.endsWith("/") ? p : `${p}/`;
    return relPath.startsWith(pre) && !relPath.slice(pre.length).includes("/");
  });
}

export default {
  id: "components",
  rank: 10,
  match: (relPath, opts = {}) => EXT_RE.test(relPath) && inLibrary(relPath, opts.libraryPrefixes) && kindOf(relPath) !== null,
  extract({ path, text, helpers }) {
    const out = { tokens: [], usages: [], components: [], diagnostics: [] };
    const kind = kindOf(path);
    if (!kind) return out;
    const base = baseName(path);
    const want = pascal(base);
    let name = null;
    let line = 1;
    if (/\.(vue|svelte|astro)$/i.test(path)) name = want;
    else {
      const pos = helpers.positions(text);
      const found = [];
      for (const re of EXPORT_PATTERNS) {
        for (const m of text.matchAll(re)) found.push({ name: m[1], at: m.index });
      }
      found.push(...exportLists(text));
      found.sort((a, b) => a.at - b.at);
      const best = found.find((f) => f.name.toLowerCase() === want.toLowerCase()) || found[0];
      if (best) {
        name = best.name;
        line = pos(best.at).line;
      }
    }
    if (name && PASCAL_RE.test(name)) out.components.push({ kind, export: name, line });
    return out;
  },
};
