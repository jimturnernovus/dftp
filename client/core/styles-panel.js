// The Styles tab of the side panel, and the way the page's live style
// samples reach the server.
//
// The tab shows the project's style tokens (.dftp/tokens.json, from the
// style scan and the live samples): color swatches with their role, the type
// scale, spacing, radii and shadows, each with its name and the file and
// line it comes from, and the object styles (the whole look of the
// project's buttons, cards, text boxes ...) with a small preview of each.
// Rescan reads the project again and has the page counted again.
//
// Everything is built with createElement and textContent. A document is
// shown only after validateTokensDoc accepts it, and a swatch, a radius, a
// shadow or an object preview is drawn through the CSSOM from text that
// formatValue / formatObjectValue build out of those validated parts, never
// from a raw value and never from the project's markup.
//
// The functions above createStylesPanel are pure and run in Node too.

import { validateTokensDoc, ROLES, pxOf, OBJECT_PROP_LIST, LIVE_VARIANTS } from "./tokens.js";
import { formatValue, formatObjectValue } from "./css-values.js";
import { OBJECT_KINDS, objectRef } from "./schema.js";

export const MAX_ROWS = 80;
const SAMPLE_GAP_MS = 1000;
const FIRST_SCAN_TRIES = 10;
const FIRST_SCAN_RETRY_MS = 2000;
const MAX_SENT_KEYS = 64;

