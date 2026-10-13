// ESLint with its recommended rules only (no style rules): what it catches is a name that doesn't
// exist, an unused one, an import assigned to, a condition that can't be true. Run: npm run lint
import js from "@eslint/js";
import globals from "globals";

// Unused: arguments and caught errors may be, a name starting with _ too, and what a rest pattern
// leaves out ({ text, ...fields }). An empty catch is a way to say an error doesn't matter.
const RULES = {
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-control-regex": "off"
};

export default [
  { ignores: ["worker.js", "node_modules/"] },
  js.configs.recommended,
  {
    // The worker: Cloudflare's runtime has the service worker globals, and none of Node's (a Buffer
    // or a process would be caught here, not at deploy)
    files: ["src/worker/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.serviceworker } },
    rules: RULES
  },
  {
    // The build and the tools (Node)
    files: ["build.mjs", "tools/**/*.mjs", "eslint.config.js"],
    ignores: ["tools/screenshot.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: RULES
  },
  {
    // The tests, and the screenshot tool built on them: Node, with code that runs in the browser's
    // tabs (page.evaluate) in the same files
    files: ["test/**/*.mjs", "tools/screenshot.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, ...globals.browser, $tw: "readonly" } },
    rules: RULES
  },
  {
    // The browser modules: TiddlyWiki modules, run in the browser, written as CommonJS
    files: ["src/browser/*.js"],
    ignores: ["src/browser/service-worker.js"],
    languageOptions: { ecmaVersion: 2015, sourceType: "commonjs", globals: { ...globals.browser, $tw: "readonly" } },
    rules: RULES
  },
  {
    // The admin wiki's service worker: a plain script run by the browser outside the page
    files: ["src/browser/service-worker.js"],
    languageOptions: { ecmaVersion: 2015, sourceType: "script", globals: { ...globals.serviceworker } },
    rules: RULES
  }
];
