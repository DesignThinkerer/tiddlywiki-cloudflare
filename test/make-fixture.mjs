// Builds test/fixtures/index.html: an empty TiddlyWiki (server edition, so it has the TiddlyWeb
// plugin) for the browser tests. Run: npm run fixture   (add -- --force to rebuild). An existing
// one is rebuilt by itself when it's from another version of TiddlyWiki than the one installed.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tiddlywiki = require.resolve("tiddlywiki/tiddlywiki.js");
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const output = dir + "index.html";

const installed = require("tiddlywiki/package.json").version;
// The version in the file's <meta name="tiddlywiki-version">, in its first few KB
function fixtureVersion() {
  const head = Buffer.alloc(16384), fd = openSync(output, "r");
  try {
    const read = readSync(fd, head, 0, head.length, 0);
    return (/<meta name="tiddlywiki-version" content="([^"]*)"/.exec(head.toString("utf8", 0, read)) || [])[1] || null;
  } finally {
    closeSync(fd);
  }
}
if (existsSync(output) && !process.argv.includes("--force")) {
  const version = fixtureVersion();
  if (version === installed) {
    console.log(`test/fixtures/index.html already exists, TiddlyWiki ${installed} (use --force to rebuild)`);
    process.exit(0);
  }
  console.log(`test/fixtures/index.html is TiddlyWiki ${version || "of an unknown version"}, the package is ${installed}: rebuilding it`);
}
mkdirSync(dir, { recursive: true });
const wikiFolder = dir + "wiki";
if (!existsSync(wikiFolder)) {
  execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--init", "server"], { stdio: "inherit" });
}
execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--output", dir, "--render", "$:/core/save/all", "index.html", "text/plain"], { stdio: "inherit" });
console.log("test/fixtures/index.html written");
