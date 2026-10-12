// Opening the admin wiki with no network (design 1.11): a service worker the admin site registers
// keeps the page, the core file, the plugin files, the status file and the last tiddler list; the
// tiddlers come from the device copy. Online nothing changes: the page is asked from the worker
// first, and an answer without the worker's mark (Cloudflare Access refusing, say) is shown as it is
// and never cached. A real TiddlyWiki in Chromium, the network cut and restored.
// Run: npm run test:cold
import fs from "node:fs";
import path from "node:path";
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

// R2 on disk: "no network" here is the worker and the public stand-in taken down (the browser's
// offline mode doesn't cut a service worker's own requests), then brought back with the same data
const r2Dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "wiki-cold-"));
let corsOn = true;   // the zone's CORS rule on the public stand-in (README 2.7), or not
const site = await startSite({ index: readWikiFile(), publicStatus: true, privateWiki: true, r2Persist: r2Dir, publicSite: { cors: () => corsOn } });
const { base: BASE, pub: PUB } = site;
const { check, results } = createChecks();
const browser = await launchBrowser({ serviceWorkers: "allow" });
const { pageErrors, watch } = createWatcher(site);
const CACHE = "cfworker-wiki-v1";
const responses = [];   // every response a page got: { tag, url, status, fromSW }
const dialogs = [];     // every browser dialog a page showed (the "Cannot load" alert of TiddlyWiki's page, say)

async function open(context, tag, url = BASE + "/", { wait = true } = {}) {
  const p = await context.newPage();
  await watch(p, tag);
  p.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  p.on("response", r => responses.push({ tag, url: r.url(), status: r.status(), fromSW: r.fromServiceWorker() }));
  p.on("dialog", d => { dialogs.push(`${tag}: ${d.message()}`); d.accept(); });
  const response = await p.goto(url);
  if (wait) await ready(p);
  return { p, response };
}
async function ready(p) {
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
}
async function reload(p, { wait = true } = {}) {
  const response = await p.reload();
  if (wait) await ready(p);
  return response;
}
const stored = async title => { const obj = await site.bucket.get("recipes/default/tiddlers/" + title); return obj ? (await obj.json()).text : null; };
// No network, for the page (the browser's offline mode) and for the service worker (nothing answers)
async function offline(context) { await site.stop(); await site.stopPublic(); await context.setOffline(true); }
async function online(context) { await context.setOffline(false); await site.start(); await site.startPublic(); }
const status = p => p.evaluate(() => { const t = $tw.wiki.getTiddler("$:/temp/cfworker/outbox"); return t ? { waiting: t.fields.waiting, online: t.fields.online } : null; });
const controller = p => p.evaluate(() => navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null);
const cached = p => p.evaluate(async name => { const c = await caches.open(name); return (await c.keys()).map(r => r.url); }, CACHE);
const CORE = "/_plugins/tiddlywikicore.js?v=";
// The core file taken out of the cache (a copy lost: a browser clearing space, a copy that didn't finish)
const dropCore = p => p.evaluate(async name => { const c = await caches.open(name); for (const k of await c.keys()) if (k.url.includes("/_plugins/tiddlywikicore.js")) await c.delete(k); }, CACHE);
const holds = async (p, ...parts) => { const keys = await cached(p); return parts.every(part => keys.some(u => u.includes(part))); };
// How the cache holds a URL: the response's type ("basic" from this site, "cors" from the public one, "opaque" never), or null
const cachedType = (p, url) => p.evaluate(async ([name, u]) => { const c = await caches.open(name); const r = await c.match(u); return r ? r.type : null; }, [CACHE, url]);
const got = (tag, from, test) => responses.slice(from).filter(r => r.tag === tag && test(r));

