// Tests the queue-based GitHub backup (Miniflare queues + R2) against an imitation of GitHub's Contents API.
// Run: npm run test:backup
import { Miniflare } from "miniflare";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));

// ---- Fake GitHub Contents API ------------------------------------------------------------------
const sha1 = b => crypto.createHash("sha1").update(b).digest("hex");
const blobSha = buf => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
const files = new Map();      // decoded path -> { sha, text }
const commits = [];           // { message, path, text|null }
let inFlight = 0, maxInFlight = 0, latencyMs = 50;
const faults = { rateLimitPuts: 0, outage: false, failOnce: new Set(), refuse: new Set(), failPutOnceOfText: new Map(), garbleContent: new Set() };
const ghCalls = [];
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

async function fakeGitHub(req) {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
  if (!m) return json({ message: "unexpected " + url.pathname }, 400);
  const path = decodeURIComponent(m[1]);            // GitHub decodes the URL path
  const body = req.method === "GET" ? null : await req.json();
  ghCalls.push(`${req.method} ${path}`);
  if (req.headers.get("authorization") !== "Bearer ghtoken") return json({ message: "Bad credentials" }, 401);
  if (faults.outage) return json({ message: "Server Error" }, 502);
  if (req.method !== "GET") {
    const key = `${req.method} ${path}`;
    if (faults.refuse.has(path)) return json({ message: "This path isn't allowed" }, 422);
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
function makeWorker(port, withQueue) {
  return new Miniflare({
    modules: true, scriptPath: WORKER, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port,
    bindings: { GITHUB_REPO: "o/r", GITHUB_TOKEN: "ghtoken", BACKUP_RETRY_SECONDS: "1" },
    ...(withQueue ? {
      queueProducers: { BACKUP_QUEUE: "wiki-backup" },
      queueConsumers: { "wiki-backup": { maxBatchSize: 10, maxBatchTimeout: 0.2, maxRetries: 3 } },
    } : {}),
    outboundService: async req => req.url.startsWith("https://api.github.com/") ? fakeGitHub(req) : new Response("{}"),
  });
}
const mf = makeWorker(8794, true);
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
async function until(cond, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
}

// 1. Saves don't wait for GitHub
latencyMs = 400;
let t0 = Date.now();
const r = await put("Fast", "x");
check("save returns without waiting for GitHub", r.status === 204 && Date.now() - t0 < 300, `${Date.now() - t0} ms`);
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
const rlDone = await until(async () => ["RL a", "RL b", "RL c"].every(t => repoText(t) !== undefined));
const rlOrder = commits.filter(c => c.path.startsWith("tiddlers/RL ")).map(c => c.path);
check("rate limited: all committed after waiting, in save order", rlDone && JSON.stringify(rlOrder) === JSON.stringify(["tiddlers/RL a.json", "tiddlers/RL b.json", "tiddlers/RL c.json"]), JSON.stringify(rlOrder));

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

// 9. Special titles keep the old file paths
await put("$:/config/Some Thing", "s");
await until(async () => files.has("tiddlers/$:/config/Some Thing.json"));
check("special title uses the same API path as before", ghCalls.some(c => c === "PUT tiddlers/$:/config/Some Thing.json"));


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
faults.refuse.clear();
check("...and goes through once GitHub accepts it", await until(async () => textOf(repoText("Refused")) === "never accepted", 30000));

// 10. Without a queue binding, it commits directly like before
const mf2 = makeWorker(8793, false);
const base2 = (await mf2.ready).toString().replace(/\/$/, "");
await (await mf2.getR2Bucket("WIKI_BUCKET")).put("recipes/default/tiddlers.json", "[]");
await put("No queue", "direct", base2, mf2);
check("no queue bound: direct commit as before", await until(async () => textOf(repoText("No queue")) === "direct", 10000));
await mf2.dispose();

console.log(`\n${results.filter(Boolean).length}/${results.length} passed; ${commits.length} commits, ${ghCalls.length} GitHub calls`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
