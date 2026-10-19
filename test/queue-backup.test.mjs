// Tests the queue-based GitHub backup (Miniflare queues + R2) against an imitation of GitHub's Contents API.
// Run: npm run test:backup
import { Miniflare } from "miniflare";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- Fake GitHub Contents API ------------------------------------------------------------------
const sha1 = b => crypto.createHash("sha1").update(b).digest("hex");
const blobSha = buf => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
const files = new Map();      // decoded path -> { sha, text }
const commits = [];           // { message, path, text|null }
let inFlight = 0, maxInFlight = 0, latencyMs = 50;
const faults = { badCredentials: false, rateLimitPuts: 0, rateLimitUntil: 0, outage: false, failOnce: new Set(), refuse: new Set(), refuseText: new Set(), notFound: new Set(), noWriteAccess: false, failPutOnceOfText: new Map(), garbleContent: new Set() };
const ghCalls = [];
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

async function fakeGitHub(req) {
  const url = new URL(req.url);
  // The Git Trees API: every file of the branch in one answer (the sync's prune reads it)
  if (req.method === "GET" && url.pathname === "/repos/o/r/git/trees/main") {
    ghCalls.push("GET trees");
    if (req.headers.get("authorization") !== "Bearer ghtoken" || faults.badCredentials) return json({ message: "Bad credentials" }, 401);
    if (faults.outage) return json({ message: "Server Error" }, 502);
    if (url.searchParams.get("recursive") !== "1") return json({ message: "the sync must ask for the whole tree" }, 400);
    const tree = [...files].map(([path, file]) => ({ path, mode: "100644", type: "blob", sha: file.sha, size: Buffer.byteLength(file.text) }));
    tree.push({ path: "README.md", mode: "100644", type: "blob", sha: "readme", size: 10 }, { path: "tiddlers", mode: "040000", type: "tree", sha: "dir" });
    return json({ sha: "treesha", url: url.href, tree, truncated: !!faults.treeTruncated });
  }
  const m = url.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
  if (!m) return json({ message: "unexpected " + url.pathname }, 400);
  const path = decodeURIComponent(m[1]);            // GitHub decodes the URL path
  const body = req.method === "GET" ? null : await req.json();
  ghCalls.push(`${req.method} ${path}`);
  if (req.headers.get("authorization") !== "Bearer ghtoken") return json({ message: "Bad credentials" }, 401);
  if (faults.badCredentials) return json({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, 401);
  if (faults.outage) return json({ message: "Server Error" }, 502);
  // (rateLimitUntil: a time until which GitHub asks every request to wait 2 seconds, reads included)
  if (Date.now() < faults.rateLimitUntil) return json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "2" });
  if (req.method !== "GET") {
    const key = `${req.method} ${path}`;
    if (faults.refuse.has(path)) return json({ message: "This path isn't allowed" }, 422);
    // (notFound: a path GitHub answers 404 for, as it answers every write to a repository it can't find;
    // noWriteAccess: a token that can read the repository but not write to it)
    if (faults.notFound.has(path)) return json({ message: "Not Found" }, 404);
    if (faults.noWriteAccess) return json({ message: "Resource not accessible by personal access token" }, 403);
    // (refuseText: content GitHub refuses, as its push protection does a text containing a secret)
    if (req.method === "PUT" && [...faults.refuseText].some(mark => Buffer.from(body.content, "base64").toString("utf8").includes(mark))) {
      return json({ message: "Secret detected in content" }, 409);
    }
    if (req.method === "PUT" && faults.failPutOnceOfText.get(path) === JSON.parse(Buffer.from(body.content, "base64").toString("utf8")).text) {
      faults.failPutOnceOfText.delete(path);
      return json({ message: "Server Error" }, 500);
    }
    if (faults.failOnce.has(key)) { faults.failOnce.delete(key); return json({ message: "Server Error" }, 500); }
    if (faults.rateLimitPuts > 0) { faults.rateLimitPuts--; return json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "1" }); }
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, latencyMs));
    inFlight--;
  }
  const file = files.get(path);
  if (req.method === "GET") {
    if (!file) return json({ message: "Not Found" }, 404);
    // Like GitHub: files over 1 MB only come in the "object" (or raw) format, without content
    const big = Buffer.byteLength(file.text) > 1024 * 1024;
    if (big && !/application\/vnd\.github\.(object|raw)/.test(req.headers.get("accept") || "")) {
      return json({ message: "This API returns blobs up to 1 MB in size.", errors: [{ resource: "Blob", field: "data", code: "too_large" }] }, 403);
    }
    // (garbleContent: content that isn't base64 at all, to show the worker doesn't decode it)
    if (faults.garbleContent.has(path)) return json({ sha: file.sha, encoding: "base64", content: "%%% not base64 %%%" });
    return json({ sha: file.sha, encoding: big ? "none" : "base64", content: big ? "" : Buffer.from(file.text).toString("base64").replace(/(.{60})/g, "$1\n") });
  }
  if (req.method === "PUT") {
    if (file && body.sha !== file.sha) return json({ message: "sha mismatch" }, 409);
    if (!file && body.sha) return json({ message: "no such file" }, 422);
    const buf = Buffer.from(body.content, "base64");
    files.set(path, { sha: blobSha(buf), text: buf.toString("utf8") });
    commits.push({ message: body.message, path, text: buf.toString("utf8") });
    return json({ content: { sha: files.get(path).sha } }, file ? 200 : 201);
  }
  if (req.method === "DELETE") {
    if (!file) return json({ message: "Not Found" }, 404);
    if (body.sha !== file.sha) return json({ message: "sha mismatch" }, 409);
    files.delete(path);
    commits.push({ message: body.message, path, text: null });
    return json({});
  }
  return json({}, 405);
}

// ---- Worker with a queue -----------------------------------------------------------------------
// (Behind test/r2-counter.mjs, which can make chosen R2 calls fail)
const workerLog = [];   // what the worker printed (console.error included)
// The direct backup's retries (a second, then two, in production) are scaled by this for the tests
// (TEST_WAIT_SCALE, design 2.25). The queue's delays are whole seconds and aren't: BACKUP_RETRY_SECONDS
// is their knob, 1 here, the least there is.
const WAIT_SCALE = 0.2, scaled = ms => Math.round(ms * WAIT_SCALE);
function makeWorker(port, withQueue, bindings = {}) {
  return new Miniflare({
    handleRuntimeStdio(stdout, stderr) {
      for (const stream of [stdout, stderr]) stream.on("data", chunk => { workerLog.push(String(chunk)); process.stdout.write(chunk); });
    },
    modules: true, scriptPath: "test/r2-counter.mjs", modulesRoot: ROOT, modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }],
    compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port,
    bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com", GITHUB_REPO: "o/r", GITHUB_TOKEN: "ghtoken", BACKUP_RETRY_SECONDS: "1", TEST_WAIT_SCALE: String(WAIT_SCALE), ...bindings },
    ...(withQueue ? {
      queueProducers: { BACKUP_QUEUE: "wiki-backup" },
      queueConsumers: { "wiki-backup": { maxBatchSize: 10, maxBatchTimeout: 0.2, maxRetries: 3 } },
    } : {}),
    outboundService: async req => req.url.startsWith("https://api.github.com/") ? fakeGitHub(req) : new Response("{}"),
  });
}
const mf = makeWorker(0, true, { BACKUP_ALERT_MINUTES: "0" });   // (port 0: any free one; failures reported at once)
const base = (await mf.ready).toString().replace(/\/$/, "");
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
await bucket.put("recipes/default/tiddlers.json", "[]");

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const put = (title, text, b = base, m = mf) => m.dispatchFetch(`${b}/recipes/default/tiddlers/${encodeURIComponent(title)}`,
  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, text }) });
