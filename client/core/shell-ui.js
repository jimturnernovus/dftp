// The designer window around the preview frame: page / screen-size / theme /
// mode controls, the side panel (current pick and the list of recorded
// edits), storing edits through the server, and the Before / After switch.
//
// The frame runs on another origin. Every message to it names that origin
// exactly and carries the nonce created for the current load; every message
// from it is checked for origin, source window and nonce, then validated by
// protocol.js. The server is reached only through the transport passed in.
// The UI is built from createElement and textContent: no HTML strings.

import { envelope, validateFrameMsg, makeNonce, windowName, KEY_ALLOW } from "./protocol.js";
import { validateList, isFilePath, isSha, FORMAT_ID, FORMAT_VERSION } from "./schema.js";
import { whatOf, nameOf, where, pageText } from "./spec.js";
import { pageIdentity } from "./devices.js";
import { createStylesPanel } from "./styles-panel.js";
import { createPalette } from "./palette.js";

const SAVE_DELAY_MS = 150;
const READY_WAIT_MS = 8000;
const LOAD_CHECK_MS = 4000;
const FLUSH_WAIT_MS = 400;
const SAVE_TRIES = 3;
const REOPEN_LIMIT = 5;
const REOPEN_WINDOW_MS = 10000;
const CONFIRM_MS = 4000;
const TOAST_MS = 2600;
const MAX_CODE = 400;
export const GRID_SIZES = Object.freeze([2, 4, 6, 8, 12, 16, 24, 32, 48, 64]);
export const GRID_DEFAULT = 12;
export const DRAWER_OPEN_MIN = 1280;

// Wording for the codes the layer may report. The frame only ever picks a
// code; the text shown is always this window's own.
const TOASTS = Object.freeze({
  "reattach-held": "Another unresolved change already claims the element you picked. Reset that change before reusing the element.",
  "nothing-selected": "Pick an element in the preview, then try again.",
  "no-text": "There is no editable text here, or the element contains a private or editable field.",
  "split-failed": "No text under the pointer to break into words.",
  "split-held": "A word inside this element has its own change. Reset that word first, then edit the whole text.",
  "split-edited": "This text has a text edit. Reset that edit first; then a double-click can break it into single words.",
  "not-on-page": "The element for that change cannot be found in the preview at the moment.",
  "undo-empty": "There is no earlier step.",
  "redo-empty": "There is no later step.",
  limit: "Not recorded: this page holds the maximum number of changes, or the element sits too deep to name.",
  "scaffold-fixed": "The main container of a blank page stays as it is. Pick it to add elements into it.",
  "insert-attach": "A change cannot be moved onto a new element, and a new element's change cannot be moved elsewhere.",
});

const NOT_LISTED = "The preview has left the configured pages. Use the Back button above it before editing.";

const NOTES = Object.freeze([
  "How to apply them: see CLAUDE.md in the DFTP folder, \"Applying changes\". Paths are relative to the project root.",
]);

const isTypingTarget = (t) => !!t && t.nodeType === 1 && (/^(input|select|textarea)$/.test(t.localName) || t.isContentEditable);
const isControl = (t) => !!t && t.nodeType === 1 && /^(button|a|summary)$/.test(t.localName);

function splitPath(p) {
  const s = String(p || "/");
  const i = s.indexOf("?");
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i)];
}

// Fingerprints from the server, kept only when well formed.
function cleanCode(map) {
  const out = Object.create(null);
  if (!map || typeof map !== "object") return out;
  let n = 0;
  for (const k of Object.keys(map)) {
    if (n >= MAX_CODE) break;
    const v = map[k];
    if (isFilePath(k) && (v === null || isSha(v))) {
      out[k] = v;
      n++;
    }
  }
  return out;
}

