// The style scan: walks the project (walk.mjs), hands each file to every
// adapter whose match() accepts it, keeps adapter failures as diagnostics,
// and builds one tokens document (build.mjs). Writing the result is the
// store's job (store.writeTokens).

import { walkProject } from "./walk.mjs";
import { ADAPTERS } from "./registry.mjs";
import { helpers } from "./helpers.mjs";
import { buildDoc, checkOutput } from "./build.mjs";
import { applyLive } from "./live.mjs";
import { formatValue } from "../../client/core/css-values.js";
import { objectSummary } from "./objects.mjs";

// root: the project folder (real path). only: path prefixes to keep (the
// demo scans demo/ only). live: stored live samples to merge again, taken
// at the screen sizes in devices ([{id, width}], default the built-in
// ones). limits: overrides for the walk's budgets (tests). signal:
// AbortSignal.
export async function scanProject({
  root, libraryPrefixes = ["src/components/ui/"], only = null, adapters = ADAPTERS, limits = {}, signal,
  live = [], devices, now = () => new Date(), clock = () => Date.now(),
} = {}) {
  const t0 = clock();
  const opts = Object.freeze({ libraryPrefixes: Object.freeze([...(libraryPrefixes || [])]) });
  const matches = (a, rel) => {
    try {
      return a.match(rel, opts) === true;
    } catch {
      return false;
    }
  };
  const inScope = (rel) => !only || only.some((p) => rel.startsWith(p));
  const state = { diagnostics: [], stats: { files: 0, skipped: 0, truncated: false } };
  const counts = {};
  const results = [];
  const wants = (rel) => inScope(rel) && adapters.some((a) => matches(a, rel));
  for await (const f of walkProject(root, { wants, limits, signal, state, now: clock })) {
    for (const a of adapters) {
      if (!matches(a, f.rel)) continue;
      let out;
      try {
        out = checkOutput(a.extract({ path: f.rel, text: f.text, helpers }));
      } catch {
        out = null;
      }
      if (!out) {
        state.diagnostics.push({ adapter: a.id, file: f.rel, code: "adapter-error" });
        continue;
      }
      if (out.capped) out.diagnostics.push({ code: "too-many-items" });
      counts[a.id] = (counts[a.id] || 0) + 1;
      results.push({ file: f.rel, adapter: { id: a.id, rank: a.rank }, out });
    }
  }
  // A scan stopped from outside (the designer closing) builds nothing more.
  if (signal && signal.aborted) results.length = 0;
  const built = buildDoc({ results, diagnostics: state.diagnostics, stats: { ...state.stats, adapters: counts }, now });
  const doc = live && live.length ? applyLive(built, live, { devices }) : built;
  // The time covers reading, extracting and building.
  doc.scan.ms = Math.min(1e9, Math.max(0, Math.round(clock() - t0)));
  return doc;
}

const TYPE_LABELS = {
  color: "color", gradient: "gradient", dimension: "size", fontFamily: "font", fontSize: "font size",
  fontWeight: "font weight", lineHeight: "line height", letterSpacing: "letter spacing", radius: "radius",
  shadow: "shadow", border: "border", opacity: "opacity", zIndex: "z-index", duration: "duration",
  easing: "easing", breakpoint: "breakpoint",
};

// A few lines for the terminal. Names and values come from project files, so
// only ids, counts and normalised values are printed.
export function summaryLines(doc) {
  const lines = [];
  const scan = doc.scan || { files: 0, adapters: {}, ms: 0, truncated: false };
  const used = Object.entries(scan.adapters).map(([k, v]) => `${k} (${v})`).join(", ") || "none";
  lines.push(`Scanned ${scan.files} file(s) in ${(scan.ms / 1000).toFixed(1)} s; adapters: ${used}`);
  const byType = new Map();
  for (const t of doc.tokens) byType.set(t.type, (byType.get(t.type) || 0) + 1);
  const parts = [...byType].map(([k, v]) => `${TYPE_LABELS[k] || k} ${v}`).join(", ");
  lines.push(`Tokens: ${doc.tokens.length}${parts ? ` (${parts})` : ""}`);
  const roles = doc.tokens.filter((t) => t.role && t.value && t.type === "color").map((t) => `${t.role} ${t.id} ${formatValue(t.type, t.value)}`);
  if (roles.length) lines.push(`Roles: ${roles.slice(0, 8).join("; ")}${roles.length > 8 ? "; …" : ""}`);
  const s = doc.scales;
  lines.push(`Scales (px): spacing ${s.spacing.join(" ") || "-"}; font size ${s.fontSize.join(" ") || "-"}; radius ${s.radius.join(" ") || "-"}`);
  if (doc.breakpoints.length) lines.push(`Breakpoints: ${doc.breakpoints.map((b) => `${b.name} ${b.min}`).join(", ")}`);
  if (doc.components.length) lines.push(`Components: ${doc.components.map((c) => `${c.export} (${c.file})`).join(", ")}`);
  const objects = (doc.objects || []).filter((o) => Object.keys(o.style).length);
  if (objects.length) lines.push(`Object styles: ${objectSummary(objects)}`);
  const live = (doc.live || []).length;
  if (live) lines.push(`Live samples merged: ${live}`);
  lines.push(`Diagnostics: ${doc.diagnostics.length}${scan.truncated ? " (the scan stopped at a limit; see diagnostics)" : ""}`);
  return lines;
}