// --- 1. The first visit registers the service worker; it controls the page from the next load -------
const contextA = await browser.newContext();
const { p: A } = await open(contextA, "A");
const registered = await waitFor(() => A.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && (r.active || r.installing || r.waiting)); }), 15000);
check("the first visit registers the service worker", registered && await A.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope === location.origin + "/"));
await waitFor(() => A.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }), 15000);
await addTiddler(A, { title: "First note", text: "written online" });
await settle(A);
let mark = responses.length;
await reload(A);
check("...and controls the page from the next load, from a versioned address", /\/sw\.js\?v=[\w-]+$/.test((await controller(A)) || ""), JSON.stringify(await controller(A)));
await sleep(1000);
const keys1 = await cached(A);
check("after that load the cache holds the page, the core file, the status file and the tiddler list",
  keys1.some(u => u === BASE + "/") && keys1.some(u => u.includes("/_plugins/tiddlywikicore.js?v=")) && keys1.some(u => u.endsWith("/status")) && keys1.some(u => u.includes("/recipes/default/tiddlers.json")),
  keys1.map(u => u.replace(BASE, "")).join(", "));
// The setup check, from the Cloudflare tab (design 1.13): the worker's lines, then this browser's own
const SETUP = "$:/temp/cfworker/setup-check", TAB = "$:/temp/cfworker/ControlPanel";
async function setupCheck(p) {
  await p.evaluate(t => { $tw.wiki.deleteTiddler(t); $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-setup-check" }); }, SETUP);
  const done = await waitFor(() => p.evaluate(t => $tw.wiki.tiddlerExists(t) && $tw.wiki.getTiddler(t).fields.checked !== undefined, SETUP), 20000);
  const tab = done ? await p.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), TAB) : "";
  return { done, tab, lines: (tab.match(/[✓✗–] [^✓✗–]+/g) || []).map(l => l.trim()) };
}
const setup1 = await setupCheck(A);
check("the Cloudflare tab's \"Check the setup\" button lists the pieces: Access, the public site (nothing to check, a private wiki), backups, the queue, and this browser's service worker with the core file kept",
  setup1.done && setup1.lines.some(l => /^✓ .*Access/.test(l)) && setup1.lines.some(l => /^– .*private/i.test(l)) && setup1.lines.some(l => /^✓ .*service worker/.test(l)) && setup1.lines.some(l => /^✓ .*core file/.test(l)),
  setup1.lines.join(" | ") || `done ${setup1.done}`);

// --- 2. With the network cut, the wiki opens from the cache and the device ---------------------------
await offline(contextA);
mark = responses.length;
const { response: offlineLoad } = await reload(A, { wait: false }).then(r => ({ response: r })).catch(e => ({ response: null, error: e }));
const booted = await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 }).then(() => true).catch(() => false);
await sleep(2500);
check("with no network, the wiki opens: the page from the service worker", !!offlineLoad && offlineLoad.status() === 200 && offlineLoad.fromServiceWorker() && booted, `status ${offlineLoad && offlineLoad.status()}`);
check("...the core file, the status file and the tiddler list from the cache too, the tiddler from the device copy, logged in and writable",
  got("A", mark, r => r.url.includes("/_plugins/tiddlywikicore.js") && r.fromSW && r.status === 200).length === 1 &&
  got("A", mark, r => r.url.endsWith("/status") && r.fromSW && r.status === 200).length >= 1 &&
  got("A", mark, r => r.url.includes("/recipes/default/tiddlers.json") && r.fromSW && r.status === 200).length >= 1 &&
  await A.evaluate(() => $tw.wiki.getTiddlerText("First note") === "written online" && $tw.wiki.getTiddlerText("$:/status/IsLoggedIn") === "yes" && $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "no"),
  got("A", mark, r => r.fromSW).map(r => `${r.status} ${r.url.replace(BASE, "").split("?")[0]}`).join(", "));

