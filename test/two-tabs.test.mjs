// End-to-end test: the worker in workerd (Miniflare) with R2, a real TiddlyWiki in Chromium, several tabs,
// and a second browser. Covers edit-conflict protection (between browsers: the tabs of one browser follow
// each other since design 1.16, so a tab there is never stale), baking, public-cache purges, the 304, the
// request savings, and the tabs following each other.
// Run: npm run test:tabs   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
import http from "node:http";
import { createChecks, createWatcher, FAST, finish, launchBrowser, listen, readWikiFile, settle as settleTab, startSite, waitFor } from "./browser-harness.mjs";

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
const context2 = await browser.newContext();   // another browser, a device of its own: nothing shared with the first, no channel, no device copy
const net = [];   // saves and deletes, with their answers
const { requests, pageErrors, watch } = createWatcher(site);
async function openTab(tag, ctx = context) {
  const page = await ctx.newPage();
  await watch(page, tag);
  page.on("response", r => {
    const q = r.request();
    if (q.method() === "PUT" || q.method() === "DELETE") {
      const h = q.headers();
      net.push({ tag, method: q.method(), path: decodeURIComponent(new URL(q.url()).pathname), status: r.status(),
        ifMatch: h["if-match"] || "", ifNoneMatch: h["if-none-match"] || "", at: Date.now() });
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
// (A click in a tab behind another takes seconds: the browser throttles the frames Playwright waits
// on before clicking. The tab is brought to the front first, as a user's would be.)
async function startEdit(page, title) {
  await page.bringToFront();
  await page.evaluate(t => new $tw.Story().navigateTiddler(t), title);
  const button = page.locator(`.tc-tiddler-frame[data-tiddler-title="${title}"] button[aria-label="Edit this tiddler"]`).first();
  // (A click lost to a refresh of the story river on a loaded machine: clicked again)
  for (let attempt = 1; ; attempt++) {
    await button.click();
    const edited = await page.waitForFunction(t => !!$tw.wiki.findDraft(t), title, { timeout: 5000 }).then(() => true, () => false);
    if (edited) return;
    if (attempt === 6) throw new Error(`no draft of '${title}' after ${attempt} clicks on Edit`);
  }
}
async function finishEdit(page, title, text, newTitle) {
  await page.bringToFront();
  const draftTitle = await page.evaluate(([t, text, newTitle]) => {
    const d = $tw.wiki.findDraft(t);
    const fields = { text };
    if (newTitle) fields["draft.title"] = newTitle;
    $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(d), fields));
    return d;
  }, [title, text, newTitle]);
  const confirm = page.locator(`.tc-tiddler-frame[data-tiddler-title="${draftTitle}"] button[aria-label="Confirm changes to this tiddler"]`).first();
  // (A click lost to a refresh of the story river on a loaded machine: clicked again, as in startEdit)
  for (let attempt = 1; ; attempt++) {
    await confirm.click();
    const saved = await page.waitForFunction(d => !$tw.wiki.tiddlerExists(d), draftTitle, { timeout: 5000 }).then(() => true, () => false);
    if (saved) return;
    if (attempt === 6) throw new Error(`the draft of '${title}' is still there after ${attempt} clicks on Confirm`);
  }
}
// Deletes the tiddler from its open editor (TiddlyWiki asks for confirmation)
async function deleteFromEditor(page, title) {
  await page.bringToFront();
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
// Drops the copies of loaded tiddlers kept on the device (shared by every tab of this browser), so
// the next load fetches them again (the device's copy itself: test:lazy)
const forgetDevice = page => page.evaluate(() => new Promise(resolve => {
  const q = indexedDB.deleteDatabase("cfworker-tiddlers");
  q.onsuccess = q.onerror = () => resolve();
  setTimeout(resolve, 3000);
}));

// --- 0. Baked page + legacy clients -------------------------------------------------------
const home = await (await mf.dispatchFetch(base + "/")).text();
check("baked page includes the conflict guard module", home.includes("$:/cfworker/conflict-guard.js"));
const A = await openTab("A");
const B = await openTab("B", context2);   // the other browser
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
await A.bringToFront(); await sync(A); await settle(A);   // (what the other browser saved last, loaded here and kept on this browser's device)
let reqMark = requests.length;
const C = await openTab("C");
const workerTiddlerGets = rs => rs.filter(r => r.method === "GET" && r.url.startsWith(base + "/recipes/default/tiddlers/"));
const publicTiddlerGets = rs => rs.filter(r => r.method === "GET" && r.url.startsWith(PUB + "/recipes/default/tiddlers/"));
let cReqs = requests.slice(reqMark).filter(r => r.tag === "C");
const texts = await C.evaluate(() => [1,2,3,4,5].map(i => $tw.wiki.getTiddlerText("Note " + i)));
check("new tab loads every tiddler correctly", texts.every((t, i) => t === `note text ${i + 1}`), JSON.stringify(texts));
check("page load takes the tiddlers from the device (the tabs that saved them kept them there), none from the worker",
  workerTiddlerGets(cReqs).length === 0 && publicTiddlerGets(cReqs).length === 0,
  `worker ${workerTiddlerGets(cReqs).length}, public ${publicTiddlerGets(cReqs).length}`);
// /status: asked from the worker by the first page load in this browser (tab A), then kept by the browser
const reachedWorker = rs => rs.filter(r => r.url.startsWith(base) && !r.cached);
const statusAsked = requests.filter(r => r.url === base + "/status");
check("the first page load in each browser asks the worker for /status, once (A; B in the other browser), the later loads in a browser get it from its cache",
  JSON.stringify(statusAsked.filter(r => !r.cached).map(r => r.tag).sort()) === '["A","B"]',
  JSON.stringify(statusAsked.map(r => `${r.tag}${r.cached ? " (cache)" : ""}`)));
check("later page loads make only 2 worker requests (page, tiddler list): /status comes from the browser's cache",
  reachedWorker(cReqs).length === 2 && cReqs.some(r => r.url === base + "/status" && r.cached),
  reachedWorker(cReqs).map(r => r.method + " " + new URL(r.url).pathname).join(", "));
check("...and TiddlyWiki still knows it's logged in as admin, writable", JSON.stringify(await C.evaluate(() =>
  ["$:/status/IsLoggedIn", "$:/status/UserName", "$:/status/IsReadOnly"].map(t => $tw.wiki.getTiddlerText(t)))) === '["yes","admin","no"]');
console.log("      worker requests during C's page load:", reachedWorker(cReqs).map(r => r.method + " " + decodeURIComponent(new URL(r.url).pathname)).join(", "));
check("no $:/StoryList or draft writes reach the worker", !net.some(x => x.path.includes("$:/StoryList") || x.path.includes("Draft of")));

// public copy is stale (even past the cache) -> falls back to the worker
await sync(C);
staleOverride.set("recipes/default/tiddlers/Note 1", await (await bucket.get("recipes/default/tiddlers/Note 1")).text());
await sync(B); await editViaUI(B, "Note 1", "note 1 edited"); await settle(B);   // (saved in the other browser: a save in this one would hand C the new version at once, design 1.16)
await forgetDevice(C);   // (without this browser's device copy either)
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
await forgetDevice(C);
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
await new Promise(r => setTimeout(r, FAST.errorRetry * 1.5));   // TiddlyWiki's own retry comes once in this; the quiet retries would be many
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
// Drafts are never saved to the server, so TiddlyWiki's syncer wouldn't ask before the tab closes or
// reloads: the browser asks here, as it does for unsaved changes, while an editor holds changes. The
// outbox keeps the draft on the device meanwhile, a moment behind the typing: the dialog is the belt
// over that (design 2.7). Not for an editor left unchanged.
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
check("closing a tab while typing in an editor asks first (a belt over the device's copy of the draft, a moment behind the typing)", whileTyping.asked && !whileTyping.closed, JSON.stringify(whileTyping));
if (!typing.isClosed()) await typing.close();
const looking = await openTab("F");
// (The half-typed draft is back in this tab, from the device: the outbox keeps drafts. Discarded here.)
const draftBack = await looking.evaluate(() => { const d = $tw.wiki.findDraft("Alpha"); const text = d ? $tw.wiki.getTiddlerText(d) : null; if (d) $tw.wiki.deleteTiddler(d); return text; });
check("...the half-typed draft is back in the next tab, from the device", draftBack === "half-typed sentence", JSON.stringify(draftBack));
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
const other = await openTab("H", context2);   // a tab in the other browser (B is closed by now)
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
  !!backupAlert && (backupAlert.tags || []).includes("$:/tags/Alert") && /2 tiddlers/.test(backupAlert.text) && backupAlert.text.includes('<$link to="Alpha">') &&
  backupAlert.text.includes("Bad credentials") && backupAlert.text.includes("GITHUB_TOKEN"), JSON.stringify(backupAlert));
const alertStamp = () => K.evaluate(t => { const a = $tw.wiki.getTiddler(t); return a ? $tw.utils.stringifyDate(a.fields.modified) : null; }, BACKUP_ALERT);
const stampShown = await alertStamp();
await sync(K);
await sync(K);
check("...and while the problem is the same, the alert isn't rewritten at each answer: its date stays", stampShown !== null && (await alertStamp()) === stampShown, `${stampShown} → ${await alertStamp()}`);
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
await K.evaluate(() => $tw.wiki.addTiddler({ title: "$:/config/cfworker/BackupCheckMinutes", text: "-5" }));
await sync(K);
reqMark16 = requests.length;
await sync(K);
check("...and a nonsense interval setting (-5 minutes) doesn't make every request ask: a minute at least", !requests.slice(reqMark16).some(r => r.tag === "K" && r.headers["x-backup-status"]),
  JSON.stringify(requests.slice(reqMark16).filter(r => r.tag === "K" && r.headers["x-backup-status"]).map(r => r.url)));
await K.evaluate(() => $tw.wiki.deleteTiddler("$:/config/cfworker/BackupCheckMinutes"));
await sync(K);
await K.close();
// A backup the runtime cut short (a version of several MB, over the free plan's CPU time: the queue
// tried it four times, nothing recorded why): the note the worker left before trying, reported
const BACKUP_STUCK = "$:/temp/cfworker/backup-stuck";
await bucket.put("_backup/status.json", JSON.stringify({ failing: {}, running: { "Gamma": { revision: "1791000000000", size: 4800000, started: Date.now() - 20 * 60000, attempt: 4 } } }));
const K2 = await openTab("K2");
await K2.waitForFunction(t => $tw.wiki.tiddlerExists(t), BACKUP_STUCK, { timeout: 10000 }).catch(() => {});
const stuckAlert = await K2.evaluate(t => { const a = $tw.wiki.getTiddler(t); return a ? { tags: a.fields.tags, text: a.fields.text } : null; }, BACKUP_STUCK);
check("a backup cut short four times on a big version shows as an alert: the tiddler, its size, how many times, what it most likely is (limits 5) and what to do",
  !!stuckAlert && (stuckAlert.tags || []).includes("$:/tags/Alert") && stuckAlert.text.includes('<$link to="Gamma">') && /4\.[0-9] MB/.test(stuckAlert.text) && /4 times/.test(stuckAlert.text) && /CPU/.test(stuckAlert.text) && /limits 5|\(5\)/.test(stuckAlert.text),
  JSON.stringify(stuckAlert));
await bucket.delete("_backup/status.json");
await sync(K2);
check("...and goes once the note is gone (each list request asks while it shows)", !(await K2.evaluate(t => $tw.wiki.tiddlerExists(t), BACKUP_STUCK)));
await K2.close();

// --- 17. A tiddler changed before its text has loaded keeps its text -------------------------------
// After a page load, TiddlyWiki has each tiddler's fields from the list, and loads the texts one by
// one. One changed before its text arrives (a checkbox clicked during that time) is saved without
// it: the worker keeps the stored text, and the tab then loads it
await create(A, "Task", "important text that must not be lost", { tags: ["todo"] });
await settle(A);
await forgetDevice(A);   // (so the new tab fetches the text, which the test holds back)
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
const skinnyMark = net.length;
await skinnyTab.evaluate(() => { const t = $tw.wiki.getTiddler("Task"); $tw.wiki.addTiddler(new $tw.Tiddler(t, { tags: t.fields.tags.concat("done") })); });
releaseText();
// (The save answered, then the text loaded: what the check needs, rather than the whole fill of a
// tab that starts with nothing on the device)
await waitFor(() => netSince(skinnyMark).some(x => x.tag === "S" && x.method === "PUT" && x.path.endsWith("/Task")), 15000);
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

// --- 19b. The same for a new tiddler: the retry mustn't carry the first try's "must not exist" ------
// A new tiddler's first save says If-None-Match: *. Stored, its answer lost, and the tiddler edited
// before the retry: the retry is refused (412), the browser module recognises its own earlier save
// and sends again based on it — with If-Match, and without the first try's header, or the worker
// refuses that too and the tab makes a conflict copy of its own text.
mark = net.length;
loseAnswer = true;
const newLostUrl = /\/recipes\/default\/tiddlers\/New%20lost%20answer$/;
await A.route(newLostUrl, async route => {
  if (route.request().method() !== "PUT" || !loseAnswer) return route.continue();
  await route.fetch();                          // stored by the worker...
  loseAnswer = false;
  return route.fulfill({ status: 502, body: "answer lost" });   // ...but the tab sees an error
});
await create(A, "New lost answer", "v1");
for (let i = 0; i < 100 && loseAnswer; i++) await new Promise(r => setTimeout(r, 100));
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("New lost answer"), { text: "v2, edited before the retry" })));
await settle(A);
await A.unroute(newLostUrl);
const newLostSaves = netSince(mark).filter(x => x.tag === "A" && x.method === "PUT" && x.path.endsWith("/New lost answer")).map(x => x.status);
check("a new tiddler whose first save's answer was lost, edited again before the retry: sent again on the stored version, no conflict copy, the newer text saved",
  !loseAnswer && (await conflictCopies(A, "New lost answer")).length === 0 && (await server("New lost answer"))?.text === "v2, edited before the retry" &&
  !(await alerts(A)).some(t => t.includes("Edit conflict")) && newLostSaves.filter(s => s === 412).length <= 1,
  JSON.stringify({ saves: newLostSaves, server: (await server("New lost answer"))?.text, alerts: await alerts(A) }));
