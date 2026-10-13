// Builds worker.js: the modules of src/worker/ inlined into one file, in dependency order, with the
// browser modules of src/browser/ embedded as text. One file, so it can be deployed as is (Wrangler,
// or pasted into the dashboard), with every comment kept.
// Usage: node build.mjs   (or npm run build)
//        node build.mjs --check   (or npm run check:build): fails, writing nothing, if worker.js
//        isn't what the sources build, so a commit can't carry one that's out of date
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const workerDir = join(root, "src/worker");
const browserDir = join(root, "src/browser");

// The browser modules, and the texts that go with them (the admin plugin's tabs, .txt): each file
// src/browser/<name>.js or .txt replaces the placeholder "__<NAME>_SOURCE__" (upper case, "-" as
// "_": src/browser/list-sync.js is "__LIST_SYNC_SOURCE__"), which src/worker must hold exactly once
// (build.js's table), so a module can't be added without being baked
const PLACEHOLDERS = Object.fromEntries(readdirSync(browserDir).filter(name => /\.(js|txt)$/.test(name)).sort()
  .map(name => [`"__${name.replace(/\.(js|txt)$/, "").toUpperCase().replace(/-/g, "_")}_SOURCE__"`, join(browserDir, name)]));
// The package's version (package.json), shown as the admin plugin's with the build's hash
const PACKAGE_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// The TiddlyWiki version the worker ships: the package seed/empty.html is built from (tools/build-wiki.mjs)
const TIDDLYWIKI_VERSION = JSON.parse(readFileSync(join(root, "node_modules", "tiddlywiki", "package.json"), "utf8")).version;
// The app's files (src/app/: the default icons, PNG), embedded as base64: src/app/icon-192.png
// replaces "__ICON_192_PNG_BASE64__"
const appDir = join(root, "src/app");
const APP_PLACEHOLDERS = existsSync(appDir) ? Object.fromEntries(readdirSync(appDir).sort()
  .map(name => [`"__${name.toUpperCase().replace(/[-.]/g, "_")}_BASE64__"`, join(appDir, name)])) : {};

// The modules: path (relative to src/worker) → { text, imports (paths) }
const modules = new Map();
(function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.name.endsWith(".js")) {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/^import \{([^}]*)\} from "(\.[^"]+)";$/gm)]
        .map(m => ({ names: m[1].split(",").map(n => n.trim()).filter(Boolean), from: relative(workerDir, resolve(dirname(file), m[2])) }));
      const exports = new Set([...text.matchAll(/^export (?:async )?(?:function\*? |const |let |var |class )(\w+)/gm)].map(m => m[1]));
      modules.set(relative(workerDir, file), { text, imports, exports });
    }
  }
})(workerDir);

// Dependency order: a module after everything it imports. Two modules importing each other, or an
// import of something not exported, fails the build.
const ordered = [];
const state = new Map();
function visit(path, chain = []) {
  if (state.get(path) === "done") return;
  if (state.get(path) === "visiting") throw new Error(`modules import each other: ${[...chain, path].join(" -> ")}`);
  if (!modules.has(path)) throw new Error(`${chain[chain.length - 1]} imports ${path}, which doesn't exist`);
  state.set(path, "visiting");
  for (const { names, from } of modules.get(path).imports) {
    visit(from, [...chain, path]);
    // (Inlined, a name needn't be exported to be found: checked here, so the modules stay true modules)
    for (const name of names) if (!modules.get(from).exports.has(name)) throw new Error(`${path} imports ${name} from ${from}, which doesn't export it`);
  }
  state.set(path, "done");
  ordered.push(path);
}
visit("index.js");
for (const path of modules.keys()) visit(path);

// Inlined: the imports of src/worker dropped (any other import can't be inlined: the worker is one
// file with no dependencies, so it fails the build rather than leave an undefined name), exports
// kept as plain declarations, each top-level name defined once (var included: two modules' vars of
// one name would silently become one)
const declared = new Map();
const parts = ordered.map(path => {
  const body = modules.get(path).text
    .replace(/^import \{[^}]*\} from "\.[^"]+";\n/gm, "")
    .replace(/^export (?=(?:async )?function|const|let|var|class)/gm, "");
  for (const m of body.matchAll(/^(?:async )?(?:function\*? |const |let |var |class )(\w+)/gm)) {
    if (declared.has(m[1])) throw new Error(`${m[1]} is declared in both ${declared.get(m[1])} and ${path}`);
    declared.set(m[1], path);
  }
  const left = /^(import|export) .*$/m.exec(body.replace(/^export default /m, ""));
  if (left) {
    throw new Error(/^import .* from "[^."]/.test(left[0]) ? `${path} imports from outside src/worker (${left[0]}), which the build can't inline: the worker is one file, with no dependencies`
      : `${path}: an import or export the build doesn't know (${left[0]})`);
  }
  return `// ===== src/worker/${path} ${"=".repeat(Math.max(3, 92 - path.length))}\n\n${body.trim()}\n`;
});
let output = "// GENERATED by build.mjs from src/worker/ (inlined), src/browser/ (embedded as text) and src/app/ (embedded as base64). Edit those, then run `npm run build`.\n\n" + parts.join("\n");

// The browser modules, inserted as JSON string literals, which is valid JavaScript for any text:
// a module can contain backticks, ${, quotes or backslashes. (A replacer function, so "$&" and the
// like in a module aren't treated as replacement patterns.)
for (const [placeholder, file] of Object.entries(PLACEHOLDERS)) {
  if (output.split(placeholder).length !== 2) throw new Error(`src/worker must contain ${placeholder} exactly once (for ${relative(root, file)})`);
  output = output.replace(placeholder, () => JSON.stringify(readFileSync(file, "utf8")));
}
for (const [placeholder, file] of Object.entries(APP_PLACEHOLDERS)) {
  if (output.split(placeholder).length !== 2) throw new Error(`src/worker must contain ${placeholder} exactly once (for ${relative(root, file)})`);
  output = output.replace(placeholder, () => JSON.stringify(readFileSync(file).toString("base64")));
}
if (output.split('"__PACKAGE_VERSION__"').length !== 2) throw new Error('src/worker must contain "__PACKAGE_VERSION__" exactly once');
output = output.replace('"__PACKAGE_VERSION__"', () => JSON.stringify(PACKAGE_VERSION));
if (output.split('"__TIDDLYWIKI_VERSION__"').length !== 2) throw new Error('src/worker must contain "__TIDDLYWIKI_VERSION__" exactly once');
output = output.replace('"__TIDDLYWIKI_VERSION__"', () => JSON.stringify(TIDDLYWIKI_VERSION));
const unfilled = /"__[A-Z0-9_]+_(SOURCE|BASE64|VERSION)__"/.exec(output);
if (unfilled) throw new Error(`src/worker uses ${unfilled[0]}, which no file in src/browser or src/app fills`);

const target = join(root, "worker.js");
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== output) {
    console.error("worker.js is out of date: run `npm run build`");
    process.exit(1);
  }
  console.log("worker.js is up to date");
} else {
  writeFileSync(target, output);
  console.log(`worker.js written (${ordered.length} modules)`);
}
