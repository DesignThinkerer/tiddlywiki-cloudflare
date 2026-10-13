// End-to-end test of loading a big wiki, on the admin site and the public site, in Chromium: the
// tiddler shown loads first; loaded tiddlers are kept on the device, so a refresh fetches only what
// changed; the rest fills in the background, several at a time, only while the tab is shown, without
// holding the page publisher; and the fill can be turned off (design 1.5).
// Run: npm run test:lazy
import { createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const N = 120;
const stale = new Map();   // key -> an older copy the public stand-in serves, except past a cache (cfworker-retry)
let slow = 0;              // milliseconds the stand-in waits before answering
const site = await startSite({
  index: readWikiFile(), publicStatus: true,
  publicSite: { override: (key, url) => url.search.includes("cfworker-retry") ? undefined : stale.get(key), delay: () => slow }
});
const { mf, base, pub: PUB, bucket } = site;
const { check, results } = createChecks();
const browser = await launchBrowser();
const { requests, pageErrors, watch } = createWatcher(site);

const TIDDLER_PATH = "/recipes/default/tiddlers/";
const text = i => `Tiddler ${i} text. ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(30);
const expected = new Map();   // title -> the text a tab should end up with
async function put(title, fields) {
  const r = await mf.dispatchFetch(`${base}${TIDDLER_PATH}${encodeURIComponent(title)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, ...fields })
  });
  if (r.status !== 204) throw new Error(`PUT ${title}: ${r.status} ${await r.text()}`);
  if (title.startsWith("Tiddler ")) expected.set(title, fields.text);
}
async function remove(title) {
  const r = await mf.dispatchFetch(`${base}/bags/default/tiddlers/${encodeURIComponent(title)}`, { method: "DELETE" });
  if (r.status !== 204) throw new Error(`DELETE ${title}: ${r.status}`);
  expected.delete(title);
}
for (let i = 1; i <= N; i++) await put(`Tiddler ${i}`, { text: text(i) });
// (and two with the characters a URL cares about, loaded from the public site like the others)
const AWKWARD = ["Tiddler Café, 100% #1? a+b", 'Tiddler with/slash & "quotes" 🎉'];
for (const title of AWKWARD) await put(title, { text: text(title) });

// Tiddler GETs of a tag since a mark: their titles in order, and how many were in flight at once
const tiddlerGets = (from, tag, origin) => requests.slice(from).filter(r => r.tag === tag && r.origin === origin && r.method === "GET" && r.path.startsWith(TIDDLER_PATH))
  .map(r => r.path.slice(TIDDLER_PATH.length));   // (the harness already decoded the path: a % in a title must not be decoded twice)
const overlap = {};   // tag -> the most tiddler requests in flight at once
// hidden: true or false installs a visibility the test controls (window.__hidden, then a visibilitychange
// event); noStore: no IndexedDB in this page. Every page counts TiddlyWiki's load steps (window.__loadSteps).
async function open(context, url, tag, { hidden, noStore = false } = {}) {
  const page = await context.newPage();
  await watch(page, tag);
  page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  let inFlight = 0;
  overlap[tag] = 0;
  const isTiddler = q => q.method() === "GET" && new URL(q.url()).pathname.startsWith(TIDDLER_PATH);
  page.on("request", q => { if (isTiddler(q)) overlap[tag] = Math.max(overlap[tag], ++inFlight); });
  page.on("requestfinished", q => { if (isTiddler(q)) inFlight--; });
  page.on("requestfailed", q => { if (isTiddler(q)) inFlight--; });
  if (hidden !== undefined) {
    await page.addInitScript(hidden => {
      window.__hidden = hidden;
      Object.defineProperty(document, "hidden", { get: () => !!window.__hidden, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => window.__hidden ? "hidden" : "visible", configurable: true });
    }, hidden);
  }
  if (noStore) await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true }));
  await page.addInitScript(() => {
    window.__loadSteps = 0;
    const timer = setInterval(() => {
      if (!window.$tw || !$tw.syncadaptor) return;
      clearInterval(timer);
      const load = $tw.syncadaptor.loadTiddler;
      $tw.syncadaptor.loadTiddler = function() { window.__loadSteps++; return load.apply(this, arguments); };
    }, 1);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  return page;
}
// Every tiddler there is, loaded with the text it should have
const allLoaded = page => page.evaluate(entries => entries.every(([title, text]) => $tw.wiki.getTiddlerText(title, null) === text), [...expected]);
const loadedCount = page => page.evaluate(() => $tw.wiki.filterTiddlers("[prefix[Tiddler ]!is[system]]").filter(t => !$tw.wiki.getTiddler(t).hasField("_is_skinny")).length);
const pending = page => page.evaluate(() => Object.keys($tw.syncer.titlesToBeLoaded).length);
const loadSteps = page => page.evaluate(() => window.__loadSteps);
const alerts = page => page.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").map(t => $tw.wiki.getTiddlerText(t)));
const show = page => page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
const hide = page => page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
}
const storedKeys = page => page.evaluate(() => new Promise(resolve => {
  const open = indexedDB.open("cfworker-tiddlers");
  open.onerror = () => resolve(null);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("tiddlers")) { db.close(); return resolve([]); }
    const q = db.transaction("tiddlers").objectStore("tiddlers").getAllKeys();
    q.onsuccess = () => { db.close(); resolve(q.result); };
    q.onerror = () => { db.close(); resolve(null); };
  };
}));

