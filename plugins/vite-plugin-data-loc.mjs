// Vite plugin: the same data-loc stamping as babel-plugin-data-loc.cjs, for
// Vite setups that do not run Babel themselves (plugin-react-swc, Preact,
// Solid with JSX, ...). Runs only while serving, before the other plugins,
// on .jsx/.tsx files outside node_modules.
//
// It needs @babel/core installed in the project as a devDependency; it is
// loaded from the project, never from this folder.
//
//   import dataLoc from "<path to dftp>/plugins/vite-plugin-data-loc.mjs";
//   export default defineConfig({ plugins: [dataLoc(), react()] });
//
// Options: { root = Vite's root, attr = "data-loc" }

import path from "node:path";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);
const babelPlugin = localRequire("./babel-plugin-data-loc.cjs");

const JSX_FILE_RE = /\.[jt]sx$/;

export const MISSING_BABEL =
  "dftp data-loc: this plugin needs @babel/core in your project. " +
  "Add it as a devDependency (npm install --save-dev @babel/core), or remove the plugin.";

// Load @babel/core the way the project itself would.
export function loadProjectBabel(root) {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    return projectRequire("@babel/core");
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") throw new Error(MISSING_BABEL, { cause: e });
    throw e;
  }
}

export default function dataLoc(options = {}) {
  const attr = options.attr === undefined ? "data-loc" : options.attr;
  let root = options.root ? path.resolve(options.root) : process.cwd();
  let babel = null;

  return {
    name: "dftp-data-loc",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      if (!options.root && config && typeof config.root === "string") root = path.resolve(config.root);
      babel = loadProjectBabel(root);
    },
    async transform(code, id) {
      if (process.env.NODE_ENV === "production") return null;
      const file = String(id).split("?")[0];
      if (!JSX_FILE_RE.test(file) || file.startsWith("\0") || file.split(/[\\/]/).includes("node_modules")) return null;
      if (!babel) babel = loadProjectBabel(root);
      const result = await babel.transformAsync(code, {
        babelrc: false,
        configFile: false,
        filename: file,
        parserOpts: { plugins: ["jsx", ...(file.endsWith(".tsx") ? ["typescript"] : [])] },
        plugins: [[babelPlugin, { root, attr }]],
        retainLines: true,
        sourceMaps: true,
      });
      return result && result.code ? { code: result.code, map: result.map } : null;
    },
  };
}
