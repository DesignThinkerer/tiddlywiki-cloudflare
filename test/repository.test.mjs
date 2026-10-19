// The repository's guards: local secrets and Wrangler's files kept out of git, wrangler.toml deployable
// without an edit, what a deploy uploads, the test scripts through the runner, the Miniflare
// dependencies pinned above what it declares, the docs' links and chapter references, the restore
// tool, and the build refusing what it can't inline. Nothing here runs the worker.
// Run: npm run test:repository
import fs, { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// --- 6. Local secrets and Wrangler's files stay out of git ---------------------------------------
// wrangler.toml is part of the repository (the worker's names and settings, no secret in it: those are
// set as secrets); Wrangler's local files aren't
const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map(l => l.trim());
const missing = [".dev.vars", ".wrangler/", "restore.json", "wiki/"].filter(p => !ignored.includes(p));
check(".gitignore covers .dev.vars and .wrangler/, restore.json and wiki/ (what a restore leaves, setup 2.4), and not wrangler.toml", missing.length === 0 && !ignored.includes("wrangler.toml") && fs.existsSync(path.join(ROOT, "wrangler.toml")),
  missing.length ? "missing: " + missing.join(", ") : ignored.includes("wrangler.toml") ? "wrangler.toml is ignored" : fs.existsSync(path.join(ROOT, "wrangler.toml")) ? "" : "no wrangler.toml");
const toml = fs.existsSync(path.join(ROOT, "wrangler.toml")) ? fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8") : "";
const tomlActive = toml.split(/\r?\n/).filter(l => !l.trim().startsWith("#")).join("\n");   // (what Wrangler reads: comments aside)
check("wrangler.toml holds no secret, and every binding the worker needs",
  !/GITHUB_TOKEN\s*=|CF_API_TOKEN\s*=/.test(tomlActive) && ["WIKI_BUCKET", "BACKUP_QUEUE", "max_retries = 3", "max_concurrency = 1", "preview_urls = false"].every(k => tomlActive.includes(k)));
// Dependabot: the engine stays the hand bump's, and what Dependabot proposes has been out for a few
// days (cooldown). A compromised release is usually pulled within days, and Workers Builds installs
// the dev dependencies with the credentials that deploy the worker; a security update isn't delayed.
const dependabot = fs.readFileSync(path.join(ROOT, ".github/dependabot.yml"), "utf8");
// (The semver-*-days keys exist for npm only: Dependabot refuses the file with one of them under
// github-actions, whose versions are tags, and says so only in the repository's Insights, after the merge.)
const ecosystems = dependabot.split(/^ {2}- package-ecosystem: /m).slice(1)
  .map(block => ({ name: block.split(/\s/)[0], cooldown: /^[ \t]+cooldown:/m.test(block), days: Number((/^[ \t]+default-days:[ \t]*(\d+)/m.exec(block) || [])[1] || 0), semver: /^[ \t]+semver-\w+-days:/m.test(block) }));
check("dependabot.yml leaves the engine to the hand bump (operating 3.3) and puts a cooldown of three days at least on every ecosystem it updates, the Actions' as one number of days",
  /dependency-name: tiddlywiki/.test(dependabot) && ecosystems.length >= 2 && ecosystems.every(e => e.cooldown && e.days >= 3 && (e.name !== "github-actions" || !e.semver)),
  ecosystems.map(e => `${e.name}: ${e.cooldown ? e.days + " days" + (e.semver ? ", semver days" : "") : "no cooldown"}`).join(", ") || "no ecosystem found");
// The empty wiki travels with the worker as a text module, never as a static asset: Workers with
// static assets run behind a router that doesn't pass ctx.access on, which the Access check needs
// What Wrangler would upload, from the file as it is (a dry run, no account needed): worker.js and
// the empty wiki, nothing else of the repository (the default rules would sweep up node_modules)
let attached = null, dryRun;
try {
  dryRun = execFileSync(process.execPath, [path.join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", mkdtempSync(path.join(tmpdir(), "wrangler-dry-"))],
    { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  attached = [...dryRun.matchAll(/^│ (\S+)\s+│ (\S+)\s+│ [\d.]+ KiB\s+│$/gm)].map(m => `${m[1]} (${m[2]})`).filter(row => !row.startsWith("Total"));
} catch (e) {
  dryRun = String(e.stdout || "") + String(e.stderr || e.message);
}
check("a deploy uploads worker.js with the empty wiki as a text module, and nothing else (Wrangler's dry run)",
  Array.isArray(attached) && attached.length === 1 && attached[0] === "seed/empty.html (text)",
  attached ? attached.join(", ") || "no module attached" : dryRun.slice(-300));
check("wrangler.toml ships the empty wiki as a text module (a rule for seed/), and has no static assets",
  tomlActive.includes("find_additional_modules = true") &&
  /\[\[rules\]\]\s*type\s*=\s*"Text"\s*globs\s*=\s*\[\s*"seed\/[^"]*"\s*\]\s*fallthrough\s*=\s*false/.test(tomlActive) &&
  !/\[assets\]|ASSETS|run_worker_first|directory\s*=/.test(tomlActive));
// Deployed as it is: the settings live in the dashboard (keep_vars), the admin site is the worker's
// workers.dev address unless a custom domain is added, and nothing in the file is a value to replace
check("wrangler.toml needs no edit: settings kept in the dashboard, the admin site on workers.dev, nothing to fill in",
  tomlActive.includes("keep_vars = true") && tomlActive.includes("workers_dev = true") &&
  !/PUBLIC_WIKI_URL\s*=|CF_ZONE_ID\s*=|GITHUB_REPO\s*=|GITHUB_BRANCH\s*=|example\.com|YOUR-|OWNER\/REPO|^\s*routes?\s*=/m.test(tomlActive),
  (tomlActive.match(/.*(PUBLIC_WIKI_URL\s*=|CF_ZONE_ID\s*=|GITHUB_REPO\s*=|example\.com|YOUR-|OWNER\/REPO|^\s*routes?\s*=).*/mg) || []).join(" | "));
// The test scripts all go through the runner, and test:suite ends with it, so the suites named
// after it (npm run test:suite -- page-publish two-tabs) are the ones run, after a build
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {};
check("package.json: test, test:fast, test:browser and test:suite build, then run suites through tools/run-suites.mjs; test:suite takes the names after it",
  ["test", "test:fast", "test:browser", "test:suite"].every(s => /^npm run build && node tools\/run-suites\.mjs/.test(scripts[s] || "")) && /node tools\/run-suites\.mjs$/.test(scripts["test:suite"] || ""),
  JSON.stringify({ "test:suite": scripts["test:suite"] }));

// Dependencies of Miniflare pinned above what it declares ("overrides" in package.json, development 6.2):
// each pin has to be the copy Miniflare resolves, and has to still be needed — the day Miniflare's
// own declaration reaches the pinned version, the override is a leftover that would hold the
// package back from then on, so this says to drop it. (Which versions, and why: the changelog.)
const resolveFrom = (dir, name) => {   // Node's lookup for a bare name from dir: its own node_modules, then each parent's
  for (let d = dir; ; d = path.dirname(d)) {
    const candidate = path.join(d, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")).version;
    if (d === path.dirname(d) || d === path.dirname(ROOT)) return null;
  }
};
const numbers = v => String(v).replace(/^[^\d]*/, "").split(/[.+-]/).map(Number);   // "^7.29.1" → [7, 29, 1]
const below = (a, b) => { const x = numbers(a), y = numbers(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
const miniflareDir = path.join(ROOT, "node_modules", "miniflare");
const miniflareDeclares = JSON.parse(fs.readFileSync(path.join(miniflareDir, "package.json"), "utf8")).dependencies || {};
const pins = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).overrides || {}).miniflare || {};
for (const [name, pin] of Object.entries(pins)) {
  const resolved = resolveFrom(miniflareDir, name);
  check(`${name} is pinned to ${pin} for Miniflare (package.json overrides), and that is the copy Miniflare gets`, resolved === pin, `Miniflare gets ${resolved}`);
  check(`...and the pin is still needed: Miniflare declares less (drop the override from package.json when its declaration reaches ${pin})`,
    !!miniflareDeclares[name] && below(miniflareDeclares[name], pin), `Miniflare declares ${miniflareDeclares[name]}`);
}

// The documentation holds together: every relative link in a markdown file names a file that exists
// and, with an anchor, a heading of that file (GitHub's slug: lower case, punctuation dropped, spaces to
// hyphens); and every reference by chapter number — "setup 2.6", "operating 3.4", "design 1.7", in the
// docs, the code and the tests alike — names a heading of the page the chapter lives in. The chapters
// are numbered across the pages (readme 1, then docs/setup.md 2, operating 3, troubleshooting 4, limits
// 5, development 6, reference 7), so a number means the same thing wherever it's cited.
const DOC_PAGES = { readme: "README.md", setup: "docs/setup.md", operating: "docs/operating.md", troubleshooting: "docs/troubleshooting.md", limits: "docs/limits.md", development: "docs/development.md", reference: "docs/reference.md", design: "docs/design.md" };
const markdownFiles = [
  ...fs.readdirSync(ROOT).filter(f => f.endsWith(".md")),
  ...fs.readdirSync(path.join(ROOT, "docs")).filter(f => f.endsWith(".md")).map(f => "docs/" + f),
  ".github/PULL_REQUEST_TEMPLATE.md",
].filter(f => fs.existsSync(path.join(ROOT, f)));
const slugOf = h => h.toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/ /g, "-");
const docHeadings = {};   // file -> { slugs: Set, numbers: Set }
for (const f of markdownFiles) {
  const seen = {}, slugs = new Set(), numbers = new Set();
  let inCode = false;
  for (const line of fs.readFileSync(path.join(ROOT, f), "utf8").split("\n")) {
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    const m = !inCode && /^#{1,6} (.+)$/.exec(line);
    if (!m) continue;
    let slug = slugOf(m[1]);
    if (seen[slug] !== undefined) { seen[slug]++; slug += "-" + seen[slug]; } else seen[slug] = 0;
    slugs.add(slug);
    const n = /^(\d+(?:\.\d+)?)\b/.exec(m[1]);
    if (n) numbers.add(n[1]);
  }
  docHeadings[f] = { slugs, numbers };
}
const brokenLinks = [];
for (const f of markdownFiles) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [file, hash] = target.split("#");
    const resolved = file ? path.normalize(path.join(path.dirname(f), file)) : f;
    if (file && !fs.existsSync(path.join(ROOT, resolved))) { brokenLinks.push(`${f}: ${target} (no such file)`); continue; }
    if (hash && docHeadings[resolved] && !docHeadings[resolved].slugs.has(hash)) brokenLinks.push(`${f}: ${target} (no such heading)`);
  }
}
check("the docs' relative links all name a file that exists and, with an anchor, one of its headings", brokenLinks.length === 0, brokenLinks.join(" | "));
const citedFrom = [...markdownFiles, ...["src", "test", "tools"].flatMap(dir => walkFiles(path.join(ROOT, dir)).map(f => path.relative(ROOT, f)))];
const brokenRefs = [];
let refs = 0;
for (const f of citedFrom) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of text.matchAll(/\b(README|setup(?: guide)?|operating|troubleshooting|limits|development|reference|design) (\d+(?:\.\d+)?)\b/g)) {
    refs++;
    const page = DOC_PAGES[m[1].toLowerCase().replace(" guide", "")];
    if (!docHeadings[page] || !docHeadings[page].numbers.has(m[2])) brokenRefs.push(`${f}: "${m[0]}"`);
  }
}
check(`every chapter reference ("setup 2.6", "design 1.7") in the docs, the code and the tests names a heading of its page (${refs} checked)`, refs > 100 && brokenRefs.length === 0, brokenRefs.slice(0, 12).join(" | "));