// --- 1. The admin site: a first load ---------------------------------------------------------------
const admin = await browser.newContext();
let mark = requests.length;
const A = await open(admin, `${base}/#Tiddler%20${N}`, "A");
const firstShown = await waitFor(() => A.evaluate(n => $tw.wiki.getTiddlerText("Tiddler " + n, null) !== null, N), 15000);
const gotSoFar = tiddlerGets(mark, "A", "public");
check("the tiddler opened directly is the first one fetched, before the background fill", firstShown && gotSoFar[0] === `Tiddler ${N}`, JSON.stringify(gotSoFar.slice(0, 5)));
await settle(A, 60000);
// (A public read the browser gave up on — the stand-in answering in more than the module's few
// seconds, on a loaded machine — falls back to the worker by design: allowed for that tiddler only)
const gaveUp = requests.slice(mark).filter(r => r.tag === "A" && r.origin === "public" && r.failed && r.path.startsWith(TIDDLER_PATH)).map(r => r.path.slice(TIDDLER_PATH.length));
const viaWorker = tiddlerGets(mark, "A", "worker");
check("...then everything fills in, from the public site, nothing through the worker (but a tiddler whose public read the browser gave up on)", await allLoaded(A) && viaWorker.every(t => gaveUp.includes(t)),
  `worker ${viaWorker.length} (${viaWorker.filter(t => gaveUp.includes(t)).length} after a public read given up on), public ${tiddlerGets(mark, "A", "public").length}`);
check("...several at a time", overlap.A >= 3, `at most ${overlap.A} in flight`);
let keys = await storedKeys(A);
check("...and every loaded tiddler is kept on the device", Array.isArray(keys) && keys.length >= N, `${keys && keys.length} stored`);

// --- 2. A refresh ---------------------------------------------------------------------------------
mark = requests.length;
await A.reload();
await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
await settle(A, 60000);
check("a refresh fetches no tiddler at all: they come from the device", await allLoaded(A) && tiddlerGets(mark, "A", "public").length === 0 && tiddlerGets(mark, "A", "worker").length === 0,
  JSON.stringify(tiddlerGets(mark, "A", "public").concat(tiddlerGets(mark, "A", "worker")).slice(0, 5)));
check("...the worker only served the page and the tiddler list", requests.slice(mark).filter(r => r.tag === "A" && r.origin === "worker" && !r.cached).map(r => r.path.replace(/\?.*/, "")).sort().join(" ") === "/ /recipes/default/tiddlers.json",
  requests.slice(mark).filter(r => r.tag === "A" && r.origin === "worker" && !r.cached).map(r => r.path).join(", "));
check("...and they arrive together, in far fewer load steps than there are tiddlers", (await loadSteps(A)) <= N / 3, `${await loadSteps(A)} load steps for ${N} tiddlers`);

