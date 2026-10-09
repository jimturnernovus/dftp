// Merging live samples (computed styles the designer read from the page)
// into a scanned tokens document. Values the scan already has are marked as
// seen on the page and counted; frequent values it has not seen become
// unnamed tokens. The samples are kept in the document ("live"), so a later
// scan can merge them again.
//
// A sample taken under the dark theme is matched against the tokens' dark
// values first, then their plain ones, and never adds a token: a token's
// value is its light one, and a dark color is not that. A unitless line
// height in a sample is a ratio the layer worked out from px values (the
// page itself only reports px), so it marks a unitless token as seen but
// never becomes a token of its own.
//
// The object styles a sample recorded (a primary button's whole look, a
// card's ...) become the document's live objects, named by tokens where
// tokens have their values (objects.mjs), ahead of the static ones the
// scan found in the files.

import { valueKey } from "../../client/core/css-values.js";
import { TOKEN_LIMITS, cleanRaw, checkValue } from "../../client/core/tokens.js";
import { usageValues, colorUse } from "./usage.mjs";
import { slugFor, uniqueId, sortTokens, computeScales } from "./build.mjs";
import { TYPE_GROUP } from "./names.mjs";
import { liveObjects, mergeObjects } from "./objects.mjs";

// A value seen on fewer elements than this does not become a token of its own.
export const LIVE_MIN = 3;

// The stored samples with `sample` added: one per page, device and theme
// (a newer one replaces the older), the most recent TOKEN_LIMITS.liveSamples kept.
export function mergeSamples(list, sample, at) {
  const same = (s) => s.page === sample.page && s.device === sample.device && s.theme === sample.theme;
  const next = [...(list || []).filter((s) => !same(s)), { ...sample, sampled_at: at }];
  next.sort((a, b) => (a.sampled_at < b.sampled_at ? -1 : a.sampled_at > b.sampled_at ? 1 : 0));
  return next.slice(-TOKEN_LIMITS.liveSamples);
}

// opts.devices: the designer's screen sizes ([{id, width}]), for object
// styles that differ by screen size (objects.mjs liveObjects).
export function applyLive(doc, samples, { devices } = {}) {
  const tokens = doc.tokens.map((t) => ({ ...t, sources: [...t.sources], usage: { ...t.usage } }));
  const used = new Set(tokens.map((t) => t.id));
  const index = new Map();
  const darkIndex = new Map();
  const put = (map, k, t) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  };
  for (const t of tokens) {
    if (!t.value) continue;
    put(index, valueKey(t.type, t.value), t);
    if (t.modes && t.modes.dark) put(darkIndex, valueKey(t.type, t.modes.dark), t);
  }
  const use = new Map();
  for (const s of samples || []) {
    const dark = s.theme === "dark";
    for (const e of s.values) {
      for (const v of usageValues(e.prop, e.value)) {
        const k = valueKey(v.type, v.value);
        let list = (dark && darkIndex.get(k)) || index.get(k);
        if (!list) {
          if (dark || (v.type === "lineHeight" && v.value.unit === "")) continue;
          if (e.count < LIVE_MIN || tokens.length >= TOKEN_LIMITS.tokens) continue;
          // Only a value the token file accepts becomes a token.
          if (!checkValue(v.type, v.value)) continue;
          const id = uniqueId(`${v.group || TYPE_GROUP[v.type]}.auto.${slugFor(v.type, v.value)}`, used);
          if (!id) continue;
          const t = {
            id, type: v.type, value: v.value, raw: cleanRaw(e.value), modes: {}, aliasOf: null, role: null,
            sources: [], usage: { count: 0, seenLive: true, live: 0 }, confidence: 0.45,
          };
          tokens.push(t);
          list = [t];
          index.set(k, list);
        }
        for (const t of list) {
          t.usage.seenLive = true;
          t.usage.live = Math.min(TOKEN_LIMITS.count, (t.usage.live || 0) + e.count);
          const has = t.sources.some((x) => x.adapter === "live" && x.page === s.page && x.device === s.device);
          if (!has && t.sources.length < TOKEN_LIMITS.sources) t.sources.push({ adapter: "live", page: s.page, device: s.device });
          const u = v.type === "color" ? colorUse(e.prop) : null;
          if (u) {
            if (!use.has(t)) use.set(t, { fg: 0, bg: 0 });
            if (u === "fg" || u === "bg") use.get(t)[u] += e.count;
          }
        }
      }
    }
  }
  for (const t of tokens) if (t.usage.seenLive) t.confidence = Math.min(1, Math.round((t.confidence + 0.05) * 100) / 100);
  // Text and background roles from what the page shows, when names gave none.
  for (const [role, k] of [["text", "fg"], ["background", "bg"]]) {
    if (tokens.some((t) => t.role === role)) continue;
    let best = null;
    let n = LIVE_MIN - 1;
    for (const [t, u] of use) if (!t.role && u[k] > n) [best, n] = [t, u[k]];
    if (best) best.role = role;
  }
  sortTokens(tokens);
  const statics = (Array.isArray(doc.objects) ? doc.objects : []).filter((o) => o.source === "static");
  const objects = mergeObjects(liveObjects(samples, tokens, { devices, statics }), statics, tokens);
  return { ...doc, tokens, scales: computeScales(tokens), objects, live: [...(samples || [])] };
}