await clearAlerts(A);

// --- 20. Titles at the edges, and a public site that doesn't answer ----------------------------------
// (quietOrNot: false rather than a timeout, for a tab whose syncer would keep retrying)
const quietOrNot = (page, ms = 20000) => settleTab(page, ms).then(() => true, () => false);
const L = await openTab("L", context2);   // the other browser: a tab that hasn't synced
// An edit conflict: A saves first, then L, which hasn't synced since
async function staleEdit(title) {
  await create(A, title, "first"); await settle(A); await sync(L);
  await A.evaluate(t => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(t), { text: "A's edit" })), title); await settle(A);
  await L.evaluate(t => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(t), { text: "L's stale edit" })), title);
  return quietOrNot(L);
}
// The tiddlers the links in a tab's alerts point to
const alertLinks = page => page.evaluate(() => {
  const div = document.createElement("div");
  $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").forEach(t => {
    $tw.wiki.makeWidget($tw.wiki.parseTiddler(t), { parentWidget: $tw.rootWidget, document }).render(div, null);
  });
  return [...div.querySelectorAll("a[href^='#']")].map(a => decodeURIComponent(a.getAttribute("href").slice(1)));
});

// The alert's links work whatever the title: one ending in "]", one holding "]]" and "|", and
// quotes: one kind, both kinds, and both with a final quote (which no quoted attribute can hold)
const EDGE_TITLES = ["Todo [x]", "Odd ]] title | with <<version>>", 'Say "hi"', 'Bob\'s "hi" there', 'Bob\'s "hi"'];
for (const title of EDGE_TITLES) await staleEdit(title);
const linked = await alertLinks(L);
const notLinked = EDGE_TITLES.filter(t => !linked.includes(t));
check("alert links point to the tiddler whatever its title (ending in ], holding ]] and |, a quote, both kinds, both with a final quote)",
  notLinked.length === 0, `not linked: ${JSON.stringify(notLinked)}; linked: ${JSON.stringify(linked)}`);