// --- 3. A change made then waits in the outbox, and reaches the worker at the network's return ------
await addTiddler(A, { title: "Offline note", text: "written with no network" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
check("a change made offline waits in the outbox", (await status(A))?.waiting === "1" && (await status(A))?.online === "no", JSON.stringify(await status(A)));
await online(contextA);
check("...and reaches the worker at the network's return", await waitFor(async () => (await stored("Offline note")) === "written with no network", 15000));
await settle(A);

// --- 4. A tiddler never loaded on this device, opened offline: empty, no alert, no crash -------------
const contextC = await browser.newContext();
const { p: C } = await open(contextC, "C");
await addTiddler(C, { title: "Unseen", text: "never loaded by the other browser" });
await settle(C);
await addTiddler(A, { title: "$:/config/cfworker/LoadAll", text: "no" });
await settle(A);
await reload(A);   // online: the list has Unseen, left skinny (the fill is off)
check("(a tiddler saved elsewhere is listed, not loaded, with the fill off)", await A.evaluate(() => { const t = $tw.wiki.getTiddler("Unseen"); return !!t && t.hasField("_is_skinny"); }));
await offline(contextA);
await reload(A, { wait: false });
await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 });
await sleep(1500);
await A.evaluate(() => { new $tw.Story().navigateTiddler("Unseen"); });
await sleep(4000);
// (TiddlyWiki's network alert for the failed load isn't shown on the admin wiki, design 2.17; it would have cleared it at once anyway, nothing being unsaved)
check("a tiddler never loaded on this device, opened offline: still empty, the wiki saying it's offline, no alert, nothing broken",
  await A.evaluate(() => { const t = $tw.wiki.getTiddler("Unseen"); return !!t && t.fields.text === undefined; }) && (await status(A))?.online === "no" && await A.evaluate(() => $tw.wiki.getTiddlersWithTag("$:/tags/Alert").length === 0) && pageErrors.length === 0,
  `${JSON.stringify(await A.evaluate(() => { const t = $tw.wiki.getTiddler("Unseen"); return t && t.fields.text; }))} ${JSON.stringify(await status(A))} ${pageErrors.join(" | ")}`);
await online(contextA);
await A.evaluate(() => $tw.wiki.deleteTiddler("$:/config/cfworker/LoadAll"));
await settle(A);
await reload(A);

// --- 4b. Another device, one visit online and no reload: it opens offline ---------------------------
// (The service worker fills its cache as soon as it's in place: the page, its files, the status file
// and the tiddler list, which a first visit loaded before it was there)
const contextB = await browser.newContext();
const { p: B } = await open(contextB, "B");
await waitFor(() => B.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }), 15000);
const filled = await waitFor(() => holds(B, BASE + "/", CORE, "/status", "/recipes/default/tiddlers.json"), 10000);
check("another device, after its first visit alone (no reload): the cache holds the page, the core file, the status file and the tiddler list", filled, (await cached(B)).map(u => u.replace(BASE, "")).join(", "));
await waitFor(() => B.evaluate(() => $tw.wiki.getTiddlerText("First note") === "written online"), 15000);   // (the fill of the device copy)
await sleep(500);
await offline(contextB);
await reload(B, { wait: false });
const bootedB = await B.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 }).then(() => true).catch(() => false);
const noteOnB = bootedB && await waitFor(() => B.evaluate(() => $tw.wiki.getTiddlerText("First note") === "written online").catch(() => false), 15000);
check("...and with no network it opens, the tiddlers from its device copy, logged in and writable", noteOnB && await B.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsLoggedIn") === "yes" && $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "no"),
  `booted ${bootedB}, note ${noteOnB}`);
await online(contextB);
await contextB.close();

// --- 5. An answer without the worker's mark (Access refusing): shown as it is, never cached ----------
await site.setBindings({ ACCESS: "" });   // the worker then refuses every request, as it does without Access
mark = responses.length;
const refusedLoad = await A.reload({ waitUntil: "commit" }).catch(() => null);
await sleep(1000);
const refusedBody = await A.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
check("online, an answer without the worker's mark is shown as it is (here the worker refusing without Access), through the service worker",
  !!refusedLoad && refusedLoad.status() === 403 && refusedLoad.fromServiceWorker() && /Access/.test(refusedBody), `status ${refusedLoad && refusedLoad.status()}: ${refusedBody.slice(0, 60)}`);
await offline(contextA);
await reload(A, { wait: false });
const bootedAgain = await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 }).then(() => true).catch(() => false);
const noteBack = bootedAgain && await waitFor(() => A.evaluate(() => $tw.wiki.getTiddlerText("First note") === "written online").catch(() => false), 15000);
check("...and wasn't cached: offline, the wiki still opens from the page kept before", noteBack,
  `booted ${bootedAgain}: ${await A.evaluate(() => document.body ? document.body.innerText.slice(0, 80).replace(/\s+/g, " ") : "").catch(e => e.message.split("\n")[0])}`);
