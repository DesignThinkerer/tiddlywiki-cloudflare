// End-to-end test: the worker in workerd (Miniflare) with R2, a real TiddlyWiki in Chromium, several tabs.
// Covers edit-conflict protection, baking, public-cache purges, the 304 and the request savings.
// Run: npm run test:tabs   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));
const WIKI_HTML = process.env.WIKI_HTML || fileURLToPath(new URL("./fixtures/index.html", import.meta.url));
if (!fs.existsSync(WIKI_HTML)) {
  console.error(`No wiki file at ${WIKI_HTML}. Run "npm run fixture" first, or set WIKI_HTML.`);
  process.exit(1);
}
const outbound = [];
const mf = new Miniflare({
  modules: true,
  scriptPath: WORKER,
  compatibilityDate: "2024-09-23",
  r2Buckets: ["WIKI_BUCKET"],
  port: 8799,
  bindings: { CF_ZONE_ID: "zone123", CF_API_TOKEN: "token", PUBLIC_WIKI_URL: "http://127.0.0.1:8800" },
  outboundService: async (req) => {
    const body = req.method === "GET" ? "" : await req.text();
    outbound.push({ method: req.method, url: req.url, body });
    return new Response(req.url.includes("purge_cache") ? '{"success":true}' : "{}", { status: req.method === "GET" ? 404 : 200 });
  },
});
const purged = () => outbound.filter(o => o.url.includes("purge_cache")).map(o => JSON.parse(o.body));
const base = (await mf.ready).toString().replace(/\/$/, "");
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
await bucket.put("index.html", fs.readFileSync(WIKI_HTML, "utf8"));
await bucket.put("recipes/default/tiddlers.json", "[]");

// Stand-in for the public site: the R2 bucket served directly (custom domain + CORS header rule)
const PUB = "http://127.0.0.1:8800";
let publicCors = true;
const staleOverride = new Map();
const publicServer = http.createServer(async (req, res) => {
  const key = decodeURIComponent(new URL(req.url, PUB).pathname.slice(1));
  let body = staleOverride.get(key);
  if (body === undefined) {
    const obj = await bucket.get(key);
    body = obj ? await obj.text() : null;
  }
  const headers = publicCors ? { "Access-Control-Allow-Origin": "*" } : {};
  if (body === null) { res.writeHead(404, headers); return res.end("Not found"); }
  res.writeHead(200, { ...headers, "Content-Type": "application/json" });
  res.end(body);
});
await new Promise(r => publicServer.listen(8800, "127.0.0.1", r));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function server(title) {
  const r = await mf.dispatchFetch(`${base}/recipes/default/tiddlers/${encodeURIComponent(title)}`);
  return r.status === 200 ? await r.json() : null;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext();
const net = [];
const pageErrors = [];
const requests = [];
async function openTab(tag) {
  const page = await context.newPage();
  page.on("response", r => {
    const q = r.request();
    if (q.method() === "PUT" || q.method() === "DELETE") {
      const h = q.headers();
      net.push({ tag, method: q.method(), path: decodeURIComponent(new URL(q.url()).pathname), status: r.status(),
        ifMatch: h["if-match"] || "", ifNoneMatch: h["if-none-match"] || "" });
    }
  });
  page.on("pageerror", e => pageErrors.push(`${tag}: ${e.message}`));
  page.on("request", q => requests.push({ tag, method: q.method(), url: q.url() }));
  page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource") && !(tag === "D" && m.text().includes("CORS"))) pageErrors.push(`${tag} console: ${m.text()}`); });
  await page.goto(base + "/");
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
  return page;
}
async function settle(page) {
  await page.waitForFunction(() => {
    const s = $tw.syncer;
    const quiet = !s.isDirty() && s.numTasksInProgress === 0 && Object.keys(s.titlesToBeLoaded).length === 0 && !s.forceSyncFromServer;
    window.__quiet = quiet ? (window.__quiet || 0) + 1 : 0;
    return window.__quiet >= 3;
  }, null, { timeout: 20000, polling: 300 });
}
async function sync(page) {
  await page.evaluate(() => $tw.syncer.syncFromServer());
  await settle(page);
}
async function create(page, title, text, extra = {}) {
  await page.evaluate(([title, text, extra]) => {
    $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), extra, { title, text }, $tw.wiki.getModificationFields()));
  }, [title, text, extra]);
}
async function startEdit(page, title) {
  await page.evaluate(t => new $tw.Story().navigateTiddler(t), title);
  await page.locator(`.tc-tiddler-frame[data-tiddler-title="${title}"] button[aria-label="Edit this tiddler"]`).first().click();
  await page.waitForFunction(t => !!$tw.wiki.findDraft(t), title);
}
async function finishEdit(page, title, text, newTitle) {
  const draftTitle = await page.evaluate(([t, text, newTitle]) => {
    const d = $tw.wiki.findDraft(t);
    const fields = { text };
    if (newTitle) fields["draft.title"] = newTitle;
    $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(d), fields));
    return d;
  }, [title, text, newTitle]);
  await page.locator(`.tc-tiddler-frame[data-tiddler-title="${draftTitle}"] button[aria-label="Confirm changes to this tiddler"]`).first().click();
  await page.waitForFunction(d => !$tw.wiki.tiddlerExists(d), draftTitle);
}
// Deletes the tiddler from its open editor (TiddlyWiki asks for confirmation)
async function deleteFromEditor(page, title) {
  const draftTitle = await page.evaluate(t => $tw.wiki.findDraft(t), title);
  page.once("dialog", dialog => dialog.accept());
  await page.locator(`.tc-tiddler-frame[data-tiddler-title="${draftTitle}"] button[aria-label="Delete this tiddler"]`).first().click();
  await page.waitForFunction(d => !$tw.wiki.tiddlerExists(d), draftTitle);
}
async function editViaUI(page, title, text) {
  await startEdit(page, title);
  await finishEdit(page, title, text);
}
const localText = (page, title) => page.evaluate(t => $tw.wiki.getTiddlerText(t, null), title);
const conflictCopies = (page, title) => page.evaluate(t => $tw.wiki.filterTiddlers("[field:conflict-of[" + t + "]]"), title);
const alerts = page => page.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").map(t => $tw.wiki.getTiddlerText(t)));
const clearAlerts = page => page.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").forEach(t => $tw.wiki.deleteTiddler(t)));
const netSince = n => net.slice(n);

