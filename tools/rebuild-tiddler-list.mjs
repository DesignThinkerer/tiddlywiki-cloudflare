// Rebuilds the tiddler list (recipes/default/tiddlers.json) from the GitHub backup, for when the
// list in R2 is damaged and the worker refuses to touch it (README, section 7).
//
//   node tools/rebuild-tiddler-list.mjs tiddlers > tiddlers.json
//
// Run it on an up-to-date clone of the backup repository, once no backups are waiting (no files
// under _backup/versions/ in R2), so the backup holds every tiddler's latest version. Then upload
// tiddlers.json to R2 as recipes/default/tiddlers.json.
import fs from "node:fs";
import path from "node:path";

const folder = process.argv[2];
if (!folder || !fs.existsSync(folder)) {
  console.error("Usage: node tools/rebuild-tiddler-list.mjs <the backup's tiddlers folder>");
  process.exit(1);
}

// TiddlyWiki's date format, as the worker uses for missing dates
const now = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

function* jsonFiles(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) yield* jsonFiles(full);
    else if (item.name.endsWith(".json")) yield full;
  }
}

const entries = [];
for (const file of jsonFiles(folder)) {
  let tiddler;
  try {
    tiddler = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Skipped ${file}: ${e.message}`);
    continue;
  }
  if (!tiddler || typeof tiddler.title !== "string") {
    console.error(`Skipped ${file}: no title`);
    continue;
  }
  // The same entry the worker's updateManifest writes: every field but the text
  const { text, revision, bag, recipe, ...fields } = tiddler;
  entries.push({
    ...fields,
    title: tiddler.title,
    bag: "default",
    recipe: "default",
    modified: tiddler.modified || now,
    created: tiddler.created || now,
    tags: tiddler.tags || [],
    type: tiddler.type || "text/vnd.tiddlywiki",
    revision: String(revision ?? ""),
    _is_skinny: ""
  });
}

process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
console.error(`${entries.length} tiddlers listed`);