// createShell({transport, el, ns, storageKey, devices, pages, features})
//   transport  {getJson(path), postJson(path, body, {keepalive}), getText(path)}
//              each resolving {status, body} (or {status, text})
//   el         the document holding the designer's markup (index.html)
//   ns         message namespace, also the iframe name prefix
//   storageKey localStorage key for this window's preferences
//   devices    [{id, label, width, height}]
//   pages      [{id, label, path, keep}]
//   features   {frameOrigin, themeToggle, libraryPrefixes, changesPath, version, start}
//              start: the page to open on when it is not the first one (a
//              blank page asked for with --blank); it wins over the page
//              this window showed last
export function createShell({ transport, el, ns, storageKey, devices, pages, features = {} }) {
  const doc = el && el.nodeType === 9 ? el : document;
  const win = doc.defaultView || window;
  const $ = (id) => doc.getElementById(id);
  const frameOrigin = String(features.frameOrigin || "");
  const libraryPrefixes = Array.isArray(features.libraryPrefixes) ? features.libraryPrefixes : [];
  // A new iframe element is made for every load, because a browsing context
  // reads its name (where the nonce travels) only once, when it is created.
  let frame = $("page-frame");
  const TAB = win.crypto && typeof win.crypto.randomUUID === "function" ? win.crypto.randomUUID() : `t${makeNonce()}`;

  const h = (tag, props = {}, ...children) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") n.className = v;
      else if (k === "text") n.textContent = String(v);
      else if (k === "onclick") n.addEventListener("click", v);
      else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = String(dv);
      else if (k === "disabled") n.disabled = !!v;
      else n.setAttribute(k, String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(typeof c === "string" ? doc.createTextNode(c) : c);
    return n;
  };
  const clear = (n) => {
    while (n.firstChild) n.firstChild.remove();
  };

  // ---------------------------------------------------------------- preferences

  const prefs = (() => {
    try {
      const v = JSON.parse(win.localStorage.getItem(storageKey) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  })();
  const pageById = (id) => pages.find((p) => p.id === id) || null;
  const deviceById = (id) => devices.find((d) => d.id === id) || null;
  const prefGrid = prefs.grid && typeof prefs.grid === "object" ? prefs.grid : {};

  const st = {
    page: features.start && features.start !== pages[0].id && pageById(features.start) ? features.start : pageById(prefs.page) ? prefs.page : pages[0].id,
    device: deviceById(prefs.device) ? prefs.device : devices[0].id,
    theme: prefs.theme === "dark" ? "dark" : "light",
    mode: "design",
    view: "after",
    modeBeforeView: null,
    modeBeforeAway: null,
    list: [],
    sel: null,
    canUndo: false,
    canRedo: false,
    grid: {
      on: prefGrid.on === true,
      size: GRID_SIZES.includes(prefGrid.size) ? prefGrid.size : GRID_DEFAULT,
      snap: prefGrid.snap === true,
    },
    cur: null,
    seq: 0,
    edits: 0,
    dirty: false,
    saves: 0,
    scale: 1,
    drawer: win.innerWidth >= DRAWER_OPEN_MIN,
    away: false,
    switching: false,
  };
  const savePrefs = () => {
    try {
      win.localStorage.setItem(storageKey, JSON.stringify({ page: st.page, device: st.device, theme: st.theme, grid: st.grid }));
    } catch {
      // storage may be unavailable (private window, blocked site data)
    }
  };
  const devOf = () => deviceById(st.device) || devices[0];
  const pageOf = () => pageById(st.page) || pages[0];
  // The element palette of blank pages (palette.js); made at start-up.
  let palette = null;
  const isBlank = (id) => !!pageById(id) && pageById(id).blank === true;

  // ---------------------------------------------------------------- messages to the layer

  const focusFrame = () => {
    try {
      frame.focus();
    } catch {
      // the frame may not exist yet
    }
  };
  const send = (type, fields = {}) => {
    const cur = st.cur;
    if (!cur || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(envelope(ns, cur.nonce, type, fields), frameOrigin);
    } catch {
      // the frame is navigating; the next load starts over
    }
  };

  // Ask the layer to commit an open text edit and wait for its answer. Its
  // "changes" message (if any) is posted before "flushed", so by the time this
  // resolves the edit is in st.list and marked dirty. Gives up after a short
  // wait so a page without a working layer cannot hold anything up.
  let flushDone = null;
  function flushLayer() {
    const cur = st.cur;
    if (!cur || !cur.ready || !cur.loaded || st.view === "before" || st.away) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        win.clearTimeout(timer);
        if (flushDone === finish) flushDone = null;
        resolve();
      };
      if (flushDone) flushDone();
      flushDone = finish;
      timer = win.setTimeout(finish, FLUSH_WAIT_MS);
      send("flush");
    });
  }

  // ---------------------------------------------------------------- notices

  function toast(text) {
    const box = $("notices");
    if (!box || !text) return;
    const n = h("div", { className: "notice", role: "status", text });
    box.appendChild(n);
    while (box.children.length > 4) box.firstChild.remove();
    win.setTimeout(() => n.remove(), TOAST_MS);
  }

  // The bars sit above the preview in the page flow; the preview is fitted
  // again whenever one appears or goes away.
  function showStrip(id, on) {
    const n = $(id);
    if (!n || n.hidden === !on) return;
    n.hidden = !on;
    fit();
  }

  function showAway(path) {
    if (!st.cur) return;
    st.away = true;
    if (st.modeBeforeAway === null) st.modeBeforeAway = st.mode;
    st.mode = "use";
    $("away-msg").textContent = `The preview moved to ${String(path).slice(0, 200)}. That address is outside the configured page list, so nothing is drawn or recorded there.`;
    $("away-return").textContent = `Back to ${pageOf().label}`;
    showStrip("away-note", true);
    mark();
  }
  function hideAway() {
    if (st.away && st.modeBeforeAway !== null) st.mode = st.modeBeforeAway;
    st.away = false;
    st.modeBeforeAway = null;
    showStrip("away-note", false);
  }

  function showNoLayer(text) {
    $("nolayer-msg").textContent = text;
    showStrip("nolayer-note", true);
  }

  // ---------------------------------------------------------------- controls

  const pageSel = $("page-select");
  for (const p of pages) pageSel.appendChild(h("option", { value: p.id, text: p.label }));
  pageSel.value = st.page;
  pageSel.addEventListener("change", () => {
    st.page = pageSel.value;
    savePrefs();
    load();
  });

  const devBox = $("screen-sizes");
  for (const d of devices) {
    devBox.appendChild(h("button", {
      type: "button",
      dataset: { screen: d.id },
      title: `${d.label}: ${d.width} × ${d.height} px`,
      onclick: () => {
        if (st.device === d.id && st.cur) return;
        st.device = d.id;
        savePrefs();
        load();
      },
    }, d.label, h("span", { className: "faint", text: ` ${d.width}` })));
  }

  const themeBox = $("theme-switch");
  themeBox.hidden = !features.themeToggle;
  for (const b of themeBox.querySelectorAll("button[data-set-theme]")) {
    b.addEventListener("click", () => {
      st.theme = b.dataset.setTheme === "dark" ? "dark" : "light";
      savePrefs();
      send("theme", { theme: st.theme });
      mark();
    });
  }

  for (const b of doc.querySelectorAll("button[data-set-mode]")) b.addEventListener("click", () => setMode(b.dataset.setMode));
  for (const b of doc.querySelectorAll("button[data-set-view]")) b.addEventListener("click", () => setView(b.dataset.setView));
  $("before-exit").addEventListener("click", () => setView("after"));
  $("away-return").addEventListener("click", () => load({ keepView: false }));
  $("nolayer-retry").addEventListener("click", () => load({ keepView: true }));

  const gridSize = $("grid-pitch");
  for (const n of GRID_SIZES) gridSize.appendChild(h("option", { value: String(n), text: `${n} px` }));
  const sendGrid = () => {
    savePrefs();
    mark();
    send("grid", { grid: { ...st.grid } });
  };
  const toggleGrid = () => {
    st.grid.on = !st.grid.on;
    sendGrid();
  };
  $("grid-toggle").addEventListener("click", toggleGrid);
  $("grid-lock").addEventListener("click", () => {
    st.grid.snap = !st.grid.snap;
    if (st.grid.snap) st.grid.on = true;
    sendGrid();
  });
  gridSize.addEventListener("change", () => {
    const n = Number(gridSize.value);
    st.grid.size = GRID_SIZES.includes(n) ? n : GRID_DEFAULT;
    sendGrid();
  });

  $("undo-btn").addEventListener("click", () => {
    if (st.view !== "before") send("undo");
  });
  $("redo-btn").addEventListener("click", () => {
    if (st.view !== "before") send("redo");
  });
  $("reload-page").addEventListener("click", () => load({ keepView: true }));
  $("save-state").addEventListener("click", () => saveNow(true));

  // Reset page needs a second press within a few seconds; the first press
  // only turns the button into a question.
  const resetBtn = $("clear-page");
  let resetArmed = null;
  const disarmReset = () => {
    if (resetArmed) win.clearTimeout(resetArmed);
    resetArmed = null;
    resetBtn.classList.remove("armed");
    resetBtn.textContent = "Reset page";
  };
  resetBtn.addEventListener("click", () => {
    if (st.view === "before" || !st.list.length) return;
    if (resetArmed) {
      disarmReset();
      send("reset", { key: null });
      return;
    }
    resetBtn.classList.add("armed");
    resetBtn.textContent = `Remove all ${st.list.length}?`;
    resetArmed = win.setTimeout(disarmReset, CONFIRM_MS);
  });

  function setMode(m) {
    if (m === "design" && st.away) {
      toast(NOT_LISTED);
      return;
    }
    if (m === "design" && st.view === "before") {
      toast("Editing is paused while Before shows the original page; switch back with B or the After button.");
      return;
    }
    st.mode = m === "design" ? "design" : "use";
    send("mode", { mode: st.mode });
    mark();
    drawSel();
  }

  // Before / After. Before strips every recorded edit off the preview and
  // freezes editing and storing; After draws them again. Pending work (an
  // open text editor, edits not yet stored) is committed and stored first.
  async function setView(v) {
    if (st.switching || v === st.view || !st.cur || !st.cur.loaded) return;
    if (v === "before") {
      if (st.away) {
        toast(NOT_LISTED);
        return;
      }
      st.switching = true;
      try {
        await flushLayer();
        if (st.dirty) {
          win.clearTimeout(saveTimer);
          await save();
        }
      } finally {
        st.switching = false;
      }
      if (st.view === "before" || !st.cur) return;
      disarmReset();
      st.modeBeforeView = st.mode;
      st.view = "before";
      st.mode = "use";
      send("view", { view: "before" });
      send("mode", { mode: "use" });
    } else {
      st.view = "after";
      send("view", { view: "after" });
      st.mode = st.modeBeforeView || st.mode;
      st.modeBeforeView = null;
      send("mode", { mode: st.mode });
    }
    mark();
    drawList();
    drawSel();
  }
  const toggleView = () => setView(st.view === "before" ? "after" : "before");

  function setDrawer(open) {
    st.drawer = !!open;
    $("workspace").classList.toggle("panel-open", st.drawer);
    $("side-panel").hidden = !st.drawer;
    $("panel-toggle").setAttribute("aria-expanded", st.drawer ? "true" : "false");
    fit();
  }
  const toggleDrawer = () => setDrawer(!st.drawer);
  $("panel-toggle").addEventListener("click", toggleDrawer);
  $("panel-close").addEventListener("click", () => setDrawer(false));

  // Bring every control in line with the state.
  let hintsHeight = -1;
  function mark() {
    const bf = st.view === "before";
    for (const b of doc.querySelectorAll("button[data-screen]")) b.classList.toggle("is-on", b.dataset.screen === st.device);
    for (const b of doc.querySelectorAll("button[data-set-theme]")) b.classList.toggle("is-on", b.dataset.setTheme === st.theme);
    for (const b of doc.querySelectorAll("button[data-set-mode]")) {
      b.classList.toggle("is-on", b.dataset.setMode === st.mode);
      b.setAttribute("aria-pressed", b.dataset.setMode === st.mode ? "true" : "false");
    }
    for (const b of doc.querySelectorAll("button[data-set-view]")) {
      b.classList.toggle("is-on", b.dataset.setView === st.view);
      b.setAttribute("aria-pressed", b.dataset.setView === st.view ? "true" : "false");
    }
    $("undo-btn").disabled = bf || !st.canUndo;
    $("redo-btn").disabled = bf || !st.canRedo;
    resetBtn.disabled = bf || !st.list.length;
    $("grid-toggle").classList.toggle("is-on", st.grid.on);
    $("grid-lock").classList.toggle("is-on", st.grid.on && st.grid.snap);
    gridSize.value = String(st.grid.size);
    pageSel.value = st.page;
    $("change-count").textContent = String(st.list.length);
    $("panel-count").textContent = String(st.list.length);
    const n = st.list.length;
    $("before-msg").textContent = `Before view: the page without your ${n} ${n === 1 ? "edit" : "edits"}. Editing and storing are paused; key B or the After button brings them back.`;
    showStrip("before-note", bf);
    doc.body.dataset.currentView = st.view;
    doc.body.dataset.currentMode = st.mode;
    // The key hints change with the mode and may wrap differently.
    const hints = $("key-hints");
    const hh = hints ? hints.offsetHeight : 0;
    if (hh !== hintsHeight) {
      hintsHeight = hh;
      fit();
    }
    if (palette) palette.update();
  }

  // ---------------------------------------------------------------- fitting the screen size into the window

  function fit() {
    const d = devOf();
    const stage = $("canvas");
    const availW = Math.max(120, stage.clientWidth - 32);
    const availH = Math.max(120, stage.clientHeight - 32);
    const scale = Math.max(0.05, Math.min(1, availW / d.width));
    const height = Math.max(d.height, Math.round(availH / scale));
    frame.style.width = `${d.width}px`;
    frame.style.height = `${height}px`;
    const box = $("viewport-box");
    box.style.width = `${d.width}px`;
    box.style.height = `${height}px`;
    box.style.transform = `scale(${scale})`;
    box.style.marginRight = `${-(d.width * (1 - scale))}px`;
    box.style.marginBottom = `${-(height * (1 - scale))}px`;
    st.scale = scale;
    $("fit-zoom").textContent = `${Math.round(scale * 100)}%`;
    if (st.cur && st.cur.ready) send("scale", { scale });
  }
  win.addEventListener("resize", fit);

  // ---------------------------------------------------------------- loading a page

  // st.cur describes the document in the frame: which page and screen size,
  // the nonce its messages must carry and the file revision it started from.
  // Moving to another page or size stores the current edits first, under
  // the page they were made on; if storing fails the move is cancelled.
  let loads = 0;
  let readyTimer = null;
  const reopens = [];

  function frameUrl(cur) {
    const p = pageById(cur.page) || pages[0];
    return `${frameOrigin}${p.path}`;
  }

  function replaceFrame(name, url) {
    const f = doc.createElement("iframe");
    f.id = "page-frame";
    f.title = "Preview of the page you are designing";
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    f.setAttribute("referrerpolicy", "no-referrer");
    if (name) f.name = name;
    f.style.width = frame.style.width;
    f.style.height = frame.style.height;
    f.addEventListener("load", onFrameLoad);
    if (url) f.src = url;
    frame.replaceWith(f);
    frame = f;
  }

  function navFrame(cur) {
    replaceFrame(windowName(ns, cur.nonce), frameUrl(cur));
    win.clearTimeout(readyTimer);
    readyTimer = win.setTimeout(() => {
      if (st.cur === cur && !cur.ready && !st.away) {
        showNoLayer("The design layer did not start in this page. A Content-Security-Policy may block it, or the address is not an HTML page. Press Reload to try again.");
      }
    }, READY_WAIT_MS);
  }

  function blankFrame() {
    replaceFrame("", "");
  }

  // A switch was cancelled: point the controls back at what the frame shows.
  function stay() {
    if (!st.cur) return;
    st.page = st.cur.page;
    st.device = st.cur.device;
    savePrefs();
    mark();
  }

  async function load({ skipSave = false, keepView = false } = {}) {
    const n = ++loads;
    $("canvas").dataset.loaded = "0";
    if (!skipSave) await flushLayer();
    // One turn of the event loop lets a message already queued by the layer
    // (the end of a drag, say) arrive and count toward the page it was made on.
    await new Promise((r) => win.setTimeout(r, 0));
    if (n !== loads) return;
    win.clearTimeout(saveTimer);
    // Retried a few times: edits that arrive while a store is in flight make
    // the page dirty again and need one more round.
    for (let i = 0; !skipSave && st.cur && st.dirty && i < SAVE_TRIES; i++) {
      win.clearTimeout(saveTimer);
      if (!(await save())) {
        if (n === loads) {
          stay();
          if (st.cur && st.cur.loaded) $("canvas").dataset.loaded = "1";
          toast("Switching was cancelled because this page's edits could not be stored. Try Save again, or keep a copy with Download.");
        }
        return;
      }
    }
    if (n !== loads) return;
    // A different page or screen size always starts in After; a reload of
    // the same one keeps whichever view was on.
    if (!keepView && st.view === "before") {
      st.view = "after";
      st.mode = st.modeBeforeView || st.mode;
      st.modeBeforeView = null;
    }
    hideAway();
    showStrip("nolayer-note", false);
    disarmReset();
    const cur = {
      page: st.page,
      device: st.device,
      nonce: makeNonce(),
      rev: 0,
      loaded: false,
      ready: false,
      saved: [],
      code: Object.create(null),
      codeBudget: MAX_CODE,
      loadsSeen: 0,
      starts: 0,
    };
    st.cur = cur;
    st.dirty = false;
    st.edits = 0;
    st.list = [];
    st.canUndo = false;
    st.canRedo = false;
    st.sel = null;
    $("canvas").dataset.loaded = "0";
    markSave("saved");
    mark();
    fit();
    drawSel();
    drawList();
    setStatus("Loading…");
    try {
      const r = await transport.getJson(`/api/changes?page=${encodeURIComponent(cur.page)}&device=${encodeURIComponent(cur.device)}`);
      if (st.cur !== cur) return;
      const body = r && r.body;
      if (!r || r.status !== 200 || !body || typeof body !== "object") throw new Error(`server status ${r ? r.status : "none"}`);
      const v = validateList(body.doc && Array.isArray(body.doc.list) ? body.doc.list : []);
      if (!v.ok) throw new Error("the stored list failed validation");
      cur.saved = v.value;
      cur.rev = Number.isInteger(body.rev) && body.rev >= 0 ? body.rev : 0;
      cur.code = cleanCode(body.code);
    } catch (err) {
      if (st.cur !== cur) return;
      // An empty preview here is deliberate. Showing the page with an empty
      // list would let the next autosave replace the stored file with nothing.
      st.cur = null;
      blankFrame();
      setStatus(`Stored edits for this page could not be loaded (${String(err && err.message ? err.message : err).slice(0, 120)}), so the preview is left empty and the file is untouched.`);
      return;
    }
    if (st.cur !== cur) return;
    // A blank page: the style scan is read again (the palette picks its
    // token styles from it), and a screen size with nothing stored starts
    // with another size's new elements.
    if (palette && isBlank(cur.page)) {
      const [seeded] = await Promise.all([cur.rev === 0 && !cur.saved.length ? palette.seed(cur.page, cur.device) : [], styles.load()]);
      if (st.cur !== cur) return;
      if (seeded.length) cur.saved = seeded;
    }
    setStatus("");
    navFrame(cur);
  }

  function matchPage(path) {
    const [pp, pq] = splitPath(path);
    for (const p of pages) {
      const [cp, cq] = splitPath(p.path);
      if (pageIdentity(pp, pq, p.keep) === pageIdentity(cp, cq, p.keep)) return p;
    }
    return null;
  }

  function switchPage(id) {
    const p = pageById(id);
    if (!p) return;
    st.page = p.id;
    savePrefs();
    toast(`Opened ${p.label}`);
    load();
  }

  // The app navigated by itself (a client-side route change).
  function onNavigate(path) {
    const p = matchPage(path);
    if (p && p.id === st.cur.page) {
      load({ keepView: true });
      return;
    }
    if (p) {
      switchPage(p.id);
      return;
    }
    showAway(path);
  }

  // "hello" comes from a document that loaded without a nonce, i.e. the
  // frame reloaded or followed a link on its own.
  function onHello(path) {
    const t = Date.now();
    while (reopens.length && t - reopens[0] > REOPEN_WINDOW_MS) reopens.shift();
    if (path) {
      const p = matchPage(path);
      if (!p) {
        showAway(path);
        return;
      }
      if (p.id !== st.cur.page) {
        switchPage(p.id);
        return;
      }
    }
    if (reopens.length >= REOPEN_LIMIT) {
      showNoLayer("The page reloads itself over and over, so automatic reopening has stopped. Press Reload once it settles.");
      return;
    }
    reopens.push(t);
    load({ keepView: true });
  }

  // A load event with neither "ready" nor "hello" after it means the frame
  // now shows a document without the layer (a download, an image, an error).
  function onFrameLoad() {
    const cur = st.cur;
    if (!cur) return;
    cur.loadsSeen++;
    const seen = cur.loadsSeen;
    win.setTimeout(() => {
      if (st.cur === cur && cur.loadsSeen === seen && cur.starts < seen && cur.ready && !st.away) {
        showNoLayer("The preview is now showing something the design layer cannot run in. Your recorded edits are safe; Reload brings the page back.");
      }
    }, LOAD_CHECK_MS);
  }

  // ---------------------------------------------------------------- the Styles tab

  // The tab, and the live style samples on their way to the server
  // (styles-panel.js). A new sample is asked for only while the layer runs
  // in After on an app page this window opened: a blank page is drawn from
  // the tokens, so it is never counted. After a rescan a blank page loads
  // its token style sheet again, so its new elements show the new values.
  const layerUp = () => {
    const cur = st.cur;
    return !!cur && cur.ready && cur.loaded && !st.away;
  };
  const styles = createStylesPanel({
    doc,
    transport,
    toast,
    requestSample: () => {
      if (!layerUp() || st.view !== "after" || isBlank(st.cur.page)) return false;
      send("sample-styles");
      return true;
    },
    onRescan: () => {
      if (layerUp() && isBlank(st.cur.page)) send("reload-tokens");
    },
    closeDrawer: () => setDrawer(false),
  });

  // ---------------------------------------------------------------- messages from the layer

  win.addEventListener("message", (e) => {
    if (e.origin !== frameOrigin || e.source !== frame.contentWindow) return;
    const cur = st.cur;
    if (!cur) return;
    const m = validateFrameMsg(e.data, { ns, nonce: cur.nonce });
    if (!m) return;
    switch (m.type) {
      case "hello":
        cur.starts++;
        onHello(m.path || "");
        return;
      case "ready": {
        cur.starts++;
        if (cur.ready) return;
        const p = matchPage(m.path || "/");
        if (m.path && (!p || p.id !== cur.page)) {
          win.clearTimeout(readyTimer);
          showAway(m.path);
          return;
        }
        cur.ready = true;
        win.clearTimeout(readyTimer);
        showStrip("nolayer-note", false);
        const page = pageById(cur.page) || pages[0];
        const dev = deviceById(cur.device) || devices[0];
        send("init", {
          list: cur.saved,
          mode: st.view === "before" ? "use" : st.mode,
          view: st.view,
          theme: st.theme,
          grid: { ...st.grid },
          code: { ...cur.code },
          page: { id: page.id, path: page.path, keep: [...page.keep], ...(page.blank === true ? { blank: true } : {}) },
          device: { id: dev.id, width: dev.width, height: dev.height },
          scale: st.scale,
        });
        return;
      }
      case "changes":
        onChanges(cur, m);
        return;
      case "selection":
        st.sel = m.info;
        drawSel();
        return;
      case "navigate":
        onNavigate(m.path);
        return;
      case "toast":
        toast(TOASTS[m.code]);
        return;
      case "save-now":
        saveNow(true);
        return;
      case "mode-request":
        setMode(m.mode);
        return;
      case "grid-toggle":
        toggleGrid();
        return;
      case "view-toggle":
        toggleView();
        return;
      case "drawer-toggle":
        toggleDrawer();
        return;
      case "need-code":
        fetchCode(cur, m.files);
        return;
      case "flushed":
        if (flushDone) flushDone();
        return;
      case "style-sample":
        // Counted styles of the app page this window opened (never a blank
        // page); the page, device and theme are this window's own.
        if (cur.loaded && st.view === "after" && !st.away && !isBlank(cur.page)) styles.onSample({ page: cur.page, device: cur.device, theme: st.theme }, m);
        return;
      default:
    }
  });

  function onChanges(cur, m) {
    if (m.init) {
      if (cur.loaded) return;
      cur.loaded = true;
      st.list = m.list;
      st.canUndo = false;
      st.canRedo = false;
      $("canvas").dataset.loaded = "1";
      mark();
      drawList();
      return;
    }
    // Ignored until the first list arrives, and while Before shows or the
    // frame is away from the page: none of those may change what is stored.
    if (!cur.loaded || st.view === "before" || st.away) return;
    if (m.view) {
      // Only presence changed (an element appeared or vanished). The
      // "missing" flags are copied onto the list already held; the message's
      // own list never replaces it and nothing is stored for it.
      const off = new Set(m.list.filter((c) => c.missing).map((c) => c.id));
      let differs = false;
      st.list = st.list.map((c) => {
        const miss = off.has(c.id);
        if (!!c.missing === miss) return c;
        differs = true;
        const x = { ...c };
        if (miss) x.missing = true;
        else delete x.missing;
        return x;
      });
      if (differs) drawList();
      return;
    }
    st.list = m.list;
    st.canUndo = m.canUndo;
    st.canRedo = m.canRedo;
    disarmReset();
    mark();
    drawList();
    st.edits++;
    st.dirty = true;
    markSave("dirty");
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(save, SAVE_DELAY_MS);
  }

  // Fingerprints for files the layer has not seen yet. Each load may ask
  // about a bounded number of files in total.
  async function fetchCode(cur, files) {
    const want = files.filter((f) => !(f in cur.code)).slice(0, Math.max(0, cur.codeBudget));
    cur.codeBudget -= want.length;
    if (!want.length) {
      send("code", { code: {} });
      return;
    }
    try {
      const r = await transport.postJson("/api/code", { files: want });
      if (!r || r.status !== 200 || !r.body) return;
      const code = cleanCode(r.body.code);
      for (const f of Object.keys(code)) cur.code[f] = code[f];
      if (st.cur === cur) send("code", { code });
    } catch {
      // the layer then treats those files as edited since the change
    }
  }

  // ---------------------------------------------------------------- storing

  let saveTimer = null;
  let chain = Promise.resolve(true);

  function markSave(state) {
    const b = $("save-state");
    b.dataset.state = state;
    b.dataset.saves = String(st.saves);
    b.textContent = state === "dirty" ? "Save" : state === "saving" ? "Saving…" : "Saved";
  }
  function setStatus(text) {
    $("save-status").textContent = text;
  }

  const bodyFor = (cur) => ({
    page: cur.page,
    device: cur.device,
    theme: st.theme,
    list: st.list,
    tab: TAB,
    seq: ++st.seq,
    base: cur.rev,
  });

  // Requests are queued so they reach the server in order; each one carries
  // the list as it is when that request starts, not when it was queued.
  const save = () => {
    chain = chain.then(saveOnce, saveOnce);
    return chain;
  };

  async function saveOnce() {
    const cur = st.cur;
    if (!cur || !cur.loaded) return true;
    const upto = st.edits;
    const body = bodyFor(cur);
    markSave("saving");
    try {
      const r = await transport.postJson("/api/changes", body);
      const j = r && r.body;
      if (r && r.status === 409 && j && j.conflict) {
        // The file moved on since this window read it (another window, or
        // "dftp done"). The newer file wins: reload it rather than overwrite.
        if (st.cur === cur) {
          toast("Another window (or dftp done) stored newer edits for this page. Reloading them now.");
          load({ skipSave: true, keepView: true });
        }
        return false;
      }
      if (!r || r.status !== 200 || !j || j.ok !== true) throw new Error(j && typeof j.error === "string" ? j.error : `server status ${r ? r.status : "none"}`);
      if (!j.stale && Number.isInteger(j.rev)) cur.rev = j.rev;
      if (st.cur === cur) {
        st.saves++;
        if (st.edits === upto) {
          st.dirty = false;
          markSave("saved");
        } else {
          markSave("dirty");
        }
        setStatus(`Last stored ${new Date().toLocaleTimeString()}.`);
      }
      return true;
    } catch (err) {
      if (st.cur === cur) {
        markSave("dirty");
        setStatus(`Could not store the edits (${String(err && err.message ? err.message : err).slice(0, 160)}). Try Save once more, or keep a copy with Download.`);
      }
      return false;
    }
  }

  async function saveNow(announce) {
    if (!st.cur || !st.cur.loaded) {
      if (announce) toast("The page has not finished loading yet.");
      return;
    }
    if (st.view === "before") {
      if (announce) toast("Nothing is stored while Before is showing.");
      return;
    }
    win.clearTimeout(saveTimer);
    const ok = await save();
    if (announce) toast(ok ? "Stored. You can close this window." : "Storing failed. Download keeps a copy of this page's edits.");
  }

  // Unload: hand any unsent edits to a keepalive request, which the browser
  // finishes after the page is gone (its body is limited to 64 KiB).
  win.addEventListener("pagehide", () => {
    const cur = st.cur;
    if (!st.dirty || !cur || !cur.loaded) return;
    try {
      transport.postJson("/api/changes", bodyFor(cur), { keepalive: true }).catch(() => {});
    } catch {
      // the window is closing; there is no later chance
    }
  });

  // ---------------------------------------------------------------- the side panel

  function drawList() {
    const box = $("change-list");
    clear(box);
    const before = st.view === "before";
    box.classList.toggle("faded", before);
    if (!st.list.length) {
      box.appendChild(h("li", { className: "empty-note", text: "Nothing recorded yet. Drag, resize or edit an element in the preview to start." }));
      return;
    }
    st.list.forEach((c, i) => {
      const li = h("li", { className: c.missing ? "is-missing" : "", dataset: { id: c.id, key: c.key } });
      if (c.missing) li.appendChild(h("div", { className: "chg-warn", text: "The preview does not show this element at the moment (a closed menu, a filtered list, or edited code). The change is kept and is drawn again when the element returns." }));
      li.appendChild(h("div", { className: "chg-what", text: `${i + 1}. ${whatOf(c)}` }));
      li.appendChild(h("div", { className: "chg-name", text: nameOf(c) }));
      li.appendChild(h("div", { className: "chg-where", text: where(c, { libraryPrefixes }).join("\n") }));
      li.appendChild(h("div", { className: "chg-id", text: `id ${c.id}` }));
      const btns = h("div", { className: "row-btns" });
      if (c.missing) {
        btns.appendChild(h("button", {
          type: "button",
          disabled: before,
          title: "Pick the matching element in the preview first",
          onclick: () => {
            if (!st.sel) {
              toast(TOASTS["nothing-selected"]);
              return;
            }
            send("reattach", { key: c.key });
          },
        }, "Attach to selection"));
      } else {
        btns.appendChild(h("button", {
          type: "button",
          disabled: before,
          onclick: () => {
            if (st.mode !== "design") setMode("design");
            send("select", { key: c.key });
          },
        }, "Find"));
      }
      if (c.hidden) btns.appendChild(h("button", { type: "button", disabled: before, onclick: () => send("show", { key: c.key }) }, "Show"));
      btns.appendChild(h("button", { type: "button", disabled: before, onclick: () => send("reset", { key: c.key }) }, "Reset"));
      li.appendChild(btns);
      box.appendChild(li);
    });
  }

  function drawSel() {
    if (palette) palette.update();
    const box = $("picked");
    clear(box);
    const s = st.sel;
    const before = st.view === "before";
    if (!s) {
      let text = "Nothing picked. Click an element in the preview.";
      if (before) text = "Before is showing the original page. Return to After to pick elements.";
      else if (st.mode === "use") text = "Use mode: the page reacts as normal. Switch to Design to pick an element.";
      box.appendChild(h("p", { className: "soft", text }));
      return;
    }
    if (s.count > 1) box.appendChild(h("p", { className: "multi-note", text: `${s.count} picked. Shift or ⌘/Ctrl-click to add or drop one. Dragging, arrow keys, Delete and R apply to the whole group; details below are for the first pick.` }));
    const kv = h("dl", { className: "facts" });
    const row = (k, v, cls) => {
      kv.append(h("dt", { text: k }), h("dd", { className: cls || "", text: v }));
    };
    row("Element", `<${s.tag}>${s.text ? ` "${s.text.slice(0, 60)}"` : ""}`);
    const fresh = s.key === "scaffold" ? "the main container of this blank page" : s.key.startsWith("ins:") ? "a new element, not in the code yet" : "";
    row("Source", s.loc ? `${s.part ? "inside " : ""}${s.loc}` : fresh || "not stamped", "mono");
    if (s.piece) row("Part", "a single word of a text", "soft");
    else if (s.part) row("Part", `child ${s.path || "?"} of the stamped element`, "soft");
    if (s.used_in) row("Inside", s.used_in, "mono");
    row("Size", `${Number.isFinite(s.rect.w) ? s.rect.w : 0} × ${Number.isFinite(s.rect.h) ? s.rect.h : 0} px`);
    row("Change", s.change ? whatOf(s.change) : "none");
    box.appendChild(kv);
    if (s.crumbs.length) {
      box.appendChild(h("p", { className: "soft fine", text: "Enclosing elements (click one to pick it):" }));
      const crumbs = h("div", { className: "ancestry" });
      for (const k of s.crumbs) {
        crumbs.appendChild(h("button", {
          type: "button",
          title: k.loc || "",
          disabled: before,
          onclick: () => send("select", { key: k.key, real: true }),
        }, `<${k.tag}>${k.text ? ` ${k.text}` : ""}`));
      }
      box.appendChild(crumbs);
    }
    const btns = h("div", { className: "row-btns" });
    if (s.change) btns.appendChild(h("button", { type: "button", className: "tiny-btn", disabled: before, onclick: () => send("reset", { key: s.key }) }, s.key.startsWith("ins:") ? "Remove element" : "Remove change"));
    btns.appendChild(h("button", {
      type: "button",
      className: "tiny-btn",
      disabled: before,
      onclick: () => {
        if (st.mode !== "design") setMode("design");
        focusFrame();
        send("edit");
      },
    }, "Change text"));
    btns.appendChild(h("button", { type: "button", className: "tiny-btn", disabled: before, onclick: () => send("key", { init: { key: "Delete" } }) }, "Hide element"));
    box.appendChild(btns);
  }

  // ---------------------------------------------------------------- copy and download

  function currentDoc() {
    const cur = st.cur || { page: st.page, device: st.device };
    const dev = deviceById(cur.device) || devOf();
    return {
      format: FORMAT_ID,
      version: FORMAT_VERSION,
      page: cur.page,
      device: cur.device,
      viewport: { width: dev.width, height: dev.height },
      theme: st.theme,
      saved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      list: st.list,
    };
  }

  async function copyText(text, okMsg) {
    try {
      await win.navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      toast("The browser blocked the clipboard. Download saves the same data.");
    }
  }

  $("copy-page").addEventListener("click", () => {
    const text = pageText(currentDoc(), { notes: NOTES, devices, pages, libraryPrefixes, code: st.cur ? st.cur.code : undefined });
    copyText(text, "Copied the edits for this page. Paste them into your coding assistant.");
  });
  $("copy-every").addEventListener("click", async () => {
    try {
      if (st.dirty) await save();
      const r = await transport.getText("/api/changes-md");
      if (!r || r.status !== 200 || typeof r.text !== "string") throw new Error("no answer");
      copyText(r.text, "Copied CHANGES.md (all pages and screen sizes).");
    } catch {
      toast("The server did not return CHANGES.md.");
    }
  });
  $("save-file").addEventListener("click", () => {
    const d = currentDoc();
    const blob = new Blob([`${JSON.stringify(d, null, 2)}\n`], { type: "application/json" });
    const a = h("a", { download: `dftp-${d.page}-${d.device}.json` });
    a.href = URL.createObjectURL(blob);
    doc.body.appendChild(a);
    a.click();
    a.remove();
    win.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("md-path").textContent = typeof features.changesPath === "string" ? features.changesPath : ".dftp/CHANGES.md";

  // ---------------------------------------------------------------- keyboard while this window has focus

  win.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveNow(true);
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (!mod && !e.altKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleView();
      return;
    }
    if (!mod && !e.altKey && e.key === "\\") {
      e.preventDefault();
      toggleDrawer();
      return;
    }
    if (!mod && !e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      setMode(st.mode === "design" ? "use" : "design");
      return;
    }
    if (!mod && !e.altKey && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      toggleGrid();
      return;
    }
    if (!KEY_ALLOW.includes(e.key)) return;
    if (isControl(e.target) && (e.key === "Enter" || e.key === " ")) return;
    if (mod && !/^[zZyY]$/.test(e.key)) return;
    e.preventDefault();
    // The editor is opened inside the frame; move the focus there so the
    // following keystrokes land in it.
    if (!mod && /^(e|E|Enter)$/.test(e.key)) focusFrame();
    send("key", { init: { key: e.key, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey } });
  });

  // ---------------------------------------------------------------- start

  if (pages.some((p) => p.blank === true) && $("palette-bar")) {
    palette = createPalette({
      doc,
      win,
      transport,
      tokens: () => styles.tokens(),
      send,
      devices,
      state: () => ({
        blank: isBlank(st.page) && !!st.cur && st.cur.page === st.page,
        loaded: !!st.cur && st.cur.loaded,
        view: st.view,
        away: st.away,
        sel: st.sel,
        list: st.list,
      }),
      setDesign: () => {
        if (st.mode !== "design") setMode("design");
      },
      relayout: () => fit(),
    });
  }
  $("tool-version").textContent = typeof features.version === "string" ? `v${features.version}` : "";
  setDrawer(st.drawer);
  mark();
  drawSel();
  drawList();
  load();

  return {
    state: () => ({ page: st.page, device: st.device, view: st.view, mode: st.mode, count: st.list.length }),
    reload: () => load({ keepView: true }),
  };
}