// --- 0. Baked page + legacy clients -------------------------------------------------------
const home = await (await mf.dispatchFetch(base + "/")).text();
check("baked page includes the conflict guard module", home.includes("$:/cfworker/conflict-guard.js"));
const A = await openTab("A");
const B = await openTab("B");
check("guard module is active in the browser", await A.evaluate(() => !!$tw.syncadaptor.conflictGuardInstalled));

await create(A, "Alpha", "a1");
await settle(A);
let r = await mf.dispatchFetch(`${base}/recipes/default/tiddlers/Alpha`, { method: "PUT", body: JSON.stringify({ title: "Alpha", text: "legacy" }), headers: { "Content-Type": "application/json" } });
check("PUT without If-Match is accepted (no more 428)", r.status === 204, `status ${r.status}`);
r = await mf.dispatchFetch(`${base}/recipes/default/tiddlers/Alpha`, { method: "PUT", body: JSON.stringify({ title: "Alpha", text: "a1" }), headers: { "Content-Type": "application/json", "If-Match": '"default/Alpha/123:auto"' } });
check("PUT with a stale If-Match gets 412", r.status === 412, `status ${r.status}`);
await sync(A); await sync(B);

// --- 1. Normal back-and-forth editing never conflicts ---------------------------------------
let mark = net.length;
await editViaUI(B, "Alpha", "b1"); await settle(B);
await sync(A);
await editViaUI(A, "Alpha", "a2"); await settle(A);
await sync(B);
await editViaUI(B, "Alpha", "b2"); await settle(B);
check("alternating edits after sync: no 412", !netSince(mark).some(x => x.status === 412));
check("alternating edits: server has the last edit", (await server("Alpha"))?.text === "b2");
check("saves carried If-Match", netSince(mark).filter(x => x.method === "PUT" && x.path.endsWith("/Alpha")).every(x => x.ifMatch.includes("/Alpha/")));
await sync(A);

// --- 2. Edit started before the other tab saved, tab re-synced meanwhile (the old silent overwrite)
mark = net.length;
await startEdit(B, "Alpha");
await editViaUI(A, "Alpha", "A wins"); await settle(A);
await sync(B);                                  // B's poll pulls A's version in behind the open draft
check("B loaded A's version behind its open draft", (await localText(B, "Alpha")) === "A wins");
check("B's open editor survived the poll (drafts aren't synced)", await B.evaluate(() => !!$tw.wiki.findDraft("Alpha")));
await finishEdit(B, "Alpha", "B late edit"); await settle(B);
let copies = await conflictCopies(B, "Alpha");
check("stale-draft save is rejected with 412", netSince(mark).some(x => x.tag === "B" && x.method === "PUT" && x.path.endsWith("/Alpha") && x.status === 412));
check("server keeps A's version", (await server("Alpha"))?.text === "A wins");
check("B's text is kept in a conflict copy on the server", copies.length === 1 && (await server(copies[0]))?.text === "B late edit", JSON.stringify(copies));
check("B's tiddler now shows the server version", (await localText(B, "Alpha")) === "A wins");
check("B shows an alert linking the copy", (await alerts(B)).some(t => t.includes("Edit conflict") && t.includes(copies[0])));
check("B ends clean (nothing left to retry)", await B.evaluate(() => !$tw.syncer.isDirty()));
check("conflict copy opened in B's story", await B.evaluate(c => $tw.wiki.getTiddlerList("$:/StoryList").includes(c), copies[0]));
await clearAlerts(B);
await sync(A);
check("A receives the conflict copy on its next sync", (await A.evaluate(c => $tw.wiki.tiddlerExists(c), copies[0])));

