# Changelog

DFTP (Designer for the Page) follows [semantic versioning](https://semver.org/).

## Unreleased

- Pages that scroll inside their own container (an app shell with a
  scrolling `<main>`) keep scrolling with the wheel and trackpad after an
  element is moved: clipping is no longer lifted on the boxes around a
  scroll container.
- An always-visible scrollbar for the page's main scroll area, drawn by the
  layer (drag, click the track, or scroll over it), in Design and Use mode.
- Dropping an element entirely outside its parent detaches it: the parent
  closes up, the element keeps its dropped position, and `CHANGES.md` names
  the container it left (`detached`, `container`). Dropping it back over the
  parent puts it back.

## 0.1.0

First release.

- Visual designer for a running web page: select, move, resize, hide and
  re-word elements; multi-select, grid and snap, undo and redo.
- Before / After view, and desktop, tablet and phone sizes.
- Changes saved per page and screen size under `.dftp/`, with a `CHANGES.md`
  summary for coding assistants and a `done` command to clear applied ones.
- Works with any dev server through a loopback proxy; built-in demo page.
- Optional source-location plugins for Babel, Vite and Vue.
- Instructions for coding assistants (`CLAUDE.md`) and a matching skill.
