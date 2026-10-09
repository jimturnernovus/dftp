// The adapters the scan runs. Adding a styling system means adding one file
// under adapters/ and one line here; the scanner itself does not change.
//
// An adapter is a plain object:
//
//   {
//     id: "css-vars",                       unique, lower-case letters, digits and "-"
//     rank: 20,                             name precedence when two sources name one
//                                           value (token files 30, CSS 20, inline 10-15)
//     match(relPath, opts) -> boolean,      opts: {libraryPrefixes}
//     extract({path, text, helpers}) -> {tokens, usages, components, diagnostics}
//   }
//
// extract is pure: text in, data out. It must not use the file system, the
// network, timers or project code; `helpers` (helpers.mjs) holds the parsers
// it may need. Its output is checked and trimmed by the scanner:
//
//   tokens:      [{name, raw, line, col?, type?, mode?, scoped?, aliasRef?, path?, group?}]
//                name: "--brand-600" (CSS) or "color.brand.600" (token files);
//                raw: the value as CSS text; aliasRef: the name it refers to
//                when the whole value is a reference; mode: "dark" or another
//                theme; scoped: defined in a narrower rule than the page root;
//                path/group: segments and first segment for the token's id
//   usages:      [{prop, raw, line, col?, selector?, narrow?}]   a style
//                property with its value (narrow: inside a media query);
//                also "media-min"/"media-max" with a width, and "class"
//                with one class name
//   components:  [{kind, export, line?}]
//   diagnostics: [{code, line?}]                         codes from DIAG_CODES

import css from "./adapters/css.mjs";
import cssVars from "./adapters/css-vars.mjs";
import tailwindV4 from "./adapters/tailwind-v4.mjs";
import tokensJson from "./adapters/tokens-json.mjs";
import html from "./adapters/html.mjs";
import sfc from "./adapters/sfc.mjs";
import components from "./adapters/components.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Checks the shape of a list of adapters; throws on the first problem.
export function checkAdapters(list) {
  const ids = new Set();
  for (const a of list) {
    if (!a || typeof a !== "object") throw new TypeError("an adapter must be an object");
    if (typeof a.id !== "string" || !ID_RE.test(a.id) || a.id === "scan" || a.id === "live") throw new TypeError("adapter id must be lower-case letters, digits and \"-\"");
    if (ids.has(a.id)) throw new TypeError(`adapter id "${a.id}" is used twice`);
    if (typeof a.match !== "function" || typeof a.extract !== "function") throw new TypeError(`adapter "${a.id}" needs match() and extract()`);
    if (a.rank !== undefined && !(Number.isInteger(a.rank) && a.rank >= 0 && a.rank <= 100)) throw new TypeError(`adapter "${a.id}" rank must be 0-100`);
    ids.add(a.id);
  }
  return Object.freeze([...list]);
}

export const ADAPTERS = checkAdapters([css, cssVars, tailwindV4, tokensJson, html, sfc, components]);