await online(contextA);
await site.setBindings({ ACCESS: "off" });
await reload(A);

// --- 6. The cache follows the page: a plugin's file comes in with the plugin, and goes with it -------
const HELLO = "$:/plugins/test/hello";
await addTiddler(A, {
  title: HELLO, "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { [HELLO + "/startup.js"]: { type: "application/javascript", "module-type": "startup", text: "exports.name='hello-test';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__helloRan=true;};" } } })
});
await settle(A);
await reload(A);
await sleep(1000);
const helloFile = `/_plugins/${encodeURIComponent(HELLO)}.js?v=`;
check("a plugin installed: the next load runs it, and its file is in the cache", await A.evaluate(() => window.__helloRan === true) && (await cached(A)).some(u => u.includes(helloFile)), (await cached(A)).map(u => u.replace(BASE, "")).join(", "));
await offline(contextA);
await reload(A, { wait: false });
await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 });
await sleep(1000);
check("...and runs offline, from the cache", await A.evaluate(() => window.__helloRan === true));
await online(contextA);

// --- 6b. The core file lost from the cache: back at the next load online; offline, a line, not an alert
await reload(A);
await dropCore(A);
await reload(A);   // (a reload: the page asks for the file conditionally, and the worker answers 304)
const coreBack = await waitFor(() => holds(A, CORE), 10000);
check("the core file gone from the cache (a browser clearing space, a copy that didn't finish): back at the next load online", coreBack, (await cached(A)).map(u => u.replace(BASE, "")).join(", "));
await dropCore(A);
const cdpA = await contextA.newCDPSession(A);
await cdpA.send("Network.clearBrowserCache");   // (the browser's own copy gone too, as on a phone short of space)
await cdpA.detach();
await offline(contextA);
const dialogsBefore = dialogs.length;
await reload(A, { wait: false });
await sleep(3000);
const bodyNoCore = await A.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, " ").trim() : "").catch(() => "");
check("no network and no core file on the device: the page says so in a line (open the wiki once online), not the browser's \"Cannot load\" alert",
  /core file/.test(bodyNoCore) && /online/.test(bodyNoCore) && dialogs.length === dialogsBefore, `${JSON.stringify(bodyNoCore.slice(0, 120))}; dialogs: ${dialogs.slice(dialogsBefore).join(" | ")}`);
await online(contextA);
await reload(A);
check("(online again, the wiki is back, its core file kept)", await A.evaluate(() => $tw.wiki.getTiddlerText("First note") === "written online") && await waitFor(() => holds(A, CORE), 10000));

// --- 6c. The advanced setting: the service worker's network wait, told to it by the page ------------
// ($:/config/cfworker/NetworkWait, seconds, from the admin plugin's settings tab; the page posts it at each load)
const swSettings = p => p.evaluate(() => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), 4000);
  navigator.serviceWorker.addEventListener("message", function once(e) {
    if (e.data && e.data.cfworker === "settings") { clearTimeout(timer); navigator.serviceWorker.removeEventListener("message", once); resolve(e.data); }
  });
  navigator.serviceWorker.controller.postMessage({ cfworker: "ask" });
}));
check("the service worker waits 8 s for the network by default, and says so when asked", (await swSettings(A))?.networkWait === 8000, JSON.stringify(await swSettings(A)));
await addTiddler(A, { title: "$:/config/cfworker/NetworkWait", text: "3" });
await settle(A);
await reload(A);
check("...set to 3 s in the wiki: told to the service worker at the next page load", (await swSettings(A))?.networkWait === 3000, JSON.stringify(await swSettings(A)));
await A.evaluate(() => $tw.wiki.deleteTiddler("$:/config/cfworker/NetworkWait"));
await settle(A);
await reload(A);
check("...cleared: back to the default at the next load", (await swSettings(A))?.networkWait === 8000, JSON.stringify(await swSettings(A)));

