// Updates a copy of tiddlywiki-cloudflare from this repository (operating 3.1): the copy the Deploy to
// Cloudflare button makes, or a fork. Run in a clone of your copy, on your machine, with git and
// Node 22: node tools/update.mjs, then git push, and Workers Builds redeploys.
//
// The button's copy is an import, not a fork: one commit by Cloudflare's bot with the files of one of
// this repository's commits, without the CI workflow, and the project's names written into
// wrangler.toml (the worker, the bucket, the queue twice) and package.json (the name). It shares no
// history with this repository, so a plain git pull refuses to merge. The first update finds the
// commit the import was taken from (the same files but those three places), grafts the import onto
// it for the time of the merge (git replace, undone after) and merges this repository's main as an
// ordinary three-way merge: the copy's names stay by themselves, and so does anything else the copy
// changed. Three conflicts are resolved here, their right answer being known: a workflow this
// repository changed, which the copy never had, stays out; wrangler.toml or package.json, when the
// copy's only change to it is the import's names (a release bumps the version next to the name), is
// this repository's file with the copy's names put back. Anything else is left as git leaves it, for
// the user. Later updates are ordinary merges, the histories joined; a fork's too. Nothing is pushed:
// the deploy is the user's push. Design 2.30; test/update-copy.test.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const UPSTREAM = "https://github.com/DesignThinkerer/tiddlywiki-cloudflare";
const BRANCH = "main";
const WORKFLOWS = ".github/workflows";
// The lines the import rewrites: the key, then the value between the quotes
const IDENTITY = {
  "wrangler.toml": /^(name|bucket_name|queue) = "([^"]*)"/,
  "package.json": /^(\s*"name"): "([^"]*)"/
};
const USAGE = `Usage: node tools/update.mjs [--from <repository>]

Updates this copy of tiddlywiki-cloudflare from ${UPSTREAM} (operating 3.1): fetches it, merges
its ${BRANCH} into the current branch, keeps this copy's names in wrangler.toml and package.json and
the CI workflow out if the copy never had it, and says what came in. Nothing is pushed: git push
afterwards, and Workers Builds redeploys.

  --from <repository>   fetch from there instead (a URL or a path)`;