await clearAlerts(L);

// A public site that doesn't answer (rather than failing) doesn't hold up loading: after a short wait
// the text comes from the worker
await create(A, "Slow public copy", "loaded from the worker"); await settle(A);
await forgetDevice(A);
const M = await context.newPage();
await watch(M, "M");
await M.route(url => url.origin === PUB && url.pathname.endsWith("/tiddlers/Slow%20public%20copy"), () => {});   // never answered
const slowMark = requests.length;
await M.goto(base + "/");
const slowLoaded = await M.waitForFunction(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Slow public copy") === "loaded from the worker", null, { timeout: 30000 }).then(() => true, () => false);
const slowReads = requests.slice(slowMark).filter(r => r.tag === "M" && r.path === "/recipes/default/tiddlers/Slow public copy");
const slowPublic = slowReads.find(r => r.origin === "public"), slowWorker = slowReads.find(r => r.origin === "worker");
const slowWait = slowPublic && slowWorker ? slowWorker.at - slowPublic.at : null;
check("a public site that doesn't answer doesn't hold up loading: the text comes from the worker after a short wait (5 s in production, a scaled second here: within 2 s)",
  slowLoaded && slowWait !== null && slowWait < 2000, `${slowLoaded ? "loaded" : "not loaded"}; the worker asked ${slowWait} ms after the public site`);
await M.close();

// A conflict copy of a tiddler whose title is near the worker's limit (999 bytes): the copy's name,
// which adds the date, is shortened to fit, rather than refused for good (and retried forever)
const LONG_TITLE = "Long " + "y".repeat(990);
const longSettled = await staleEdit(LONG_TITLE);
const longCopies = await conflictCopies(L, LONG_TITLE);
const longCopy = longCopies.length === 1 ? await server(longCopies[0]) : null;
check("a conflict copy of a tiddler with a title near the length limit is saved, its name shortened to fit",
  longSettled && !!longCopy && Buffer.byteLength(longCopies[0]) <= 999 && longCopy.text === "L's stale edit",
  JSON.stringify({ settled: longSettled, copies: longCopies.map(t => Buffer.byteLength(t)), stored: !!longCopy }));
await clearAlerts(L);

// Titles "." and ".." can't be in a URL (the browser takes them for the current or parent folder): not
// sent, which would fail and be retried forever, and the tab says to rename them
mark = net.length;
await L.evaluate(() => { $tw.wiki.addTiddler({ title: ".", text: "a dot" }); $tw.wiki.addTiddler({ title: "..", text: "two dots" }); });
const dotsSettled = await quietOrNot(L, 15000);
const dotSends = netSince(mark).filter(x => x.tag === "L" && /^\/recipes\/default\/(tiddlers\/?)?$/.test(x.path));
const dotAlerts = (await alerts(L)).filter(t => /rename/i.test(t));
check("tiddlers titled . or .. aren't sent (a URL can't carry them), and the tab says to rename them",
  dotsSettled && dotSends.length === 0 && dotAlerts.length >= 1, JSON.stringify({ settled: dotsSettled, sent: dotSends.map(x => x.status), alerts: dotAlerts }));
// Kept on the device all the same (the outbox), so a reload doesn't lose them: the browser asks
// before a reload or a close, as for any unsaved change, the dropdown says how many are to rename,
// the two come back with the alert, and renamed, the tiddler is saved and the old title leaves the device
const outboxTitles = () => L.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open("cfworker-tiddlers");
  req.onsuccess = () => { const db = req.result; const get = db.transaction("outbox").objectStore("outbox").getAll(); get.onsuccess = () => { db.close(); resolve(get.result.map(e => e.title)); }; get.onerror = () => { db.close(); resolve(["error"]); }; };
  req.onerror = () => resolve(["open error"]);
}));
const toRename = () => L.evaluate(() => $tw.wiki.getTiddler("$:/temp/cfworker/outbox")?.fields.rename);
const dotsKept = await waitFor(async () => { const t = await outboxTitles(); return t.includes(".") && t.includes(".."); }, 5000);
const dotsToRename = await toRename();
let dotsAsked = false;
L.once("dialog", d => { dotsAsked = d.type() === "beforeunload"; d.accept().catch(() => {}); });
await L.reload();
await L.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
const dotsBack = await waitFor(() => L.evaluate(() => $tw.wiki.getTiddlerText(".") === "a dot" && $tw.wiki.getTiddlerText("..") === "two dots"), 10000);
await quietOrNot(L, 15000);
const dotsAlertBack = await waitFor(async () => (await alerts(L)).some(t => /rename/i.test(t)), 5000);
check("...kept on the device meanwhile (the dropdown says 2 to rename), a reload asks first, and after it the two are back, with the alert",
  dotsKept && dotsToRename === "2" && dotsAsked && dotsBack && dotsAlertBack, JSON.stringify({ kept: dotsKept, toRename: dotsToRename, asked: dotsAsked, back: dotsBack, alert: dotsAlertBack }));