// The worker's and the modules' own links into the manual (src/worker/docs.js, src/browser/lib.js, the
// plugin's tabs): the same address in both; every heading in their maps the page's own, since the
// anchor a link carries is made from it; and every literal link into the docs, in any source file,
// a page and a heading that exist.
const DOCS_URL = "https://github.com/DesignThinkerer/tiddlywiki-cloudflare/blob/main/docs";
const guideSources = ["src/worker/docs.js", "src/browser/lib.js"].map(f => ({ f, text: fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), "utf8") : "" }));
check("the worker and the browser library name the same documentation address", guideSources.every(({ text }) => text.includes(`"${DOCS_URL}"`)), guideSources.map(({ f, text }) => `${f}: ${text.includes(DOCS_URL) ? "has it" : "doesn't"}`).join(", "));
const mapSlug = text => text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const badMapped = [];
let mapped = 0;
for (const { f, text } of guideSources) {
  for (const chapter of text.matchAll(/(setup|operating|limits): \{ page: "([a-z]+\.md)", headings: \{([^}]*)\} \}/g)) {
    const page = docHeadings["docs/" + chapter[2]];
    for (const entry of chapter[3].matchAll(/"([\d.]+)": "([^"]+)"/g)) {
      mapped++;
      if (!page || !page.numbers.has(entry[1]) || !page.slugs.has(mapSlug(`${entry[1]} ${entry[2]}`))) badMapped.push(`${f}: ${chapter[1]} ${entry[1]} "${entry[2]}"`);
    }
  }
}
check(`the headings the worker and the browser library map (${mapped}) are the pages' own, number and title`, mapped >= 10 && badMapped.length === 0, badMapped.join(" | "));
const badLiteral = [];
let literal = 0;
for (const f of walkFiles(path.join(ROOT, "src"))) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(new RegExp(DOCS_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "/([a-z-]+\\.md)(?:#([a-z0-9-]+))?", "g"))) {
    literal++;
    const page = docHeadings["docs/" + m[1]];
    if (!page || (m[2] && !page.slugs.has(m[2]))) badLiteral.push(`${path.relative(ROOT, f)}: ${m[0]}`);
  }
}
check(`every literal link into the docs in the sources (${literal}) names a page and a heading that exist`, literal >= 3 && badLiteral.length === 0, badLiteral.join(" | "));
function walkFiles(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : /\.(js|mjs|txt|md|yml)$/.test(e.name) ? [path.join(dir, e.name)] : []); }