const del = (title, b = base, m = mf) => m.dispatchFetch(`${b}/bags/default/tiddlers/${encodeURIComponent(title)}`, { method: "DELETE" });
const r2Text = async title => (await bucket.get(`recipes/default/tiddlers/${title}`))?.text();
const repoText = title => files.get(`tiddlers/${title}.json`)?.text;          // decoded path
const textOf = s => s && JSON.parse(s).text;
// What the admin wiki is told about backups when it asks with the tiddler list: "ok", the problem, or
// null when the answer doesn't say
async function backupStatus(b = base, m = mf, ask = true) {
  const res = await m.dispatchFetch(`${b}/recipes/default/tiddlers.json`, ask ? { headers: { "X-Backup-Status": "ask" } } : undefined);
  await res.arrayBuffer();
  const value = res.headers.get("X-Backup-Status");
  return value === null || value === "ok" || value === "off" ? value : JSON.parse(decodeURIComponent(value));
}
async function until(cond, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
}

// 1. Saves don't wait for GitHub: the save answers while GitHub's imitation still sits on the commit
// (2 s here), so the repository has nothing of the tiddler when the answer comes. (Not a clock on the
// save alone: a 300 ms bound failed on a cold CI runner at 337 ms, the save's own time there, where it
// is about 100 ms warm; a save that waited for GitHub would take the 2 s.)
latencyMs = 2000;
let t0 = Date.now();
const r = await put("Fast", "x");
const elapsed = Date.now() - t0, committedAtAnswer = repoText("Fast") !== undefined;
check("save returns without waiting for GitHub (the commit lands after the answer)", r.status === 204 && !committedAtAnswer && elapsed < latencyMs, `${elapsed} ms; on GitHub when the save answered: ${committedAtAnswer}`);
await until(async () => repoText("Fast") === await r2Text("Fast"));
latencyMs = 30;

// 2. Bulk import: one commit per tiddler, never two commits at once, content exact
const N = 150;
for (let i = 0; i < N; i++) await put(`Imported ${i}`, `text ${i}`);   // TiddlyWiki saves one at a time
const allIn = await until(async () => { for (let i = 0; i < N; i++) if (repoText(`Imported ${i}`) === undefined) return false; return true; }, 120000);
let exact = allIn;
for (let i = 0; i < N && exact; i++) if (repoText(`Imported ${i}`) !== await r2Text(`Imported ${i}`)) exact = false;
check("bulk import of 150: every tiddler committed, byte-identical", exact);
check("one commit per save", commits.filter(c => c.path.startsWith("tiddlers/Imported ")).length === N);
check("commits never overlapped (no collisions possible)", maxInFlight === 1, `max in flight ${maxInFlight}`);

// 3. Rapid edits of one tiddler: every version committed, in order, ending on the latest
for (const v of ["v1", "v2", "v3"]) await put("Rapid", v);
await until(async () => textOf(repoText("Rapid")) === "v3");
const rapid = commits.filter(c => c.path === "tiddlers/Rapid.json").map(c => textOf(c.text));
check("rapid edits: every version committed in order", JSON.stringify(rapid) === '["v1","v2","v3"]', JSON.stringify(rapid));

// 4. Secondary rate limit: backups wait and then go through, in order
faults.rateLimitPuts = 4;
for (const t of ["RL a", "RL b", "RL c"]) await put(t, t);
await until(async () => faults.rateLimitPuts <= 2);
await new Promise(r => setTimeout(r, 300));
const rlRecorded = await bucket.get("_backup/status.json");
check("a rate limit isn't a failure to report: GitHub only asks to wait",
  Object.keys((rlRecorded && (await rlRecorded.json()).failing) || {}).length === 0 && await backupStatus() === "ok");
const rlDone = await until(async () => ["RL a", "RL b", "RL c"].every(t => repoText(t) !== undefined));
const rlOrder = commits.filter(c => c.path.startsWith("tiddlers/RL ")).map(c => c.path);
check("rate limited: all committed after waiting, in save order", rlDone && JSON.stringify(rlOrder) === JSON.stringify(["tiddlers/RL a.json", "tiddlers/RL b.json", "tiddlers/RL c.json"]), JSON.stringify(rlOrder));

// 4b. A rate limit pauses every backup, not only the batch it hit: while GitHub asks to wait, the
// backups waiting make about one call each time the wait ends, however many they are (here 40 saves
// during 6 seconds of rate limit, GitHub asking each time to wait 2 seconds)
const pacedCalls = () => ghCalls.filter(c => c.includes("tiddlers/Paced ")).length;
faults.rateLimitUntil = Date.now() + 6000;
for (let i = 0; i < 40; i++) await put(`Paced ${i}`, `p${i}`);
await until(async () => Date.now() > faults.rateLimitUntil, 10000);
const pacedDuring = pacedCalls();
const pacedIn = await until(async () => { for (let i = 0; i < 40; i++) if (repoText(`Paced ${i}`) === undefined) return false; return true; }, 60000);
check("a rate limit pauses every backup: a few GitHub calls while it lasts, not one per batch, and then they all go through",
  pacedDuring <= 6 && pacedIn && await backupStatus() === "ok", `${pacedDuring} calls during the rate limit, all in ${pacedIn}`);

// 5. GitHub outage: nothing lost, final state right
faults.outage = true;
await put("Outage 1", "o1"); await put("Outage 2", "first"); await put("Outage 2", "second"); await del("Fast");
await new Promise(r => setTimeout(r, 3000));
check("during the outage nothing was committed", repoText("Outage 1") === undefined && repoText("Fast") !== undefined);
faults.outage = false;
const outageDone = await until(async () => textOf(repoText("Outage 2")) === "second" && repoText("Outage 1") !== undefined && repoText("Fast") === undefined);
const o2 = commits.filter(c => c.path === "tiddlers/Outage 2.json").map(c => textOf(c.text));
check("after the outage: everything committed, both versions kept, delete applied", outageDone && JSON.stringify(o2) === '["first","second"]', JSON.stringify(o2));