// --- 7. A public wiki: the core and plugin files come from the public site, and are cached too -------
await site.setBindings({ PUBLIC_WIKI_URL: PUB });
await reload(A);
await waitFor(async () => { const obj = await site.bucket.get("_page/shell.html"); return !!obj && (await obj.text()).includes(`${PUB}/_plugins/tiddlywikicore.js`); }, 30000);
await sleep(1500);
mark = responses.length;
await reload(A);
await sleep(1500);
check("a public wiki: the admin page loads its core and plugin files from the public site", got("A", mark, r => r.url.startsWith(PUB + "/_plugins/") && r.status === 200).length >= 2,
  got("A", mark, r => r.url.startsWith(PUB)).map(r => r.url.replace(PUB, "")).join(", "));
await offline(contextA);
mark = responses.length;
await reload(A, { wait: false });
const bootedPublic = await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("$:/core"), null, { timeout: 30000 }).then(() => true).catch(() => false);
await sleep(1500);
check("...and offline, the wiki opens with them from the cache, the plugin running", bootedPublic && await A.evaluate(() => window.__helloRan === true) &&
  got("A", mark, r => r.url.startsWith(PUB + "/_plugins/") && r.fromSW).length >= 2, got("A", mark, r => r.url.startsWith(PUB)).map(r => `${r.fromSW ? "sw" : "net"} ${r.status} ${r.url.replace(PUB, "").split("?")[0]}`).join(", "));
const publicFiles = (await cached(A)).filter(u => u.startsWith(PUB + "/_plugins/"));
const types = await Promise.all(publicFiles.map(u => cachedType(A, u)));
check("...kept as real answers, asked for with CORS, never opaque (the browser would charge megabytes each, and evict the site's storage, the outbox with it)",
  publicFiles.length >= 2 && types.every(t => t === "cors"), `${publicFiles.length} files: ${types.join(", ")}`);
