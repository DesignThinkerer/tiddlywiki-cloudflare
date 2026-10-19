// Prints a dated block of CHANGELOG.md without its heading: the release's notes (CONTRIBUTING,
// "Releases"). The newest dated block unless a date is given:
//   node tools/release-notes.mjs             # the newest dated block
//   node tools/release-notes.mjs 2026-10-19  # that block
// An "Unreleased" block is never printed: it isn't a release yet.
import fs from "node:fs";

const text = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const wanted = process.argv[2];
const blocks = text.split(/^## /m).slice(1);   // each starts with its heading line
const block = blocks.find(b => wanted ? b.startsWith(wanted + "\n") : /^\d{4}-\d{2}-\d{2}\n/.test(b));
if (!block) {
  console.error(wanted ? `CHANGELOG.md has no block dated ${wanted}` : "CHANGELOG.md has no dated block");
  process.exit(1);
}
process.stdout.write(block.slice(block.indexOf("\n") + 1).trim() + "\n");