// The runner (tools/run-suites.mjs): --parallel <n> runs that many suites at once; what isn't a
// suite is reported as such, every suite runs, and a failure makes the exit code 1. (Two names that
// aren't suites: nothing is run, which is the cheapest way to see the arguments read.)
const runner = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, "tools/run-suites.mjs"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
};
const parallelRun = runner("--parallel", "2", "no-such-suite-a", "no-such-suite-b");
const parallelSummary = parallelRun.out.split("=== Summary ===")[1] || "";
check("the runner takes --parallel <n> (not as a suite's name), runs every suite named, reports what isn't one, and exits 1",
  parallelRun.code === 1 && (parallelSummary.match(/no such suite/g) || []).length === 2 && !/--parallel|FAIL\s+2\b/.test(parallelSummary) && /2 of 2 suites failed/.test(parallelSummary),
  parallelSummary.trim().replace(/\s+/g, " ").slice(0, 200) || parallelRun.out.slice(-200));
const noParallel = runner("--parallel", "0", "cpu");
check("...and refuses a parallel count under 1", noParallel.code === 2 && /parallel/.test(noParallel.out), `exit ${noParallel.code}: ${noParallel.out.slice(0, 120)}`);
// --timeout <seconds>: a suite still running after that is stopped and counted as failed, so a
// suite that hangs doesn't run to the job's timeout (a temporary suite that doesn't end by itself)
const hangSuite = `hang-${process.pid}`;
fs.writeFileSync(path.join(ROOT, "test", `${hangSuite}.test.mjs`), "console.log('hanging');\nsetTimeout(() => {}, 20000);\n");
let timedOut;
try {
  timedOut = runner("--timeout", "1", hangSuite);
} finally {
  fs.rmSync(path.join(ROOT, "test", `${hangSuite}.test.mjs`), { force: true });
}
const timedOutSummary = timedOut.out.split("=== Summary ===")[1] || "";
check("--timeout <seconds>: a suite still running after that is stopped and fails, the summary saying it timed out",
  timedOut.code === 1 && /timed out/.test(timedOutSummary) && /1 of 1 suites failed/.test(timedOutSummary), timedOutSummary.trim().replace(/\s+/g, " ").slice(0, 200) || timedOut.out.slice(-200));