await online(contextA);
const setupPublic = await setupCheck(A);
check("the setup check on a public wiki: the public site answering with the page, the CORS rule covering the reads and the files, this browser keeping the core file",
  setupPublic.done && setupPublic.lines.some(l => /^✓ .*rewrite/i.test(l)) && setupPublic.lines.some(l => /^✓ .*\/recipes\//.test(l)) && setupPublic.lines.some(l => /^✓ .*\/_plugins\//.test(l)) && setupPublic.lines.some(l => /^✓ .*core file/.test(l)),
  setupPublic.lines.join(" | ") || `done ${setupPublic.done}`);
corsOn = false;
const setupNoCors = await setupCheck(A);
check("...without the CORS header: the files line fails naming /_plugins/ and README 2.7 (what nothing said before)", setupNoCors.done && setupNoCors.lines.some(l => /^✗ .*\/_plugins\/.*2\.7/.test(l)),
  setupNoCors.lines.filter(l => /_plugins|recipes/.test(l)).join(" | ") || `done ${setupNoCors.done}`);
corsOn = true;
// Without the CORS header (the rule of README 2.7 missing): a new file (a second plugin) loads and runs
// as a plain script, and isn't kept. (A new file, because a file the browser already holds in memory
// is served from there, a year's cache, without asking the service worker.)
const HELLO2 = "$:/plugins/test/hello2";
const plugin2 = text => ({ title: HELLO2, "plugin-type": "plugin", type: "application/json", version: "1.0.0", text: JSON.stringify({ tiddlers: { [HELLO2 + "/startup.js"]: { type: "application/javascript", "module-type": "startup", text } } }) });
const hello2File = `/_plugins/${encodeURIComponent(HELLO2)}.js?v=`;
corsOn = false;
await addTiddler(A, plugin2("exports.name='hello2';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__hello2Ran=1;};"));
await settle(A);
await reload(A);
await sleep(1500);
check("without the public site's CORS header, a plugin file still loads and runs online, as a plain script, and isn't kept", await A.evaluate(() => window.__hello2Ran === 1) && !(await cached(A)).some(u => u.includes(hello2File)),
  (await cached(A)).filter(u => u.startsWith(PUB)).map(u => u.replace(PUB, "")).join(", "));
corsOn = true;
await addTiddler(A, plugin2("exports.name='hello2';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__hello2Ran=2;};"));   // a new version: a new address
await settle(A);
await reload(A);
await sleep(1500);
const hello2Url = (await cached(A)).find(u => u.includes(hello2File));
check("...and kept, as a real answer, once the header is there", await A.evaluate(() => window.__hello2Ran === 2) && !!hello2Url && (await cachedType(A, hello2Url)) === "cors", `${hello2Url ? hello2Url.replace(PUB, "") : "not cached"}: ${hello2Url && await cachedType(A, hello2Url)}`);
await A.evaluate(t => $tw.wiki.deleteTiddler(t), HELLO2);
await settle(A);
check("the browser was asked to keep this site's storage; the status says what it answered", ["persistent", "best-effort"].includes(await A.evaluate(() => $tw.wiki.getTiddler("$:/temp/cfworker/outbox")?.fields.storage)),
  JSON.stringify(await A.evaluate(() => $tw.wiki.getTiddler("$:/temp/cfworker/outbox")?.fields.storage)));
await A.evaluate(t => $tw.wiki.deleteTiddler(t), HELLO);
await settle(A);
await reload(A);
await sleep(1500);
check("the plugin deleted: the next load no longer refers to its file, which leaves the cache", !(await cached(A)).some(u => u.includes(helloFile)), (await cached(A)).map(u => u.replace(BASE, "").replace(PUB, "pub:")).join(", "));

// --- 9. This device: the plugin's device tab (design 1.14) --------------------------------------------
// What this browser keeps of the wiki, measured; the browser asked to keep it, on a click; the copy
// forgotten. The browser's answer to persist() is counted and, when the test says, replaced: headless
// Chromium never promises, and what's tested is what the page does with either answer.
const DEVICE = "$:/plugins/cfworker/admin/device", MEASURE = "$:/temp/cfworker/device", DEVICE_SAID = "$:/temp/cfworker/device-message", ITEM = "$:/temp/cfworker/outbox-status";
const DEVICE_DB = "cfworker-tiddlers";
await contextA.addInitScript(() => {
  if (!navigator.storage || typeof navigator.storage.persist !== "function") return;
  const persist = navigator.storage.persist.bind(navigator.storage), persisted = navigator.storage.persisted.bind(navigator.storage);
  window.__persistCalls = 0;
  navigator.storage.persist = () => { window.__persistCalls++; return window.__persistAnswer === undefined ? persist() : Promise.resolve(window.__persistAnswer); };
  navigator.storage.persisted = () => window.__persistAnswer === undefined ? persisted() : Promise.resolve(window.__persistAnswer);
});
const storageSaid = p => p.evaluate(() => $tw.wiki.getTiddler("$:/temp/cfworker/outbox")?.fields.storage);
const deviceCount = (p, table = "tiddlers") => p.evaluate(([name, t]) => new Promise(resolve => {
  const r = indexedDB.open(name);
  r.onsuccess = () => { const db = r.result; try { const c = db.transaction(t, "readonly").objectStore(t).count(); c.onsuccess = () => { db.close(); resolve(c.result); }; c.onerror = () => { db.close(); resolve(-1); }; } catch { db.close(); resolve(-1); } };
  r.onerror = () => resolve(-1);
}), [DEVICE_DB, table]);
const listedCount = async () => JSON.parse(await (await site.bucket.get("recipes/default/tiddlers.json")).text()).length;
async function measure(p) {
  await p.evaluate(t => { $tw.wiki.deleteTiddler(t); $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-measure" }); }, MEASURE);
  const done = await waitFor(() => p.evaluate(t => $tw.wiki.tiddlerExists(t) && $tw.wiki.getTiddler(t).fields.measured !== undefined, MEASURE), 20000);
  return { done, text: done ? await p.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), MEASURE) : "" };
}
const said = p => p.evaluate(t => $tw.wiki.tiddlerExists(t) ? $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " ").trim() : "", DEVICE_SAID);
await reload(A);
await sleep(1500);
check("the plugin has a device tab, a shadow like its others; the page doesn't ask the browser to keep the site's data at load, and says what it has promised so far",
  await A.evaluate(d => $tw.wiki.isShadowTiddler(d) && $tw.wiki.getTiddlerList("$:/plugins/cfworker/admin").includes("device"), DEVICE) && (await A.evaluate(() => window.__persistCalls)) === 0 && (await storageSaid(A)) === "best-effort",
  `persist() calls ${await A.evaluate(() => window.__persistCalls)}, storage ${await storageSaid(A)}`);