await L.evaluate(() => { $tw.wiki.addTiddler({ title: "Dot", text: "a dot" }); $tw.wiki.deleteTiddler("."); $tw.wiki.deleteTiddler(".."); });
await settle(L);
const dotOutbox = await outboxTitles();
check("...renamed, the tiddler is saved, and the old titles leave the device", (await server("Dot"))?.text === "a dot" && !dotOutbox.includes(".") && !dotOutbox.includes("..") && (await toRename()) === "0",
  JSON.stringify({ stored: (await server("Dot"))?.text, outbox: dotOutbox, toRename: await toRename() }));
await L.close();

// --- 21. Restoring from the backup ---------------------------------------------------------------
// The backup holds each tiddler's stored bytes: TiddlyWeb's layout, tags as a list, with the old
// revision, bag and recipe. TiddlyWiki's JSON import keeps only text fields, so such a file dropped
// onto a wiki would lose its tags: the admin wiki's restore-import module takes those files over
// (TiddlyWiki's th-importing-file hook, the path a drop or the import button takes) and hands the
// import every field as text, without the old revision, bag and recipe; the save then creates the
// tiddler, not a conflict. Other files are read as TiddlyWiki reads them.
await clearAlerts(A);
await create(A, "Restored note", "the text to restore", { tags: "kept [[two words]]", color: "red" }); await settle(A);
const backupFile = await (await bucket.get("recipes/default/tiddlers/Restored note")).text();   // = tiddlers/Restored note.json on GitHub
const backupFields = JSON.parse(backupFile);
await mf.dispatchFetch(`${base}/bags/default/tiddlers/Restored%20note`, { method: "DELETE" });   // lost
await sync(A);
const lost = (await localText(A, "Restored note")) === null && (await server("Restored note")) === null;
// What TiddlyWiki's own deserializer makes of the file: the reason the module exists
const asIs = await A.evaluate(file => $tw.wiki.deserializeTiddlers("application/json", file)[0], backupFile);
check("TiddlyWiki's JSON deserializer drops a stored tiddler's tags (text fields only): hence the restore-import module",
  Array.isArray(backupFields.tags) && backupFields.tags.length === 2 && asIs && !("tags" in asIs) && asIs.text === "the text to restore", JSON.stringify(asIs));
