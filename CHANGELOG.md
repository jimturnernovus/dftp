# Changelog

DFTP (Designer for the Page) follows [semantic versioning](https://semver.org/).

## 0.2.0

- Style scan: the designer (at start-up and on **Rescan**) and the new
  `dftp scan` command read the project's styles into one normalised
  `.dftp/tokens.json`. This release reads plain CSS, custom properties
  (with dark values), Tailwind CSS v4 `@theme`, design-token and theme JSON
  files (including Tokens Studio and WordPress `theme.json`), HTML style
  blocks and attributes, and the style blocks of `.vue`, `.svelte` and
  `.astro` files. The scan never runs project code and works on fixed
  budgets.
- Live style sample: the computed styles of the rendered page (style values
  only, never text) mark tokens as seen and add frequent values no file
  names.
- **Styles** tab in the side panel: colors with roles, type scale, spacing,
  radii and shadows, each with its source file and line.
- Object styles: the whole look of the project's buttons (primary,
  secondary, ghost), cards, text boxes, badges, avatars, links, headings,
  body text and dividers, from the live sample and from the style files
  (`objects` in `tokens.json`, an **Objects** section in the Styles tab).
  New elements on a blank page copy them first (per screen size; colors
  without a dark value only in the light theme), and `CHANGES.md` says which
  one an element copies so the project's own class or component is reused.
- Blank pages (`--blank [NAME]`): an empty, responsive page styled from the
  tokens, with an element palette. New elements are listed under "New
  elements" in `CHANGES.md` (change kind `insert`) with their token styles
  and the project's own components. `--blank` opens the designer on the
  blank page.
- Pages that scroll inside their own container keep scrolling after a move;
  an always-visible scrollbar for the page's main scroll area.
- An element dropped entirely outside its parent is detached from it
  (`detached`, `container` in `CHANGES.md`).

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