// --- 3. Stale tab that never re-synced -------------------------------------------------------
mark = net.length;
await editViaUI(A, "Alpha", "A again"); await settle(A);
await editViaUI(B, "Alpha", "B stale"); await settle(B);
check("stale tab save rejected", netSince(mark).some(x => x.tag === "B" && x.status === 412));
check("server still has A's edit", (await server("Alpha"))?.text === "A again");
check("second conflict copy holds B's edit", (await conflictCopies(B, "Alpha")).length === 2);
await clearAlerts(B);
await sync(A); await sync(B);

// --- 4. Rapid edits in one tab (draft opened while previous save is in flight) -----------------
mark = net.length;
await editViaUI(A, "Alpha", "r1");
await editViaUI(A, "Alpha", "r2");
await editViaUI(A, "Alpha", "r3");
await settle(A);
check("rapid same-tab edits: no 412", !netSince(mark).some(x => x.status === 412), JSON.stringify(netSince(mark).filter(x=>x.status===412)));
check("rapid same-tab edits: server has the last one", (await server("Alpha"))?.text === "r3");
check("rapid same-tab edits: no conflict copies created", (await conflictCopies(A, "Alpha")).length === 2);
await sync(B);

// --- 5. Same new title created in two tabs ---------------------------------------------------
mark = net.length;
await create(A, "Gamma", "from A"); await settle(A);
await create(B, "Gamma", "from B"); await settle(B);
check("second creator gets 412 (If-None-Match: *)", netSince(mark).some(x => x.tag === "B" && x.path.endsWith("/Gamma") && x.ifNoneMatch === "*" && x.status === 412));
check("server keeps the first Gamma", (await server("Gamma"))?.text === "from A");
copies = await conflictCopies(B, "Gamma");
check("B's Gamma is kept as a copy", copies.length === 1 && (await server(copies[0]))?.text === "from B");
await clearAlerts(B);
await sync(A);

// --- 6. Delete in a stale tab after the other tab edited -------------------------------------
await create(A, "Delta", "d1"); await settle(A); await sync(B);
mark = net.length;
await editViaUI(A, "Delta", "d2"); await settle(A);
await B.evaluate(() => $tw.wiki.deleteTiddler("Delta")); await settle(B);
check("stale delete is rejected with 412", netSince(mark).some(x => x.tag === "B" && x.method === "DELETE" && x.status === 412));
check("Delta still on the server with A's edit", (await server("Delta"))?.text === "d2");
check("Delta restored in B", (await localText(B, "Delta")) === "d2");
await clearAlerts(B);
mark = net.length;
await B.evaluate(() => $tw.wiki.deleteTiddler("Delta")); await settle(B);
check("up-to-date delete succeeds", netSince(mark).some(x => x.method === "DELETE" && x.status === 204) && (await server("Delta")) === null);
await sync(A);
check("A drops Delta after sync", !(await A.evaluate(() => $tw.wiki.tiddlerExists("Delta"))));

// --- 7. Both tabs make the identical change --------------------------------------------------
await create(A, "Epsilon", "e1"); await settle(A); await sync(B);
await startEdit(B, "Epsilon");
await editViaUI(A, "Epsilon", "same"); await settle(A);
await finishEdit(B, "Epsilon", "same"); await settle(B);
check("identical edits: no conflict copy", (await conflictCopies(B, "Epsilon")).length === 0);
check("identical edits: no alert, B clean", (await alerts(B)).length === 0 && await B.evaluate(() => !$tw.syncer.isDirty()));

