#!/usr/bin/env node
// Merges the backup (setup 2.4: tiddlers/<title>.json, each tiddler as the worker stores it) into
// one file any TiddlyWiki imports: restore.json, an array of tiddlers with every field as text.
//
// The admin wiki imports the backup's files as they are (src/browser/restore-import.js does the
// same conversion as this tool, on a drop). Any other TiddlyWiki can't: its JSON import keeps only
// the fields whose value is text, and a stored tiddler has its tags as a list (TiddlyWeb's layout),
// so every tag would be lost; the stored revision, bag and recipe belong to the old wiki, not the
// new one. And a whole clone is better dragged as one file than as a thousand.
//
// Usage: node tools/restore.mjs <a clone of the backup, or one of its files> [restore.json]
// Then drag restore.json onto the admin wiki (setup 2.4), or build a single-file wiki from it:
//   npx tiddlywiki@5.4.1 wiki --init empty && npx tiddlywiki@5.4.1 wiki --load restore.json --build index

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A list field as TiddlyWiki writes it: items with a space in double brackets ($tw.utils.stringifyList)
export function stringifyList(items) {
  return items.map(item => (item.indexOf(" ") !== -1 ? `[[${item}]]` : item)).join(" ");
}

// The importable tiddler for a stored one: every field as text, without the old wiki's revision, bag
// and recipe. A custom field called "fields" is stored nested ({ fields: { fields: "…" } }, see
// layout.js), and comes back flat. Returns null (with a reason in problems) for what isn't a tiddler.
export function importable(stored, problems = []) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored) || typeof stored.title !== "string" || !stored.title) {
    problems.push("not a tiddler (no title)");
    return null;
  }
  const fields = {};
  for (const [name, value] of Object.entries(stored)) {
    if (name === "revision" || name === "bag" || name === "recipe") continue;
    if (name === "fields" && value && typeof value === "object" && !Array.isArray(value) && typeof value.fields === "string") {
      fields.fields = value.fields;
    } else if (typeof value === "string") {
      fields[name] = value;
    } else if (Array.isArray(value) && value.every(item => typeof item === "string")) {
      fields[name] = stringifyList(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields[name] = String(value);
    } else {
      problems.push(`field "${name}" of "${stored.title}" isn't text, left out`);
    }
  }
  return fields;
}

// Every .json file under a directory (the backup's tiddlers/, with its subdirectories for titles
// that have slashes), or one file
function jsonFiles(target) {
  if (fs.statSync(target).isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
  }
  return files;
}

// The importable tiddlers of a backup clone (its tiddlers/ directory, or the clone itself), or of
// one file; sorted by title. problems: what was left out, and why.
export function collect(target, problems = []) {
  const dir = fs.statSync(target).isDirectory() && fs.existsSync(path.join(target, "tiddlers")) ? path.join(target, "tiddlers") : target;
  const tiddlers = [];
  for (const file of jsonFiles(dir)) {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      problems.push(`${file}: not JSON (${e.message})`);
      continue;
    }
    const fileProblems = [];
    const fields = importable(stored, fileProblems);
    problems.push(...fileProblems.map(p => `${file}: ${p}`));
    if (fields) tiddlers.push(fields);
  }
  tiddlers.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return tiddlers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, out = "restore.json"] = process.argv.slice(2);
  if (!target) {
    console.error("Usage: node tools/restore.mjs <a clone of the backup, or one of its files> [restore.json]");
    process.exit(2);
  }
  const problems = [];
  const tiddlers = collect(target, problems);
  fs.writeFileSync(out, JSON.stringify(tiddlers, null, 1));
  for (const problem of problems) console.error("Left out: " + problem);
  console.log(`${out}: ${tiddlers.length} tiddlers, ready to drag onto the admin wiki (setup 2.4)`);
}
