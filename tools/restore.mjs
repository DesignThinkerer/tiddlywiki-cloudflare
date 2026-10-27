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
// A clone can come up short (limits 5): the backup's files are named after the titles, and a disk
// may not take a name. On Windows git checks out no title with a ":" (every system tiddler); macOS's
// default disk ignores case, so two titles differing by case check out as one file, holding the
// last; a title, or a part of it between slashes, longer than a file name may be fails the
// checkout. The commit has them all: on a git clone, its file list (git ls-tree on HEAD) is compared
// with the titles read, and what the disk lacks is read from the commit (git cat-file) and named.
// An empty folder is refused. Design 2.38.
//
// Usage: node tools/restore.mjs <a clone of the backup, or one of its files> [restore.json]
// Then drag restore.json onto the admin wiki (setup 2.4), or build a single-file wiki from it:
//   npx tiddlywiki@5.4.1 wiki --init empty && npx tiddlywiki@5.4.1 wiki --load restore.json --build index

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = "tiddlers/";   // the backup's files: tiddlers/<title>.json
const titleOf = file => file.slice(FILES.length, -".json".length);

// Said first on Windows, where the clone lacks every title with a ":" whatever the tool does next,
// and a drag of the clone's files would too
export function platformNotice(platform = process.platform) {
  return platform === "win32"
    ? "On Windows, git can't check out a title with a ':', which every system tiddler has (settings, themes and installed plugins among them): the clone lacks them, and so would a drag of its files (limits 5). From a git clone, this tool reads them from the commit instead, and says which; from a download that isn't a clone, they're missing: clone the backup with git, or run this on Linux, macOS or WSL."
    : "";
}

// The commit's tiddler files (git ls-tree on HEAD: the commit, not the index, which a checkout that
// failed leaves short), or null when the directory isn't a git clone, or git isn't there
export function committedFiles(root) {
  const run = spawnSync("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "tiddlers"], { maxBuffer: 256 * 1024 * 1024 });
  if (run.error || run.status !== 0) return null;
  return run.stdout.toString("utf8").split("\0").filter(file => file.startsWith(FILES) && file.endsWith(".json") && !file.includes("\n"));
}

// The text of these files as committed, file -> text, read in one git process (cat-file --batch:
// a header line "<sha> blob <size>" and the content for each, in the order asked; a file it
// doesn't find answers "… missing" with nothing after)
export function readCommitted(root, files) {
  const texts = new Map();
  if (!files.length) return texts;
  const run = spawnSync("git", ["-C", root, "cat-file", "--batch"], { input: Buffer.from(files.map(file => `HEAD:${file}\n`).join(""), "utf8"), maxBuffer: 1024 * 1024 * 1024 });
  if (run.error || run.status !== 0) return texts;
  const out = run.stdout;
  let at = 0;
  for (const file of files) {
    const end = out.indexOf(10, at);
    if (end < 0) break;
    const found = /^\S+ \S+ (\d+)$/.exec(out.toString("utf8", at, end));
    at = end + 1;
    if (!found) continue;
    const size = Number(found[1]);
    texts.set(file, out.toString("utf8", at, at + size));
    at += size + 1;
  }
  return texts;
}

// The tiddler of a stored file's text, into tiddlers, or the reason into problems
function take(text, where, tiddlers, problems) {
  let stored;
  try {
    stored = JSON.parse(text);
  } catch (e) {
    problems.push(`${where}: not JSON (${e.message})`);
    return null;
  }
  const fileProblems = [];
  const fields = importable(stored, fileProblems);
  problems.push(...fileProblems.map(p => `${where}: ${p}`));
  if (fields) tiddlers.push(fields);
  return fields;
}

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
// one file; sorted by title. problems: what was left out, and why. notes.fromCommit: the titles the
// disk lacked, read from the commit (a git clone only; a download, or a machine without git, is
// taken as it is). Compared by title, not by path: on a case-insensitive disk the twin that
// collided has a path, the other's, with the last one's content in it. A file that isn't a tiddler
// (not JSON, no title) is reported once, not read from the commit again.
export function collect(target, problems = [], notes = {}) {
  const isDir = fs.statSync(target).isDirectory();
  const dir = isDir && fs.existsSync(path.join(target, "tiddlers")) ? path.join(target, "tiddlers") : target;
  const root = isDir && path.basename(dir) === "tiddlers" ? path.dirname(dir) : null;   // the clone, if this is its tiddlers/
  const tiddlers = [], read = new Set(), bad = new Set();
  for (const file of jsonFiles(dir)) {
    const fields = take(fs.readFileSync(file, "utf8"), file, tiddlers, problems);
    if (fields) read.add(fields.title);
    else bad.add(path.relative(root || path.dirname(dir), file).split(path.sep).join("/"));
  }
  notes.fromCommit = [];
  const committed = root ? committedFiles(root) : null;
  if (committed) {
    const lacking = committed.filter(file => !read.has(titleOf(file)) && !bad.has(file));
    const texts = readCommitted(root, lacking);
    for (const file of lacking) {
      if (!texts.has(file)) {
        problems.push(`${file}: in the commit, but git couldn't read it`);
        continue;
      }
      const fields = take(texts.get(file), `${file} (in the commit, not on the disk)`, tiddlers, problems);
      if (fields) notes.fromCommit.push(fields.title);
    }
    notes.fromCommit.sort();
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
  if (!fs.existsSync(target)) {
    console.error(`${target}: no such file or folder.`);
    process.exit(1);
  }
  const notice = platformNotice();
  if (notice) console.error(notice);
  const problems = [], notes = {};
  const tiddlers = collect(target, problems, notes);
  for (const problem of problems) console.error("Left out: " + problem);
  for (const title of notes.fromCommit) console.error(`Read from the commit, not from the disk: ${title}`);
  // (Nothing to restore is a wrong path, or a clone with nothing checked out, never a wiki)
  if (!tiddlers.length) {
    console.error(fs.statSync(target).isDirectory() ? `No tiddler file under ${target}: is this the backup's clone, or its tiddlers/ folder? (setup 2.4)` : `${target} isn't a tiddler file (setup 2.4).`);
    process.exit(1);
  }
  fs.writeFileSync(out, JSON.stringify(tiddlers, null, 1));
  const fromCommit = notes.fromCommit.length ? `, ${notes.fromCommit.length} read from the commit (the disk lacked them: limits 5)` : "";
  console.log(`${out}: ${tiddlers.length} tiddlers${fromCommit}, ready to drag onto the admin wiki (setup 2.4)`);
}