const noTimeout = runner("--timeout", "0", "no-such-suite");
check("...and refuses a timeout under a second", noTimeout.code === 2 && /timeout/.test(noTimeout.out), `exit ${noTimeout.code}: ${noTimeout.out.slice(0, 120)}`);

// --- 7. Restoring from the backup: tools/restore.mjs ------------------------------------------------
// The backup's files are tiddlers as stored, with their tags as a list (TiddlyWeb's layout); TiddlyWiki's
// JSON import keeps only text fields, so they can't be imported as they are without losing every tag.
// The tool turns a clone of the backup into one file TiddlyWiki imports, every field as text.
const { collect, importable, stringifyList } = await import("../tools/restore.mjs");
const clone = mkdtempSync(path.join(tmpdir(), "backup-clone-"));
fs.mkdirSync(path.join(clone, "tiddlers", "$:", "config"), { recursive: true });
const storedBackup = {
  "tiddlers/Hello, World.json": { title: "Hello, World", text: "hello", tags: ["kept", "two words"], created: "20261011000000000", type: "text/vnd.tiddlywiki", revision: "1760000000000", bag: "default", recipe: "default" },
  "tiddlers/$:/config/Thing.json": { title: "$:/config/Thing", text: "cfg", revision: "1760000000001", bag: "default", recipe: "default" },
  "tiddlers/With fields.json": { title: "With fields", fields: { fields: "a custom field called fields" }, count: 3, text: "", tags: [], revision: "1", bag: "default", recipe: "default" },
  "tiddlers/README.json": { note: "not a tiddler" },
  "tiddlers/broken.json": "{not json"
};
for (const [file, content] of Object.entries(storedBackup)) fs.writeFileSync(path.join(clone, file), typeof content === "string" ? content : JSON.stringify(content));
const restoreProblems = [];
const restorable = collect(clone, restoreProblems);
const hello = restorable.find(t => t.title === "Hello, World"), withFields = restorable.find(t => t.title === "With fields");
check("the tool collects every tiddler of a backup clone (subdirectories for titles with slashes), sorted by title, leaving out what isn't one",
  restorable.map(t => t.title).join("|") === "$:/config/Thing|Hello, World|With fields" && restoreProblems.length === 2 && restoreProblems.some(p => p.includes("README.json")) && restoreProblems.some(p => p.includes("broken.json")),
  `${restorable.map(t => t.title).join("|")}; problems: ${restoreProblems.join(" / ")}`);
