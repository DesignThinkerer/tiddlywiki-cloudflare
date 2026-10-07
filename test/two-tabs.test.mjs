// End-to-end test: the worker in workerd (Miniflare) with R2, a real TiddlyWiki in Chromium, several tabs.
// Covers edit-conflict protection, baking, public-cache purges, the 304 and the request savings.
// Run: npm run test:tabs   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
import http from "node:http";
import { createChecks, createWatcher, finish, launchBrowser, listen, readWikiFile, settle as settleTab, startSite } from "./browser-harness.mjs";

const outbound = [];
// The public site's stand-in can leave out the CORS header, or serve an older copy of a tiddler
let publicCors = true;
const staleOverride = new Map();
const site = await startSite({
  index: readWikiFile(),
  bindings: { CF_ZONE_ID: "zone123", CF_API_TOKEN: "token" },
  outbound: async (req) => {
    const body = req.method === "GET" ? "" : await req.text();
    outbound.push({ method: req.method, url: req.url, body });
    return new Response(req.url.includes("purge_cache") ? '{"success":true}' : "{}", { status: req.method === "GET" ? 404 : 200 });
  },
  publicSite: { cors: () => publicCors, override: key => staleOverride.get(key) }
});
const { mf, base, pub: PUB, bucket } = site;
const purged = () => outbound.filter(o => o.url.includes("purge_cache")).map(o => JSON.parse(o.body));

const { check, results } = createChecks();
async function server(title) {
  const r = await mf.dispatchFetch(`${base}/recipes/default/tiddlers/${encodeURIComponent(title)}`);
  return r.status === 200 ? await r.json() : null;
}

const browser = await launchBrowser();
const context = await browser.newContext();
const net = [];   // saves and deletes, with their answers
const { requests, pageErrors, watch } = createWatcher(site);
async function openTab(tag) {
  const page = await context.newPage();
  await watch(page, tag);
  page.on("response", r => {
    const q = r.request();
    if (q.method() === "PUT" || q.method() === "DELETE") {
      const h = q.headers();
      net.push({ tag, method: q.method(), path: decodeURIComponent(new URL(q.url()).pathname), status: r.status(),
        ifMatch: h["if-match"] || "", ifNoneMatch: h["if-none-match"] || "" });
    }
  });
  page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource") && !(tag === "D" && m.text().includes("CORS"))) pageErrors.push(`${tag} console: ${m.text()}`); });
  await page.goto(base + "/");
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
  return page;
}
const settle = page => settleTab(page, 20000);
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
// The same for a tiddler the tab created itself: it has no type there, while the server's copy has the
// default one the browser module sends
await create(A, "Kappa", "k1"); await settle(A); await sync(B);
await startEdit(A, "Kappa");
await editViaUI(B, "Kappa", "same"); await settle(B);
await finishEdit(A, "Kappa", "same"); await settle(A);
check("identical edits of a tiddler created in this tab: no conflict copy, no alert",
  (await conflictCopies(A, "Kappa")).length === 0 && (await alerts(A)).length === 0, JSON.stringify(await alerts(A)));
await clearAlerts(A);

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

// The same, when the request for the other tab's version (after the refusal) fails once: the delete,
// tried again later, is still based on the version the editor started from, so it's refused again
// rather than deleting the newer version
await create(A, "Iota", "i1"); await settle(A); await sync(B);
mark = net.length;
await startEdit(B, "Iota");
await editViaUI(A, "Iota", "i2 from A"); await settle(A);
await sync(B);
behindEditor = (await localText(B, "Iota")) === "i2 from A";
let iotaGetFailed = false;
await B.route(/\/recipes\/default\/tiddlers\/Iota$/, route => {
  if (route.request().method() === "GET" && !iotaGetFailed) { iotaGetFailed = true; return route.abort("failed"); }
  return route.continue();
});
await deleteFromEditor(B, "Iota"); await settle(B);
await B.unroute(/\/recipes\/default\/tiddlers\/Iota$/);
const iotaDeletes = netSince(mark).filter(x => x.tag === "B" && x.method === "DELETE" && x.path.endsWith("/Iota"));
check("...and when fetching the other tab's version after that refusal fails once, the delete tried again is refused too, the newer version kept",
  behindEditor && iotaGetFailed && iotaDeletes.length >= 2 && iotaDeletes.every(x => x.status === 412) &&
  (await server("Iota"))?.text === "i2 from A" && (await localText(B, "Iota")) === "i2 from A",
  JSON.stringify({ deletes: iotaDeletes.map(x => x.status), server: (await server("Iota"))?.text ?? null }));
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
// The list URL TiddlyWiki itself asks for (the worker purges its public copy): taken from a tab's
// request, not copied from the worker, so a TiddlyWiki that changed it would fail here
const listRequest = requests.find(r => r.origin === "worker" && /^\/recipes\/default\/tiddlers\.json\?filter=/.test(r.path) && !r.url.includes("cfworker-retry"));
const PUBLIC_LIST = listRequest ? PUB + new URL(listRequest.url).pathname + new URL(listRequest.url).search : "(no list request seen)";
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
// /status: asked from the worker by the first page load in this browser (tab A), then kept by the browser
const reachedWorker = rs => rs.filter(r => r.url.startsWith(base) && !r.cached);
const statusAsked = requests.filter(r => r.url === base + "/status");
check("the first page load in a browser asks the worker for /status, once",
  statusAsked.filter(r => !r.cached).length === 1 && statusAsked.find(r => !r.cached)?.tag === "A",
  JSON.stringify(statusAsked.map(r => `${r.tag}${r.cached ? " (cache)" : ""}`)));
