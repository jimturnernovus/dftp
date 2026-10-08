# DFTP — Designer for the Page

**A drag-and-drop layout designer for almost any web page**

DFTP (Designer for the Page) shows your running web app in a frame and lets
you rearrange it by hand: drag elements, resize them, hide them, change their
text, and compare **Before** and **After**, on desktop, tablet and phone
sizes. It never edits your code. It writes down each change, with the source
file and line the element comes from, in a plain text file that your coding
assistant (Claude, for example) turns into real code, written the way your
project already does layout.

Everything runs on your own computer: two loopback ports, no account,
nothing sent over the internet, no packages to install.

![The DFTP designer showing the demo page, with one card selected and two changes in the panel](docs/screenshot.png)

## Quick start

You need [Node.js](https://nodejs.org/) 22 or newer. DFTP has no runtime
dependencies, so there is no `npm install` step.

1. Download or clone this repository.
2. In its folder, run:

   ```sh
   node bin/dftp.mjs --demo --open
   ```

   or double-click `start-demo.command` (macOS) or `start-demo.bat` (Windows).
   If macOS says it cannot verify `start-demo.command` (common for files from
   a downloaded ZIP), right-click it and choose **Open**, or run the command
   above in Terminal.
3. Your browser opens the designer with a demo page ("Active Clients",
   made-up data). Click something, drag it, press `B`.

The terminal shows a `Designer:` link such as
`http://127.0.0.1:7450/?k=3f9c…`. The designer only opens through that link
(it sets a cookie for this run), so open it again from there if you close the
browser. Stop DFTP with Ctrl+C in the terminal.

## Use it with your project

Start your dev server as usual and note the exact address it prints. Then,
from your project folder:

```sh
node /path/to/dftp/bin/dftp.mjs --root . --target http://localhost:5173 --open
```

- Pass `--target` the address your dev server prints. Vite, for example,
  prints `http://localhost:5173/`; on many systems it then listens on IPv6
  only (`[::1]`). A `localhost` target is tried on `127.0.0.1` first and then
  on `::1`, so keep `localhost` when that is what the dev server shows. An IP
  target (`http://127.0.0.1:5173` or `http://[::1]:5173`) is used exactly as
  written.
- If DFTP says nothing answered at the target although the dev server is
  running, the address does not match: use the one the dev server prints.

Make your changes in the designer; they are saved as you go to
`.dftp/CHANGES.md` in your project.

### Let your coding assistant do the rest

The assistant guide is [CLAUDE.md](CLAUDE.md) **in the DFTP folder**, not in
your project, so tell your assistant where it is. Either:

- say:
  *"Read /path/to/dftp/CLAUDE.md, then integrate DFTP into this project"*,
  or
- for Claude Code, install the same guide as a skill, for every project:

  ```sh
  mkdir -p ~/.claude/skills && cp -R /path/to/dftp/skills/dftp ~/.claude/skills/
  ```

  or for one project only, into that project's `.claude/skills/` folder.
  The skill asks for the DFTP folder when it does not know it.

Integration finds your dev server, can write a `dftp.config.json` and set up
source stamping, and leaves a two-line note in your project's own
`CLAUDE.md` saying where DFTP lives. After that, *"Apply the DFTP layout
changes"* is enough: the assistant reads `.dftp/CHANGES.md`, changes your
code, shows you the diff, and marks the changes done with
`node /path/to/dftp/bin/dftp.mjs done --root . <id> …`.

`examples/vite-react` is a small Vite + React app already set up for DFTP.

## The screen

- **Top bar**: the page picker, the **Before | After** switch and the
  **Changes** button that opens and closes the side panel.
- **Toolbar**: screen size (Desktop 1440, Tablet 820, Phone 390), Light / Dark
  (when your config names a theme), **Design** / **Use** mode, the grid (size
  and snap), and Save, Undo, Redo, Reload and Reset page.
- **Preview**: your page at the chosen size, scaled to fit.
- **Side panel**: the selected element (source location, size, what changed,
  enclosing elements) and the list of changes, with **Copy** (this page and
  size, as text for your assistant), **Copy all** (all of `CHANGES.md`) and
  **Download** (the change file for this page at this screen size).
- **Before / After**: Before hides every recorded edit so you see the
  original page; editing and storing pause until you switch back with `B` or
  the After button. Notices such as this one sit above the preview, never
  over it.

**Use** mode lets the page behave as usual (links, forms, menus, typing),
apart from dialogs, pop-ups and downloads (see Limits), with your edits still
drawn on it.

## Keys

| key | what it does |
|---|---|
| click | pick an element |
| Shift-click or ⌘/Ctrl-click | add it to the selection, or drop it from the selection |
| Option/Alt-click or `P` | pick the enclosing element (repeat to climb further) |
| drag / drag a grip | move / resize |
| Shift while dragging | keep the move on one axis |
| arrow keys | step 1 px (Shift: 10 px; with Snap on, from grid line to grid line) |
| `E` or Return | edit the text (or a text box's placeholder); in the editor, Return confirms, Shift+Return inserts a line break, Esc cancels |
| double-click text | break it into words you can move one at a time |
| Delete or Backspace | hide the element |
| `R` | reset the selected elements |
| Esc | clear the selection |
| ⌘Z / Ctrl+Z | undo |
| ⇧⌘Z / Ctrl+Y | redo |
| ⌘S / Ctrl+S | store right away (edits are also stored automatically) |
| `D` | switch between Design and Use |
| `G` | grid on or off |
| `B` | Before / After |
| `\` | open or close the side panel |

`B`, `\`, `D`, `G` and ⌘S / Ctrl+S work in both modes, also while the page
itself has the keyboard focus, except while you type into one of its fields.

## Where changes go

Into a `.dftp/` folder in your project root:

| path | what it is |
|---|---|
| `.dftp/CHANGES.md` | every change, as text for your assistant; rebuilt after every save |
| `.dftp/changes/<page>__<device>.json` | one change file per page and screen size |
| `.dftp/history/` | the last 30 versions of each change file |
| `.dftp/fingerprint.key` | a random key for source fingerprints; readable by you only |
| `.dftp/.gitignore` | contains `*`: nothing in `.dftp/` is committed by default |

To commit `CHANGES.md` (to share changes through git), change
`.dftp/.gitignore` to:

```
*
!.gitignore
!CHANGES.md
```

Check what it contains first: it holds text captured from your pages.
`node /path/to/dftp/bin/dftp.mjs where --root .` prints its location.

## Command line

```
dftp [serve] --demo [--open]
dftp [serve] --target http://localhost:5173 [--root DIR] [options]
dftp done [--root DIR] [--demo] <id> [<id> ...]
dftp where [--root DIR] [--demo]
```

| option | meaning |
|---|---|
| `--demo` | show the built-in demo page instead of a dev server (with `done` and `where`: use the demo's own `.dftp/`) |
| `--target URL` | your dev server: `http` on `127.0.0.1`, `[::1]` or `localhost`; scheme, host and port only (no path or query) |
| `--root DIR` | project folder (default: the current folder; with `--demo`, the DFTP folder) |
| `--port N` | designer port, between 1024 and 65534 (default 7450); the page is served on `N+1`. If a port is busy, the next pair is tried |
| `--page PATH` | a page of your app to offer (repeatable) |
| `--open` | open the designer in your browser |
| `--no-text` | record no text from the page |
| `--debug` | log each request (method, path, status, time) and expose a debug handle in the page |
| `--relax-csp` | drop your dev page's Content-Security-Policy while it is shown (dev servers only) |
| `--host H` | `127.0.0.1` (default) or `::1` |
| `-h`, `--help` / `-v`, `--version` | help / version |

Run `node bin/dftp.mjs` in this folder, or from anywhere with its full path.
Invalid options or settings stop startup with a message and exit code 2.

## Configuration

`dftp.config.json` in your project root is optional. Every key is optional;
unknown keys are refused.

```json
{
  "target": "http://localhost:5173",
  "pages": [
    { "id": "home", "label": "Home", "path": "/" },
    { "id": "client", "label": "Client page", "path": "/clients/view?id=1042", "keep": ["id"] }
  ],
  "devices": "default",
  "libraryPrefixes": ["src/components/ui/"],
  "locAttribute": "data-loc",
  "rootSelector": "#root",
  "theme": { "selector": "html", "darkClass": "dark" },
  "captureText": true
}
```

| key | meaning |
|---|---|
| `target` | the dev server, as for `--target` (the flag wins) |
| `pages` | up to 100 pages. `path` is the address the designer opens: it starts with one `/`, may include a query string (`/clients/view?id=1042`) and is at most 200 characters. `keep` lists the query parameters that decide whether an address is that page; all other parameters (a tab, a filter) are ignored. `id` (lower-case letters, digits, `-`) defaults to a slug of the path, `label` (at most 60 characters) to the path. Default: one page, `home` at `/`. `--page` flags replace this list |
| `devices` | `"default"` or 1–6 entries `{ "id", "label", "width", "height" }` (width 240–3840, height 320–4000) |
| `libraryPrefixes` | folders of shared components (default `["src/components/ui/"]`); a change inside one also names the enclosing page element |
| `locAttribute` | the attribute the stamping plugins write (default `data-loc`) |
| `rootSelector` | your app's root element (default: the first of `#root`, `#app`, `#__next`, else `body`) |
| `theme` | only when your app switches themes with a class or attribute: `{ "selector", "darkClass" }` or `{ "selector", "attribute", "dark", "light" }`, where `attribute` must start with `data-`; adds a Light / Dark switch. Leave it out if the app follows `prefers-color-scheme` |
| `captureText` | `false` records no page text (same as `--no-text`) |

## Source stamping (optional)

DFTP works on any page as it is. For exact file-and-line locations, the
plugins in [`plugins/`](plugins/README.md) add a `data-loc="src/App.jsx:12:5"`
attribute to each element while your dev server runs: a Babel plugin (Vite +
React, Next.js with webpack), a Vite plugin (SWC, Preact, Solid) and a Vue
template transform. They are development-only and write relative paths only.
Without them, each change carries a selector, classes, role and text instead.

## Security model

DFTP is a development tool for your own computer. The design assumes the page
you are designing may be hostile and keeps it away from your files.

- **Loopback only.** It listens on `127.0.0.1` (or `::1`) and refuses any
  other `--host`. Your dev server must also be on this computer.
- **Start-up link.** The designer page is served only to a browser that
  opened the link printed at start-up: the link's key sets an `HttpOnly`,
  `SameSite=Strict` cookie for this run. Other programs or other users on the
  same computer can reach the port but get nothing from it.
- **Two origins.** The designer runs on port P (7450); your page runs on P+1
  (7451), a different origin, inside a sandboxed frame that cannot navigate
  the window or open pop-ups. Only the designer origin can write anything,
  and the session cookie is never passed on to your dev server.
- **Locked-down write API.** Every API call needs a random token made at
  startup, the exact `Host`, and `Sec-Fetch-Site: same-origin` when the
  browser sends it; writes also need the exact `Origin` and a JSON body of at
  most 1 MiB. There are no CORS headers, so other sites cannot read or write.
- **Strict page policy for the designer.** Its Content-Security-Policy allows
  only its own scripts, enforces Trusted Types and forbids framing. No HTML is
  ever built from strings; page text is shown with `textContent` only.
- **Checked messages.** The designer and the page talk through `postMessage`
  with an exact target origin, and every message is checked for its origin,
  sender, a per-load secret and its shape. The page can only propose changes
  for the page and screen size the designer chose, and only as data.
- **Files stay in `.dftp/`.** DFTP writes only inside your project's `.dftp/`
  folder, refuses symbolic links there (checked at start-up and again before
  every read and write), and validates every id and path. Source locations
  must be relative, without `..`. On Node versions with the permission model,
  DFTP runs itself inside it: read access to the DFTP folder and your
  project, write access to `.dftp/` only.
- **Fingerprints, not contents.** To notice edited source files, DFTP keeps a
  12-character keyed hash (HMAC-SHA256 with the key in `.dftp/`) of the
  source files that changes point at. Only ordinary source files are hashed:
  never paths with a segment starting with `.` (such as `.env` or `.git/`),
  nothing under `node_modules`, and only source and style file types.
- **No network.** The server talks only to your loopback dev server. It never
  phones home and loads nothing from the internet.
- **What is captured.** For each element you change, `.dftp/` records:
  - its tag, `id`, classes, role and a CSS path to it (which can include the
    `id` of an ancestor), its box and its layout context;
  - a label of up to 80 characters: the text it contains, or else its
    `aria-label`, placeholder, `title` or `alt` text;
  - its `aria-label` (up to 80 characters), to search for it by;
  - for a text edit, the original text (up to 500 characters; for a text
    box, its original placeholder) and the new text you typed.

  What is not captured:
  - the value typed into any field: DFTP never reads it;
  - the text inside text areas and editable regions (`contenteditable`).
    Their `aria-label`, placeholder or `title` can still be the label;
  - any text of password, hidden and card fields (`autocomplete="cc-…"`),
    or of an element marked `data-dftp-private` or inside one: no label, no
    `aria-label`, no placeholder, no original text. Their tag, `id`,
    classes, role and CSS path are still recorded.

  A text edit of an editable region, of anything inside one, or of an
  element that holds a password, hidden, card or private field or an
  editable region is refused. An element that holds a text area can be
  edited; the text area's own text is left alone.

  `--no-text` records no page text at all (no label, `aria-label` or
  original text); the tag, `id`, classes, role, CSS path and the new text
  you type are still saved.
- **Text you may not want in files.** If your dev page shows real customer
  data, the labels, `aria-label`s, ids, classes and original text of the
  elements you change end up in `.dftp/`. That folder is git-ignored by
  default; consider `--no-text`, and mark regions that hold personal data
  with `data-dftp-private`.
- **Assistant safety.** `CHANGES.md` quotes every captured string as a JSON
  literal and says that quoted text is data, never instructions;
  [CLAUDE.md](CLAUDE.md) tells your assistant to refuse anything a change asks
  it to do, to edit only files inside the project, and to show you the diff.

What the proxy does to your dev server's responses, while they are shown in
the designer: it removes `X-Frame-Options`, `frame-ancestors` and CORS
headers, adds the designer's script to HTML pages (up to 8 MiB), refuses
service-worker scripts, never follows redirects (one to another host shows a
notice instead), and passes WebSockets (hot reload) through. The same app
opened directly is untouched.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a
vulnerability.

## Limits

- Tested in Chromium-based browsers. Firefox and Safari are untested; word
  splitting in Firefox uses a less precise fallback.
- Inside the designer, `alert` / `confirm` / `prompt` dialogs, pop-ups and
  links that open a new tab, and file downloads are blocked by the frame's
  sandbox (`confirm()` returns `false`). Test those flows in a normal browser
  tab.
- Your dev server must be plain `http` on this computer; `https` dev servers
  are not supported yet.
- Pages with a strict `strict-dynamic` CSP may need `--relax-csp`.
- Cross-origin iframes, `<canvas>` and WebGL content inside your app cannot
  be designed.
- An app that calls an API on another port directly needs that API's dev
  CORS settings to allow `http://127.0.0.1:7451`.
- Cookies belong to a host name, so log in again inside the designer if your
  app uses `localhost` and the designer uses `127.0.0.1`.
- Request bodies through the proxy are limited to 1 MiB.
- The page origin (`127.0.0.1:7451`) is shared by every project you design,
  so its local storage carries over from one app to the next.
- When the window is closed, unsaved edits are sent with a request the
  browser caps at 64 KiB; changes are normally saved a moment after each edit.

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md): how to build, test and send changes.
- [SECURITY.md](SECURITY.md): report vulnerabilities privately through GitHub.
- [CHANGELOG.md](CHANGELOG.md)

MIT © 2026 NCF-VA LLC. See [LICENSE](LICENSE).
