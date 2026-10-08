import js from "@eslint/js";
import globals from "globals";

// HTML sinks and code-from-string sinks are banned everywhere; a page string
// must reach the DOM only through textContent or setAttribute.
const htmlSinks = [
  { property: "innerHTML", message: "Build DOM with createElement and textContent." },
  { property: "outerHTML", message: "Build DOM with createElement and textContent." },
  { property: "insertAdjacentHTML", message: "Build DOM with createElement and textContent." },
  { property: "srcdoc", message: "No srcdoc: frames load only from the frame origin." },
  { property: "setHTMLUnsafe", message: "Build DOM with createElement and textContent." },
  { property: "createContextualFragment", message: "Build DOM with createElement and textContent." },
  { object: "document", property: "write", message: "No document.write." },
  { object: "document", property: "writeln", message: "No document.write." },
];

const restrictedSyntax = [
  {
    selector: "CallExpression[callee.property.name='postMessage'][arguments.1.type='Literal'][arguments.1.value='*']",
    message: "postMessage needs an exact target origin, never \"*\".",
  },
  {
    selector: "CallExpression[callee.name='postMessage'][arguments.1.type='Literal'][arguments.1.value='*']",
    message: "postMessage needs an exact target origin, never \"*\".",
  },
  // Only a string first argument is refused; Playwright's test.setTimeout(ms)
  // and similar numeric calls are fine.
  {
    selector: "CallExpression[callee.name=/^set(Timeout|Interval)$/][arguments.0.type='TemplateLiteral']",
    message: "Timers take a function, never a string.",
  },
  {
    selector: "CallExpression[callee.name=/^set(Timeout|Interval)$/][arguments.0.type='Literal'][arguments.0.raw=/^[\"']/]",
    message: "Timers take a function, never a string.",
  },
  {
    selector: "CallExpression[callee.property.name=/^set(Timeout|Interval)$/][arguments.0.type='TemplateLiteral']",
    message: "Timers take a function, never a string.",
  },
  {
    selector: "CallExpression[callee.property.name=/^set(Timeout|Interval)$/][arguments.0.type='Literal'][arguments.0.raw=/^[\"']/]",
    message: "Timers take a function, never a string.",
  },
];

export default [
  {
    ignores: ["node_modules/", "test-results/", "playwright-report/", ".dftp/", "examples/**/node_modules/", "examples/**/dist/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-undef": "error",
      "no-restricted-properties": ["error", ...htmlSinks],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    files: ["server/**", "bin/**", "scripts/**", "test/**", "plugins/**", "eslint.config.js", "playwright.config.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["client/**", "layer/**", "demo/**"],
    ignores: ["client/core/schema.js", "client/core/protocol.js", "client/core/devices.js", "client/core/spec.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Shared modules run in the browser and in Node: standard JavaScript only.
    files: ["client/core/schema.js", "client/core/protocol.js", "client/core/devices.js", "client/core/spec.js"],
    languageOptions: {
      globals: { URLSearchParams: "readonly", crypto: "readonly", globalThis: "readonly" },
    },
  },
  {
    // The example app's components (JSX, browser).
    files: ["examples/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-undef": "error",
      "no-restricted-properties": ["error", ...htmlSinks],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    files: ["test/e2e/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