check("later page loads make only 2 worker requests (page, tiddler list): /status comes from the browser's cache",
  reachedWorker(cReqs).length === 2 && cReqs.some(r => r.url === base + "/status" && r.cached),
  reachedWorker(cReqs).map(r => r.method + " " + new URL(r.url).pathname).join(", "));
check("...and TiddlyWiki still knows it's logged in as admin, writable", JSON.stringify(await C.evaluate(() =>
  ["$:/status/IsLoggedIn", "$:/status/UserName", "$:/status/IsReadOnly"].map(t => $tw.wiki.getTiddlerText(t)))) === '["yes","admin","no"]');
console.log("      worker requests during C's page load:", reachedWorker(cReqs).map(r => r.method + " " + decodeURIComponent(new URL(r.url).pathname)).join(", "));
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
const PROXY = await listen(proxy);
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
const codeAlerts = await alerts(other);
check("...and the alert says the copy is inactive, and how to use that version",
  codeAlerts.filter(t => t.includes("inactive") && t.includes("conflict-removed-")).length === 2, JSON.stringify(codeAlerts));
// Deleted in another tab: there's no original to copy the text into, so the advice is to rename the copy
const GONE = "$:/test/gone-marker.js";
await putCode(A, GONE, markerModule("before the delete")); await settle(A);
await sync(other);
await A.evaluate(t => $tw.wiki.deleteTiddler(t), GONE); await settle(A);
await putCode(other, GONE, markerModule("edited after the delete")); await settle(other);
const goneAlert = (await alerts(other)).find(t => t.includes("was deleted") && t.includes(GONE)) || "";
check("...when the original was deleted in another tab, it says to rename the copy and give its module-type back",
  /inactive/.test(goneAlert) && /rename it/.test(goneAlert) && /module-type/.test(goneAlert) && !/copy its text/.test(goneAlert), goneAlert);
// A raw markup tiddler with TiddlyWiki's older tag, $:/core/wiki/rawmarkup (still rendered into the
// page's <head>): its copy loses that tag too, as every $:/ tag, so the copy's markup isn't published
const OLD_RAW = "Old-style raw markup";
await create(A, OLD_RAW, "<meta name='cfw-old' content='original'>", { tags: ["$:/core/wiki/rawmarkup", "notes"] }); await settle(A);
await sync(other);
await startEdit(other, OLD_RAW);
await editViaUI(A, OLD_RAW, "<meta name='cfw-old' content='A'>"); await settle(A);
await sync(other);
await finishEdit(other, OLD_RAW, "<meta name='cfw-old' content='other tab'>"); await settle(other);
const oldRawCopies = await conflictCopies(other, OLD_RAW);
const oldRawCopy = oldRawCopies.length === 1 ? await server(oldRawCopies[0]) : null;
check("a conflict copy of a tiddler with the older raw markup tag loses that tag too (every $:/ tag moved aside), keeping the others",
  !!oldRawCopy && JSON.stringify(oldRawCopy.tags) === '["notes"]' && oldRawCopy["conflict-removed-tags"] === "$:/core/wiki/rawmarkup",
  JSON.stringify(oldRawCopy && { tags: oldRawCopy.tags, removed: oldRawCopy["conflict-removed-tags"] }));
await clearAlerts(other);
await other.close();

