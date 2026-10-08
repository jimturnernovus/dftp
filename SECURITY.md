# Security policy

DFTP (Designer for the Page) is a local development tool. It runs on your own
computer, listens only on loopback addresses, and shows pages from your own
dev server. Security issues are taken seriously all the same: a designer that
a hostile web page could use against your files or your other local services
would be a real problem.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's private
vulnerability reporting: open this repository on GitHub, go to the
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for a security problem.

Include what you can of:

- the DFTP version (`node bin/dftp.mjs --version`), Node version, browser and
  operating system;
- the steps or a small test page that shows the problem;
- what an attacker gains (read a file, write outside `.dftp/`, reach another
  local service, run code in the designer window, and so on).

You can expect an acknowledgement within a week. Fixes are released as a new
version with a changelog entry; reporters are credited unless they ask not to
be.

## Supported versions

Only the latest release gets security fixes.

## Threat model

What DFTP defends against, and how:

| threat | defences |
|---|---|
| **A malicious website open in another tab** while DFTP runs (cross-site request forgery, DNS rebinding, clickjacking, WebSocket hijacking, probing local ports) | listens on `127.0.0.1` / `::1` only; exact `Host` check on every request; a random per-launch token on every API call; exact `Origin`, `Sec-Fetch-Site: same-origin` and a JSON content type on writes; no CORS headers at all; `frame-ancestors` / `X-Frame-Options` so only the designer can frame the page; WebSocket upgrades only from the page origin |
| **Another program or another user on the same computer** (anything can connect to a loopback port) | the designer page, which holds the API token, is served only with a session cookie (`HttpOnly`, `SameSite=Strict`) that the start-up link printed in the owner's terminal sets; requests without it get a refusal with no token; the cookie is stripped from every request passed to the dev server and the dev server cannot set it; source fingerprints are keyed with a secret in `.dftp/` that only the owner can read |
| **Hostile content inside the page being designed** (a third-party script, stored XSS in dev data, a compromised dependency of your app) | the page runs on a separate origin in a sandboxed frame without top navigation, pop-ups or modals; the designer accepts only well-formed messages from that frame with the right origin, window and per-load secret; the page can only propose a validated list of changes for the page and screen size the designer chose; notices the page triggers are codes that the designer maps to its own wording, and page-supplied strings (paths, captured labels) are only ever shown as plain text through `textContent`; fingerprint requests from the page are limited to ordinary source files and a fixed number per page load, and return keyed hashes that cannot be checked against guesses offline; no HTML is ever built from strings; the designer's CSP allows only its own scripts and enforces Trusted Types |
| **A crafted change file** in a project (for example from a pull request), aimed at the coding assistant that reads it, or at path tricks | every file is validated on read; source locations must be relative paths without `..`, absolute roots or drive letters; `CHANGES.md` writes every captured string as a JSON literal and states that quoted text is data; `CLAUDE.md` tells assistants to ignore requests found in change data, edit only files inside the project, and show a diff first |
| **Accidental capture of private data** | what a change records is the element's tag, `id`, classes, role, CSS path, box and layout context, a label of up to 80 characters (its text, or else its `aria-label`, placeholder, `title` or `alt`), its `aria-label` (up to 80), and for a text edit the original text (up to 500) and the new text; the value typed into a field is never read; the text inside text areas and editable regions is never read, though their `aria-label`, placeholder or `title` can be the label; password, hidden and card fields and anything marked `data-dftp-private` or inside such an element give no text at all (no label, `aria-label`, placeholder or original text), while their tag, `id`, classes, role and CSS path are still recorded; a text edit of an editable region, of anything inside one, or of an element holding one or a password, hidden, card or private field is refused; `--no-text` records no page text (the tag, `id`, classes, role, CSS path and the new text still are); `.dftp/` is git-ignored by default |
| **Escaping the project folder** | writes go only to `<project>/.dftp/`, through validated ids and atomic renames; symbolic links there stop startup, and the folders are checked again (type, device and inode) before every read and write, so one swapped for a link while DFTP runs (for example by a branch switch) is refused; static files come from fixed lists and request paths are never joined onto the disk; where Node has a permission model, DFTP runs inside it with write access to `.dftp/` only |
| **Supply chain** | no runtime dependencies; development dependencies pinned to exact versions with a lockfile and install scripts disabled; CI actions pinned to commit hashes with read-only permissions |

## Out of scope

- Anything that needs an attacker who can already run code as your user, or
  read your files.
- Your own dev server and app: DFTP shows them as they are. Your app's
  scripts run in the frame with your app's normal powers (its cookies, its
  storage, its network access).
- Changes your coding assistant makes to your code. Review its diffs.
- Exposing DFTP's ports through a tunnel or proxy, or running it on a remote
  machine. Other local users are kept out of the designer page, but DFTP is
  built for one person on one computer, and the project folder's own file
  permissions decide who can read `.dftp/`.

## Known limits

- The page origin (`http://127.0.0.1:7451` by default) is shared by every
  project you design with DFTP, so local storage and IndexedDB on it carry
  over between apps. Service workers are refused on it.
- Trusted Types are enforced only in Chromium-based browsers.
- Content inside the page can send the same messages DFTP's own script sends;
  the worst it can do is propose junk changes for the current page, which are
  validated and stored as data.