// What a dropped file goes through: $tw.wiki.readFile, where the module's hook runs
const readFile = (page, name, type, text) => page.evaluate(([name, type, text]) => new Promise(resolve =>
  $tw.wiki.readFile(new File([text], name, { type }), fields => resolve(fields))), [name, type, text]);
const dropped = await readFile(A, "Restored note.json", "application/json", backupFile);
check("a backup file dropped onto the admin wiki comes through the import with its tags as text, without the old revision, bag and recipe",
  Array.isArray(dropped) && dropped.length === 1 && dropped[0].tags === "kept [[two words]]" && dropped[0].color === "red" && dropped[0].text === "the text to restore" &&
  !("revision" in dropped[0]) && !("bag" in dropped[0]) && !("recipe" in dropped[0]) && Object.values(dropped[0]).every(v => typeof v === "string"), JSON.stringify(dropped));
const several = await readFile(A, "two.json", "application/json", JSON.stringify([backupFields, { ...backupFields, title: "Second restored", tags: [], fields: { fields: "a field called fields" } }]));
check("...also a file holding several stored tiddlers, a nested custom field called fields flat again, an empty tag list as an empty string",
  Array.isArray(several) && several.length === 2 && several[1].title === "Second restored" && several[1].tags === "" && several[1].fields === "a field called fields" && several[0].tags === "kept [[two words]]", JSON.stringify(several));
const plain = [{ title: "Plain export", text: "from any TiddlyWiki", tags: "a [[b c]]" }];
const plainRead = await readFile(A, "plain.json", "application/json", JSON.stringify(plain));
const html = await readFile(A, "page.html", "text/html", "<html><body><div id='storeArea'><div title='From a page' tags='x'><pre>old wiki</pre></div></div></body></html>");
check("a plain TiddlyWiki JSON export, and an HTML wiki file, are read as TiddlyWiki reads them",
  Array.isArray(plainRead) && plainRead.length === 1 && plainRead[0].title === "Plain export" && plainRead[0].tags === "a [[b c]]" &&
  Array.isArray(html) && html.some(t => t.title === "From a page" && t.text === "old wiki"), JSON.stringify({ plainRead, html }));
mark = net.length;
await A.evaluate(fields => {
  // The import dialog's last step, once Import is clicked (the navigator widget's tm-perform-import)
  fields.forEach(f => $tw.wiki.addTiddler($tw.hooks.invokeHook("th-importing-tiddler", new $tw.Tiddler(f))));
}, dropped || []);
const restoredSettled = await quietOrNot(A);
const restored = await server("Restored note");
const restoreSends = netSince(mark).filter(x => x.tag === "A" && x.path.endsWith("/Restored note"));
const sameField = key => key === "revision" || JSON.stringify(backupFields[key]) === JSON.stringify(restored?.[key]);
check("imported, it's created again on the server with every field the same, tags included, but the revision, and no conflict",
  lost && restoredSettled && !!restored && Object.keys(backupFields).every(sameField) && Object.keys(restored).every(sameField) && restored.revision !== backupFields.revision &&
  restoreSends.length === 1 && restoreSends[0].status === 204 && restoreSends[0].ifNoneMatch === "*" && (await alerts(A)).length === 0,
  JSON.stringify({ lost, settled: restoredSettled, sends: restoreSends.map(x => `${x.status} ${x.ifMatch || x.ifNoneMatch}`), alerts: await alerts(A), backupFields, restored }));

// --- 22. Tabs following each other ------------------------------------------------------------------
// The tabs of one browser share their work over the outbox's channel (design 1.16, 2.27): a save or a
// delete the worker confirmed reaches the other tabs at once, with the worker's revision, and they
// make no request for it; a draft is one per tiddler for the browser, shown live in every tab that
// opens it, saved or cancelled everywhere at once.
const P = await openTab("P"), Q = await openTab("Q");
for (const page of [P, Q]) page.on("dialog", d => d.accept().catch(() => {}));   // "discard changes?", the guard's warning on reload
const tiddlerGets = (tag, title, from) => requests.slice(from).filter(r => r.tag === tag && r.method === "GET" && decodeURIComponent(r.url).includes("/tiddlers/" + title));
const draftOf = (page, title) => page.evaluate(t => $tw.wiki.findDraft(t) || null, title);
const editorFrame = (page, draftTitle) => page.frameLocator(`[data-tiddler-title="${draftTitle}"] iframe.tc-edit-texteditor`).locator("textarea");
const storyList = page => page.evaluate(() => $tw.wiki.getTiddlerList("$:/StoryList"));
const draftsListed = page => page.locator(".tc-drafts-list a.tc-tiddlylink").allInnerTexts();
// A keystroke's effect: the draft's text set as the edit widget sets it
const typeInto = (page, draftTitle, text) => page.evaluate(([d, text]) => $tw.wiki.setText(d, "text", null, text), [draftTitle, text]);
const textOf = (page, title) => page.evaluate(t => $tw.wiki.getTiddlerText(t, null), title);
async function reloadTab(page) {
  await page.reload();
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
}
const sectionStart = net.length;

