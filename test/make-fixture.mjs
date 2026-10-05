// Builds test/fixtures/index.html: an empty TiddlyWiki (server edition, so it has the TiddlyWeb
// plugin) for the browser tests. Run: npm run fixture   (add -- --force to rebuild)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tiddlywiki = require.resolve("tiddlywiki/tiddlywiki.js");
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const output = dir + "index.html";

if (existsSync(output) && !process.argv.includes("--force")) {
  console.log("test/fixtures/index.html already exists (use --force to rebuild)");
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const wikiFolder = dir + "wiki";
if (!existsSync(wikiFolder)) {
  execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--init", "server"], { stdio: "inherit" });
}
execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--output", dir, "--render", "$:/core/save/all", "index.html", "text/plain"], { stdio: "inherit" });
console.log("test/fixtures/index.html written");
