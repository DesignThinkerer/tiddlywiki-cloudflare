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

async function open(context, tag, url = BASE + "/", { wait = true } = {}) {
  const p = await context.newPage();
  await watch(p, tag);
  p.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  p.on("response", r => responses.push({ tag, url: r.url(), status: r.status(), fromSW: r.fromServiceWorker() }));
  p.on("dialog", d => d.accept());
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

// --- 4. A tiddler never loaded on this device, opened offline: empty, the network alert, no crash ----
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
// (TiddlyWiki shows its network alert for the failed load and clears it at once, nothing being unsaved: its own behaviour)
check("a tiddler never loaded on this device, opened offline: still empty, the wiki saying it's offline, nothing broken",
  await A.evaluate(() => { const t = $tw.wiki.getTiddler("Unseen"); return !!t && t.fields.text === undefined; }) && (await status(A))?.online === "no" && pageErrors.length === 0,
  `${JSON.stringify(await A.evaluate(() => { const t = $tw.wiki.getTiddler("Unseen"); return t && t.fields.text; }))} ${JSON.stringify(await status(A))} ${pageErrors.join(" | ")}`);
await online(contextA);
await A.evaluate(() => $tw.wiki.deleteTiddler("$:/config/cfworker/LoadAll"));
await settle(A);
await reload(A);

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

// --- 8. The public site registers nothing --------------------------------------------------------------
const visitors = await browser.newContext();
const { p: V } = await open(visitors, "V", PUB + "/", { wait: false });
await V.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
check("the public site registers no service worker", await V.evaluate(async () => !(await navigator.serviceWorker.getRegistration())) && await V.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "yes"),
  `registration ${await V.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.scope : null; })}, read-only ${await V.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsReadOnly"))}`);

await finish({ check, results, pageErrors, browser, site, cleanup: () => fs.rmSync(r2Dir, { recursive: true, force: true }) });