// 6. Out of order: v1's commit fails once, v2 goes first; v1 is still recorded, GitHub ends on v2
faults.failOnce.add("PUT tiddlers/Ord.json");
await put("Ord", "v1");
await new Promise(r => setTimeout(r, 400));     // v1 has failed and is waiting
await put("Ord", "v2");
await until(async () => commits.filter(c => c.path === "tiddlers/Ord.json").length >= 3, 30000);
await new Promise(r => setTimeout(r, 2000));
const ord = commits.filter(c => c.path === "tiddlers/Ord.json").map(c => textOf(c.text));
check("late version still committed, GitHub ends on the latest", ord.includes("v1") && ord.includes("v2") && textOf(repoText("Ord")) === "v2", JSON.stringify(ord));

// 7. Delete, then recreate
await put("Gone", "g1");
await until(async () => repoText("Gone") !== undefined);
await del("Gone");
await until(async () => repoText("Gone") === undefined);
await put("Gone", "g2");
await until(async () => textOf(repoText("Gone")) === "g2");
check("delete then recreate", textOf(repoText("Gone")) === "g2" && commits.some(c => c.path === "tiddlers/Gone.json" && c.text === null));

// 8. Large tiddler goes through R2, temporary copy cleaned up
const big = "x".repeat(200000);
await put("Big", big);
await until(async () => textOf(repoText("Big")) === big);
const leftovers = (await bucket.list({ prefix: "_backup/versions/" })).objects.length;
check("200 KB tiddler committed, temporary copy removed", textOf(repoText("Big")) === big && leftovers === 0, `leftovers ${leftovers}`);

// 8a. The queue counts an operation per 64 KB of message, as sent (V8-serialized), so a version waits
// in R2 rather than make a message over 64 KB (6 operations instead of 3): a 70 KB Latin-1 text; a
// text with a character past Latin-1, which takes two bytes a character (40 KB of it is over); a big
// one with a title too long to be part of an R2 key. A 60 KB Latin-1 text still fits in the message.
// Held up by an outage here, to see the copies waiting.
const logMark = workerLog.length;
const wide = "€" + "w".repeat(40000), longTitle = "Long " + "t".repeat(990), latin = "é" + "l".repeat(60000), latinBig = "é" + "L".repeat(70000);
faults.outage = true;
await put("Wide", wide);
await put(longTitle, "a".repeat(95000) + "😀".repeat(10000));
await put("Latin", latin);
await put("Latin big", latinBig);
await new Promise(r => setTimeout(r, 1500));
const waiting = (await bucket.list({ prefix: "_backup/versions/" })).objects.length;
faults.outage = false;
await until(async () => textOf(repoText("Wide")) === wide && repoText(longTitle) !== undefined && textOf(repoText("Latin")) === latin && textOf(repoText("Latin big")) === latinBig);
const notQueued = workerLog.slice(logMark).join("").match(/Could not queue[^\n]*/g) || [];
const leftAfter = (await bucket.list({ prefix: "_backup/versions/" })).objects.length;
check("versions that would make a message over 64 KB wait in R2 (two bytes a character, a 70 KB one, a long title); a 60 KB Latin-1 one fits in the message",
  waiting === 3 && leftAfter === 0 && notQueued.length === 0 && textOf(repoText("Wide")) === wide && repoText(longTitle) === await r2Text(longTitle) &&
  textOf(repoText("Latin")) === latin && textOf(repoText("Latin big")) === latinBig,
  `waiting ${waiting}, left ${leftAfter}${notQueued.length ? ", " + notQueued.join(" | ").slice(0, 200) : ""}`);

// 8d. A big version's R2 copy that can't be removed after its commit: the backup is still done (not
// run again, nor reported as failing); the copy is only left behind
await mf.dispatchFetch(`${base}/__r2fail`, { method: "POST", body: JSON.stringify({ call: "delete backup copy", times: 1 }) });
const copyText = "c".repeat(150000);
await put("Copy kept", copyText);
await until(async () => textOf(repoText("Copy kept")) === copyText);
await new Promise(r => setTimeout(r, 3000));
const copyRuns = ghCalls.filter(c => c === "GET tiddlers/Copy kept.json").length;
check("a backup whose R2 copy can't be removed afterwards still counts as done: not run again, not reported", copyRuns === 1 && await backupStatus() === "ok", `${copyRuns} runs, status ${JSON.stringify(await backupStatus())}`);

// 8f. The queue refusing a message (its daily operations used up on the free plan, say): the save is
// backed up directly instead, small or big, and a big version's R2 copy is removed again
const queueLogMark = workerLog.length;
const copiesBefore = (await bucket.list({ prefix: "_backup/versions/" })).objects.length;   // (8d leaves one)
await mf.dispatchFetch(`${base}/__qfail`, { method: "POST", body: JSON.stringify({ times: 2 }) });
const directSmall = "backed up directly", directBig = "d".repeat(150000);
await put("Queue refused small", directSmall);
await put("Queue refused big", directBig);
const directIn = await until(async () => textOf(repoText("Queue refused small")) === directSmall && textOf(repoText("Queue refused big")) === directBig, 20000);
const directCopies = (await bucket.list({ prefix: "_backup/versions/" })).objects.length;
const directLogged = (workerLog.slice(queueLogMark).join("").match(/Could not queue/g) || []).length;
check("a message the queue refuses: the save is backed up directly instead, small or big (the big one's R2 copy removed)",
  directIn && directCopies === copiesBefore && directLogged === 2, `committed ${directIn}, copies ${copiesBefore} before, ${directCopies} after, ${directLogged} refusals logged`);

