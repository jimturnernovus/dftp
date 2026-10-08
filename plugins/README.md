# Source-location plugins

DFTP (Designer for the Page) works without any change to your project. These
optional plugins make its change notes more precise: each HTML element your
code renders gets a `data-loc` attribute such as

```html
<button data-loc="src/components/ui/button.jsx:6:5">
```

meaning "drawn by line 6, column 5 of that file". DFTP then records the
exact file and line for every change, instead of only a CSS selector, class
names and text.

Rules every plugin here follows:

- **Development only.** Each one does nothing when `NODE_ENV` is
  `production`, and the setups below add it only while the dev server runs.
- **Relative paths only.** Paths are relative to the project root, with `/`
  separators. Absolute paths never appear in the page.
- **Your own files only.** Files outside the root or under `node_modules` are
  skipped, as are file names with characters a change file would refuse
  (spaces, for example).
- **Plain elements only.** `<div>`, `<button>`, `<my-widget>` are stamped;
  components (`<Button>`, `<ui.Card>`) are not. A component's elements are
  stamped in the component's own file, and DFTP works out where it is used.
- An element that already has the attribute is left as it is.

To check that nothing leaks into production, build the project and search the
output; this should print nothing:

```sh
grep -R "data-loc" dist/
```

## Where the plugin path comes from

The plugins live in the DFTP folder, whose location differs from one machine
to the next. A config file that names that path outright breaks the dev
server for everyone whose copy is elsewhere (or who has none). The setups
below therefore add a plugin only when the `DFTP_PLUGINS` environment
variable points at a folder that really holds it, and otherwise run exactly
as before:

```sh
DFTP_PLUGINS=/path/to/dftp/plugins npm run dev
```

When DFTP sits next to the project (as `examples/vite-react` does inside this
repository), a path relative to the config file works too and needs no
variable.

## Vite + React (`@vitejs/plugin-react`)

`plugins/babel-plugin-data-loc.cjs` plugs into the Babel step that
`@vitejs/plugin-react` already runs:

```js
// vite.config.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const file = process.env.DFTP_PLUGINS ? path.join(process.env.DFTP_PLUGINS, "babel-plugin-data-loc.cjs") : "";
const dataLoc = file && fs.existsSync(file) ? file : null;

export default defineConfig(({ command }) => ({
  plugins: [
    react(command === "serve" && dataLoc ? { babel: { plugins: [[dataLoc, { root }]] } } : {}),
  ],
}));
```

`examples/vite-react` is a small working app set up this way.

## Vite with SWC, Preact, Solid or other JSX setups

`plugins/vite-plugin-data-loc.mjs` runs the same Babel plugin as a Vite plugin
of its own (`apply: "serve"`, `enforce: "pre"`) on `.jsx` and `.tsx` files:

```js
// vite.config.js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

const file = process.env.DFTP_PLUGINS ? path.join(process.env.DFTP_PLUGINS, "vite-plugin-data-loc.mjs") : "";
const dataLoc = file && fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null;

export default defineConfig({ plugins: [...(dataLoc ? [dataLoc()] : []), react()] });
```

It needs `@babel/core` in your project as a devDependency
(`npm install --save-dev @babel/core`). It loads it from your project, never
from the DFTP folder, and stops the dev server with a clear message when it is
missing.

## Next.js (webpack)

Add the Babel plugin for development builds only:

```js
// babel.config.js
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.DFTP_PLUGINS ? path.join(process.env.DFTP_PLUGINS, "babel-plugin-data-loc.cjs") : "";

module.exports = (api) => ({
  presets: ["next/babel"],
  plugins: api.env("development") && file && fs.existsSync(file) ? [[file, { root: __dirname }]] : [],
});
```

A Babel config turns off Next's SWC compiler for your code, which makes builds
slower; remove it when you are done designing if that matters to you.

## Vue (`@vitejs/plugin-vue`)

`plugins/vue-data-loc.mjs` is a template compiler transform:

```js
// vite.config.js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const file = process.env.DFTP_PLUGINS ? path.join(process.env.DFTP_PLUGINS, "vue-data-loc.mjs") : "";
const dataLoc = file && fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null;

export default defineConfig(({ command }) => ({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          nodeTransforms: command === "serve" && dataLoc ? [dataLoc({ root: process.cwd() })] : [],
        },
      },
    }),
  ],
}));
```

## Options

| option | default | meaning |
|---|---|---|
| `root` | the current folder (the Vite plugin: Vite's `root`) | the project root that paths are relative to |
| `attr` | `data-loc` | the attribute name; must look like `data-…`. If you change it, set `locAttribute` in `dftp.config.json` to match |

## Other stacks

Next.js with Turbopack, Svelte, Angular and server-rendered templates have no
plugin yet. DFTP still works there: each change carries a selector, classes,
role and text, which is enough to find the element in the source.
