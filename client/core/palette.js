// The element palette of blank pages, a bar above the preview: drag an
// element from it onto the page, or click it (or press Return on it) to add
// the element to the selected box. The layer makes the element; this window
// picks its look from the style scan (the project's object style for it
// first, then role tokens), names the project's own component for it when
// the scan found one, and says where it goes.
//
// While an element is dragged, a cover over the preview keeps the pointer in
// this window (the preview is another origin); the drop point is turned into
// the frame's own pixels and sent with the element.
//
// A screen size of a blank page with nothing stored yet starts with the new
// elements of another screen size (seed), so a page laid out on one screen
// size can be checked and adjusted on the others.

import { ELEMENTS, PALETTE, pickLook, componentFor, seedInserts } from "./blank.js";
import { validateList } from "./schema.js";

const DRAG_PX = 4;

// opts:
//   doc, win     the designer's document and window
//   transport    {getJson(path)} (shell.js)
//   tokens()     the style scan's document, validated (the Styles tab's
//                copy, styles-panel.js), or null
//   send(type, fields)  a message to the layer
//   state()      {blank, loaded, view, away, sel, list}: the current page
//   setDesign()  switch to Design mode first
//   relayout()   fit the preview again (the bar takes room above it)
//   devices      [{id}] in the designer's order
export function createPalette({ doc, win, transport, tokens, send, state, setDesign, relayout, devices }) {
  const bar = doc.getElementById("palette-bar");
  let drag = null;
  let skipClick = false;

  const make = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  // The message for an element of kind `kind`: its token styles, the
  // project's object style it copies and, when the project has one, its
  // component.
  function payload(kind) {
    const scan = tokens();
    const look = pickLook(scan, kind);
    const out = { element: kind, styles: look.styles };
    if (look.object) out.object = look.object;
    const comp = componentFor(scan, kind);
    if (comp) {
      out.component = comp.export;
      out.component_file = comp.file;
    }
    return out;
  }

  // A window point in the frame's own CSS pixels, or null outside the part
  // of the preview that is on screen.
  function framePoint(x, y) {
    const f = doc.getElementById("page-frame");
    const canvas = doc.getElementById("canvas");
    if (!f || !canvas || !f.offsetWidth) return null;
    const r = f.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    if (x < Math.max(r.left, c.left) || x > Math.min(r.right, c.right) || y < Math.max(r.top, c.top) || y > Math.min(r.bottom, c.bottom)) return null;
    const k = r.width / f.offsetWidth;
    return { x: Math.round(((x - r.left) / k) * 10) / 10, y: Math.round(((y - r.top) / k) * 10) / 10 };
  }

  const usable = () => {
    const s = state();
    return !!s.blank && s.loaded && s.view !== "before" && !s.away;
  };

  function addHere(kind) {
    if (!usable()) return;
    setDesign();
    send("insert", payload(kind));
  }

  function startDrag() {
    drag.moved = true;
    setDesign();
    const canvas = doc.getElementById("canvas");
    const r = canvas.getBoundingClientRect();
    drag.cover = make("div", "pal-cover");
    drag.cover.style.left = `${r.left}px`;
    drag.cover.style.top = `${r.top}px`;
    drag.cover.style.width = `${r.width}px`;
    drag.cover.style.height = `${r.height}px`;
    drag.ghost = make("div", "pal-ghost", ELEMENTS[drag.kind].label);
    doc.body.append(drag.cover, drag.ghost);
  }

  function moveDrag(x, y) {
    drag.ghost.style.left = `${x + 14}px`;
    drag.ghost.style.top = `${y + 10}px`;
    const at = framePoint(x, y);
    drag.ghost.classList.toggle("is-out", !at);
    const same = at && drag.at ? Math.abs(at.x - drag.at.x) < 2 && Math.abs(at.y - drag.at.y) < 2 : at === drag.at;
    if (same) return;
    drag.at = at;
    send("insert-hint", { at });
  }

  function endDrag(drop) {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return;
    // The click that ends a drag is not a click on the palette item.
    skipClick = true;
    win.setTimeout(() => {
      skipClick = false;
    }, 0);
    send("insert-hint", { at: null });
    if (drop && d.at && usable()) send("insert", { ...payload(d.kind), at: d.at });
    d.cover.remove();
    d.ghost.remove();
  }

  function hook(b, kind) {
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || b.disabled || drag) return;
      drag = { kind, b, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, at: null, cover: null, ghost: null };
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        // capture keeps the drag going over the preview; the cover does too
      }
    });
    b.addEventListener("pointermove", (e) => {
      if (!drag || drag.b !== b || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x0) < DRAG_PX && Math.abs(e.clientY - drag.y0) < DRAG_PX) return;
        startDrag();
      }
      moveDrag(e.clientX, e.clientY);
    });
    b.addEventListener("pointerup", (e) => {
      if (drag && drag.b === b && e.pointerId === drag.id) {
        if (drag.moved) moveDrag(e.clientX, e.clientY);
        endDrag(true);
      }
    });
    b.addEventListener("pointercancel", () => {
      if (drag && drag.b === b) endDrag(false);
    });
    b.addEventListener("click", () => {
      if (skipClick) {
        skipClick = false;
        return;
      }
      addHere(kind);
    });
  }

  bar.appendChild(make("span", "pal-lead", "Add"));
  const buttons = PALETTE.map((kind) => {
    const b = make("button", "pal-item", ELEMENTS[kind].label);
    b.type = "button";
    b.dataset.insert = kind;
    b.title = `${ELEMENTS[kind].label}: drag onto the page, or click to add it to the selected box`;
    bar.appendChild(b);
    hook(b, kind);
    return b;
  });
  const hint = make("span", "pal-hint", "");
  bar.appendChild(hint);

  // Where a click adds an element, from the current pick.
  function target(sel, list) {
    if (!sel || sel.key === "scaffold" || !sel.key.startsWith("ins:")) return "at the end of the page";
    const c = (list || []).find((x) => x.key === sel.key);
    const def = c && Object.prototype.hasOwnProperty.call(ELEMENTS, c.element) ? ELEMENTS[c.element] : null;
    if (!def) return "at the end of the page";
    const name = def.label.toLowerCase();
    return def.box ? `into the selected ${name} (another ${name} goes after it)` : `after the selected ${name}`;
  }

  // Bring the bar in line with the current page, view and pick. The preview
  // is fitted again whenever the bar's height changes (its buttons wrap on
  // narrow windows; the hint never does, see .pal-hint in shell.css).
  let height = -1;
  function update() {
    const s = state();
    const show = !!s.blank;
    bar.hidden = !show;
    if (show) {
      const on = usable();
      for (const b of buttons) b.disabled = !on;
      if (s.view === "before") hint.textContent = "Before shows the page without its new elements.";
      else if (!on) hint.textContent = "";
      else hint.textContent = `Drag onto the page, or click to add ${target(s.sel, s.list)}.`;
      hint.title = hint.textContent;
    }
    const h = bar.offsetHeight;
    if (h !== height) {
      height = h;
      relayout();
    }
  }

  // The new elements another screen size of `page` holds, for `device`
  // which has nothing stored yet. [] when none has any.
  async function seed(page, device) {
    for (const d of devices) {
      if (d.id === device) continue;
      let r;
      try {
        r = await transport.getJson(`/api/changes?page=${encodeURIComponent(page)}&device=${encodeURIComponent(d.id)}`);
      } catch {
        continue;
      }
      const list = r && r.status === 200 && r.body && r.body.doc && Array.isArray(r.body.doc.list) ? r.body.doc.list : [];
      const seeded = seedInserts(list);
      if (!seeded.length) continue;
      const v = validateList(seeded);
      if (v.ok) return v.value;
    }
    return [];
  }

  return { update, seed };
}