await offline(contextA);
await addTiddler(A, { title: "Device note", text: "written offline" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
const item = await A.evaluate(t => $tw.wiki.renderTiddler("text/html", t), ITEM);
check("while a change waits and the browser hasn't promised, the cloud dropdown says so, with a link to the device tab",
  /hasn't promised/.test(item) && (item.includes(encodeURIComponent(DEVICE)) || item.includes(DEVICE)), item.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 240));
const offlineMeasure = await measure(A);
check("Measure, offline: the change waiting in the outbox is counted (the tab needs no network)", offlineMeasure.done && /1 change\b.* waiting in the outbox/.test(offlineMeasure.text), offlineMeasure.text.slice(0, 300));
await online(contextA);
await waitFor(async () => (await status(A))?.waiting === "0", 15000);
await settle(A);
await sleep(2000);   // (the fill done: the copy complete)
mark = responses.length;
const onlineMeasure = await measure(A);
const kept = await deviceCount(A), listed = await listedCount();
const copyLine = onlineMeasure.text.match(/(\d+) of (\d+) tiddlers/);
check("Measure: the tiddlers kept on this device of those the worker lists, with their size; nothing waiting in the outbox",
  onlineMeasure.done && !!copyLine && Number(copyLine[1]) === kept && Number(copyLine[2]) === listed && kept > 0 && /tiddlers kept \(\d+(\.\d+)? (B|KB|MB)\)/.test(onlineMeasure.text) && /nothing waiting in the outbox/.test(onlineMeasure.text),
  `${onlineMeasure.text.slice(0, 200)} — device ${kept}, listed ${listed}`);
check("...the files the service worker keeps, each with its size", /the page\) \(\d+(\.\d+)? (KB|MB)\)/.test(onlineMeasure.text) && /_plugins\/tiddlywikicore\.js[^)]*\(\d+(\.\d+)? (KB|MB)\)/.test(onlineMeasure.text) && /tiddlers\.json[^)]*\(\d+(\.\d+)? (B|KB|MB)\)/.test(onlineMeasure.text),
  onlineMeasure.text.replace(/^.*?files/, "files").slice(0, 300));
check("...what the browser says: this site's use of what it allows, and that it hasn't promised to keep it", /uses \d+(\.\d+)? (B|KB|MB|GB) of (the )?\d+(\.\d+)? (KB|MB|GB)/.test(onlineMeasure.text) && /hasn't promised/.test(onlineMeasure.text),
  onlineMeasure.text.replace(/^.*?uses/, "uses").slice(0, 200));
// A tiddler the page itself carries (the site subtitle, saved on another device: the worker bakes
// it into the page in full, so this tab never loads it and the copy never sees it) is counted apart
await addTiddler(C, { title: "$:/SiteSubtitle", text: "set on another device" });
await settle(C);
await reload(A);
await sleep(2000);
const carriedMeasure = await measure(A);
const carriedLine = carriedMeasure.text.match(/(\d+) of (\d+) tiddlers kept[^;]*/);
check("...a tiddler the page carries (the site subtitle, set on another device) is listed, not in the copy, and counted apart as in the page itself",
  carriedMeasure.done && !!carriedLine && Number(carriedLine[2]) === Number(carriedLine[1]) + 1 && /1 tiddler in the page itself/.test(carriedLine[0]) && !/not loaded yet/.test(carriedLine[0]) && await A.evaluate(() => $tw.wiki.getTiddlerText("$:/SiteSubtitle") === "set on another device"),
  carriedLine ? carriedLine[0] : carriedMeasure.text.slice(0, 200));
