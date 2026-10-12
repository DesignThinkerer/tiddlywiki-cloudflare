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
    // The worker (Cloudflare's runtime: the service worker globals), the build and the tests (Node)
    files: ["src/worker/**/*.js", "build.mjs", "tools/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.serviceworker, ...globals.node } },
    rules: RULES
  },
  {
    // The tests: Node, with code that runs in the browser's tabs (page.evaluate) in the same files
    files: ["test/**/*.mjs"],
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