let from = UPSTREAM;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help" || args[i] === "-h") { console.log(USAGE); process.exit(0); }
  else if (args[i] === "--from" && args[i + 1]) from = args[++i];
  else if (args[i].startsWith("--from=")) from = args[i].slice("--from=".length);
  else fail(`Unknown argument ${JSON.stringify(args[i])}.\n${USAGE}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// git in the copy: { status, out (trimmed), raw }; a failing command throws with git's words, unless allowed
let top = null;
function git(cmd, { allow = false } = {}) {
  const r = spawnSync("git", cmd, { cwd: top || process.cwd(), encoding: "utf8" });
  if (r.error) fail(`git couldn't be run (${r.error.message}): install git first.`);
  if (r.status !== 0 && !allow) throw new Error(`git ${cmd.join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  return { status: r.status, out: (r.stdout || "").trim(), raw: r.stdout || "" };
}
const valuesOf = (text, re) => text.split("\n").filter(l => re.test(l)).map(l => { const m = re.exec(l); return { key: m[1].trim(), value: m[2] }; });
// This repository's file, with the copy's values on the lines the import rewrites (by key, in order)
function withIdentity(text, values, re) {
  const left = values.map(v => ({ ...v }));
  return text.split("\n").map(line => {
    const m = re.exec(line);
    if (!m) return line;
    const at = left.findIndex(v => v.key === m[1].trim());
    if (at < 0) return line;
    const [{ value }] = left.splice(at, 1);
    return m[0].replace(`"${m[2]}"`, `"${value}"`) + line.slice(m[0].length);
  }).join("\n");
}

// --- Where we are --------------------------------------------------------------------------------
const topLevel = git(["rev-parse", "--show-toplevel"], { allow: true });
if (topLevel.status !== 0) fail(`Not in a git repository (${process.cwd()}): run this in a clone of your copy of tiddlywiki-cloudflare.`);
top = topLevel.out;
const gitDir = path.resolve(top, git(["rev-parse", "--git-dir"]).out);
if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) fail("A merge is in progress: finish it (git commit) or undo it (git merge --abort), then run this again. Nothing changed.");
if (git(["status", "--porcelain"]).out !== "") fail("The working tree has changes (git status). Commit or stash them, then run this again. Nothing changed.");

// --- Fetch this repository, as a remote of the copy ----------------------------------------------
const sameRepo = (a, b) => a.replace(/\.git$/, "").replace(/\/+$/, "") === b.replace(/\.git$/, "").replace(/\/+$/, "");
const remotes = git(["remote"]).out.split("\n").filter(Boolean);
let remote = remotes.find(name => sameRepo(git(["remote", "get-url", name]).out, from));
if (!remote) {
  remote = ["upstream", "tiddlywiki-cloudflare"].find(name => !remotes.includes(name));
  if (!remote) fail(`The remotes upstream and tiddlywiki-cloudflare both exist and neither is ${from}: add a remote for it and run this again. Nothing changed.`);
  git(["remote", "add", remote, from]);
}
const fetched = git(["fetch", "--quiet", remote, BRANCH], { allow: true });
if (fetched.status !== 0) fail(`Couldn't fetch ${from} (${BRANCH}): ${fetched.out || "no answer"}. Nothing changed.`);
const upstream = git(["rev-parse", "FETCH_HEAD"]).out;
const head = git(["rev-parse", "HEAD"]).out;
if (git(["merge-base", "--is-ancestor", upstream, "HEAD"], { allow: true }).status === 0) {
  console.log(`Already up to date with tiddlywiki-cloudflare (${upstream.slice(0, 7)}): nothing to update.`);
  process.exit(0);
}

// --- The first update of an import: no history in common, the import's source found and grafted --
const related = git(["merge-base", "HEAD", upstream], { allow: true }).status === 0;
let graft = null;
if (!related) {
  const roots = git(["rev-list", "--max-parents=0", "HEAD"]).out.split("\n").filter(Boolean);
  const candidates = git(["rev-list", "--first-parent", upstream]).out.split("\n").filter(Boolean);
  const snapshot = (commit, root) => git(["diff", "--quiet", commit, root, "--", ".", ":(exclude)wrangler.toml", ":(exclude)package.json", `:(exclude)${WORKFLOWS}`], { allow: true }).status === 0;
  let source = null;
  for (const root of roots) {
    source = candidates.find(c => snapshot(c, root));
    if (source) { graft = root; break; }
  }
  if (!source) {
    fail(`This copy has no history in common with tiddlywiki-cloudflare, and its first commit (${roots.map(r => r.slice(0, 7)).join(", ")}) matches none of that repository's commits once wrangler.toml, package.json and ${WORKFLOWS} are set aside, so I can't find where the import was taken from. Nothing changed.\nBy hand: git merge --allow-unrelated-histories ${upstream.slice(0, 7)}, then put this copy's names back in wrangler.toml and package.json before pushing.`);
  }
  git(["replace", "--graft", graft, source]);
}

// --- What the copy has that this repository hasn't: its names, no workflows ----------------------
const identity = {};
for (const file of Object.keys(IDENTITY)) {
  if (fs.existsSync(path.join(top, file))) identity[file] = valuesOf(fs.readFileSync(path.join(top, file), "utf8"), IDENTITY[file]);
}
const hadWorkflows = git(["ls-tree", "--name-only", "HEAD", `${WORKFLOWS}/`], { allow: true }).out !== "";
const base = git(["merge-base", "HEAD", upstream]).out;
const onlyIdentity = file => {
  const changed = git(["diff", base, head, "--", file]).out.split("\n").filter(l => /^[-+]/.test(l) && !/^(\+\+\+|---)/.test(l));
  return changed.length > 0 && changed.every(l => IDENTITY[file].test(l.slice(1)));
};

// --- The merge, the three conflicts whose answer is known resolved here ---------------------------
const notes = [];
try {
  git(["merge", "--no-ff", "--no-commit", "--quiet", "-m", `Update from tiddlywiki-cloudflare ${upstream.slice(0, 7)}`, upstream], { allow: true });
} finally {
  if (graft) git(["replace", "-d", graft]);   // the graft gave the merge its base; the merge commit joins the histories itself
}
const unmerged = () => git(["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
for (const file of unmerged()) {
  if (file.startsWith(`${WORKFLOWS}/`) && !hadWorkflows) {
    git(["rm", "--quiet", "--", file]);
    notes.push(`${file}: this repository changed it; kept out, as the import left it.`);
  } else if (IDENTITY[file] && identity[file] && onlyIdentity(file)) {
    fs.writeFileSync(path.join(top, file), withIdentity(git(["show", `${upstream}:${file}`]).raw, identity[file], IDENTITY[file]));
    git(["add", "--", file]);
    notes.push(`${file}: this repository's file, with this copy's names put back.`);
  }
}
const left = unmerged();
if (left.length) {
  fail(`${notes.length ? notes.join("\n") + "\n" : ""}The merge stopped on conflicts this script doesn't resolve:\n  ${left.join("\n  ")}\nResolve them (edit, then git add), then git commit; or undo everything with git merge --abort.`);
}
if (!hadWorkflows) {
  const brought = git(["ls-files", "--", WORKFLOWS]).out.split("\n").filter(Boolean);
  if (brought.length) {
    git(["rm", "-r", "--quiet", "--", WORKFLOWS]);
    notes.push(`${brought.join(", ")}: kept out, as the import left the workflows out.`);
  }
  const theirs = git(["ls-tree", "-r", "--name-only", upstream, `${WORKFLOWS}/`], { allow: true }).out.split("\n").filter(Boolean);
  if (theirs.length && !notes.some(n => n.startsWith(WORKFLOWS))) notes.push(`${theirs.join(", ")}: still out, as the import left the workflows out.`);
}
git(["commit", "--quiet", "--no-edit"]);

// --- What came in --------------------------------------------------------------------------------
const commits = Number(git(["rev-list", "--count", `${head}..${upstream}`]).out);
console.log(`Updated from tiddlywiki-cloudflare (${upstream.slice(0, 7)}): ${commits} commit${commits === 1 ? "" : "s"} merged, ${git(["diff", "--shortstat", head, "HEAD"]).out || "no file changed"}.`);
const kept = Object.keys(identity).flatMap(file => {
  const theirs = valuesOf(git(["show", `${upstream}:${file}`]).raw, IDENTITY[file]);
  return identity[file].filter((v, i) => !theirs[i] || theirs[i].value !== v.value).map(v => `${file} ${v.key.replace(/"/g, "")} ${v.value}`);
});
if (kept.length) console.log(`Kept this copy's names: ${kept.join("; ")}.`);
for (const note of notes) console.log(note);
console.log(git(["remote", "get-url", "origin"], { allow: true }).status === 0 ? "Push to deploy: git push (Workers Builds redeploys from the push)." : "Push to deploy.");
