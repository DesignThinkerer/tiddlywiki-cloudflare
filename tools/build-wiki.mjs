// Builds seed/empty.html: an empty TiddlyWiki with the TiddlyWeb plugin (the server edition of the
// installed tiddlywiki package). Uploaded with the worker as a text module (wrangler.toml), it's what
// the worker puts in a new bucket on the first visit (setup 2.8); the browser tests start from it too.
// Run: npm run build   (or node tools/build-wiki.mjs; add --force to rebuild an existing file).
// An existing file is kept when it's from the installed version of TiddlyWiki, and rebuilt otherwise.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tiddlywiki = require.resolve("tiddlywiki/tiddlywiki.js");
const dir = fileURLToPath(new URL("../seed/", import.meta.url));
const output = dir + "empty.html";

const installed = require("tiddlywiki/package.json").version;
// The version in the file's <meta name="tiddlywiki-version">, in its first few KB
function fileVersion() {
  const head = Buffer.alloc(16384), fd = openSync(output, "r");
  try {
    const read = readSync(fd, head, 0, head.length, 0);
    return (/<meta name="tiddlywiki-version" content="([^"]*)"/.exec(head.toString("utf8", 0, read)) || [])[1] || null;
  } finally {
    closeSync(fd);
  }
}
if (existsSync(output) && !process.argv.includes("--force")) {
  const version = fileVersion();
  if (version === installed) {
    console.log(`seed/empty.html is up to date: TiddlyWiki ${installed} (--force rebuilds it)`);
    process.exit(0);
  }
  console.log(`seed/empty.html is TiddlyWiki ${version || "of an unknown version"}, the package is ${installed}: rebuilding it`);
}
mkdirSync(dir, { recursive: true });
// The wiki folder TiddlyWiki renders from, made fresh each time (seed/ holds only what's deployed)
const wikiFolder = mkdtempSync(join(tmpdir(), "empty-wiki-"));
try {
  execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--init", "server"], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync(process.execPath, [tiddlywiki, wikiFolder, "--output", dir, "--render", "$:/core/save/all", "empty.html", "text/plain"], { stdio: ["ignore", "ignore", "inherit"] });
} finally {
  rmSync(wikiFolder, { recursive: true, force: true });
}
console.log(`seed/empty.html written: TiddlyWiki ${installed}`);