// a. A save in one tab shows in the other at once, which makes no request for it
let followReq = requests.length, followMark = net.length, t0 = Date.now();
await create(P, "Followed note", "written in P");
const followed = await waitFor(async () => (await textOf(Q, "Followed note")) === "written in P", 5000);
const followedIn = (Date.now() - t0) / 1000;
await settle(P);
check("a tiddler saved in one tab shows in the other within a second, which made no request for it",
  followed && followedIn < 2 && tiddlerGets("Q", "Followed note", followReq).length === 0, `${followedIn.toFixed(1)} s, ${tiddlerGets("Q", "Followed note", followReq).length} loads by Q`);
await sync(Q);
const qRevision = await Q.evaluate(() => ($tw.syncer.tiddlerInfo["Followed note"] || {}).revision);
check("...and its next poll loads nothing: it holds the worker's revision", tiddlerGets("Q", "Followed note", followReq).length === 0 && String(qRevision) === String((await server("Followed note")).revision),
  `loads ${tiddlerGets("Q", "Followed note", followReq).length}, revision ${qRevision} vs ${(await server("Followed note")).revision}`);

// b. An edit through the UI: the draft travels, then the save; nothing left behind in the other tab
await editViaUI(P, "Followed note", "edited in P");
const editFollowed = await waitFor(async () => (await textOf(Q, "Followed note")) === "edited in P" && (await draftOf(Q, "Followed note")) === null, 5000);
check("an edit confirmed in one tab shows in the other at once, no draft left behind there, still no request", editFollowed && tiddlerGets("Q", "Followed note", followReq).length === 0,
  `${await textOf(Q, "Followed note")}, draft ${await draftOf(Q, "Followed note")}, loads ${tiddlerGets("Q", "Followed note", followReq).length}`);

// c. A delete
await P.evaluate(() => $tw.wiki.deleteTiddler("Followed note"));
await settle(P);
const deleteFollowed = await waitFor(() => Q.evaluate(() => !$tw.wiki.tiddlerExists("Followed note")), 5000);
await sync(Q);
check("a tiddler deleted in one tab is gone from the other at once, which sent no delete of its own", deleteFollowed && !netSince(followMark).some(x => x.tag === "Q" && x.method === "DELETE") && !(await Q.evaluate(() => $tw.wiki.tiddlerExists("Followed note"))),
  JSON.stringify(netSince(followMark).filter(x => x.tag === "Q").map(x => x.method + " " + x.path)));

// d. A draft begun in one tab is in the other at once, listed at the top of its page
await create(P, "Shared draft", "v1"); await settle(P);
await waitFor(async () => (await textOf(Q, "Shared draft")) === "v1", 5000);
followMark = net.length;
await startEdit(P, "Shared draft");
const sharedDraft = await draftOf(P, "Shared draft");
const listedInQ = await waitFor(async () => (await draftOf(Q, "Shared draft")) === sharedDraft && (await draftsListed(Q)).some(t => t.includes(sharedDraft)), 5000);
check("a draft begun in one tab is in the other at once, listed at the top of its page, its story untouched", listedInQ && !(await storyList(Q)).includes(sharedDraft),
  `draft in Q: ${await draftOf(Q, "Shared draft")}, listed: ${JSON.stringify(await draftsListed(Q))}, story: ${JSON.stringify(await storyList(Q))}`);
await typeInto(P, sharedDraft, "v2 typed in P");
check("...and its text follows the typing", await waitFor(async () => (await textOf(Q, sharedDraft)) === "v2 typed in P", 5000), JSON.stringify(await textOf(Q, sharedDraft)));

// e. The other tab opens it: an editor on the same draft, following on
await Q.bringToFront();
await Q.evaluate(d => new $tw.Story().navigateTiddler(d), sharedDraft);   // (what the drafts list's link does)
await editorFrame(Q, sharedDraft).waitFor({ timeout: 10000 });
check("the other tab opens the draft from its list: an editor on the same draft, with the text as typed", (await editorFrame(Q, sharedDraft).inputValue()) === "v2 typed in P" && (await storyList(Q)).includes(sharedDraft),
  JSON.stringify(await editorFrame(Q, sharedDraft).inputValue()));
await typeInto(P, sharedDraft, "v3 typed in P");
check("...its editor follows the typing in the first tab", await waitFor(async () => (await editorFrame(Q, sharedDraft).inputValue()) === "v3 typed in P", 5000), JSON.stringify(await editorFrame(Q, sharedDraft).inputValue()));

// f. Typed in the other tab, the first follows
await editorFrame(Q, sharedDraft).fill("v4 typed in Q");
const firstFollows = await waitFor(async () => (await textOf(P, sharedDraft)) === "v4 typed in Q" && (await editorFrame(P, sharedDraft).inputValue()) === "v4 typed in Q", 5000);
check("typed in the other tab, the first tab's draft and editor follow", firstFollows, `${JSON.stringify(await textOf(P, sharedDraft))} / editor ${JSON.stringify(await editorFrame(P, sharedDraft).inputValue())}`);
check("nothing of the draft reached the worker", !netSince(followMark).some(x => x.path.includes("Draft of")), JSON.stringify(netSince(followMark).map(x => x.method + " " + x.path)));