// --- 16. Backups failing are shown in the admin wiki ---------------------------------------------
// The worker records backups GitHub keeps refusing (_backup/status.json, written by the queue
// consumer; stored here directly). A page load asks with its first tiddler list request, and the
// problem appears as an alert, which goes once the backups get through.
const BACKUP_ALERT = "$:/temp/cfworker/backup-alert";
const hourAgo = Date.now() - 2 * 3600 * 1000;
await bucket.put("_backup/status.json", JSON.stringify({ failing: {
  "Alpha": { since: hourAgo, last: Date.now(), error: "Bad credentials", status: 401 },
  "Beta": { since: hourAgo + 60000, last: Date.now(), error: "Bad credentials", status: 401 } } }));
let reqMark16 = requests.length;
const K = await openTab("K");
const firstListAsk = requests.slice(reqMark16).find(r => r.tag === "K" && r.url.includes("tiddlers.json"))?.headers["x-backup-status"];
await K.waitForFunction(t => $tw.wiki.tiddlerExists(t), BACKUP_ALERT, { timeout: 10000 }).catch(() => {});
const backupAlert = await K.evaluate(t => { const a = $tw.wiki.getTiddler(t); return a ? { tags: a.fields.tags, text: a.fields.text } : null; }, BACKUP_ALERT);
check("a page load asks how backups go with its first tiddler list request", firstListAsk === "ask", String(firstListAsk));
check("...and failing backups show as an alert: since when, how many, the oldest, GitHub's answer, what to do",
  !!backupAlert && (backupAlert.tags || []).includes("$:/tags/Alert") && /2 tiddlers/.test(backupAlert.text) && backupAlert.text.includes("[[Alpha]]") &&
  backupAlert.text.includes("Bad credentials") && backupAlert.text.includes("GITHUB_TOKEN"), JSON.stringify(backupAlert));
reqMark16 = requests.length;
await bucket.delete("_backup/status.json");
await sync(K);
const askedWhileShown = requests.slice(reqMark16).some(r => r.tag === "K" && r.url.includes("tiddlers.json") && r.headers["x-backup-status"] === "ask");
check("...while it shows, each tiddler list request asks again, and the alert goes once backups get through",
  askedWhileShown && !(await K.evaluate(t => $tw.wiki.tiddlerExists(t), BACKUP_ALERT)));
reqMark16 = requests.length;
await sync(K);
check("...after that, the next requests don't ask (once an hour)", !requests.slice(reqMark16).some(r => r.tag === "K" && r.headers["x-backup-status"]),
  JSON.stringify(requests.slice(reqMark16).filter(r => r.tag === "K").map(r => r.url)));
await K.close();

// --- 17. A tiddler changed before its text has loaded keeps its text -------------------------------
// After a page load, TiddlyWiki has each tiddler's fields from the list, and loads the texts one by
// one. One changed before its text arrives (a checkbox clicked during that time) is saved without
// it: the worker keeps the stored text, and the tab then loads it
await create(A, "Task", "important text that must not be lost", { tags: ["todo"] });
await settle(A);
const skinnyTab = await context.newPage();
await watch(skinnyTab, "S");
let releaseText;
const textHeld = new Promise(r => { releaseText = r; });
await skinnyTab.route(/\/recipes\/default\/tiddlers\/Task$/, async route => {
  if (route.request().method() === "GET") await textHeld;
  return route.continue();
});
await skinnyTab.goto(base + "/");
await skinnyTab.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("Task"));
const wasSkinny = await skinnyTab.evaluate(() => $tw.wiki.getTiddler("Task").hasField("_is_skinny"));
await skinnyTab.evaluate(() => { const t = $tw.wiki.getTiddler("Task"); $tw.wiki.addTiddler(new $tw.Tiddler(t, { tags: t.fields.tags.concat("done") })); });
releaseText();
await settle(skinnyTab);
await skinnyTab.waitForFunction(() => $tw.wiki.getTiddlerText("Task") !== null && !$tw.wiki.getTiddler("Task").hasField("_is_skinny"), null, { timeout: 15000 }).catch(() => {});
const skinnyServer = await server("Task");
const skinnyLocal = await skinnyTab.evaluate(() => ({ text: $tw.wiki.getTiddlerText("Task"), tags: $tw.wiki.getTiddler("Task").fields.tags }));
check("a tiddler changed before its text loaded keeps its text on the server, with the change, and the tab gets the text",
  wasSkinny && skinnyServer?.text === "important text that must not be lost" && JSON.stringify(skinnyServer?.tags) === '["todo","done"]' &&
  !("_is_skinny" in (skinnyServer || {})) && skinnyLocal.text === "important text that must not be lost" && skinnyLocal.tags.includes("done"),
  JSON.stringify({ wasSkinny, server: skinnyServer && { text: skinnyServer.text, tags: skinnyServer.tags, skinny: "_is_skinny" in skinnyServer }, local: skinnyLocal }));
