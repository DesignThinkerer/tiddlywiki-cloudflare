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

// Tiddler GETs of a tag since a mark: their titles in order, and how many were in flight at once
const tiddlerGets = (from, tag, origin) => requests.slice(from).filter(r => r.tag === tag && r.origin === origin && r.method === "GET" && r.path.startsWith(TIDDLER_PATH))
  .map(r => decodeURIComponent(r.path.slice(TIDDLER_PATH.length)));
const overlap = {};   // tag -> the most tiddler requests in flight at once
async function open(context, url, tag, { hidden = false } = {}) {
  const page = await context.newPage();
  await watch(page, tag);
  page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  let inFlight = 0;
  overlap[tag] = 0;
  const isTiddler = q => q.method() === "GET" && new URL(q.url()).pathname.startsWith(TIDDLER_PATH);
  page.on("request", q => { if (isTiddler(q)) overlap[tag] = Math.max(overlap[tag], ++inFlight); });
  page.on("requestfinished", q => { if (isTiddler(q)) inFlight--; });
  page.on("requestfailed", q => { if (isTiddler(q)) inFlight--; });
  if (hidden) {
    await page.addInitScript(() => {
      window.__hidden = true;
      Object.defineProperty(document, "hidden", { get: () => !!window.__hidden, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => window.__hidden ? "hidden" : "visible", configurable: true });
    });
  }
  await page.goto(url);
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  return page;
}
// Every tiddler there is, loaded with the text it should have
const allLoaded = page => page.evaluate(entries => entries.every(([title, text]) => $tw.wiki.getTiddlerText(title, null) === text), [...expected]);
const loadedCount = page => page.evaluate(() => $tw.wiki.filterTiddlers("[prefix[Tiddler ]!is[system]]").filter(t => !$tw.wiki.getTiddler(t).hasField("_is_skinny")).length);
const pending = page => page.evaluate(() => Object.keys($tw.syncer.titlesToBeLoaded).length);
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
check("...then everything fills in, from the public site, nothing through the worker", await allLoaded(A) && tiddlerGets(mark, "A", "worker").length === 0,
  `worker ${tiddlerGets(mark, "A", "worker").length}, public ${tiddlerGets(mark, "A", "public").length}`);
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
await sleep(2500);
const hiddenGets = tiddlerGets(mark, "C", "public");
check("a hidden tab loads what it shows and nothing more", shownHidden && JSON.stringify(hiddenGets) === '["Tiddler 30"]' && (await loadedCount(C)) === 1, `${JSON.stringify(hiddenGets.slice(0, 5))}, ${await loadedCount(C)} loaded`);
await C.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
await settle(C, 60000);
check("...and fills once shown", await allLoaded(C));
await C.close();

// --- 6. The fill turned off: a tiddler loads when shown, the rest stays skinny -------------------------
await put("$:/config/cfworker/LoadAll", { text: "no" });
check("the setting is built into the page, so the modules have it at boot", (await (await mf.dispatchFetch(base + "/")).text()).includes('"title":"$:/config/cfworker/LoadAll"'));
const admin4 = await browser.newContext();
mark = requests.length;
const D = await open(admin4, `${base}/#Tiddler%2050`, "D");
const shown50 = await waitFor(() => D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 50", null) !== null), 15000);
await sleep(2500);
const offGets = tiddlerGets(mark, "D", "public").concat(tiddlerGets(mark, "D", "worker"));
check("with $:/config/cfworker/LoadAll set to no, only the tiddler shown is fetched", shown50 && JSON.stringify(offGets) === '["Tiddler 50"]' && (await pending(D)) === 0 && (await loadedCount(D)) === 1,
  `${JSON.stringify(offGets.slice(0, 5))}, ${await pending(D)} pending, ${await loadedCount(D)} loaded`);
check("...the others are there, skinny: titles and fields, no text", (await D.evaluate(() => $tw.wiki.filterTiddlers("[prefix[Tiddler ]]").length)) === N - 1 &&
  await D.evaluate(() => $tw.wiki.getTiddler("Tiddler 51").hasField("_is_skinny")));
mark = requests.length;
await D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 51"));   // what a transclusion does
const shown51 = await waitFor(() => D.evaluate(() => $tw.wiki.getTiddlerText("Tiddler 51", null) !== null), 15000);
check("...and another loads the moment it's needed", shown51 && JSON.stringify(tiddlerGets(mark, "D", "public")) === '["Tiddler 51"]');
await D.close();
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

await finish({ check, results, pageErrors, browser, site });