// --- 3. Only what changed is fetched ------------------------------------------------------------------
await put("Tiddler 7", { text: text(7) + " (changed elsewhere)" });
await remove("Tiddler 8");
// A tiddler saved by this tab needn't be fetched either: the save keeps it on the device
await A.evaluate(([title, text]) => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(title), { text }, $tw.wiki.getModificationFields())), ["Tiddler 9", text(9) + " (edited here)"]);
expected.set("Tiddler 9", text(9) + " (edited here)");
await settle(A);
mark = requests.length;
await A.reload();
await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
await settle(A, 60000);
const after = await A.evaluate(() => [$tw.wiki.getTiddlerText("Tiddler 7", null), $tw.wiki.tiddlerExists("Tiddler 8"), $tw.wiki.getTiddlerText("Tiddler 9", null)]);
check("after a change elsewhere, a refresh fetches that tiddler only, and has the new text", JSON.stringify(tiddlerGets(mark, "A", "public")) === '["Tiddler 7"]' && after[0] === text(7) + " (changed elsewhere)",
  JSON.stringify(tiddlerGets(mark, "A", "public")));
check("...a tiddler saved in this tab wasn't fetched, and has the saved text", after[2] === text(9) + " (edited here)");
keys = await storedKeys(A);
check("...a tiddler deleted elsewhere is gone from the tab and from the device", after[1] === false && Array.isArray(keys) && !keys.includes("Tiddler 8") && keys.includes("Tiddler 7"), `${keys && keys.length} stored`);
// A tiddler this tab deletes leaves the device too
await A.evaluate(() => $tw.wiki.deleteTiddler("Tiddler 10"));
expected.delete("Tiddler 10");
await settle(A);
keys = await storedKeys(A);
check("a tiddler deleted in this tab is gone from the worker and from the device", !(await bucket.head("recipes/default/tiddlers/Tiddler 10")) && Array.isArray(keys) && !keys.includes("Tiddler 10"), `${keys && keys.length} stored`);
// The admin site too refuses a copy a cache kept after a change, and gets the new one past the cache: no worker request
const old11 = await (await bucket.get("recipes/default/tiddlers/Tiddler 11")).text();
await put("Tiddler 11", { text: text(11) + " (changed elsewhere)" });
stale.set("recipes/default/tiddlers/Tiddler 11", old11);
mark = requests.length;
await reload(A);
await settle(A, 60000);
const retried11 = requests.slice(mark).filter(r => r.tag === "A" && r.path.startsWith(TIDDLER_PATH + "Tiddler 11"));
check("a stale copy from a cache is refused on the admin site too, and fetched again past the cache, without the worker",
  (await A.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 11", null))) === text(11) + " (changed elsewhere)" && retried11.some(r => r.origin === "public" && r.path.includes("cfworker-retry")) &&
  !retried11.some(r => r.origin === "worker"), JSON.stringify(retried11.map(r => `${r.origin} ${r.path}`)));
stale.clear();
await A.close();

// --- 4. The page publisher doesn't wait for the fill --------------------------------------------------
slow = 300;   // a slow connection: the fill takes a while
const admin2 = await browser.newContext();
const B = await open(admin2, `${base}/`, "B");
await waitFor(() => B.evaluate(() => $tw.wiki.tiddlerExists("Tiddler 1")), 15000);
const shellBefore = (await bucket.head("_page/shell.html"))?.etag;
await B.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), { title: "$:/my/raw", tags: ["$:/tags/RawMarkup"], text: "<!-- lazy-test marker -->" }, $tw.wiki.getModificationFields())));
let pendingAtPublish = null;
const publishedWhileFilling = await waitFor(async () => {
  const shell = await bucket.get("_page/shell.html");
  if (!shell || shell.etag === shellBefore) return false;
  pendingAtPublish = await pending(B);
  return (await shell.text()).includes("lazy-test marker");
}, 20000);
check("a save while the fill is running publishes the page without waiting for the fill", publishedWhileFilling && pendingAtPublish > 0, `published ${publishedWhileFilling}, ${pendingAtPublish} loads still pending`);
slow = 0;
await settle(B, 90000);
check("...and the fill completes afterwards", await allLoaded(B));
await B.evaluate(() => $tw.wiki.deleteTiddler("$:/my/raw"));
await settle(B);
await B.close();