// --- 8. Rename ------------------------------------------------------------------------------
await sync(A); await sync(B);
mark = net.length;
await startEdit(B, "Epsilon");
await finishEdit(B, "Epsilon", "renamed", "Epsilon renamed"); await settle(B);
check("rename: no 412", !netSince(mark).some(x => x.status === 412), JSON.stringify(netSince(mark)));
check("rename: new title on server, old one gone", (await server("Epsilon renamed"))?.text === "renamed" && (await server("Epsilon")) === null);

// Renaming, or deleting from the editor, deletes the old title: an editor opened before another tab
// saved mustn't delete that newer version (a delete conflict: refused, the newer version restored)
await create(A, "Zeta", "z1"); await settle(A); await sync(B);
mark = net.length;
await startEdit(B, "Zeta");
await editViaUI(A, "Zeta", "z2 from A"); await settle(A);
await sync(B);                                  // A's version arrives behind B's open editor
let behindEditor = (await localText(B, "Zeta")) === "z2 from A";
await finishEdit(B, "Zeta", "B's renamed text", "Zeta renamed"); await settle(B);
check("rename in an editor opened before another tab's save: deleting the old title is refused (412)", behindEditor &&
  netSince(mark).some(x => x.tag === "B" && x.method === "DELETE" && x.path.endsWith("/Zeta") && x.status === 412), JSON.stringify(netSince(mark)));
check("...the old title keeps the other tab's version, on the server and in this tab; the new title has this tab's text",
  (await server("Zeta"))?.text === "z2 from A" && (await localText(B, "Zeta")) === "z2 from A" && (await server("Zeta renamed"))?.text === "B's renamed text");
check("...and this tab is told", (await alerts(B)).some(t => t.includes("Delete conflict") && t.includes("Zeta")), JSON.stringify(await alerts(B)));
await clearAlerts(B);

await create(A, "Eta", "h1"); await settle(A); await sync(B);
mark = net.length;
await startEdit(B, "Eta");
await editViaUI(A, "Eta", "h2 from A"); await settle(A);
await sync(B);
behindEditor = (await localText(B, "Eta")) === "h2 from A";
await deleteFromEditor(B, "Eta"); await settle(B);
check("delete from an editor opened before another tab's save: refused (412), the other tab's version kept and restored",
  behindEditor && netSince(mark).some(x => x.tag === "B" && x.method === "DELETE" && x.path.endsWith("/Eta") && x.status === 412) &&
  (await server("Eta"))?.text === "h2 from A" && (await localText(B, "Eta")) === "h2 from A" && (await alerts(B)).some(t => t.includes("Delete conflict")),
  JSON.stringify(netSince(mark)));
await clearAlerts(B);

// With no other save in between, deleting from the editor simply deletes
await create(A, "Theta", "t1"); await settle(A); await sync(B);
mark = net.length;
await startEdit(B, "Theta");
await deleteFromEditor(B, "Theta"); await settle(B);
check("delete from an up-to-date editor goes through", netSince(mark).some(x => x.tag === "B" && x.method === "DELETE" && x.status === 204) &&
  !netSince(mark).some(x => x.status === 412) && (await server("Theta")) === null, JSON.stringify(netSince(mark)));
await sync(A);

// --- 9. Two saves hitting the worker at the same instant --------------------------------------
await create(A, "Zeta", "z0"); await settle(A);
const zeta = await server("Zeta");
const put = text => mf.dispatchFetch(`${base}/recipes/default/tiddlers/Zeta`, { method: "PUT",
  body: JSON.stringify({ title: "Zeta", text }), headers: { "Content-Type": "application/json", "If-Match": `"default/Zeta/${zeta.revision}:auto"` } });
const statuses = (await Promise.all([put("one"), put("two"), put("three")])).map(x => x.status).sort();
check("simultaneous saves: exactly one wins", JSON.stringify(statuses) === "[204,412,412]", JSON.stringify(statuses));

// --- 10. Startup tiddlers are baked with their custom fields flattened ------------------------
await create(A, "$:/my/startup", "<$action-setfield $tiddler='$:/temp/x' text='$1 $& done'/>", { tags: ["$:/tags/StartupAction"], "my-field": "flat" });
await settle(A);
await new Promise(r => setTimeout(r, 500));
const baked = await (await mf.dispatchFetch(base + "/baked.html")).text();
check("baked startup tiddler has flattened custom field", baked.includes('"my-field":"flat"') && !baked.includes('"fields":{"my-field"'));
check("$-patterns in tiddler text survive baking", baked.includes("$1 $& done"));

