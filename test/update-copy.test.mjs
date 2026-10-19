// The update of a copy of this repository by tools/update.mjs (operating 3.1): a copy the Deploy to
// Cloudflare button made (one commit by Cloudflare's bot, the files of one of this repository's
// commits without the CI workflow, the project's names written into wrangler.toml and package.json),
// or a fork. Two temporary git repositories, an upstream standing for this one and the copy, with
// the real wrangler.toml, package.json and CI workflow as fixtures; nothing on the network, no worker,
// no browser. Run: npm run test:update-copy
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "tools/update.mjs");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// git with none of this machine's configuration (no signing, no pull.rebase), one identity, dates in order
const WORK = fs.mkdtempSync(path.join(tmpdir(), "update-copy-"));
fs.writeFileSync(path.join(WORK, "gitconfig"), "[init]\n\tdefaultBranch = main\n[user]\n\tname = Test\n\temail = test@example.com\n");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: path.join(WORK, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
let clock = Date.parse("2026-10-19T06:00:00Z");
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(cwd, files) {
  for (const [p, content] of Object.entries(files)) {
    const f = path.join(cwd, p);
    if (content === null) fs.rmSync(f, { force: true });
    else { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
  }
}
function commit(cwd, message, files = {}, author) {
  write(cwd, files);
  git(cwd, "add", "-A");
  const date = new Date(clock += 3600000).toISOString();
  execFileSync("git", ["commit", "-q", "-m", message, ...(author ? ["--author", author] : [])], { cwd, env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "ignore" });
  return git(cwd, "rev-parse", "HEAD");
}
const read = (cwd, p) => fs.readFileSync(path.join(cwd, p), "utf8");
const exists = (cwd, p) => fs.existsSync(path.join(cwd, p));
const edit = (text, from, to) => { if (!text.includes(from)) throw new Error(`fixture: ${JSON.stringify(from)} not found`); return text.replace(from, to); };
const isMerge = (cwd, ref = "HEAD") => git(cwd, "rev-list", "--parents", "-n", "1", ref).split(" ").length === 3;
const replacements = cwd => git(cwd, "replace", "-l");
const safe = fn => { try { return fn(); } catch { return ""; } };
function update(cwd, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, ...extra], { cwd, env: ENV, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// --- The upstream: this repository, in small -----------------------------------------------------
const UP = path.join(WORK, "upstream");
fs.mkdirSync(UP);
git(UP, "init", "-q");
const realToml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const realPkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
const realCi = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
commit(UP, "initial", {
  "wrangler.toml": realToml, "package.json": realPkg, ".github/workflows/ci.yml": realCi,
  "README.md": "# TiddlyWiki on Cloudflare\n\nIntro.\n", "src/worker/index.js": "export default 1;\n", "worker.js": "// bundle v1\n", "docs/operating.md": "## 3.1 Updating your copy\n\nv1\n"
});
const X = commit(UP, "docs: a line", { "README.md": "# TiddlyWiki on Cloudflare\n\nIntro, revised.\n" });   // what the import is taken from

// --- The copy, as the button's import makes it: one commit, X's files but the workflow, the names ---
const names = toml => edit(edit(toml, 'name = "wiki-admin"', 'name = "wiki-test"'), 'bucket_name = "wiki"', 'bucket_name = "wiki-test"').split('queue = "wiki-backup"').join('queue = "wiki-test-backup"');
if ((realToml.match(/^queue = "wiki-backup"/gm) || []).length !== 2) throw new Error("fixture: wrangler.toml should name the queue twice");
function importOf(dir, extra = {}) {
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  const files = {};
  for (const p of git(UP, "ls-tree", "-r", "--name-only", X).split("\n")) {
    if (p.startsWith(".github/workflows/")) continue;
    files[p] = git(UP, "show", `${X}:${p}`) + "\n";
  }
  files["wrangler.toml"] = names(files["wrangler.toml"]);
  files["package.json"] = edit(files["package.json"], '"name": "tiddlywiki-cloudflare"', '"name": "wiki-test"');
  return commit(dir, "source repo import", { ...files, ...extra }, "cloudflare[bot] <cloudflare[bot]@users.noreply.github.com>");
}
const COPY = path.join(WORK, "copy");
const importCommit = importOf(COPY);
const BARE = path.join(WORK, "origin.git");
git(WORK, "init", "-q", "--bare", BARE);
git(COPY, "remote", "add", "origin", BARE);
git(COPY, "push", "-q", "origin", "main");
commit(COPY, "my own note in the copy", { "README.md": read(COPY, "README.md") + "\nMy own note.\n" });

// --- Upstream moves on: code, the bundle, a manual page, a wrangler.toml comment away from the names, the README's first line
const U3 = commit(UP, "feat: something", {
  "src/worker/index.js": "export default 2;\n", "worker.js": "// bundle v2\n", "docs/operating.md": "## 3.1 Updating your copy\n\nv2\n",
  "wrangler.toml": edit(realToml, "behind Access (setup 2.6)", "behind Access (setup 2.6), say"),
  "README.md": "# TiddlyWiki on Cloudflare (v3)\n\nIntro, revised.\n"
});

// --- 1. The first update of the button's copy ---------------------------------------------------
let r = update(COPY, "--from", UP);
check("the first update of a button's copy (one import commit, no history in common): the script finds the commit the import was taken from and brings upstream's changes since, in one merge commit, exit 0",
  r.code === 0 && isMerge(COPY) && git(COPY, "merge-base", "HEAD", U3) === U3 && read(COPY, "src/worker/index.js") === "export default 2;\n" && read(COPY, "worker.js") === "// bundle v2\n" && /v2/.test(read(COPY, "docs/operating.md")),
  `exit ${r.code}: ${r.out.slice(0, 300).replace(/\n/g, "⏎")}`);
const toml1 = read(COPY, "wrangler.toml");
check("...the copy's names stay: wrangler.toml's worker, bucket and two queue lines, package.json's name; upstream's comment change in wrangler.toml is in",
  /^name = "wiki-test"/m.test(toml1) && /^bucket_name = "wiki-test"/m.test(toml1) && (toml1.match(/^queue = "wiki-test-backup"/gm) || []).length === 2 && toml1.includes("(setup 2.6), say") &&
  read(COPY, "package.json") === edit(git(UP, "show", `${U3}:package.json`) + "\n", '"name": "tiddlywiki-cloudflare"', '"name": "wiki-test"'),
  toml1.split("\n").filter(l => /^(name|bucket_name|queue) = /.test(l)).map(l => l.split("#")[0].trim()).join("; ") + "; " + (read(COPY, "package.json").match(/"name": "[^"]*"/) || [""])[0]);
check("...the copy's own commit survives (its README note), with upstream's change to the README's first line",
  read(COPY, "README.md").startsWith("# TiddlyWiki on Cloudflare (v3)\n") && read(COPY, "README.md").endsWith("\nMy own note.\n"), JSON.stringify(read(COPY, "README.md")));
check("...the CI workflow the import left out stays out, and the script says so", !exists(COPY, ".github/workflows/ci.yml") && /ci\.yml/.test(r.out), r.out.slice(0, 300).replace(/\n/g, "⏎"));
check("...nothing is pushed (origin's main unchanged), the script says to push, and names what it kept",
  git(WORK, "-C", BARE, "rev-parse", "main") === importCommit && /git push/.test(r.out) && /wiki-test-backup/.test(r.out), r.out.slice(0, 400).replace(/\n/g, "⏎"));
check("...the replacement ref the merge used is gone, upstream is a remote of the copy, the merge commit names the source",
  replacements(COPY) === "" && safe(() => git(COPY, "remote", "get-url", "upstream")) === UP && /tiddlywiki-cloudflare/.test(git(COPY, "log", "-1", "--format=%s")), `replace: "${replacements(COPY)}"; subject: ${git(COPY, "log", "-1", "--format=%s")}`);

// --- 2. The next updates: a plain merge each --------------------------------------------------
const U4 = commit(UP, "feat: more", { "src/worker/index.js": "export default 3;\n", "wrangler.toml": edit(read(UP, "wrangler.toml"), "a preview would use the real bucket and queue", "a preview would use the real bucket and queue, ever") });
r = update(path.join(COPY, "docs"), "--from", UP);   // from a subdirectory of the copy
const toml2 = read(COPY, "wrangler.toml");
check("a second update, run from a subdirectory of the copy: a plain merge, no replacement ref, the change in, the names kept, the new comment taken",
  r.code === 0 && isMerge(COPY) && git(COPY, "merge-base", "HEAD", U4) === U4 && read(COPY, "src/worker/index.js") === "export default 3;\n" && replacements(COPY) === "" &&
  /^name = "wiki-test"/m.test(toml2) && (toml2.match(/^queue = "wiki-test-backup"/gm) || []).length === 2 && toml2.includes("bucket and queue, ever"),
  `exit ${r.code}: ${r.out.slice(0, 300).replace(/\n/g, "⏎")}`);
const version = JSON.parse(realPkg).version;
const U5 = commit(UP, "release", { "package.json": edit(read(UP, "package.json"), `"version": "${version}"`, '"version": "2099.1.1"') });
r = update(COPY, "--from", UP);
check("a release upstream (the version line next to the name line the import changed): the conflict resolved by the script, upstream's package.json with the copy's name",
  r.code === 0 && read(COPY, "package.json") === edit(git(UP, "show", `${U5}:package.json`) + "\n", '"name": "tiddlywiki-cloudflare"', '"name": "wiki-test"') && git(COPY, "status", "--porcelain") === "",
  `exit ${r.code}: ${(read(COPY, "package.json").match(/"(name|version)": "[^"]*"/g) || []).join(", ")}; ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);
const U6 = commit(UP, "ci and a name line's comment", { ".github/workflows/ci.yml": "# touched\n" + realCi, "wrangler.toml": edit(read(UP, "wrangler.toml"), "the bucket you created (setup 2.2)", "the bucket you created (setup 2.2), yours") });
r = update(COPY, "--from", UP);
const toml3 = read(COPY, "wrangler.toml");
check("upstream edits the CI workflow and the comment on the bucket line: the workflow kept out (its modify/delete conflict resolved), the bucket line upstream's with the copy's name, exit 0",
  r.code === 0 && !exists(COPY, ".github/workflows/ci.yml") && /^bucket_name = "wiki-test" .*\(setup 2\.2\), yours/m.test(toml3) && /^name = "wiki-test"/m.test(toml3) && git(COPY, "status", "--porcelain") === "" && git(COPY, "merge-base", "HEAD", U6) === U6,
  `exit ${r.code}: ${(toml3.match(/^bucket_name = .*/m) || [""])[0].slice(0, 90)}; ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);
const before = git(COPY, "rev-parse", "HEAD");
r = update(COPY, "--from", UP);
check("nothing to update: said, no commit, exit 0", r.code === 0 && git(COPY, "rev-parse", "HEAD") === before && /nothing to update|up to date/i.test(r.out), `exit ${r.code}: ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);

// --- 3. Refusals ---------------------------------------------------------------------------------
commit(UP, "feat: again", { "src/worker/index.js": "export default 7;\n" });
write(COPY, { "README.md": read(COPY, "README.md") + "uncommitted\n" });
r = update(COPY, "--from", UP);
check("a working tree with changes: refused, saying to commit or stash, nothing touched (the change still there, no merge, no fetch needed)",
  r.code !== 0 && /commit or stash/i.test(r.out) && git(COPY, "rev-parse", "HEAD") === before && read(COPY, "README.md").endsWith("uncommitted\n") && !exists(COPY, ".git/MERGE_HEAD"),
  `exit ${r.code}: ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);
git(COPY, "checkout", "--", "README.md");
commit(COPY, "my own change to the worker", { "src/worker/index.js": "export default 100; // mine\n" });
r = update(COPY, "--from", UP);
check("a real conflict (the copy and upstream changed the same line of a source file): the script stops, names the file, says how to finish or undo the merge, exit 1; the merge left in progress for the user",
  r.code !== 0 && /src\/worker\/index\.js/.test(r.out) && /git merge --abort/.test(r.out) && /^UU src\/worker\/index\.js/m.test(git(COPY, "status", "--porcelain")) && replacements(COPY) === "",
  `exit ${r.code}: ${r.out.slice(0, 300).replace(/\n/g, "⏎")}`);
git(COPY, "merge", "--abort");
const COPY2 = path.join(WORK, "copy2");
importOf(COPY2, { "README.md": "# TiddlyWiki on Cloudflare\n\nIntro, revised, and more.\n" });   // not a snapshot of any upstream commit
const head2 = git(COPY2, "rev-parse", "HEAD");
r = update(COPY2, "--from", UP);
check("a copy whose first commit matches no upstream commit (not a snapshot the script can place): refused, saying so, nothing changed",
  r.code !== 0 && /find|match/i.test(r.out) && /nothing changed/i.test(r.out) && git(COPY2, "rev-parse", "HEAD") === head2 && !exists(COPY2, ".git/MERGE_HEAD") && replacements(COPY2) === "",
  `exit ${r.code}: ${r.out.slice(0, 300).replace(/\n/g, "⏎")}`);
const NOWHERE = path.join(WORK, "nowhere");
fs.mkdirSync(NOWHERE);
r = update(NOWHERE, "--from", UP);
check("outside a git repository: refused, saying so", r.code !== 0 && /git repository/i.test(r.out), `exit ${r.code}: ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);
r = update(COPY, "--help");
check("--help prints the usage, with --from, and exits 0", r.code === 0 && /--from/.test(r.out) && /tiddlywiki-cloudflare/.test(r.out), r.out.slice(0, 200).replace(/\n/g, "⏎"));

// --- 4. A fork: shared history, nothing renamed, the workflow its own -----------------------------
const FORK = path.join(WORK, "fork");
git(WORK, "clone", "-q", UP, FORK);
git(FORK, "reset", "-q", "--hard", U4);
r = update(FORK, "--from", UP);
const tip = git(UP, "rev-parse", "HEAD");
check("a fork (shared history): a plain merge to upstream's tip, its files upstream's as they are (names untouched, the CI workflow kept, since the fork has it), exit 0",
  r.code === 0 && git(FORK, "diff", "--quiet", "HEAD", tip) === "" && read(FORK, "wrangler.toml") === git(UP, "show", `${tip}:wrangler.toml`) + "\n" && exists(FORK, ".github/workflows/ci.yml") && git(FORK, "merge-base", "HEAD", tip) === tip,
  `exit ${r.code}: ${r.out.slice(0, 200).replace(/\n/g, "⏎")}`);

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