check("...with the tags as TiddlyWiki writes them, the old revision, bag and recipe left out, every other field kept as text",
  hello?.tags === "kept [[two words]]" && !("revision" in hello) && !("bag" in hello) && !("recipe" in hello) && hello.created === "20261011000000000" && hello.type === "text/vnd.tiddlywiki" && hello.text === "hello" &&
  Object.values(hello).every(v => typeof v === "string"), JSON.stringify(hello));
check("...a custom field called fields flat again, a number as text, an empty tag list as an empty string",
  withFields?.fields === "a custom field called fields" && withFields.count === "3" && withFields.tags === "" && Object.values(withFields).every(v => typeof v === "string"), JSON.stringify(withFields));
check("stringifyList matches TiddlyWiki's: only items with a space get double brackets", stringifyList(["a", "b c", "d[e]"]) === "a [[b c]] d[e]" && stringifyList([]) === "");
check("importable refuses what has no title", importable({ text: "x" }, []) === null && importable("text", []) === null && importable(null, []) === null);
let restoreRun;
try {
  restoreRun = execFileSync(process.execPath, [path.join(ROOT, "tools/restore.mjs"), clone, path.join(clone, "restore.json")], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  restoreRun = "FAILED " + String(e.stderr || e.message);
}
const restoreFile = fs.existsSync(path.join(clone, "restore.json")) ? JSON.parse(fs.readFileSync(path.join(clone, "restore.json"), "utf8")) : null;
check("run as a command, the tool writes restore.json, the array TiddlyWiki imports, and says how many tiddlers",
  Array.isArray(restoreFile) && restoreFile.length === 3 && restoreFile[1].tags === "kept [[two words]]" && /3 tiddlers/.test(restoreRun), restoreRun.slice(0, 200));
try {
  restoreRun = execFileSync(process.execPath, [path.join(ROOT, "tools/restore.mjs"), path.join(clone, "tiddlers/Hello, World.json"), path.join(clone, "one.json")], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  restoreRun = "FAILED " + String(e.stderr || e.message);
}
const oneFile = fs.existsSync(path.join(clone, "one.json")) ? JSON.parse(fs.readFileSync(path.join(clone, "one.json"), "utf8")) : null;
check("...and does the same for a single file (one tiddler restored from its history on GitHub)", Array.isArray(oneFile) && oneFile.length === 1 && oneFile[0].title === "Hello, World" && oneFile[0].tags === "kept [[two words]]", restoreRun.slice(0, 200));
fs.rmSync(clone, { recursive: true, force: true });

// --- 8. The build refuses what it can't inline -----------------------------------------------------
// build.mjs inlines src/worker into one file: an import from anywhere but src/worker can't be
// inlined (dropped, its name would be undefined when the worker runs), and a top-level var declared
// in two modules would silently become one (var allows it; const and let were already refused). Run
// on a copy of the sources, with a module added.
const buildRoot = mkdtempSync(path.join(tmpdir(), "build-copy-"));
fs.cpSync(path.join(ROOT, "src"), path.join(buildRoot, "src"), { recursive: true });
for (const f of ["build.mjs", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(buildRoot, f));
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(buildRoot, "node_modules"), "dir");
const build = () => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(buildRoot, "build.mjs")], { cwd: buildRoot, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
};
const extra = (name, text) => fs.writeFileSync(path.join(buildRoot, "src/worker", name), text);
const asIs = build();
check("(the build runs on a copy of the sources)", asIs.code === 0 && fs.existsSync(path.join(buildRoot, "worker.js")), asIs.out.slice(-200));
extra("extra.js", 'import { readFileSync } from "node:fs";\nexport function extraRead() { return readFileSync("x"); }\n');
const foreign = build();
check("a module importing from outside src/worker (node:fs, say) fails the build, naming the module and the import",
  foreign.code !== 0 && /extra\.js/.test(foreign.out) && /node:fs/.test(foreign.out), foreign.out.slice(-300));
extra("extra.js", "var shared = 1;\nexport function extraOne() { return shared; }\n");
extra("extra2.js", "var shared = 2;\nexport function extraTwo() { return shared; }\n");
const twiceVar = build();
check("a top-level var declared in two modules fails the build, naming both", twiceVar.code !== 0 && /shared/.test(twiceVar.out) && /extra\.js/.test(twiceVar.out) && /extra2\.js/.test(twiceVar.out), twiceVar.out.slice(-300));
fs.rmSync(buildRoot, { recursive: true, force: true });

// --- 9. Every suite is wired in ------------------------------------------------------------------
// A suite nobody runs fails in the most flattering way: the file is there, its checks pass, and it
// never executes. So every test/*.test.mjs is in `npm test`'s list, in exactly one of test:fast and
// test:browser (the two CI jobs), and has a script of its own; and nothing listed lacks a file.
const allScripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {};
const suiteFiles = fs.readdirSync(path.join(ROOT, "test")).filter(f => f.endsWith(".test.mjs")).map(f => f.slice(0, -".test.mjs".length));
const suitesOf = name => ((allScripts[name] || "").split("run-suites.mjs ")[1] || "").trim().split(/\s+/).filter(Boolean);
const inTest = suitesOf("test"), inFast = suitesOf("test:fast"), inBrowser = suitesOf("test:browser");
const notWired = suiteFiles.filter(s => !inTest.includes(s) || (inFast.includes(s) ? 1 : 0) + (inBrowser.includes(s) ? 1 : 0) !== 1 || !Object.values(allScripts).some(v => v.endsWith(`node test/${s}.test.mjs`)));
const noFile = [...new Set([...inTest, ...inFast, ...inBrowser])].filter(s => !suiteFiles.includes(s));
check(`every suite in test/ (${suiteFiles.length}) is in npm test, in one of test:fast and test:browser, and has a script of its own; nothing listed lacks a file`,
  suiteFiles.length >= 18 && notWired.length === 0 && noFile.length === 0, `not wired: ${notWired.join(", ") || "none"}; no file: ${noFile.join(", ") || "none"}`);

// --- 10. The deployed bundle fits the free plan ----------------------------------------------------
// A deploy uploads worker.js and the empty wiki (a text module); Cloudflare measures the bundle
// compressed, against 3 MB on the free plan (reference 7). Two thirds of that is the budget here,
// so growth shows long before a deploy is refused: a bigger TiddlyWiki, or something inlined by mistake.
const BUNDLE_BUDGET = 2 * 1024 * 1024;
const gzSize = f => gzipSync(fs.readFileSync(path.join(ROOT, f)), { level: 9 }).length;
const bundle = { "worker.js": gzSize("worker.js"), "seed/empty.html": gzSize("seed/empty.html") };
const bundleTotal = Object.values(bundle).reduce((a, b) => a + b, 0);
check("the deployed bundle, worker.js and the empty wiki gzipped as Cloudflare measures it, stays under 2 MB (two thirds of the free plan's 3 MB)", bundleTotal < BUNDLE_BUDGET,
  Object.entries(bundle).map(([f, n]) => `${f} ${Math.round(n / 1024)} KB`).join(", ") + `, together ${Math.round(bundleTotal / 1024)} KB`);

// --- 11. The version is the changelog's newest dated block ------------------------------------------
// A release is a dated block of CHANGELOG.md (CONTRIBUTING, "Releases"): package.json's version is
// that date, 2026.10.19 for 2026-10-19 (valid semver), so the admin wiki's plugin version says which
// release a wiki runs and the tag is v<version>. An Unreleased block above it doesn't count. The
// release's notes are the block, which tools/release-notes.mjs prints.
const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const newestDated = (changelog.match(/^## (\d{4}-\d{2}-\d{2})$/m) || [])[1];
const versionOf = date => date.split("-").map(n => String(Number(n))).join(".");
const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
check(`package.json's version is the changelog's newest dated block as a version (${newestDated} → ${newestDated && versionOf(newestDated)})`, !!newestDated && packageVersion === versionOf(newestDated), `version ${packageVersion}`);
const expectedNotes = newestDated && changelog.split("\n## " + newestDated + "\n")[1].split("\n## ")[0].trim() + "\n";
const printedNotes = (() => { try { return execFileSync(process.execPath, [path.join(ROOT, "tools/release-notes.mjs")], { cwd: ROOT, encoding: "utf8" }); } catch (e) { return `(failed: ${e.message})`; } })();
check("tools/release-notes.mjs prints that block, the release's notes, without its heading", !!newestDated && printedNotes === expectedNotes, printedNotes.slice(0, 80).replace(/\n/g, "⏎"));

// --- 12. The Deploy to Cloudflare button's files (setup 2.1) --------------------------------------
// The button clones the repository, creates the bucket and the queue named in wrangler.toml and
// deploys; package.json's cloudflare.bindings describes the two for its form. No .dev.vars.example:
// the form makes every secret such a file names mandatory, and both of the worker's are optional
// (design 2.30), so they go in the dashboard afterwards, as the variables do: a [vars] entry would put
// its value back over the dashboard's at every deploy. Variables and secrets are named in
// wrangler.toml's settings comment, where a user finds them. Every setting the worker reads (env.NAME
// in src/worker) is declared in exactly one place, a binding or a settings line of that file;
// TEST_WAIT_SCALE, which only the test setups give the worker, is the named exception.
const workerEnv = new Set(walkFiles(path.join(ROOT, "src/worker")).flatMap(f => [...fs.readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map(m => m[1])));
workerEnv.delete("TEST_WAIT_SCALE");
const bindingsInToml = new Set([...tomlActive.matchAll(/^binding = "([A-Z_]+)"/gm)].map(m => m[1]));
const variablesInToml = new Set([...toml.matchAll(/^# {3}([A-Z][A-Z0-9_]*) /gm)].map(m => m[1]));
const exampleFiles = [".dev.vars.example", ".env.example"].filter(f => fs.existsSync(path.join(ROOT, f)));
check("no .dev.vars.example or .env.example in the repository: the button's form makes every secret such a file names mandatory, and both of the worker's are optional (they go in the dashboard, setup 2.5)",
  exampleFiles.length === 0, exampleFiles.join(", "));
const pkgCloudflare = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).cloudflare;
const described = pkgCloudflare?.bindings || {};
const describedNames = Object.keys(described).sort();
const toDescribe = [...bindingsInToml].sort();
check("package.json's cloudflare.bindings describes each binding of wrangler.toml, the bucket and the queue, with a sentence, and nothing else (no secret: none is asked for)",
  toDescribe.length === 2 && describedNames.join(",") === toDescribe.join(",") && describedNames.every(n => typeof described[n]?.description === "string" && described[n].description.length > 20),
  `described: ${describedNames.join(", ") || "none"}; to describe: ${toDescribe.join(", ")}`);
const placeOf = n => (bindingsInToml.has(n) ? "binding" : "") + (variablesInToml.has(n) ? "settings line" : "");
const misplaced = [...workerEnv].filter(n => !["binding", "settings line"].includes(placeOf(n)));
const unread = [...new Set([...bindingsInToml, ...variablesInToml])].filter(n => !workerEnv.has(n));
check(`every setting the worker reads (${workerEnv.size}, TEST_WAIT_SCALE excepted) is declared in one place, a binding or a settings line of wrangler.toml (the two secrets among the lines); and nothing is declared that the worker doesn't read`,
  misplaced.length === 0 && unread.length === 0 && workerEnv.size >= 10,
  (misplaced.length ? "misplaced: " + misplaced.map(n => `${n} (${placeOf(n) || "nowhere"})`).join(", ") : "") + (unread.length ? " unread: " + unread.join(", ") : ""));
const readmeText = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/DesignThinkerer/tiddlywiki-cloudflare";
check("the README carries the Deploy to Cloudflare button (Cloudflare's image, linking to its deploy page with this repository's address), and the setup guide says what the button does (setup 2.1)",
  readmeText.includes(`[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${DEPLOY_URL})`) && /Deploy to Cloudflare/.test(fs.readFileSync(path.join(ROOT, "docs/setup.md"), "utf8")),
  readmeText.includes(DEPLOY_URL) ? "the README has the link" : "no button in the README");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