// --- 11. Public cache purges and the tiddler-list 304 ------------------------------------------
const PUBLIC_LIST = PUB + "/recipes/default/tiddlers.json?filter=%5Ball%5Btiddlers%5D%5D%20-%5B%5B%24%3A%2FisEncrypted%5D%5D%20-%5Bprefix%5B%24%3A%2Ftemp%2F%5D%5D%20-%5Bprefix%5B%24%3A%2Fstatus%2F%5D%5D%20-%5B%5B%24%3A%2Fboot%2Fboot.js%5D%5D%20-%5B%5B%24%3A%2Fboot%2Fbootprefix.js%5D%5D%20-%5Bhas%5Bplugin-type%5Dfield%3Aplatform%5Bserver%5D%5D%20-%5B%5B%24%3A%2Flibrary%2Fsjcl.js%5D%5D%20-%5B%5B%24%3A%2Fcore%5D%5D";
await sync(A);
let before = outbound.length;
await editViaUI(A, "Zeta", "purge me"); await settle(A);
await new Promise(r => setTimeout(r, 300));
let bodies = outbound.slice(before).filter(o => o.url.includes("purge_cache")).map(o => JSON.parse(o.body));
check("save purges the public tiddler URL and the exact public tiddler-list URL",
  bodies.some(b => b.files && b.files.includes(PUB + "/recipes/default/tiddlers/Zeta") && b.files.includes(PUBLIC_LIST)), JSON.stringify(bodies));
// The admin page reads tiddlers from the public site cross-origin, so its requests carry an Origin
// header, which is part of Cloudflare's cache key: that copy is purged separately, with the header
const ADMIN_ORIGIN = new URL(base).origin;
const purgesWithOrigin = (bs, url) => bs.some(b => (b.files || []).some(f => f && f.url === url && f.headers && f.headers.Origin === ADMIN_ORIGIN));
check("...and the copy Cloudflare keeps for the admin page's requests (with its Origin header)",
  purgesWithOrigin(bodies, PUB + "/recipes/default/tiddlers/Zeta"), JSON.stringify(bodies));
before = outbound.length;
const doomed = await mf.dispatchFetch(`${base}/recipes/default/tiddlers/Purged%20on%20delete`, {
  method: "PUT", headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat" },
  body: JSON.stringify({ title: "Purged on delete", text: "x" })
});
await doomed.arrayBuffer();
await (await mf.dispatchFetch(`${base}/bags/default/tiddlers/Purged%20on%20delete`, { method: "DELETE" })).arrayBuffer();
await new Promise(r => setTimeout(r, 300));
bodies = outbound.slice(before).filter(o => o.url.includes("purge_cache")).map(o => JSON.parse(o.body));
check("...also on a delete", purgesWithOrigin(bodies.slice(-1), PUB + "/recipes/default/tiddlers/Purged%20on%20delete"), JSON.stringify(bodies.slice(-1)));
await create(A, "$:/config/Some Thing", "x"); await settle(A);
await new Promise(r => setTimeout(r, 300));
check("system tiddler URL encoded like TiddlyWiki requests it",
  purged().some(b => b.files && b.files.includes(PUB + "/recipes/default/tiddlers/%24%3A%2Fconfig%2FSome%20Thing")));
check("rebuilt baked.html is purged on the public site", purged().some(b => b.files && b.files.includes(PUB + "/baked.html")));
check("purge_everything is never used", !purged().some(b => b.purge_everything));
const fresh = await mf.dispatchFetch(base + "/recipes/default/tiddlers.json");
const etag = fresh.headers.get("ETag");
const again = await mf.dispatchFetch(base + "/recipes/default/tiddlers.json", { headers: { "If-None-Match": "W/" + etag } });
check("unchanged tiddler list answers 304 (weak ETag accepted)", again.status === 304 && again.headers.get("ETag") === etag, `${again.status} ${etag}`);
await editViaUI(A, "Zeta", "changed again"); await settle(A);
const changed = await mf.dispatchFetch(base + "/recipes/default/tiddlers.json", { headers: { "If-None-Match": etag } });
check("changed tiddler list answers 200 with a new ETag", changed.status === 200 && changed.headers.get("ETag") !== etag && (await changed.json()).length > 0);

// --- 12. Fewer worker requests ---------------------------------------------------------------
for (let i = 1; i <= 5; i++) await create(A, `Note ${i}`, `note text ${i}`);
await settle(A);
let reqMark = requests.length;
const C = await openTab("C");
const workerTiddlerGets = rs => rs.filter(r => r.method === "GET" && r.url.startsWith(base + "/recipes/default/tiddlers/"));
const publicTiddlerGets = rs => rs.filter(r => r.method === "GET" && r.url.startsWith(PUB + "/recipes/default/tiddlers/"));
let cReqs = requests.slice(reqMark).filter(r => r.tag === "C");
const texts = await C.evaluate(() => [1,2,3,4,5].map(i => $tw.wiki.getTiddlerText("Note " + i)));
check("new tab loads every tiddler correctly", texts.every((t, i) => t === `note text ${i + 1}`), JSON.stringify(texts));
check("page load fetches tiddlers from the public site, not the worker",
  workerTiddlerGets(cReqs).length === 0 && publicTiddlerGets(cReqs).length >= 5,
  `worker ${workerTiddlerGets(cReqs).length}, public ${publicTiddlerGets(cReqs).length}`);