// f2. Keystrokes in turn, the tabs switched as a person switches them (the tab left gets blur, the one
// come to gets focus; Playwright's pages all think they have focus, so the events are sent by hand), the
// editors keeping focus as editors do. TiddlyWiki leaves a focused editor's text alone: the outbox puts
// another tab's typing into it while the tab isn't in use, so the tab left behind follows in its editor
// too and nothing typed is lost (design 2.27).
const leave = page => page.evaluate(() => window.dispatchEvent(new Event("blur")));
const enter = page => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function typeKeys(page, other, draftTitle, text) {
  await leave(other);
  await page.bringToFront(); await enter(page);
  const box = editorFrame(page, draftTitle);
  await box.click(); await box.press("End"); await box.pressSequentially(text, { delay: 20 });
}
await typeKeys(P, Q, sharedDraft, " p5");
const qFollowsKeys = await waitFor(async () => (await editorFrame(Q, sharedDraft).inputValue()) === "v4 typed in Q p5", 5000);
await typeKeys(Q, P, sharedDraft, " q6");
const pFollowsKeys = await waitFor(async () => (await editorFrame(P, sharedDraft).inputValue()) === "v4 typed in Q p5 q6", 5000);
await typeKeys(P, Q, sharedDraft, " p7");
const qFollowsAgain = await waitFor(async () => (await editorFrame(Q, sharedDraft).inputValue()) === "v4 typed in Q p5 q6 p7", 5000);
check("keystrokes in turn, each editor keeping focus: the tab left behind follows in its editor too, and no keystroke is lost",
  qFollowsKeys && pFollowsKeys && qFollowsAgain && (await textOf(P, sharedDraft)) === "v4 typed in Q p5 q6 p7" && (await textOf(Q, sharedDraft)) === "v4 typed in Q p5 q6 p7",
  `Q ${JSON.stringify(await editorFrame(Q, sharedDraft).inputValue())} P ${JSON.stringify(await editorFrame(P, sharedDraft).inputValue())} draft ${JSON.stringify(await textOf(P, sharedDraft))}`);

// g. Confirmed in the first tab: one save; the other's editor closes on the saved text
followMark = net.length;
await finishEdit(P, "Shared draft", "final text from P");
const closedInQ = await waitFor(async () => (await draftOf(Q, "Shared draft")) === null && (await textOf(Q, "Shared draft")) === "final text from P", 5000);
await settle(P); await settle(Q);
check("confirmed in the first tab: one save at the worker; in the other the editor closes on the saved text, no conflict copy, no alert",
  closedInQ && netSince(followMark).filter(x => x.method === "PUT" && x.path.endsWith("/Shared draft")).length === 1 && netSince(followMark).every(x => x.tag === "P") &&
  (await conflictCopies(Q, "Shared draft")).length === 0 && (await alerts(Q)).length === 0 && (await storyList(Q)).includes("Shared draft") && !(await storyList(Q)).includes(sharedDraft),
  `Q: ${JSON.stringify(await textOf(Q, "Shared draft"))}, draft ${await draftOf(Q, "Shared draft")}, story ${JSON.stringify(await storyList(Q))}, writes ${JSON.stringify(netSince(followMark).map(x => x.tag + " " + x.method + " " + x.path))}`);

// h. Cancelled in the first tab: gone from the other, its editor closed on the tiddler as it was
followMark = net.length;
await startEdit(P, "Shared draft");
await typeInto(P, sharedDraft, "to be discarded");
await waitFor(async () => (await textOf(Q, sharedDraft)) === "to be discarded", 5000);
await Q.bringToFront();
// (The frame of the draft closed a moment ago leaves the DOM 400 ms after the story, TiddlyWiki's closing
// animation, on a timer a background tab runs late: gone before the draft is opened here again)
await waitFor(() => Q.evaluate(d => !document.querySelector(`.tc-tiddler-frame[data-tiddler-title="${d}"]`), sharedDraft), 5000);
await Q.evaluate(d => new $tw.Story().navigateTiddler(d), sharedDraft);
await editorFrame(Q, sharedDraft).waitFor({ timeout: 10000 });
await P.bringToFront();
for (let attempt = 1; ; attempt++) {   // (a click lost to a refresh of the story river: clicked again, as in startEdit)
  await P.locator(`.tc-tiddler-frame[data-tiddler-title="${sharedDraft}"] button[aria-label="Discard changes to this tiddler"]`).first().click();
  if (await P.waitForFunction(d => !$tw.wiki.tiddlerExists(d), sharedDraft, { timeout: 5000 }).then(() => true, () => false)) break;
  if (attempt === 6) throw new Error("the draft is still there after 6 clicks on Discard");
}
const cancelledInQ = await waitFor(async () => (await draftOf(Q, "Shared draft")) === null, 5000);
check("cancelled in the first tab: the draft is gone from the other too, its editor closed on the tiddler as it was, nothing sent",
  cancelledInQ && (await textOf(Q, "Shared draft")) === "final text from P" && (await storyList(Q)).includes("Shared draft") && !(await storyList(Q)).includes(sharedDraft) && netSince(followMark).length === 0,
  `Q: ${JSON.stringify(await textOf(Q, "Shared draft"))}, story ${JSON.stringify(await storyList(Q))}, writes ${netSince(followMark).length}`);

// i. A reload while the other tab holds the draft: it comes back, as typed, and follows on
await startEdit(Q, "Shared draft");
await typeInto(Q, sharedDraft, "typed in Q before P reloads");
await waitFor(async () => (await textOf(P, sharedDraft)) === "typed in Q before P reloads", 5000);
// (P showed the keystroke over the channel at once; Q writes the draft to the device 300 ms after it,
// and a reload of P can only get the draft back from there: waited for, or P comes back without it)
const draftOnDevice = (page, text) => page.evaluate(x => new Promise(resolve => {
  const req = indexedDB.open("cfworker-tiddlers");
  req.onsuccess = () => { const db = req.result; const get = db.transaction("outbox").objectStore("outbox").getAll(); get.onsuccess = () => { db.close(); resolve(get.result.some(e => e.fields && e.fields.text === x)); }; get.onerror = () => { db.close(); resolve(false); }; };
  req.onerror = () => resolve(false);
}), text);
await waitFor(() => draftOnDevice(Q, "typed in Q before P reloads"), 5000);
await reloadTab(P);
const backAfterReload = await waitFor(async () => (await textOf(P, sharedDraft)) === "typed in Q before P reloads", 10000);
check("the first tab reloaded while the other holds the draft: it has the draft back, as typed", backAfterReload, JSON.stringify(await textOf(P, sharedDraft)));
await typeInto(Q, sharedDraft, "typed in Q after P's reload");
check("...and follows on", await waitFor(async () => (await textOf(P, sharedDraft)) === "typed in Q after P's reload", 5000), JSON.stringify(await textOf(P, sharedDraft)));
await finishEdit(Q, "Shared draft", "final from Q");
check("...saved in the other tab, the reloaded one shows the save", await waitFor(async () => (await textOf(P, "Shared draft")) === "final from Q" && (await draftOf(P, "Shared draft")) === null, 5000), JSON.stringify(await textOf(P, "Shared draft")));

