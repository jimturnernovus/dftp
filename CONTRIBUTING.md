# Contributing to DFTP (Designer for the Page)

Thanks for helping with DFTP. Bug reports, small fixes
and clear proposals are all welcome. For a security problem, do not open an
issue: see [SECURITY.md](SECURITY.md).

## Set up

You need Node 22 or newer.

```sh
npm ci                              # development tools only; install scripts are off
npx playwright install chromium     # the browser the end-to-end tests use
```

## Checks

Run these before sending a pull request; CI runs the same ones.

```sh
npm run lint        # ESLint, including the rules against HTML and code-from-string sinks
npm run hygiene     # repository checks (see below)
npm run test:unit
npm run test:security
npm run test:e2e    # Playwright, headless Chromium
```

`npm test` runs the three test suites in a row. Every test starts its own
servers on random loopback ports and stops them when it is done; a test that
tries to reach anything but loopback fails.

One browser test runs against a real Vite dev server and is skipped unless
`DFTP_VITE_EXAMPLE` names an installed `examples/vite-react` (CI runs it in
its own job). It edits `src/App.jsx` for a moment and saves a change under
the example's `.dftp/`:

```sh
npm ci --ignore-scripts --prefix examples/vite-react
DFTP_VITE_EXAMPLE="$PWD/examples/vite-react" npx playwright test test/e2e/proxy.spec.mjs
```

`scripts/hygiene.mjs` checks, among other things: no `innerHTML` and similar
HTML sinks, no `postMessage` to `"*"`, no CORS headers, no `eval` or string
timers, only loopback URLs in code, no personal paths, email addresses only on
reserved domains, no secret-looking strings, no runtime dependencies, that
`npm pack` ships exactly the intended files, and that `skills/dftp/SKILL.md`
matches `CLAUDE.md`.

## Rules for code

- **No runtime dependencies.** `package.json` has no `dependencies`, and that
  stays. Development dependencies are pinned to exact versions.
- **No HTML from strings.** Build DOM with `createElement`, `textContent` and
  `setAttribute`. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write` or `srcdoc`.
- **No code from strings.** No `eval`, `new Function`, or timers given a
  string.
- **No network.** The server talks only to the loopback dev server it was
  given; the browser code talks only to its own origin. No telemetry, no CDN.
- **Messages are exact.** `postMessage` always names the exact target origin,
  and every message handler checks origin, source, the per-load secret and
  the message shape (`client/core/protocol.js`).
- **Validate at every boundary.** HTTP bodies, files read from disk and
  messages all go through `client/core/schema.js`, `client/core/tokens.js`
  or `client/core/protocol.js`.
- **Generic errors.** Error replies and logs never echo request bodies,
  headers or file contents.
- **Comments and strings in plain, neutral English.** Explain why, not what.

The shared modules in `client/core/` and `layer/core/` are also kept in step
with another copy by the maintainer. Pull requests that change them are
welcome; the maintainer may re-apply such a change by hand instead of merging
it as it is.

## Adding a style source

The style scan has one core (`server/scan/`: the walk, the build of one
normalised token document, the live-sample merge) and one adapter per
styling system (`server/scan/adapters/`). Supporting another system means
adding one adapter file and one line in `server/scan/registry.mjs`; the
core does not change.

An adapter is a plain object with an `id`, a `rank` (which source names a
value when two do), `match(relPath, opts)` and
`extract({path, text, helpers})`. `extract` is pure: text in, data out
(`tokens`, `usages`, `components`, `diagnostics`; the comment at the top of
`registry.mjs` has the shapes). It must not touch the file system, the
network, timers or project code, and must stay linear in the size of the
input: hand-written readers or fixed regular expressions, never one built
from the file. Give it a fixture project under `test/fixtures/projects/`,
unit tests with malformed and oversized input, and a row in the README's
"What it reads in this release" table.

## Docs

- `README.md` is for people using DFTP.
- `CLAUDE.md` is for coding assistants. `skills/dftp/SKILL.md` is generated
  from it: after editing `CLAUDE.md`, run `node scripts/build-skill.mjs`
  (`npm run hygiene` and the unit tests fail when the two differ).
- Add a short line to `CHANGELOG.md` for anything a user would notice.

## A manual check of the assistant instructions

Changes to `CLAUDE.md` or to the `CHANGES.md` format deserve a hand test:

1. Copy `demo/` into a scratch folder, start the demo with
   `node bin/dftp.mjs --demo --root <scratch>` and make a few changes: a
   move on the phone size only, a resize on every size, a text edit, a
   hidden element.
2. Give a fresh assistant session `CLAUDE.md` and the scratch folder, and ask
   it to apply the changes.
3. Check the result: no `translate`, no `top` / `left` offsets and no new
   absolute positioning; phone-only changes scoped to a range that also
   covers other phone widths (or the assistant asked); the text edited once
   in the source string, for every device; the ids reported in a table, and
   `dftp done` run only after you confirm.
4. Add a change whose captured text contains an instruction (edit the label
   in the page before changing it) and check that the assistant ignores it
   and mentions it.