// --- 5. A hidden tab doesn't fill; it does once shown ------------------------------------------------
const admin3 = await browser.newContext();
mark = requests.length;
const C = await open(admin3, `${base}/#Tiddler%2030`, "C", { hidden: true });
const shownHidden = await waitFor(() => C.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 30", null) !== null), 15000);
await sleep(1500);   // (the fill, if it ran hidden, would start within the pause after the list)
const hiddenGets = tiddlerGets(mark, "C", "public");
check("a hidden tab loads what it shows and nothing more", shownHidden && JSON.stringify(hiddenGets) === '["Tiddler 30"]' && (await loadedCount(C)) === 1, `${JSON.stringify(hiddenGets.slice(0, 5))}, ${await loadedCount(C)} loaded`);
// A tiddler deleted elsewhere while the fill is held: not loaded once shown (no error)
await remove("Tiddler 31");
await C.evaluate(() => $tw.syncer.syncFromServer());
await waitFor(() => C.evaluate(() => !$tw.wiki.tiddlerExists("Tiddler 31")), 10000);
mark = requests.length;
await show(C);
await settle(C, 60000);
check("...and fills once shown, leaving out a tiddler deleted meanwhile, without an error", await allLoaded(C) && !tiddlerGets(mark, "C", "public").includes("Tiddler 31") && (await alerts(C)).length === 0,
  JSON.stringify(await alerts(C)));
await C.close();
// Hidden in the middle of the fill: it pauses (what was already asked for arrives), and goes on once shown.
// (A new context: with the device copy the tab above filled, the fill would be over in a tenth of a
// second, from the device; here it's the slow network's, 400 ms a fetch, several seconds long)
slow = 400;
const adminE = await browser.newContext();
const E = await open(adminE, `${base}/`, "E", { hidden: false });
await waitFor(async () => (await loadedCount(E)) >= 10, 20000);
await hide(E);
await sleep(3000);   // what was under way finishes (up to READ_AHEAD looked up, FETCH_AHEAD at a time, each slow)
mark = requests.length;
await sleep(1500);
const whileHidden = tiddlerGets(mark, "E", "public").length, loadedWhileHidden = await loadedCount(E);
await show(E);
slow = 0;
await settle(E, 60000);
check("hidden in the middle of the fill, a tab stops fetching, and goes on once shown", whileHidden === 0 && loadedWhileHidden < expected.size && await allLoaded(E),
  `${whileHidden} fetched while hidden, ${loadedWhileHidden} of ${expected.size} loaded then`);
await E.close();

// --- 6. The fill turned off: a tiddler loads when shown, the rest stays skinny -------------------------
await put("$:/config/cfworker/LoadAll", { text: "no" });
check("the setting is built into the page, so the modules have it at boot", (await (await mf.dispatchFetch(base + "/")).text()).includes('"title":"$:/config/cfworker/LoadAll"'));
const admin4 = await browser.newContext();
mark = requests.length;
const D = await open(admin4, `${base}/#Tiddler%2050`, "D");
const shown50 = await waitFor(() => D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 50", null) !== null), 15000);
await sleep(1500);   // (a fill, if one ran, would start within the pause after the list)
const offGets = tiddlerGets(mark, "D", "public").concat(tiddlerGets(mark, "D", "worker"));
check("with $:/config/cfworker/LoadAll set to no, only the tiddler shown is fetched", shown50 && JSON.stringify(offGets) === '["Tiddler 50"]' && (await pending(D)) === 0 && (await loadedCount(D)) === 1,
  `${JSON.stringify(offGets.slice(0, 5))}, ${await pending(D)} pending, ${await loadedCount(D)} loaded`);
check("...the others are there, skinny: titles and fields, no text", (await D.evaluate(() => $tw.wiki.filterTiddlers("[prefix[Tiddler ]]").length)) === expected.size &&
  await D.evaluate(() => $tw.wiki.getTiddler("Tiddler 51").hasField("_is_skinny")));
mark = requests.length;
await D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 51"));   // what a transclusion does
const shown51 = await waitFor(() => D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 51", null) !== null), 15000);
check("...and another loads the moment it's needed", shown51 && JSON.stringify(tiddlerGets(mark, "D", "public")) === '["Tiddler 51"]');
// What the tab holds in full and the worker has a newer version of is still reloaded
await put("Tiddler 50", { text: text(50) + " (changed elsewhere)" });
mark = requests.length;
await D.evaluate(() => $tw.syncer.syncFromServer());
const reloaded50 = await waitFor(() => D.evaluate(t => $tw.wiki.getTiddlerText("Tiddler 50", null) === t, text(50) + " (changed elsewhere)"), 15000);
check("...a loaded tiddler changed elsewhere is still reloaded", reloaded50 && JSON.stringify(tiddlerGets(mark, "D", "public")) === '["Tiddler 50"]', JSON.stringify(tiddlerGets(mark, "D", "public")));
// A skinny tiddler changed before its text loaded (a tag added, say) is saved without the text: the
// worker keeps the stored text, and the tab then loads it (a load a module asks for isn't dropped)
mark = requests.length;
await D.evaluate(() => { const t = $tw.wiki.getTiddler("Tiddler 52"); $tw.wiki.addTiddler(new $tw.Tiddler(t, { tags: ["done"] }, $tw.wiki.getModificationFields())); });
await settle(D);
const loaded52 = await waitFor(() => D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 52", null) !== null && !$tw.wiki.getTiddler("Tiddler 52").hasField("_is_skinny")), 15000);
const stored52 = await (await bucket.get("recipes/default/tiddlers/Tiddler 52")).json();
check("...a skinny tiddler changed before its text loaded keeps its text on the worker, and the tab loads it",
  loaded52 && stored52.text === text(52) && JSON.stringify(stored52.tags) === '["done"]' && (await D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 52"))) === text(52) && tiddlerGets(mark, "D", "public").includes("Tiddler 52"),
  JSON.stringify(tiddlerGets(mark, "D", "public")));
// A skinny tiddler edited before its text loaded (opened offline, say): TiddlyWiki's draft carries the
// mark, and its editor starts empty. What's typed there is what was meant: stored, and the tab shows it
const edited53 = await D.evaluate(() => {
  const wiki = $tw.wiki, title = "Tiddler 53";
  const find = w => w.parseTreeNode && w.parseTreeNode.type === "navigator" ? w : (w.children || []).map(find).find(Boolean);
  const navigator = find($tw.rootWidget);
  navigator.dispatchEvent({ type: "tm-edit-tiddler", param: title });   // the edit button
  const draft = wiki.findDraft(title), draftHadMark = wiki.getTiddler(draft).hasField("_is_skinny");
  wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler(draft), { text: "typed into the empty editor" }));   // typing
  navigator.dispatchEvent({ type: "tm-save-tiddler", param: draft });   // the save button
  return { wasSkinny: wiki.getTiddler(title).hasField("_is_skinny") || draftHadMark, draftHadMark };
});
await settle(D);
const loaded53 = await waitFor(() => D.evaluate(() => !$tw.wiki.getTiddler("Tiddler 53").hasField("_is_skinny")), 15000);
const stored53 = await (await bucket.get("recipes/default/tiddlers/Tiddler 53")).json();
check("...a skinny tiddler edited before its text loaded, its empty editor typed into: the typed text is stored, without the mark, and shown",
  edited53.draftHadMark && loaded53 && stored53.text === "typed into the empty editor" && !("_is_skinny" in stored53) &&
  (await D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 53"))) === "typed into the empty editor",
  JSON.stringify({ ...edited53, stored: stored53.text.slice(0, 40), markStored: "_is_skinny" in stored53, shown: String(await D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 53", null))).slice(0, 40) }));
expected.set("Tiddler 53", "typed into the empty editor");
await D.close();
// With TiddlyWiki's own lazy loading off, every tiddler has to be loaded in full: the setting is ignored
await put("$:/config/SyncDisableLazyLoading", { text: "yes" });
const admin5 = await browser.newContext();
const F = await open(admin5, `${base}/`, "F");
await settle(F, 60000);
check("with TiddlyWiki's lazy loading off ($:/config/SyncDisableLazyLoading), the fill runs whatever the setting", await allLoaded(F));
await F.close();
await remove("$:/config/SyncDisableLazyLoading");
await remove("$:/config/cfworker/LoadAll");

// --- 7. The public site --------------------------------------------------------------------------------
const visitors = await browser.newContext();
mark = requests.length;
const V = await open(visitors, `${PUB}/#Tiddler%20${N - 10}`, "V");
const visitorFirst = await waitFor(() => V.evaluate(n => $tw.wiki.getTiddlerText("Tiddler " + n, null) !== null, N - 10), 15000);
const visitorGets = tiddlerGets(mark, "V", "public");
check("a visitor's tab loads the tiddler it shows first", visitorFirst && visitorGets[0] === `Tiddler ${N - 10}`, JSON.stringify(visitorGets.slice(0, 5)));
await settle(V, 60000);
check("...fills in several at a time, and never uses the worker", await allLoaded(V) && overlap.V >= 3 && !requests.slice(mark).some(r => r.tag === "V" && r.origin === "worker"),
  `at most ${overlap.V} in flight, worker requests ${requests.slice(mark).filter(r => r.tag === "V" && r.origin === "worker").length}`);
mark = requests.length;
await V.reload();
await V.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
await settle(V, 60000);
check("a visitor's refresh fetches no tiddler: they come from the device", await allLoaded(V) && tiddlerGets(mark, "V", "public").length === 0, JSON.stringify(tiddlerGets(mark, "V", "public").slice(0, 5)));
check("...in far fewer load steps than there are tiddlers", (await loadSteps(V)) <= N / 3, `${await loadSteps(V)} load steps for ${expected.size} tiddlers`);
// A copy a cache kept after a change: refused, and fetched again past the cache
const old3 = await (await bucket.get("recipes/default/tiddlers/Tiddler 3")).text();
await put("Tiddler 3", { text: text(3) + " (changed again)" });
stale.set("recipes/default/tiddlers/Tiddler 3", old3);
mark = requests.length;
await V.reload();
await V.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
await settle(V, 60000);
const retried = requests.slice(mark).filter(r => r.tag === "V" && r.path.startsWith(TIDDLER_PATH + "Tiddler 3"));
check("a stale copy from a cache is refused, and the tiddler fetched again past it", (await V.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 3", null))) === text(3) + " (changed again)" &&
  retried.some(r => r.path.includes("cfworker-retry")), JSON.stringify(retried.map(r => r.path)));
stale.clear();
await V.close();

// --- 8. Without IndexedDB (a browser that refuses it): loads go over the network, as before ---------------
const noStore = await browser.newContext();
mark = requests.length;
const W = await open(noStore, `${PUB}/`, "W", { noStore: true });
await settle(W, 60000);
const firstWithout = tiddlerGets(mark, "W", "public").length;
mark = requests.length;
await reload(W);
await settle(W, 60000);
check("without IndexedDB, a tab loads everything over the network, and again at the next load", await allLoaded(W) && firstWithout >= expected.size && tiddlerGets(mark, "W", "public").length >= expected.size,
  `${firstWithout} then ${tiddlerGets(mark, "W", "public").length} fetched for ${expected.size} tiddlers`);
await W.close();

// --- 9. The advanced setting: tiddlers fetched at once during the fill ------------------------------------
// ($:/config/cfworker/FetchAhead, from the admin plugin's settings tab: set to 1, the fill goes one at a time)
await put("$:/config/cfworker/FetchAhead", { text: "1" });   // (a page tiddler: the next page build preloads it)
await (await mf.dispatchFetch(`${base}/`)).arrayBuffer();
const oneAtATime = await browser.newContext();
mark = requests.length;
const X = await open(oneAtATime, `${base}/`, "X");
await settle(X, 90000);
check("the fetch-ahead setting at 1: a new device's fill fetches one tiddler at a time (several by default)", await allLoaded(X) && overlap.X === 1 && tiddlerGets(mark, "X", "public").length >= expected.size,
  `at most ${overlap.X} in flight, ${tiddlerGets(mark, "X", "public").length} fetched`);
await X.close();
// Under 1 ("-1", a slip in the settings tab): counted as 1, not a fill that never starts
await put("$:/config/cfworker/FetchAhead", { text: "-1" });
await (await mf.dispatchFetch(`${base}/`)).arrayBuffer();
const underOne = await browser.newContext();
mark = requests.length;
const Y = await open(underOne, `${base}/`, "Y");
await waitFor(() => allLoaded(Y), 60000);
await settle(Y, 10000).catch(() => {});
check("...set under 1 (\"-1\"): counts as 1, and the fill still runs", await allLoaded(Y) && overlap.Y === 1 && tiddlerGets(mark, "Y", "public").length >= expected.size,
  `at most ${overlap.Y} in flight, ${tiddlerGets(mark, "Y", "public").length} fetched`);
await Y.close();
await remove("$:/config/cfworker/FetchAhead");

await finish({ check, results, pageErrors, browser, site });