// (Q's save of "Shared draft" goes out on the syncer's next tick, after P showed it over the channel:
// waited for here, or it goes out after the network is cut and counts as Q's own write below)
await settle(Q);
await waitFor(async () => (await server("Shared draft"))?.text === "final from Q", 5000);

// i2. With no network, a change made in one tab shows in the other at once: a change travels when it's
// made, as the version its tab will save, and the worker's revision follows when the save is confirmed
// (design 2.27). Here the browser offline cuts both tabs off (the suite blocks the service worker).
await context.setOffline(true);
followMark = net.length;
const offlineAt = Date.now();
await create(P, "Offline follow", "typed with no network");
const offlineFollowed = await waitFor(async () => (await textOf(Q, "Offline follow")) === "typed with no network", 5000);
const offlineFollowedIn = (Date.now() - offlineAt) / 1000;
await P.evaluate(() => $tw.wiki.deleteTiddler("Raced"));   // (a delete too: Raced is a tiddler both tabs have)
const offlineDeleteFollowed = await waitFor(() => Q.evaluate(() => !$tw.wiki.tiddlerExists("Raced")), 5000);
const qCleanOffline = await Q.evaluate(() => !$tw.syncer.isDirty());
check("with no network, a tiddler created in one tab shows in the other within a second, and one deleted is gone there, the other tab having nothing of its own to send",
  offlineFollowed && offlineFollowedIn < 2 && offlineDeleteFollowed && qCleanOffline && netSince(followMark).length === 0,
  `${offlineFollowedIn.toFixed(1)} s; Q: ${JSON.stringify(await textOf(Q, "Offline follow"))}, Raced ${await Q.evaluate(() => $tw.wiki.tiddlerExists("Raced"))}, clean ${qCleanOffline}; writes ${netSince(followMark).length}`);
await context.setOffline(false);
const offlineSent = await waitFor(async () => (await server("Offline follow"))?.text === "typed with no network" && (await server("Raced")) === null, 15000);
await settle(P);
const qRevision2 = await waitFor(async () => String(await Q.evaluate(() => ($tw.syncer.tiddlerInfo["Offline follow"] || {}).revision)) === String((await server("Offline follow"))?.revision), 10000);
check("the network back: the saving tab sends them, and the other tab then holds the worker's revision without a request of its own",
  offlineSent && qRevision2 && netSince(followMark).every(x => x.tag === "P") && tiddlerGets("Q", "Offline follow", followReq).length === 0,
  `sent ${offlineSent}, revision in Q ${qRevision2}, writes ${JSON.stringify(netSince(followMark).map(x => x.tag + " " + x.method + " " + x.path))}`);

// j. A conflict stays a conflict: a tab with its own unsaved change keeps it, and gets its copy at its save
await create(P, "Raced", "r1"); await settle(P);
await waitFor(async () => (await textOf(Q, "Raced")) === "r1", 5000);
await Q.route("**/recipes/default/tiddlers/Raced", async route => { if (route.request().method() === "PUT") await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
followMark = net.length; await clearAlerts(Q); await clearAlerts(P);
await create(Q, "Raced", "from Q");                       // Q's save, held 1.5 s on its way
await new Promise(r => setTimeout(r, 300));
await create(P, "Raced", "from P"); await settle(P);     // P's lands first; Q is told, but holds its own unsaved change
const racedSettled = await quietOrNot(Q);
await Q.unroute("**/recipes/default/tiddlers/Raced");
const copiesInP = await waitFor(async () => (await conflictCopies(P, "Raced")).length === 1, 5000);
check("a tab with its own unsaved change to a tiddler another tab saved keeps it, and gets its conflict copy at its save, as today; the copy reaches the first tab too",
  racedSettled && (await server("Raced"))?.text === "from P" && (await conflictCopies(Q, "Raced")).length === 1 && (await textOf(Q, "Raced")) === "from P" && netSince(followMark).some(x => x.tag === "Q" && x.status === 412) && copiesInP,
  `server ${JSON.stringify((await server("Raced"))?.text)}, Q ${JSON.stringify(await textOf(Q, "Raced"))}, copies Q ${(await conflictCopies(Q, "Raced")).length} P ${(await conflictCopies(P, "Raced")).length}, Q's answers ${JSON.stringify(netSince(followMark).filter(x => x.tag === "Q").map(x => x.status))}`);
await clearAlerts(Q); await clearAlerts(P);
check("no draft or story-list write reached the worker through all of this", !net.slice(sectionStart).some(x => x.path.includes("Draft of") || x.path.includes("$:/StoryList")), JSON.stringify(net.slice(sectionStart).filter(x => x.path.includes("Draft of") || x.path.includes("$:/StoryList")).map(x => x.path)));
await P.close(); await Q.close();

// --- Summary --------------------------------------------------------------------------------
// (Leaving out the answers sections 19 and 19b make the tab see on purpose)
const bad = net.filter(x => (x.status === 428 || x.status >= 500) && !(x.status === 502 && /\/(Lost answer|New lost answer)$/.test(x.path)));
check("no 428/5xx responses anywhere", bad.length === 0, JSON.stringify(bad));
await finish({ check, results, pageErrors, browser, site, note: `; ${net.filter(x => x.status === 412).length} conflicts detected; ${net.length} writes` });