check("page load makes only 2 worker requests (page, tiddler list): the module answers /status itself",
  cReqs.filter(r => r.url.startsWith(base)).length === 2 && !cReqs.some(r => r.url === base + "/status"));
check("...and TiddlyWiki still knows it's logged in as admin, writable", JSON.stringify(await C.evaluate(() =>
  ["$:/status/IsLoggedIn", "$:/status/UserName", "$:/status/IsReadOnly"].map(t => $tw.wiki.getTiddlerText(t)))) === '["yes","admin","no"]');
console.log("      worker requests during C's page load:", cReqs.filter(r => r.url.startsWith(base)).map(r => r.method + " " + decodeURIComponent(new URL(r.url).pathname)).join(", "));
check("no $:/StoryList or draft writes reach the worker", !net.some(x => x.path.includes("$:/StoryList") || x.path.includes("Draft of")));

// public copy is stale -> falls back to the worker
await sync(C);
staleOverride.set("recipes/default/tiddlers/Note 1", await (await bucket.get("recipes/default/tiddlers/Note 1")).text());
await editViaUI(A, "Note 1", "note 1 edited"); await settle(A);
reqMark = requests.length;
await sync(C);
cReqs = requests.slice(reqMark).filter(r => r.tag === "C");
check("stale public copy is ignored, worker used instead",
  (await localText(C, "Note 1")) === "note 1 edited" && workerTiddlerGets(cReqs).some(r => r.url.endsWith("/Note%201")));
staleOverride.clear();
await editViaUI(C, "Note 1", "edited in C"); await settle(C);
check("editing after a fallback load saves without conflict", (await server("Note 1"))?.text === "edited in C" && (await conflictCopies(C, "Note 1")).length === 0);

// no CORS header on the public site -> everything still works through the worker
publicCors = false;
reqMark = requests.length;
const D = await openTab("D");
const dReqs = requests.slice(reqMark).filter(r => r.tag === "D");
check("without the CORS header the wiki still loads (via the worker)",
  (await D.evaluate(() => $tw.wiki.getTiddlerText("Note 2"))) === "note text 2" && workerTiddlerGets(dReqs).length >= 5);
publicCors = true;
await D.close();

// background tab stops polling, catches up when shown
await C.evaluate(() => {
  Object.defineProperty(document, "hidden", { get: () => !!window.__hidden, configurable: true });
  window.__hidden = true;
  $tw.syncer.pollTimerInterval = 1000;
  $tw.syncer.processTaskQueue();
});
reqMark = requests.length;
await new Promise(r => setTimeout(r, 11000));
const hiddenPolls = requests.slice(reqMark).filter(r => r.tag === "C" && r.url.includes("tiddlers.json")).length;
reqMark = requests.length;
await C.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
await new Promise(r => setTimeout(r, 800));
const shownPolls = requests.slice(reqMark).filter(r => r.tag === "C" && r.url.includes("tiddlers.json")).length;
check("hidden tab does not poll; shown tab syncs at once", hiddenPolls === 0 && shownPolls >= 1, `hidden ${hiddenPolls}, on show ${shownPolls}`);
// Reloading: the browser asks whether the page changed (If-None-Match) and keeps its copy. The
// worker answers 304; Chromium then reports the page as 200, but nothing of it crossed the network.
const reloaded = await C.reload();
await settle(C);
const asked = (await reloaded.request().allHeaders())["if-none-match"] || "";
const transferred = (await reloaded.request().sizes()).responseBodySize;
check("a reload asks whether the page changed and downloads none of it (304)", /-page"$/.test(asked) && transferred === 0,
  `If-None-Match ${asked}, ${transferred} bytes`);