mark = responses.length;
const quietMeasure = await measure(A);
check("...and asks the worker nothing", quietMeasure.done && got("A", mark, r => (r.url.startsWith(BASE) && !r.url.includes("/recipes/default/tiddlers.json")) || r.url.startsWith(PUB)).length === 0,
  got("A", mark, r => r.url.startsWith(BASE) || r.url.startsWith(PUB)).map(r => r.url.replace(BASE, "").replace(PUB, "pub:")).join(", "));
await A.evaluate(() => $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-keep" }));
await waitFor(async () => /promise/i.test(await said(A)), 10000);
check("the button asks the browser to keep the site's data (one call, on the click) and says what it answered: not promised, here",
  (await A.evaluate(() => window.__persistCalls)) === 1 && /didn't promise|hasn't promised/.test(await said(A)) && (await storageSaid(A)) === "best-effort", `calls ${await A.evaluate(() => window.__persistCalls)}: ${await said(A)}`);
await A.evaluate(() => { window.__persistAnswer = true; $tw.wiki.deleteTiddler("$:/temp/cfworker/device-message"); $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-keep" }); });
await waitFor(async () => /promise/i.test(await said(A)), 10000);
await offline(contextA);
await addTiddler(A, { title: "Device note 2", text: "written offline, promised" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
const itemKept = await A.evaluate(t => $tw.wiki.renderTiddler("text/html", t), ITEM);
check("...promised: the tab says so, the measure too, and the dropdown no longer warns",
  (await storageSaid(A)) === "persistent" && /has promised|promised to keep/.test(await said(A)) && !/hasn't promised/.test(itemKept) && /has promised/.test((await measure(A)).text), `${await said(A)} | ${itemKept.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}`);
// Forget, refused while a change waits
const keysBefore = await cached(A);
await A.evaluate(() => { window.__stillHere = 1; $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-forget" }); });
await waitFor(async () => /waiting/.test(await said(A)), 10000);
await sleep(1000);
check("Forget this device's copy, with a change waiting: refused, saying how many, nothing removed, no reload",
  /1 change\b.*waiting/.test(await said(A)) && (await A.evaluate(() => window.__stillHere)) === 1 && (await deviceCount(A)) > 0 && (await deviceCount(A, "outbox")) === 1 && (await cached(A)).length === keysBefore.length,
  `${await said(A)} — device ${await deviceCount(A)}, outbox ${await deviceCount(A, "outbox")}, cache ${(await cached(A)).length}/${keysBefore.length}`);
await online(contextA);
await waitFor(async () => (await status(A))?.waiting === "0", 15000);
await settle(A);
// Forget, with nothing waiting: the copy and the files go, the page reloads, and both are fetched again
const publicMark = site.publicRequests.length;
await A.evaluate(() => { window.__stillHere = 1; $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-forget" }); });
const reloaded = await waitFor(() => A.evaluate(() => window.__stillHere === undefined && !!window.$tw).catch(() => false), 20000);
await ready(A);
await sleep(2500);
const fetchedAgain = site.publicRequests.slice(publicMark);
check("...with nothing waiting: the device copy, the outbox and the service worker's files are gone, the page reloads, and the copy and the files are fetched again",
  reloaded && fetchedAgain.some(u => u.includes("/_plugins/tiddlywikicore.js")) && fetchedAgain.some(u => u.startsWith("/recipes/default/tiddlers/")) && (await deviceCount(A)) > 0,
  `reloaded ${reloaded}; fetched again: ${fetchedAgain.map(u => u.split("?")[0]).join(", ").slice(0, 300)}`);

// --- 8. The public site registers nothing --------------------------------------------------------------
const visitors = await browser.newContext();
const { p: V } = await open(visitors, "V", PUB + "/", { wait: false });
await V.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
check("the public site registers no service worker", await V.evaluate(async () => !(await navigator.serviceWorker.getRegistration())) && await V.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "yes"),
  `registration ${await V.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.scope : null; })}, read-only ${await V.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsReadOnly"))}`);

await finish({ check, results, pageErrors, browser, site, cleanup: () => fs.rmSync(r2Dir, { recursive: true, force: true }) });