// 8b. Saves in the browser module's flat layout are committed exactly as stored, small or large
const putFlat = (title, text) => mf.dispatchFetch(`${base}/recipes/default/tiddlers/${encodeURIComponent(title)}`,
  { method: "PUT", headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat" }, body: JSON.stringify({ title, note: "flat", text }) });
await putFlat("Flat small", "é 😀 small");
await putFlat("Flat big", "y".repeat(200000) + " é");
await until(async () => repoText("Flat small") !== undefined && repoText("Flat big") !== undefined);
check("flat-layout saves committed byte-identical to R2", repoText("Flat small") === await r2Text("Flat small") &&
  repoText("Flat big") === await r2Text("Flat big") && JSON.parse(repoText("Flat big")).note === "flat");

// 8c. A tiddler over 1 MB is backed up again on its next save, without holding up later backups
const huge = "z".repeat(1100000);
await put("Huge", huge + " v1");
await until(async () => textOf(repoText("Huge")) === huge + " v1");
await put("Huge", huge + " v2");
await put("After huge", "still backed up");
check("a tiddler over 1 MB is backed up on every save, and later backups go through",
  await until(async () => textOf(repoText("Huge")) === huge + " v2" && textOf(repoText("After huge")) === "still backed up", 20000));

// 8e. A run backs up one big version at most (each megabyte takes a few milliseconds of CPU, and a
// run gets about 10 on the free plan): with three waiting in one batch, two go on to the next runs
await mf.dispatchFetch(`${base}/__runs`);                  // (starts a new count)
latencyMs = 1500;
await put("Slow before big", "s");                         // the next saves arrive in one batch
await new Promise(r => setTimeout(r, 300));
latencyMs = 30;
const bigTitles = ["Big 1", "Big 2", "Big 3"];
for (const t of bigTitles) await put(t, t + " é " + "b".repeat(600 * 1024));
await until(async () => bigTitles.every(t => repoText(t) !== undefined), 30000);
let bigExact = true;
for (const t of bigTitles) if (repoText(t) !== await r2Text(t)) bigExact = false;
const bigRuns = await (await mf.dispatchFetch(`${base}/__runs`)).json();
const bigPerRun = Math.max(...bigRuns.map(run => run.filter(c => c === "get backup copy").length));
check("a run backs up one big version at most: the others go on to the next runs", bigExact && bigPerRun === 1,
  `committed exactly ${bigExact}, at most ${bigPerRun} big versions in a run`);

// 9. Special titles keep the old file paths
await put("$:/config/Some Thing", "s");
await until(async () => files.has("tiddlers/$:/config/Some Thing.json"));
check("special title uses the same API path as before", ghCalls.some(c => c === "PUT tiddlers/$:/config/Some Thing.json"));
// (and a title the commit message must escape)
await put('Say "hi" \\ there', "q");
check("a title with quotes and a backslash: committed, with its commit message", await until(async () =>
  commits.some(c => c.path === 'tiddlers/Say "hi" \\ there.json' && c.message === '✏️ Save: Say "hi" \\ there'), 10000));
// (and the characters a URL cares about: a comma, %, #, ? and +, which the API path carries encoded, and GitHub decodes)
await put("Hello, World 100% #1? a+b", "h");
check("a title with a comma, %, #, ? and +: committed under its own name", await until(async () => files.has("tiddlers/Hello, World 100% #1? a+b.json"), 10000));


// 11. Non-ASCII text survives, including the "newer version restored" path
faults.failOnce.add("PUT tiddlers/Uni.json");
await put("Uni", "é 日本 😀 v1");
await new Promise(r => setTimeout(r, 400));
await put("Uni", "é 日本 😀 v2");
await until(async () => commits.filter(c => c.path === "tiddlers/Uni.json").length >= 3, 30000);
await new Promise(r => setTimeout(r, 1500));
check("non-ASCII content round-trips exactly", repoText("Uni") === await r2Text("Uni") && textOf(repoText("Uni")) === "é 日本 😀 v2");

// 12. A message delivered twice doesn't create a second commit
const before = commits.length;
const obj = await bucket.get("recipes/default/tiddlers/Imported 5");
const producer = await mf.getQueueProducer("BACKUP_QUEUE");
await producer.send({ action: "save", title: "Imported 5", revision: obj.customMetadata.revision, content: await obj.text(), time: Date.now(), tries: 0 });
await new Promise(r => setTimeout(r, 2000));
check("duplicate delivery: no extra commit", commits.length === before, `${commits.length - before} extra`);

// 14. GitHub's copy isn't decoded (that cost about 16 ms of CPU for a 254 KB plugin): only its sha is
// used, so a copy the worker couldn't decode doesn't matter
await put("Plain", "p1");
await until(async () => textOf(repoText("Plain")) === "p1");
faults.garbleContent.add("tiddlers/Plain.json");
await put("Plain", "p2");
check("a backup doesn't decode GitHub's copy of the file, only uses its sha", await until(async () => textOf(repoText("Plain")) === "p2", 15000), textOf(repoText("Plain")));
faults.garbleContent.clear();

// 15. A late version whose "newer version restored" step fails: the retry still puts the newer one back
faults.failOnce.add("PUT tiddlers/Late.json");
await put("Late", "v1");
await new Promise(r => setTimeout(r, 400));     // v1 has failed and is waiting
await put("Late", "v2");
await until(async () => textOf(repoText("Late")) === "v2");
faults.failPutOnceOfText.set("tiddlers/Late.json", "v2");   // putting v2 back after v1's late commit fails once
const lateDone = await until(async () => commits.filter(c => c.path === "tiddlers/Late.json").some(c => textOf(c.text) === "v1") &&
  textOf(repoText("Late")) === "v2" && !faults.failPutOnceOfText.has("tiddlers/Late.json"), 30000);
await new Promise(r => setTimeout(r, 2000));
const late = commits.filter(c => c.path === "tiddlers/Late.json").map(c => textOf(c.text));
check("a late version whose restore of the newer one failed: GitHub still ends on the newer one", lateDone && textOf(repoText("Late")) === "v2", JSON.stringify(late));

// 15b. A late version whose restore failed, retried after a newer version was committed: it's
// already in the history, so it isn't committed again (only the newest stays on top)
faults.failOnce.add("PUT tiddlers/Twice.json");                // v1's first try fails: it arrives late
await put("Twice", "v1");
await new Promise(r => setTimeout(r, 400));
await put("Twice", "v2");
await until(async () => textOf(repoText("Twice")) === "v2");
faults.failPutOnceOfText.set("tiddlers/Twice.json", "v2");     // v1's retry: committed, then putting v2 back fails
await until(async () => !faults.failPutOnceOfText.has("tiddlers/Twice.json"), 20000);
await put("Twice", "v3");                                      // committed before v1 is tried again
await until(async () => textOf(repoText("Twice")) === "v3");
await new Promise(r => setTimeout(r, 6000));
const twice = commits.filter(c => c.path === "tiddlers/Twice.json").map(c => textOf(c.text));
check("a retried restore doesn't commit the late version again", twice.filter(t => t === "v1").length === 1 && textOf(repoText("Twice")) === "v3", JSON.stringify(twice));

// 13. A file GitHub refuses for good doesn't hold up the backups after it: it keeps being retried on
// its own (nothing is dropped) while the others go through. (A slow commit first keeps the consumer
// busy, so the next saves arrive in one batch, the refused one first.)
latencyMs = 1500;
await put("Slow before", "s");
await new Promise(r => setTimeout(r, 300));
latencyMs = 30;
faults.refuse.add("tiddlers/Refused.json");
await put("Refused", "never accepted");
await put("After refused 1", "a1");
await put("After refused 2", "a2");
const refusedTries = () => ghCalls.filter(c => c === "PUT tiddlers/Refused.json").length;
const othersIn = await until(async () => repoText("After refused 1") !== undefined && repoText("After refused 2") !== undefined, 20000);
await until(async () => refusedTries() >= 2, 20000);
check("a file GitHub keeps refusing doesn't hold up the backups after it, and is still retried",
  othersIn && repoText("Refused") === undefined && refusedTries() >= 2, `others in ${othersIn}, refused tries ${refusedTries()}`);
const refusedStatus = await backupStatus();
check("...and the admin wiki is told that file isn't backed up, and why", refusedStatus?.count === 1 && refusedStatus.title === "Refused" &&
  refusedStatus.status === 422 && refusedStatus.error === "This path isn't allowed", JSON.stringify(refusedStatus));
faults.refuse.clear();
check("...and goes through once GitHub accepts it", await until(async () => textOf(repoText("Refused")) === "never accepted", 30000));
check("...after which there's nothing to report", await until(async () => await backupStatus() === "ok" && !(await bucket.head("_backup/status.json")), 10000));

// 13b. A version GitHub refuses for good (here a text with a secret in it) doesn't hold up that
// tiddler's later versions: the next one, without the secret, goes through, even saved right after
// (the two then come in one batch). The refused version is then dropped, as the newer one is on
// GitHub, and so is one whose tiddler was deleted since: neither is retried forever
faults.refuseText.add("SECRET-TOKEN");
latencyMs = 1500;
await put("Slow before secret", "s");                      // keeps the consumer busy: the next saves arrive in one batch
await new Promise(r => setTimeout(r, 300));
latencyMs = 30;
await put("Secret note", "pasted SECRET-TOKEN by mistake");
await put("Secret note", "secret removed");
await put("Secret gone", "SECRET-TOKEN here too");
await new Promise(r => setTimeout(r, 300));
await del("Secret gone");
const cleanIn = await until(async () => textOf(repoText("Secret note")) === "secret removed", 20000);
const secretTries = () => ghCalls.filter(c => c === "GET tiddlers/Secret note.json" || c === "GET tiddlers/Secret gone.json").length;
// (Six reads: both versions of Secret note, Secret gone's save and its delete, then the two refused
// versions' retries, which drop them)
await until(async () => secretTries() >= 6 && await backupStatus() === "ok", 30000);
const triesThen = secretTries();
await new Promise(r => setTimeout(r, 8000));
check("a version GitHub refuses for good doesn't hold up the tiddler's next one, and is dropped once a newer one is on GitHub, or the tiddler deleted",
  cleanIn && await backupStatus() === "ok" && secretTries() === triesThen && !commits.some(c => (c.text || "").includes("SECRET-TOKEN")),
  `clean version in ${cleanIn}, status ${JSON.stringify(await backupStatus())}, GitHub calls for them after ${secretTries() - triesThen}`);
faults.refuseText.clear();

// 13c. A file GitHub answers the way it answers every backup when the repository is out of reach (a
// 404 for its path here) doesn't pause the others: that takes two tiddlers answered that way
latencyMs = 1500;
await put("Slow before odd", "s");                         // the next saves arrive in one batch, the odd one first
await new Promise(r => setTimeout(r, 300));
latencyMs = 30;
faults.notFound.add("tiddlers/Odd path.json");
await put("Odd path", "o");
await put("After odd 1", "a1");
await put("After odd 2", "a2");
const oddOthersIn = await until(async () => repoText("After odd 1") !== undefined && repoText("After odd 2") !== undefined, 10000);
await until(async () => (await backupStatus())?.title === "Odd path", 5000);
const oddStatus = await backupStatus();
check("one file answered like a repository out of reach (404) doesn't pause the others, and is reported",
  oddOthersIn && oddStatus?.count === 1 && oddStatus.title === "Odd path" && oddStatus.status === 404, `others in ${oddOthersIn}, status ${JSON.stringify(oddStatus)}`);
faults.notFound.clear();
await until(async () => repoText("Odd path") !== undefined && await backupStatus() === "ok", 30000);

// 16. Every backup failing (here a token GitHub no longer accepts): reported with the oldest one and
// how many are waiting, only to a request that asks. It pauses every backup, so the ones waiting make
// a few GitHub calls in all, not a few each. Cleared once they go through, and the pause with them
const queueOps = async () => (await mf.dispatchFetch(`${base}/__qops`)).json();
// 15b. A backup GitHub takes is 3 queue operations: the message sent, delivered once, acknowledged
// (the budget CONTRIBUTING.md and limits 5 state): no retry, no second delivery
await queueOps();                                          // (starts a new count)
const opsTitles = Array.from({ length: 5 }, (_, i) => `Ops ${i + 1}`);
for (const t of opsTitles) await put(t, `ops ${t}`);
await until(() => opsTitles.every(t => repoText(t) !== undefined), 30000);
await new Promise(r => setTimeout(r, 700));                 // (the last acknowledgement follows its commit)
const plainOps = await queueOps();
check("a backup GitHub takes is 3 queue operations: sent, delivered once, acknowledged (5 saves: 15)",
  plainOps.sends === 5 && plainOps.deliveries === 5 && plainOps.acks === 5 && plainOps.retries === 0, JSON.stringify(plainOps));
faults.badCredentials = true;
await queueOps();                                          // (starts a new count)
const tokenSaved = Date.now();
const tokenCalls = () => ghCalls.filter(c => c.includes("tiddlers/Token ")).length;
const tokenTitles = Array.from({ length: 20 }, (_, i) => `Token ${i + 1}`);
for (const t of tokenTitles) await put(t, t);
await until(async () => (await backupStatus())?.count === 20, 10000);
const tokenStatus = await backupStatus();
check("all backups failing (a token GitHub refuses): reported with how many wait, the oldest, its time and GitHub's answer",
  tokenStatus?.count === 20 && tokenStatus.title === "Token 1" && tokenStatus.status === 401 && tokenStatus.error === "Bad credentials" &&
  tokenStatus.since >= tokenSaved - 1000 && tokenStatus.since <= Date.now(), JSON.stringify(tokenStatus));
check("...not in a tiddler list request that doesn't ask (no extra R2 read there)", await backupStatus(base, mf, false) === null);
await new Promise(r => setTimeout(r, Math.max(0, tokenSaved + 6000 - Date.now())));
check("...and pauses every backup: a few GitHub calls in all while it lasts, not a few for each", tokenCalls() <= 8,
  `${tokenCalls()} calls for ${tokenTitles.length} backups in ${Math.round((Date.now() - tokenSaved) / 1000)} s`);
faults.badCredentials = false;
check("...and cleared once they go through, with the pause", await until(async () => tokenTitles.every(t => repoText(t) !== undefined) &&
  await backupStatus() === "ok" && !(await bucket.head("_backup/status.json")), 60000));
// Waiting costs 1 queue operation (the next delivery, through the queue's own retry) instead of 3 (a
// fresh message sent, delivered, acknowledged), while the message has retries left: never past its
// third delivery, inside the queue's default limit of 3 retries
const tokenOps = await queueOps();
const tokenWaits = tokenOps.deliveries - tokenTitles.length;
check("...and the waits mostly use the queue's own retry (1 operation instead of 3), never past a message's third delivery",
  tokenWaits > 0 && tokenOps.retries * 2 >= tokenWaits && tokenOps.maxAttempts <= 3,
  `${tokenOps.sends + tokenOps.deliveries + tokenOps.acks} operations for ${tokenTitles.length} backups: ${JSON.stringify(tokenOps)}`);

// 16b. A token that can't write to the repository (403 for every write) pauses every backup too, once
// two tiddlers get that answer
faults.noWriteAccess = true;
const writeTitles = Array.from({ length: 10 }, (_, i) => `Read only ${i + 1}`);
const writeCalls = () => ghCalls.filter(c => c.includes("tiddlers/Read only ")).length;
const writeSaved = Date.now();
for (const t of writeTitles) await put(t, t);
await new Promise(r => setTimeout(r, Math.max(0, writeSaved + 5000 - Date.now())));
const writeStatus = await backupStatus();
check("a token that can't write (403 on every write) pauses every backup too: a few GitHub calls in all, all reported",
  writeCalls() <= 16 && writeStatus?.count === 10 && writeStatus.status === 403, `${writeCalls()} calls for ${writeTitles.length} backups in 5 s, ${JSON.stringify(writeStatus)}`);
faults.noWriteAccess = false;
check("...and cleared once they go through", await until(async () => writeTitles.every(t => repoText(t) !== undefined) &&
  await backupStatus() === "ok" && !(await bucket.head("_backup/status.json")), 60000));

// 18. A backup the runtime cuts short (the free plan's CPU time, on a version of several MB): nothing
// after the cut runs, the queue delivers the batch again, three times, then drops it, and nothing
// recorded why. For a version over 1 MB the worker notes, before the heavy part, that it's at it
// (the status file: 2 R2 calls), and clears the note when done; a note left behind is reported
const runsOf = async () => (await mf.dispatchFetch(`${base}/__runs`)).json();
const statusFile = async () => { const o = await bucket.get("_backup/status.json"); return o ? JSON.parse(await o.text()) : null; };
await runsOf();                                            // (starts a new count)
await mf.dispatchFetch(`${base}/__die`, { method: "POST", body: JSON.stringify({ call: "put backup status", times: 4 }) });
const cutText = "c".repeat(1200000);
const cutSaved = Date.now();
await put("Cut short", cutText);
const fourTimes = await until(async () => (await statusFile())?.running?.["Cut short"]?.attempt === 4, 30000);
await new Promise(r => setTimeout(r, 2500));               // (a fifth delivery, if one came, would have come)
const cutRuns = (await runsOf()).filter(run => run.includes("put backup status"));
const noted = (await statusFile())?.running?.["Cut short"];
const cutStatus = await backupStatus();
check("a version over 1 MB whose backup is cut short four times (the delivery and the queue's three retries), then dropped: noted before each try, nothing committed",
  fourTimes && cutRuns.length === 4 && !!noted && noted.size > 1200000 && noted.attempt === 4 && noted.started >= cutSaved && repoText("Cut short") === undefined,
  `runs with the note ${cutRuns.length}, note ${JSON.stringify(noted)}, on GitHub ${repoText("Cut short") !== undefined}`);
check("...and reported to the admin wiki: the tiddler, its size, how many times, since when",
  !!cutStatus && typeof cutStatus === "object" && cutStatus.stuck?.title === "Cut short" && cutStatus.stuck.attempts === 4 && cutStatus.stuck.size > 1200000 && cutStatus.stuck.count === 1 && cutStatus.stuck.started >= cutSaved,
  JSON.stringify(cutStatus));
check("...the note costs the run two R2 calls before the heavy part (the status file read and written), after the copy is looked at",
  cutRuns.length === 4 && cutRuns.every(run => { const i = run.indexOf("get backup copy"); return i >= 0 && run.slice(i + 1, i + 3).join(",") === "get backup status,put backup status"; }),
  JSON.stringify(cutRuns[0]));
// A backup of the tiddler that goes through clears the note (here its next save)
await runsOf();
await put("Cut short", cutText + "!");
const cutThrough = await until(async () => textOf(repoText("Cut short")) === cutText + "!" && await backupStatus() === "ok", 30000);
const throughRun = (await runsOf()).find(run => run.includes("get backup copy")) || [];
check("...a backup of it that goes through clears the note and the report, and costs the run four status-file calls in all (the note, then its clearing)",
  cutThrough && !(await bucket.head("_backup/status.json")) && throughRun.filter(c => c.includes("backup status")).length === 4, `status ${JSON.stringify(await backupStatus())}, run ${JSON.stringify(throughRun)}`);
await runsOf();
await put("Small plain", "a small version writes no note");
await until(() => repoText("Small plain") !== undefined, 30000);
await new Promise(r => setTimeout(r, 500));
const smallRuns = await runsOf();
check("a version under 1 MB writes no note: no status-file call in its run", smallRuns.length >= 1 && smallRuns.every(run => !run.some(c => c.includes("backup status"))), JSON.stringify(smallRuns));

// 10. Without a queue binding, it commits directly like before
const mf2 = makeWorker(0, false);
const base2 = (await mf2.ready).toString().replace(/\/$/, "");
await (await mf2.getR2Bucket("WIKI_BUCKET")).put("recipes/default/tiddlers.json", "[]");
await put("No queue", "direct", base2, mf2);
check("no queue bound: direct commit as before", await until(async () => textOf(repoText("No queue")) === "direct", 10000));
// Recording how backups go is never part of the backup: an R2 error there doesn't make a backup that
// went through count as failed (and be run again)
const bucket2 = await mf2.getR2Bucket("WIKI_BUCKET");
await bucket2.put("_backup/status.json", JSON.stringify({ failing: { "Recorded or not": { since: Date.now() - 1000, last: Date.now(), error: "x", status: 500 } } }));
await mf2.dispatchFetch(`${base2}/__r2fail`, { method: "POST", body: JSON.stringify({ call: "delete backup status", times: 3 }) });
await put("Recorded or not", "r", base2, mf2);
await until(async () => textOf(repoText("Recorded or not")) === "r", 10000);
await new Promise(r => setTimeout(r, 4000));   // long enough for the retries a failure would bring
const recordedRuns = ghCalls.filter(c => c === "GET tiddlers/Recorded or not.json").length;
check("an R2 error while recording how backups go doesn't make a backup that went through count as failed",
  textOf(repoText("Recorded or not")) === "r" && recordedRuns === 1, `${recordedRuns} runs`);
await bucket2.delete("_backup/status.json");
// A direct backup that fails for good is recorded too; it's reported once it has failed for an hour
faults.badCredentials = true;
const noQueueAt = Date.now();
await put("No queue failing", "x", base2, mf2);
const recorded = await until(async () => !!(await bucket2.head("_backup/status.json")), 15000);
const recordedMs = Date.now() - noQueueAt;
check("no queue bound: a backup that fails for good is recorded, and reported only after an hour",
  recorded && JSON.parse(await (await bucket2.get("_backup/status.json")).text()).failing?.["No queue failing"]?.status === 401 && await backupStatus(base2, mf2) === "ok",
  recorded ? await (await bucket2.get("_backup/status.json")).text() : "not recorded");
check("...after its two retries, a second then two apart in production (scaled here): recorded after those waits, and well before 3 s",
  recorded && recordedMs >= scaled(3000) && recordedMs < 2500, `recorded after ${recordedMs} ms`);
faults.badCredentials = false;
await mf2.dispose();

// 17. Back up everything: GitHub made to mirror the bucket (design 1.7). For tiddlers that predate the
// backup (imported before the repository and the token were set), a restore, a tiddler put in R2 by
// hand, or any doubt: POST /backup/sync (behind Access) queues a job that walks the stored tiddlers a
// step at a time, commits what GitHub doesn't have or has differently, then removes from GitHub the
// files whose titles are no longer stored. Idempotent: a second run commits nothing.
const mf3 = makeWorker(0, true, { BACKUP_ALERT_MINUTES: "0" });
const base3 = (await mf3.ready).toString().replace(/\/$/, "");
const bucket3 = await mf3.getR2Bucket("WIKI_BUCKET");
files.clear(); commits.length = 0;   // GitHub's repository, empty but for what's put there below
const stored = (title, text, revision = String(1700000000000 + Math.floor(Math.random() * 1e9))) =>
  ({ text: `{"title":${JSON.stringify(title)},"type":"text/vnd.tiddlywiki","text":${JSON.stringify(text)},"revision":"${revision}","bag":"default","recipe":"default"}`, revision });
const predating = new Map();   // title -> stored text: content in the bucket before backups existed
const listEntries = [];
async function storeByHand(title, text) {
  const { text: body, revision } = stored(title, text);
  await bucket3.put(`recipes/default/tiddlers/${title}`, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { revision, layout: "flat" } });
  predating.set(title, body);
  listEntries.push({ title, revision, bag: "default", recipe: "default", type: "text/vnd.tiddlywiki", tags: [] });
}
for (let i = 1; i <= 60; i++) await storeByHand(`Old ${String(i).padStart(2, "0")}`, `old text ${i} ` + "lorem ".repeat(200));
await storeByHand("Old with/slash", "in a subdirectory on GitHub");
await storeByHand("Old big", "b".repeat(600 * 1024));                  // a step on its own (the bytes budget)
await storeByHand("Old refused", "contains a SECRET_MARK GitHub refuses");   // GitHub's push protection, say
faults.refuseText.add("SECRET_MARK");
await bucket3.put("recipes/default/tiddlers.json", JSON.stringify(listEntries));
// GitHub's side before the sync: one file identical to the bucket's (nothing to commit), one older
// version of a bucket tiddler (to update), two files whose titles aren't in the bucket (to remove)
const sameBytes = Buffer.from(predating.get("Old 07"));
files.set("tiddlers/Old 07.json", { sha: blobSha(sameBytes), text: sameBytes.toString("utf8") });
files.set("tiddlers/Old 08.json", { sha: blobSha(Buffer.from("older")), text: "older" });
files.set("tiddlers/Gone 1.json", { sha: blobSha(Buffer.from("gone")), text: "gone" });
files.set("tiddlers/Gone/with slash.json", { sha: blobSha(Buffer.from("gone too")), text: "gone too" });
const syncStatus = async () => (await (await mf3.dispatchFetch(`${base3}/backup/sync`)).json());
const startSync = () => mf3.dispatchFetch(`${base3}/backup/sync`, { method: "POST" });
const syncLogs = () => workerLog.join("").split("\n").filter(l => l.includes("[Backup] Sync"));
let res17 = await startSync();
const started = res17.status === 202 ? await res17.json() : null;
check("POST /backup/sync starts a sync: 202 with its status (phase, total from the tiddler list)", res17.status === 202 && started?.phase === "push" && started.total === listEntries.length && started.done === 0, `status ${res17.status} ${JSON.stringify(started)}`);
res17 = await startSync();
check("...a second POST while it runs is refused (409) with the status", res17.status === 409 && (await res17.json()).phase, `status ${res17.status}`);
// A save during the sync: committed by its own message, once
await put("Saved meanwhile", "during the sync", base3, mf3);
const running = await backupStatus(base3, mf3);
check("while it runs, the tiddler list's answer to the admin wiki carries the progress", running && typeof running === "object" && running.sync && running.sync.phase && running.sync.total === listEntries.length, JSON.stringify(running));
const finished = await until(async () => (await syncStatus()).finished, 120000);
const final = await syncStatus();
const everyFileThere = [...predating].filter(([title]) => title !== "Old refused").every(([title, body]) => files.get(`tiddlers/${title}.json`)?.text === body);
check("the sync finishes: every stored tiddler is on GitHub, byte for byte, slashes in titles as subdirectories, the big one included",
  finished && everyFileThere && files.has("tiddlers/Old with/slash.json") && files.get("tiddlers/Old big.json")?.text.length > 600 * 1024, `finished ${finished}: ${JSON.stringify(final)}`);
const commitsOf = title => commits.filter(c => c.path === `tiddlers/${title}.json`);
check("...the file GitHub already had the same isn't committed again, the older one is updated once, the one saved meanwhile committed once",
  commitsOf("Old 07").length === 0 && commitsOf("Old 08").length === 1 && files.get("tiddlers/Old 08.json").text === predating.get("Old 08") && commitsOf("Saved meanwhile").length === 1,
  `Old 07: ${commitsOf("Old 07").length}, Old 08: ${commitsOf("Old 08").length}, meanwhile: ${commitsOf("Saved meanwhile").length}`);
check("...files on GitHub whose titles aren't in the bucket are removed (the prune), nothing else is",
  !files.has("tiddlers/Gone 1.json") && !files.has("tiddlers/Gone/with slash.json") && files.has("tiddlers/Saved meanwhile.json") && commits.filter(c => c.text === null).length === 2,
  [...files.keys()].filter(k => k.startsWith("tiddlers/Gone")).join(", ") || "removed");
check("...the counts say what happened: walked (the one saved meanwhile too), committed (the 61 not there or older), removed 2, the refused one reported as failing",
  final.done >= listEntries.length && final.done <= listEntries.length + 1 && final.committed === listEntries.length - 2 && final.removed === 2 && final.failed === 1 &&
  (await backupStatus(base3, mf3))?.title === "Old refused", JSON.stringify(final));
const stepCalls = syncLogs().map(l => Number((l.match(/(\d+) GitHub calls/) || [])[1])).filter(n => !isNaN(n));
check("...in steps, each within a run's budget of GitHub calls (40), several steps for 63 tiddlers", stepCalls.length >= 3 && stepCalls.every(n => n <= 40), `steps: ${stepCalls.join(", ")}`);
check("...the status keeps the start time across the steps", final.startedAt === started.startedAt, `${final.startedAt} vs ${started.startedAt}`);
// A second run commits nothing
const commitsBefore = commits.length;
res17 = await startSync();
await until(async () => { const s = await syncStatus(); return s.finished && s.id !== final.id; }, 60000);
const second = await syncStatus();
check("a second sync commits nothing and removes nothing (idempotent)", res17.status === 202 && commits.length === commitsBefore && second.committed === 0 && second.removed === 0 && second.done === listEntries.length + 1, JSON.stringify(second));
faults.refuseText.clear();
// The refused tiddler, fixed and saved: its backup, a fresh message, goes through and clears the
// recorded failure at once, rather than a day later, when the entry goes stale
await put("Old refused", "fixed: nothing GitHub refuses", base3, mf3);
// (after a full backup, the report always carries its status: cleared means no failing entry in it)
const noFailure = s => s === "ok" || (!!s && typeof s === "object" && !s.count);
const refusedCleared = await until(async () => repoText("Old refused") !== undefined && noFailure(await backupStatus(base3, mf3)), 30000);
check("a file GitHub refused during a full backup, fixed and saved: the alert goes once the save's backup goes through", refusedCleared, `status ${JSON.stringify(await backupStatus(base3, mf3))}`);
// ...and a later full backup that commits a refused tiddler clears it too
faults.refuseText.add("SECRET_MARK");
await storeByHand("Old refused 2", "another SECRET_MARK");
{
  const current = JSON.parse(await (await bucket3.get("recipes/default/tiddlers.json")).text());
  current.push(listEntries[listEntries.length - 1]);
  await bucket3.put("recipes/default/tiddlers.json", JSON.stringify(current));
}
await startSync();
await until(async () => { const s = await syncStatus(); return s.finished && s.id !== second.id; }, 60000);
const refusedAgain = ((await backupStatus(base3, mf3))?.count || 0) >= 1;   // ("Old refused 2" recorded; the oldest is named)
faults.refuseText.clear();
await startSync();
const committedLater = await until(async () => { const s = await syncStatus(); return s.finished && s.failed === 0 && repoText("Old refused 2") !== undefined; }, 60000);
check("...and a later full backup that commits it clears it too", refusedAgain && committedLater && noFailure(await backupStatus(base3, mf3)),
  `recorded ${refusedAgain}, committed ${committedLater}, status ${JSON.stringify(await backupStatus(base3, mf3))}`);
// Files to remove with long titles: a prune step's next message carries what fits a queue message
// (under 64 KB, so a step stays 3 operations), over more steps, not a fixed number of titles
const longGone = Array.from({ length: 300 }, (_, i) => `tiddlers/${"gone title ".repeat(80)}${i}.json`);
for (const path of longGone) files.set(path, { sha: blobSha(Buffer.from("x")), text: "x" });
await mf3.dispatchFetch(`${base3}/__qops`);                 // (starts a new count)
await startSync();
const pruned = await until(async () => { const s = await syncStatus(); return s.finished && s.removed >= 300; }, 90000);
const pruneOps = await (await mf3.dispatchFetch(`${base3}/__qops`)).json();
check("files to remove with long titles: the prune's steps carry what fits a queue message, and every file is removed",
  pruned && longGone.every(p => !files.has(p)) && pruneOps.maxMessageBytes <= 64000,
  `removed ${(await syncStatus()).removed} in ${(await syncStatus()).steps} steps, largest message ${pruneOps.maxMessageBytes} bytes`);
// A full backup whose steps were lost (hours without progress) doesn't block a new one
const lostStart = Date.now() - 9 * 3600 * 1000;
await bucket3.put("_backup/status.json", JSON.stringify({ failing: {}, sync: { id: "lost", startedAt: lostStart, updatedAt: lostStart, total: 5, phase: "push", steps: 1, done: 2, committed: 2, removed: 0, failed: 0 } }));
res17 = await startSync();
const afterLost = res17.status === 202 ? await res17.json() : null;
check("a full backup without progress for hours counts as lost: a new one starts (202) and replaces it", res17.status === 202 && afterLost?.id !== "lost" && afterLost.total === listEntries.length + 1, `status ${res17.status} ${JSON.stringify(afterLost)}`);
await until(async () => (await syncStatus()).finished, 60000);
// Without GitHub, or without the queue, the sync says what's missing
const mfNoGitHub = makeWorker(0, true, { GITHUB_REPO: "", GITHUB_TOKEN: "" });
const baseNoGitHub = (await mfNoGitHub.ready).toString().replace(/\/$/, "");
await (await mfNoGitHub.getR2Bucket("WIKI_BUCKET")).put("recipes/default/tiddlers.json", "[]");
res17 = await mfNoGitHub.dispatchFetch(`${baseNoGitHub}/backup/sync`, { method: "POST" });
check("without GITHUB_REPO and GITHUB_TOKEN: 400 naming them, and the status header says backups are off", res17.status === 400 && /GITHUB_REPO/.test(await res17.text()) && await backupStatus(baseNoGitHub, mfNoGitHub) === "off", `status ${res17.status}`);
await mfNoGitHub.dispose();
const mfNoQueue = makeWorker(0, false);
const baseNoQueue = (await mfNoQueue.ready).toString().replace(/\/$/, "");
await (await mfNoQueue.getR2Bucket("WIKI_BUCKET")).put("recipes/default/tiddlers.json", "[]");
res17 = await mfNoQueue.dispatchFetch(`${baseNoQueue}/backup/sync`, { method: "POST" });
check("without the queue: 400 naming it (the sync runs in the queue)", res17.status === 400 && /queue/i.test(await res17.text()), `status ${res17.status}`);
await mfNoQueue.dispose();
await mf3.dispose();

console.log(`\n${results.filter(Boolean).length}/${results.length} passed; ${commits.length} commits, ${ghCalls.length} GitHub calls`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