await skinnyTab.close();

// Tags and fields that read as numbers: a tiddler tagged 2024 with a field year: 2024, and a field a
// script set to a number, are stored (all as text, as TiddlyWiki keeps them)
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),
  { title: "Report", text: "x", tags: "2024 [[year 2024]]", year: "2024", count: 42 }, $tw.wiki.getModificationFields())));
await settle(A);
const report = await server("Report");
check("a tiddler tagged 2024, with a field year: 2024, and a field a script set to the number 42, is saved",
  JSON.stringify(report?.tags) === '["2024","year 2024"]' && report?.year === "2024" && report?.count === "42" &&
  JSON.stringify(await A.evaluate(() => $tw.wiki.filterTiddlers("[tag[2024]]"))) === '["Report"]', JSON.stringify(report));

// --- 18. What the worker doesn't store isn't sent, and what's sent is stored ----------------------
// TiddlyWiki takes any tiddler with a draft.of field for a draft, even an empty one: never sent (the
// worker would answer without storing it, and the next poll would delete it from the tab). A second
// story river's $:/StoryList/2 is sent and stored, so a new tab has it.
mark = net.length;
await A.evaluate(() => {
  $tw.wiki.addTiddler(new $tw.Tiddler({ title: "Empty draft.of", "draft.of": "", text: "kept in the tab" }));
  $tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/StoryList/2", list: "Alpha" }));
});
await settle(A);
await sync(A);
const emptyDraftSent = netSince(mark).some(x => x.path.endsWith("/Empty draft.of"));
const emptyDraftKept = await A.evaluate(() => $tw.wiki.getTiddlerText("Empty draft.of"));
check("a tiddler with an empty draft.of field (a draft, for TiddlyWiki) isn't sent, and stays in the tab after a poll",
  !emptyDraftSent && emptyDraftKept === "kept in the tab", JSON.stringify({ sent: emptyDraftSent, kept: emptyDraftKept }));
const secondRiver = await server("$:/StoryList/2");
check("a second story river's $:/StoryList/2 is stored, for the next tab", secondRiver?.list === "Alpha", JSON.stringify(secondRiver));

// --- 19. A save stored though its answer was lost, edited again before it's tried again ------------
// The next try carries the newer text, based on the version before: the worker refuses it (412), as
// it can't tell whose the stored version is. The server's copy is this tab's own earlier save, which
// the browser module recognises: it's sent again on it, with no conflict copy.
await create(A, "Lost answer", "v1"); await settle(A);
mark = net.length;
let loseAnswer = true;
const lostAnswerUrl = /\/recipes\/default\/tiddlers\/Lost%20answer$/;
await A.route(lostAnswerUrl, async route => {
  if (route.request().method() !== "PUT" || !loseAnswer) return route.continue();
  await route.fetch();                          // stored by the worker...
  loseAnswer = false;
  return route.fulfill({ status: 502, body: "answer lost" });   // ...but the tab sees an error
});
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Lost answer"), { text: "v2" })));
for (let i = 0; i < 100 && loseAnswer; i++) await new Promise(r => setTimeout(r, 100));
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Lost answer"), { text: "v3, edited again" })));
await settle(A);
await A.unroute(lostAnswerUrl);
const lostSaves = netSince(mark).filter(x => x.tag === "A" && x.method === "PUT" && x.path.endsWith("/Lost answer")).map(x => x.status);
check("a save stored though its answer was lost, edited again before it's tried again: no conflict copy, the newer text saved",
  !loseAnswer && (await conflictCopies(A, "Lost answer")).length === 0 && (await server("Lost answer"))?.text === "v3, edited again" &&
  !(await alerts(A)).some(t => t.includes("Edit conflict")),
  JSON.stringify({ saves: lostSaves, server: (await server("Lost answer"))?.text, alerts: await alerts(A) }));
await clearAlerts(A);

// --- Summary --------------------------------------------------------------------------------
// (Leaving out the answer section 19 makes the tab see on purpose)
const bad = net.filter(x => (x.status === 428 || x.status >= 500) && !(x.status === 502 && x.path.endsWith("/Lost answer")));
check("no 428/5xx responses anywhere", bad.length === 0, JSON.stringify(bad));
await finish({ check, results, pageErrors, browser, site, note: `; ${net.filter(x => x.status === 412).length} conflicts detected; ${net.length} writes` });