// The same behind Cloudflare, whose features that rewrite HTML remove the page's ETag: a stand-in
// proxy does that, and the browser asks by date instead (If-Modified-Since)
const PROXY = "http://127.0.0.1:8801";
const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = await mf.dispatchFetch(base + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const out = {};
  upstream.headers.forEach((value, name) => { out[name] = value; });
  if ((out["content-type"] || "").startsWith("text/html")) delete out.etag;
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
});
await new Promise(r => proxy.listen(8801, "127.0.0.1", r));
const behindCloudflare = await browser.newContext();
const tabBehind = await behindCloudflare.newPage();
const firstLoad = await tabBehind.goto(PROXY + "/");
await tabBehind.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
const noEtag = !(await firstLoad.allHeaders())["etag"];
const reloadedD = await tabBehind.reload();
await tabBehind.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
const askedByDate = (await reloadedD.request().allHeaders())["if-modified-since"] || "";
const transferredD = (await reloadedD.request().sizes()).responseBodySize;
check("...also when the ETag is removed on the way: asked by date, none of it downloaded", noEtag && !!askedByDate && transferredD === 0,
  `ETag removed: ${noEtag}, If-Modified-Since ${askedByDate}, ${transferredD} bytes`);
await behindCloudflare.close();
proxy.close();

// --- 13. A damaged tiddler list is rebuilt while a tab is open ------------------------------------
await B.close();
await C.close();
// Enough tiddlers that the worker rebuilds the list over several requests
for (let i = 0; i < 400; i += 50) {
  await Promise.all(Array.from({ length: 50 }, (_, j) => {
    const title = `$:/filler/${i + j}`, revision = String(1600000000000 + i + j);
    return bucket.put(`recipes/default/tiddlers/${title}`,
      `{"title":"${title}","type":"text/vnd.tiddlywiki","text":"f${i + j}","revision":"${revision}","bag":"default","recipe":"default"}`,
      { customMetadata: { revision, layout: "flat" } });
  }));
}
await clearAlerts(A);
await bucket.put("recipes/default/tiddlers.json", "[{\"title\": \"Alpha\", ");
reqMark = requests.length;
let settled = true;
try { await sync(A); } catch (e) { settled = false; }
const listGets = requests.slice(reqMark).filter(r => r.tag === "A" && r.url.includes("tiddlers.json")).length;
check("the tab's sync waits while the worker rebuilds a damaged list over several requests, then completes",
  settled && listGets >= 3, `${listGets} list requests${settled ? "" : ", the sync never completed"}`);
check("...keeps its tiddlers and gets the ones the damaged list was missing",
  (await localText(A, "Note 2")) === "note text 2" && (await localText(A, "$:/filler/7")) === "f7");
check("...and shows no error", (await alerts(A)).length === 0, JSON.stringify(await alerts(A)));
// Any other 503 (Cloudflare's own, when a request runs out of CPU, say) is reported as usual
await A.route("**/recipes/default/tiddlers.json*", route => route.fulfill({ status: 503, body: "Worker exceeded resource limits" }));
reqMark = requests.length;
await A.evaluate(() => $tw.syncer.syncFromServer());
await new Promise(r => setTimeout(r, 2500));
const plainRetries = requests.slice(reqMark).filter(r => r.tag === "A" && r.url.includes("tiddlers.json")).length;
check("another 503 isn't retried quietly: TiddlyWiki reports it as before",
  plainRetries <= 2 && (await alerts(A)).some(text => text.includes("503")), `${plainRetries} list requests, alerts ${JSON.stringify(await alerts(A))}`);
await A.unroute("**/recipes/default/tiddlers.json*");
await clearAlerts(A);
await settle(A);
// A save answered "rebuilding" (another tab's page load is rebuilding the list) is sent again quietly
let rebuildingAnswers = 2;
await A.route("**/recipes/default/tiddlers/QuietSave", route => {
  if (route.request().method() === "PUT" && rebuildingAnswers-- > 0) {
    return route.fulfill({ status: 503, headers: { "X-Tiddler-List": "rebuilding" }, body: "rebuilding" });
  }
  return route.continue();
});
const netBefore = net.length;
await create(A, "QuietSave", "sent three times");
await settle(A);
check("a save answered \"rebuilding\" is sent again quietly and goes through",
  rebuildingAnswers === -1 && (await server("QuietSave"))?.text === "sent three times" && (await alerts(A)).length === 0,
  `${2 - rebuildingAnswers} sends, alerts ${JSON.stringify(await alerts(A))}`);
await A.unroute("**/recipes/default/tiddlers/QuietSave");
net.splice(netBefore, net.length - netBefore, ...net.slice(netBefore).filter(x => x.status !== 503));   // expected, not failures