const ROLE_ORDER = new Map(ROLES.map((r, i) => [r, i]));
const used = (t) => t.usage.count + (t.usage.live || 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byPx = (a, b) => (pxOf(a.value) ?? Infinity) - (pxOf(b.value) ?? Infinity) || byId(a, b);

// The tokens of a validated document, grouped and ordered for the tab.
// Tokens without a value are left out.
export function styleGroups(doc) {
  const tokens = doc.tokens.filter((t) => t.value !== null);
  const of = (type) => tokens.filter((t) => t.type === type);
  const colors = of("color").sort((a, b) => {
    const ra = a.role === null ? ROLES.length : ROLE_ORDER.get(a.role);
    const rb = b.role === null ? ROLES.length : ROLE_ORDER.get(b.role);
    return ra - rb || (a.aliasOf ? 1 : 0) - (b.aliasOf ? 1 : 0) || used(b) - used(a) || b.confidence - a.confidence || byId(a, b);
  });
  return {
    colors,
    families: of("fontFamily").sort((a, b) => used(b) - used(a) || byId(a, b)),
    // Largest first, as a type scale reads; sizes without px last.
    sizes: of("fontSize").sort((a, b) => (pxOf(b.value) ?? -1) - (pxOf(a.value) ?? -1) || byId(a, b)),
    weights: of("fontWeight").sort((a, b) => a.value.value - b.value.value || byId(a, b)),
    lineHeights: of("lineHeight").sort(byPx),
    spacing: of("dimension").filter((t) => t.id.startsWith("spacing.")).sort(byPx),
    radii: of("radius").sort(byPx),
    shadows: of("shadow").sort((a, b) => used(b) - used(a) || byId(a, b)),
    scale: doc.scales.spacing.slice(),
    breakpoints: doc.breakpoints.slice().sort((a, b) => a.min - b.min),
    components: doc.components.slice(),
  };
}

// A value as text: the CSS it stands for, with the px size when the unit
// is another one, and a color's alpha as a percentage.
export function valueText(type, v) {
  if (type === "color") return v.alpha < 1 ? `${v.hex} · ${Math.round(v.alpha * 100)}%` : v.hex;
  const text = formatValue(type, v);
  const px = pxOf(v);
  return px !== null && v.unit !== "px" && v.unit !== "" ? `${text} (${px}px)` : text;
}

// Where a token comes from: the first file and line, how many more places,
// or that it was only seen on the page.
export function sourceText(t) {
  const files = t.sources.filter((s) => s.file);
  if (files.length) {
    const first = files[0];
    const more = files.length - 1;
    return `${first.file}${first.line ? `:${first.line}` : ""}${more ? ` (+${more} more)` : ""}`;
  }
  const live = t.sources.find((s) => s.adapter === "live");
  return live ? `seen on the page (${live.page}, ${live.device})` : t.sources[0].adapter;
}

// Every place a token comes from, one per line, for a tooltip.
export function sourcesTitle(t) {
  return t.sources.map((s) => {
    if (s.file) return `${s.file}${s.line ? `:${s.line}` : ""}${s.name ? ` ${s.name}` : ""} (${s.adapter})`;
    if (s.page) return `page ${s.page}, ${s.device} (computed styles)`;
    return s.adapter;
  }).join("\n");
}

export function summaryText(doc) {
  const n = doc.tokens.length;
  const seen = doc.tokens.filter((t) => t.usage.seenLive).length;
  const parts = [`${n} ${n === 1 ? "token" : "tokens"}`];
  if (doc.scan) parts.push(`${doc.scan.files} ${doc.scan.files === 1 ? "file" : "files"} read`);
  if (seen) parts.push(`${seen} seen on the page`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- object styles

const OBJECT_NAMES = Object.freeze({
  button: "Button", card: "Card", input: "Text box", badge: "Badge", avatar: "Avatar", link: "Link",
  heading: "Heading", text: "Body text", divider: "Divider",
});
// The words a preview shows (DFTP's own, never the page's).
const PREVIEW_TEXT = Object.freeze({ button: "Button", badge: "Badge", link: "Link", heading: "Heading", text: "Text", avatar: "A" });

// The object styles of a validated document, in the order the tab lists
// them: live records ahead of static ones, each group by kind, variant (h1
// before h2) and count.
export function objectRows(doc) {
  const list = Array.isArray(doc.objects) ? doc.objects.slice() : [];
  const variantRank = (o) => {
    const i = LIVE_VARIANTS[o.kind].indexOf(o.variant);
    return i === -1 ? LIVE_VARIANTS[o.kind].length : i;
  };
  return list.sort((a, b) => Number(b.source === "live") - Number(a.source === "live") ||
    OBJECT_KINDS.indexOf(a.kind) - OBJECT_KINDS.indexOf(b.kind) || variantRank(a) - variantRank(b) || b.count - a.count ||
    (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
}

// A property of an object as a value: a token id read as its token's value
// (byId: id -> token), or the value itself.
function objectValue(o, prop, byId) {
  if (!Object.prototype.hasOwnProperty.call(o.style, prop)) return null;
  const v = o.style[prop];
  if (typeof v !== "string") return v;
  const t = byId.get(v);
  return t && t.value ? t.value : null;
}

const PREVIEW_CAPS = Object.freeze({
  "border-width": [0, 3], "border-radius": [0, 999], "padding-block": [0, 6], "padding-inline": [0, 12],
  "font-size": [9, 16], "line-height": [10, 22], "letter-spacing": [-2, 3], height: [0, 30], gap: [0, 8],
});

// The CSS a small preview of object o is drawn with: [[property, value]],
// written from validated values only, with sizes kept small.
export function objectPreviewCss(o, doc) {
  const byId = new Map(doc.tokens.map((t) => [t.id, t]));
  const out = [];
  for (const prop of OBJECT_PROP_LIST) {
    const v = objectValue(o, prop, byId);
    if (v === null) continue;
    let text = formatObjectValue(prop, v);
    const cap = PREVIEW_CAPS[prop];
    const px = cap && !Array.isArray(v) ? pxOf(v) : null;
    if (cap && px !== null) text = `${Math.max(cap[0], Math.min(cap[1], px))}px`;
    else if (cap && prop !== "line-height" && prop !== "border-radius" && v.unit !== "") continue;
    if (text) out.push([prop, text]);
  }
  return out;
}

// The properties of object o as one line: "background color.primary ·
// padding-block 10px ...".
export function objectStyleText(o) {
  return OBJECT_PROP_LIST.filter((p) => Object.prototype.hasOwnProperty.call(o.style, p)).map((p) => {
    const v = o.style[p];
    return `${p} ${typeof v === "string" ? v : formatObjectValue(p, v)}`;
  }).join(" · ");
}

// Where an object style comes from: the first file and line (a rule or a
// variable that gives the look), or the page it was seen on.
export function objectSourceText(o) {
  const file = o.sources.find((x) => x.file);
  if (file) return `${file.file}${file.line ? `:${file.line}` : ""}${file.name ? ` ${file.name}` : ""}`;
  const live = o.sources.find((x) => x.adapter === "live");
  return live ? `seen on the page (${live.page}, ${live.device})` : "";
}

export function objectTitle(o) {
  return OBJECT_NAMES[o.kind] ? `${OBJECT_NAMES[o.kind]} · ${o.variant}` : o.variant;
}

// Sends live samples to the server: one request at a time, at most one per
// gapMs, the newest waiting sample only, and none that repeats the last one
// sent for the same page, device and theme (a reload of an unchanged page)
// unless force() came first.
//   post(body) -> Promise<{status, body}>; onDoc(doc) gets the server's
//   merged document; later(fn, ms) is setTimeout.
export function createSampleForwarder({ post, onDoc, later, gapMs = SAMPLE_GAP_MS }) {
  const sent = new Map();
  let pending = null;
  let busy = false;
  let forced = false;

  async function pump() {
    if (busy || !pending) return;
    const job = pending;
    pending = null;
    busy = true;
    try {
      const r = await post(job.body);
      if (r && r.status === 200 && r.body && r.body.ok === true) {
        if (!sent.has(job.key) && sent.size >= MAX_SENT_KEYS) sent.delete(sent.keys().next().value);
        sent.set(job.key, job.sig);
        onDoc(r.body.doc);
      }
    } catch {
      // the server is gone; the next sample tries again
    } finally {
      later(() => {
        busy = false;
        pump();
      }, gapMs);
    }
  }

  return {
    force() {
      forced = true;
    },
    // where: {page, device, theme}; sample: {elements, values, objects?}.
    // Returns whether the sample will be sent.
    push(where, sample) {
      const key = `${where.page}\u0000${where.device}\u0000${where.theme}`;
      const objects = Array.isArray(sample.objects) && sample.objects.length ? sample.objects : null;
      const sig = JSON.stringify([sample.elements, sample.values, objects || []]);
      if (!forced && sent.get(key) === sig) return false;
      forced = false;
      const body = { page: where.page, device: where.device, theme: where.theme, elements: sample.elements, values: sample.values };
      if (objects) body.objects = objects;
      pending = { key, sig, body };
      pump();
      return true;
    },
  };
}

// createStylesPanel({doc, transport, toast, requestSample, closeDrawer, onRescan})
//   doc            the designer's document (index.html)
//   transport      as for createShell
//   toast(text)    a short notice
//   requestSample  () => boolean: asks the layer for a new sample; false when
//                  the page cannot be sampled now
//   closeDrawer    () => void
//   onRescan       () => void: a rescan's result is shown (blank pages load
//                  their token style sheet again)
// Returns {onSample(where, sample)} for samples from the layer, tokens()
// for the validated document shown (or null), and load() to read the
// latest one from the server (it resolves once read, or on failure).
export function createStylesPanel({ doc, transport, toast, requestSample, closeDrawer, onRescan = () => {} }) {
  const win = doc.defaultView;
  const $ = (id) => doc.getElementById(id);
  const panel = $("side-panel");
  const body = $("styles-body");
  const status = $("styles-status");
  const rescanBtn = $("styles-rescan");
  const tabs = [...doc.querySelectorAll("#side-tabs [data-side-tab]")];

  const h = (tag, className, text) => {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const setStatus = (text) => {
    status.textContent = text;
  };

  let current = null;
  let shown = false;
  let fetched = false;
  let loading = false;
  let scanning = false;
  let tickets = 0;
  let applied = 0;

  // ---------------------------------------------------------------- data

  // A document from the server, shown only when it validates. ticket orders
  // answers: one asked for earlier never replaces a newer one.
  function setDoc(raw, ticket) {
    if (raw === null || raw === undefined) return false;
    const r = validateTokensDoc(raw);
    if (!r.ok) {
      setStatus("The style data from the server was not in the expected shape.");
      return false;
    }
    if (ticket < applied) return true;
    applied = ticket;
    current = r.value;
    if (shown) render();
    return true;
  }

  // One read of the latest document: {shown, scanning}. Reads close
  // together share one request.
  let reading = null;
  function read() {
    if (!reading) {
      reading = (async () => {
        const ticket = ++tickets;
        try {
          const r = await transport.getJson("/api/tokens");
          if (!r || r.status !== 200 || !r.body || typeof r.body !== "object") throw new Error(`server status ${r ? r.status : "none"}`);
          fetched = true;
          return { shown: setDoc(r.body.doc, ticket), scanning: r.body.scanning === true };
        } finally {
          reading = null;
        }
      })();
    }
    return reading;
  }

  async function fetchDoc(tries = FIRST_SCAN_TRIES) {
    if (loading) return;
    loading = true;
    if (!current) setStatus("Reading the project's styles…");
    try {
      const r = await read();
      if (!r.shown && !current) {
        if (r.scanning && tries > 1) {
          setStatus("The first scan of the project is still running…");
          win.setTimeout(() => fetchDoc(tries - 1), FIRST_SCAN_RETRY_MS);
        } else {
          setStatus("No style scan yet. Rescan reads the project.");
        }
      }
    } catch (err) {
      setStatus(`The styles could not be loaded (${String(err && err.message ? err.message : err).slice(0, 120)}).`);
    } finally {
      loading = false;
    }
  }

  async function rescan() {
    if (scanning) return;
    scanning = true;
    rescanBtn.disabled = true;
    setStatus("Reading the project's styles again…");
    const ticket = ++tickets;
    try {
      const r = await transport.postJson("/api/tokens/scan", {});
      if (!r || r.status !== 200 || !r.body) throw new Error(`server status ${r ? r.status : "none"}`);
      if (!setDoc(r.body.doc, ticket)) throw new Error("no result");
      onRescan();
      forwarder.force();
      if (requestSample()) toast("Styles read again. The page's own styles are being counted again.");
      else toast("Styles read again.");
    } catch (err) {
      setStatus(`The scan failed (${String(err && err.message ? err.message : err).slice(0, 120)}).`);
    } finally {
      scanning = false;
      rescanBtn.disabled = false;
    }
  }

  const forwarder = createSampleForwarder({
    post: (b) => transport.postJson("/api/tokens/sample", b),
    onDoc: (d) => setDoc(d, ++tickets),
    later: (fn, ms) => win.setTimeout(fn, ms),
  });

  // ---------------------------------------------------------------- drawing

  // Values below were validated; the CSSOM takes them as plain property
  // values.
  const css = (el, prop, value) => {
    if (value) el.style.setProperty(prop, value);
    return el;
  };

  // One token: a preview cell, its name and value, role and other tags, an
  // optional drawing under the name, and where it comes from.
  function row(t, preview, under) {
    const li = h("li", "tk-row");
    li.dataset.token = t.id;
    const pre = h("span", "tk-pre");
    if (preview) pre.appendChild(preview);
    li.appendChild(pre);
    const main = h("div", "tk-main");
    const head = h("div", "tk-head");
    head.append(h("span", "tk-name", t.id), h("span", "tk-value", valueText(t.type, t.value)));
    main.appendChild(head);
    if (under) main.appendChild(under);
    const tags = h("div", "tk-tags");
    if (t.role) tags.appendChild(h("span", "tk-role", t.role));
    if (t.usage.seenLive) {
      const live = h("span", "tk-live", "on page");
      live.title = `Seen in the page's computed styles${t.usage.live ? ` (${t.usage.live} ${t.usage.live === 1 ? "element" : "elements"})` : ""}`;
      tags.appendChild(live);
    }
    if (t.aliasOf) tags.appendChild(h("span", "tk-alias", `= ${t.aliasOf}`));
    if (t.modes.dark) tags.appendChild(h("span", "tk-mode", `dark ${valueText(t.type, t.modes.dark)}`));
    if (tags.firstChild) main.appendChild(tags);
    const src = h("div", "tk-src", sourceText(t));
    src.title = sourcesTitle(t);
    main.appendChild(src);
    li.appendChild(main);
    return li;
  }

  // makePreview(t) -> element or null; makeUnder(t) -> element or null.
  function section(title, list, makePreview, { note = null, makeUnder = null } = {}) {
    const sec = h("section", "tk-sec");
    sec.dataset.group = title.toLowerCase().replace(/\s+/g, "-");
    const head = h("h3", "tk-sec-head", title);
    head.appendChild(h("span", "tk-sec-count", ` ${list.length}`));
    sec.appendChild(head);
    if (note) sec.appendChild(note);
    if (!list.length) {
      sec.appendChild(h("p", "tk-empty", "None found."));
      return sec;
    }
    const ul = h("ul", "tk-list");
    for (const t of list.slice(0, MAX_ROWS)) ul.appendChild(row(t, makePreview(t), makeUnder ? makeUnder(t) : null));
    sec.appendChild(ul);
    if (list.length > MAX_ROWS) sec.appendChild(h("p", "tk-empty", `${list.length - MAX_ROWS} more in .dftp/tokens.json`));
    return sec;
  }

  const swatch = (t) => {
    const box = h("span", "tk-swatch");
    box.appendChild(css(h("span", "tk-chip"), "background-color", formatValue("color", t.value)));
    if (t.modes.dark) {
      const dark = css(h("span", "tk-chip tk-chip-dark"), "background-color", formatValue("color", t.modes.dark));
      dark.title = "dark";
      box.appendChild(dark);
    }
    return box;
  };

  // The object styles: a preview drawn from the bundle's validated values,
  // its kind and variant, how many elements share it, its properties and
  // where it comes from.
  function objectsSection(d) {
    const list = objectRows(d);
    const sec = h("section", "tk-sec");
    sec.dataset.group = "objects";
    const head = h("h3", "tk-sec-head", "Objects");
    head.appendChild(h("span", "tk-sec-count", ` ${list.length}`));
    sec.appendChild(head);
    if (!list.length) {
      sec.appendChild(h("p", "tk-empty", "None found."));
      return sec;
    }
    const ul = h("ul", "tk-list");
    for (const o of list.slice(0, MAX_ROWS)) {
      const li = h("li", "tk-row tk-obj-row");
      li.dataset.object = objectRef(o);
      const stage = h("span", "tk-pre tk-obj-stage");
      const pv = h("span", `tk-obj tk-obj-${o.kind}`, PREVIEW_TEXT[o.kind] || "");
      for (const [prop, value] of objectPreviewCss(o, d)) css(pv, prop, value);
      stage.appendChild(pv);
      li.appendChild(stage);
      const main = h("div", "tk-main");
      const top = h("div", "tk-head");
      top.append(h("span", "tk-name", objectTitle(o)), h("span", "tk-value", o.source === "live" ? `${o.count} on page` : "in files"));
      main.appendChild(top);
      const props = objectStyleText(o);
      if (props) main.appendChild(h("div", "tk-obj-props", props));
      const src = h("div", "tk-src", objectSourceText(o));
      src.title = o.sources.map((x) => (x.file ? `${x.file}${x.line ? `:${x.line}` : ""}${x.name ? ` ${x.name}` : ""} (${x.adapter})` : `page ${x.page}, ${x.device} (computed styles)`)).join("\n");
      main.appendChild(src);
      li.appendChild(main);
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    return sec;
  }

  function render() {
    while (body.firstChild) body.firstChild.remove();
    const d = current;
    if (!d) return;
    setStatus(`${summaryText(d)}. ${scanTime(d)}`);
    const g = styleGroups(d);
    const family = g.families.length ? formatValue("fontFamily", g.families[0].value) : "";
    const sample = (size) => {
      const s = h("span", "tk-type", "Aa");
      css(s, "font-family", family);
      if (size !== null) css(s, "font-size", `${Math.max(8, Math.min(size, 36))}px`);
      return s;
    };
    const none = () => null;
    body.appendChild(section("Colors", g.colors, swatch));
    body.appendChild(section("Font families", g.families, (t) => css(h("span", "tk-type", "Aa"), "font-family", formatValue("fontFamily", t.value))));
    body.appendChild(section("Type scale", g.sizes, (t) => sample(pxOf(t.value))));
    if (g.weights.length) body.appendChild(section("Font weights", g.weights, (t) => css(sample(null), "font-weight", String(t.value.value))));
    if (g.lineHeights.length) body.appendChild(section("Line heights", g.lineHeights, none));
    body.appendChild(section("Spacing", g.spacing, none, {
      note: g.scale.length ? h("p", "tk-scale", `Scale: ${g.scale.join(" · ")} px`) : null,
      makeUnder: (t) => css(h("span", "tk-bar"), "width", `${Math.max(2, Math.min(pxOf(t.value) ?? 2, 200))}px`),
    }));
    body.appendChild(section("Radii", g.radii, (t) => {
      const px = pxOf(t.value);
      return css(h("span", "tk-radius"), "border-radius", px === null ? formatValue("radius", t.value) : `${Math.min(px, 14)}px`);
    }));
    body.appendChild(section("Shadows", g.shadows, (t) => {
      const cell = h("span", "tk-shadow-cell");
      cell.appendChild(css(h("span", "tk-shadow"), "box-shadow", formatValue("shadow", t.value)));
      return cell;
    }));
    body.appendChild(objectsSection(d));
    if (g.breakpoints.length) body.appendChild(h("p", "tk-foot", `Breakpoints: ${g.breakpoints.map((b) => `${b.name} ${b.min}px`).join(" · ")}`));
    if (g.components.length) {
      body.appendChild(h("p", "tk-foot", `Shared components: ${g.components.slice(0, 20).map((c) => `${c.export} (${c.file})`).join(" · ")}`));
    }
    if (d.diagnostics.length) body.appendChild(h("p", "tk-foot", `${d.diagnostics.length} skipped ${d.diagnostics.length === 1 ? "item is" : "items are"} listed under diagnostics in .dftp/tokens.json.`));
  }

  function scanTime(d) {
    const t = Date.parse(d.generated_at);
    return Number.isFinite(t) ? `Read at ${new Date(t).toLocaleTimeString()}.` : "";
  }

  // ---------------------------------------------------------------- tabs

  // The panel's data-tab names the tab shown (any button in #side-tabs);
  // shell.css hides the other sections while it is "styles".
  function select(name, focus = false) {
    const styles = name === "styles";
    panel.dataset.tab = tabs.some((b) => b.dataset.sideTab === name) ? name : "changes";
    for (const b of tabs) {
      const on = b.dataset.sideTab === panel.dataset.tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("is-on", on);
      if (on && focus) b.focus();
    }
    $("styles-panel").hidden = !styles;
    shown = styles;
    if (!styles) return;
    if (current) render();
    if (!fetched) fetchDoc();
  }

  for (const b of tabs) {
    b.addEventListener("click", () => select(b.dataset.sideTab));
    // Arrow keys move between the tabs (and stay out of the page).
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      e.stopPropagation();
      const i = tabs.indexOf(b);
      const n = tabs.length;
      const j = { ArrowLeft: (i + n - 1) % n, ArrowRight: (i + 1) % n, Home: 0, End: n - 1 }[e.key];
      select(tabs[j].dataset.sideTab, true);
    });
  }
  rescanBtn.addEventListener("click", rescan);
  $("styles-close").addEventListener("click", () => closeDrawer());
  select("changes");

  return {
    onSample(where, sample) {
      forwarder.push(where, sample);
    },
    tokens: () => current,
    async load() {
      try {
        await read();
      } catch {
        // the last document read stays in use
      }
    },
  };
}