// --- 14. Leaving with an editor open ----------------------------------------------------------
// Drafts are never saved to the server, so closing or reloading the tab would lose what's being typed:
// the browser asks first, as TiddlyWiki does for unsaved changes. Not for an editor left unchanged.
async function leaving(page) {
  let asked = false;
  page.once("dialog", dialog => { asked = dialog.type() === "beforeunload"; dialog.dismiss().catch(() => {}); });
  await page.close({ runBeforeUnload: true });
  await new Promise(r => setTimeout(r, 1000));
  return { asked, closed: page.isClosed() };
}
const typing = await openTab("E");
await startEdit(typing, "Alpha");
await typing.evaluate(() => {
  const d = $tw.wiki.findDraft("Alpha");
  $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(d), { text: "half-typed sentence" }));
});
const whileTyping = await leaving(typing);
check("closing a tab while typing in an editor asks first (the draft isn't saved anywhere)", whileTyping.asked && !whileTyping.closed, JSON.stringify(whileTyping));
if (!typing.isClosed()) await typing.close();
const looking = await openTab("F");
await startEdit(looking, "Alpha");
const unchanged = await leaving(looking);
check("...but not for an editor opened and left unchanged", !unchanged.asked && unchanged.closed, JSON.stringify(unchanged));

// --- 15. A conflict copy of code doesn't run --------------------------------------------------
// The copy keeps the losing version's text, but not what would make TiddlyWiki run it: no module, no
// plugin, no file or script tag in the page. Only the version the server kept takes effect.
const MOD = "$:/test/marker.js", PLUG = "$:/plugins/test/conflicted";
const markerModule = v => ({ type: "application/javascript", "module-type": "startup",
  text: `exports.name='marker';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__ran=(window.__ran||[]).concat(${JSON.stringify(v)});};` });
const valuePlugin = v => ({ "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { [PLUG + "/value"]: { text: v } } }) });
const putCode = (page, title, fields) => page.evaluate(([title, fields]) => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), fields, { title }, $tw.wiki.getModificationFields())), [title, fields]);
const other = await openTab("H");             // a second tab (B is closed by now)
await putCode(A, MOD, markerModule("original")); await putCode(A, PLUG, valuePlugin("original")); await settle(A);
await sync(other);
await putCode(A, MOD, markerModule("A's edit")); await putCode(A, PLUG, valuePlugin("A's edit")); await settle(A);
await putCode(other, MOD, markerModule("B's edit")); await putCode(other, PLUG, valuePlugin("B's edit")); await settle(other);   // it hadn't synced: conflicts
const codeCopies = [...await conflictCopies(other, MOD), ...await conflictCopies(other, PLUG)];
const copyFields = await other.evaluate(titles => titles.map(t => $tw.wiki.getTiddler(t).fields), codeCopies);
check("conflict copies of a module and a plugin keep their text, without module-type or plugin-type (moved aside)",
  codeCopies.length === 2 && copyFields.every(f => f["module-type"] === undefined && f["plugin-type"] === undefined) &&
  copyFields.some(f => f["conflict-removed-module-type"] === "startup" && f.text.includes("B's edit")) && copyFields.some(f => f["conflict-removed-plugin-type"] === "plugin" && f.text.includes("B's edit")),
  JSON.stringify(copyFields.map(f => ({ title: f.title, module: f["module-type"], plugin: f["plugin-type"], removedModule: f["conflict-removed-module-type"], removedPlugin: f["conflict-removed-plugin-type"] }))));
const pluginFiles = (await bucket.list({ prefix: "_plugins/" })).objects.map(o => o.key);
const bakedPage = await (await bucket.get("baked.html")).text();
check("...no file in R2 and no script tag in the page for them", !pluginFiles.some(k => k.includes("(conflict")) && !bakedPage.includes(encodeURIComponent(" (conflict")),
  JSON.stringify(pluginFiles.filter(k => k.includes("conflict"))));
const freshLoad = await openTab("G");
const ran = await freshLoad.evaluate(() => window.__ran);
const pluginValue = await freshLoad.evaluate(t => $tw.wiki.getTiddlerText(t), PLUG + "/value");
check("...a fresh load runs only the version the server kept", JSON.stringify(ran) === JSON.stringify(["A's edit"]) && pluginValue === "A's edit",
  `ran ${JSON.stringify(ran)}, plugin value ${JSON.stringify(pluginValue)}`);
await freshLoad.close();
await other.close();

// --- Summary --------------------------------------------------------------------------------
const bad = net.filter(x => x.status === 428 || x.status >= 500);
check("no 428/5xx responses anywhere", bad.length === 0, JSON.stringify(bad));
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
console.log(`\n${results.filter(x => x.ok).length}/${results.length} passed; ${net.filter(x => x.status === 412).length} conflicts detected; ${net.length} writes`);
await browser.close();
await mf.dispose();
publicServer.close();
process.exit(results.every(x => x.ok) ? 0 : 1);
