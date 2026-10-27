// End-to-end test of the public site offline (design 2.40, #241), in Chromium with the service
// worker allowed: after one visit online, a public wiki opens on that device with no network, with
// the tiddlers read there; online, the page comes from the device's copy at once and the current
// one is fetched behind it (stale while revalidate), the list and the tiddlers from the network
// first; only a wiki page is ever kept; the worker is never asked. The public stand-in serves the
// bucket's objects as the custom domain does, the service worker's script among them.
// Run: npm run test:public-offline
import { createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const overrides = new Map();   // key -> what the public stand-in answers instead of the bucket's object
const site = await startSite({ index: readWikiFile(), publicStatus: true, publicSite: { override: key => overrides.get(key) } });
const { mf, base: BASE, pub: PUB, bucket } = site;
const { check, results } = createChecks();
const browser = await launchBrowser({ serviceWorkers: "allow" });
const { requests, pageErrors, watch } = createWatcher(site);
const CACHE = "cfworker-wiki-v1";
const responses = [];   // every response a page got: { tag, url, status, fromSW, served (X-Served-From) }

async function put(title, fields) {
  const r = await mf.dispatchFetch(`${BASE}/recipes/default/tiddlers/${encodeURIComponent(title)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, ...fields }) });
  if (r.status !== 204) throw new Error(`PUT ${title}: ${r.status} ${await r.text()}`);
}
async function open(context, tag, url) {
  const p = await context.newPage();
  await watch(p, tag);
  p.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  p.on("response", r => responses.push({ tag, url: r.url(), status: r.status(), fromSW: r.fromServiceWorker(), served: r.headers()["x-served-from"] || null }));
  const response = await p.goto(url);
  await ready(p);
  return { p, response };
}
async function ready(p) {
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
}
const text = (p, title) => p.evaluate(t => $tw.wiki.getTiddlerText(t, null), title).catch(() => "?");
const skinny = (p, title) => p.evaluate(t => { const x = $tw.wiki.getTiddler(t); return !!x && x.hasField("_is_skinny"); }, title).catch(() => false);
const cached = p => p.evaluate(async name => { const c = await caches.open(name); return (await c.keys()).map(r => r.url); }, CACHE).catch(() => []);
const holds = async (p, ...parts) => { const keys = await cached(p); return parts.every(part => keys.some(u => u.includes(part))); };
const keptPage = p => p.evaluate(async name => { const c = await caches.open(name); const r = await c.match(location.origin + "/"); return r ? await r.text() : ""; }, CACHE).catch(() => "");
const scriptOf = p => p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const w = r && (r.active || r.waiting || r.installing); return w ? w.scriptURL : null; }).catch(() => null);
const listResponses = from => responses.slice(from).filter(r => r.tag === "P" && r.url.includes("/recipes/default/tiddlers.json"));
// A reload that may not come back (no service worker yet on a site without the change): the error as the check's detail, never a crash
const reloadSafely = async p => { try { const r = await p.reload(); await ready(p); return { response: r, error: "" }; } catch (e) { return { response: null, error: String(e.message || e).slice(0, 160) }; } };

await put("Note one", { text: "the first note" });
await put("Note two", { text: "the second note" });
await put("$:/config/cfworker/LoadAll", { text: "no" });   // (the fill off: a tiddler loads when shown, so one stays unread)
// The owner's first visit publishes the shell and the core file (page.js): the light page the public site
// serves, with the engine as a file, comes from them; then the page build writes the manifest and the
// service worker's file beside the page
const owner = await browser.newContext();
const { p: O } = await open(owner, "O", BASE + "/");
const published = await waitFor(async () => !!(await bucket.head("_page/shell.html")) && !!(await bucket.head("_plugins/tiddlywikicore.js")), 30000);
await O.close();
await owner.close();
const pageHtml = await (await mf.dispatchFetch(BASE + "/")).text();
const swVersion = (pageHtml.match(/\/sw\.js\?v=([\w-]+)/) || [])[1] || "";
const written = await waitFor(async () => !!(await bucket.head("sw.js")), 10000);

// --- 1. The script is a file of the public site, the worker's own byte for byte ---------------------
const workerScript = await (await mf.dispatchFetch(BASE + "/sw.js")).text();
const served = await fetch(`${PUB}/sw.js?v=${swVersion}`);
const servedText = await served.text();
check("the page build writes the service worker's script into the bucket, which the public site serves at /sw.js as JavaScript, cached a day, byte for byte the worker's own",
  published && written && served.status === 200 && /application\/javascript/.test(served.headers.get("content-type") || "") && /max-age=86400/.test(served.headers.get("cache-control") || "") && servedText === workerScript && servedText.includes(CACHE),
  `published ${published}, written ${written}, status ${served.status}, ${served.headers.get("content-type")}, ${servedText.length} vs ${workerScript.length} bytes`);

// --- 2. A first visit online registers it for the public site, and it fills its cache --------------
const contextP = await browser.newContext();
const { p: P } = await open(contextP, "P", `${PUB}/#Note%20one`);
const registered = await waitFor(() => P.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }).catch(() => false), 15000);
const scriptURL = await scriptOf(P);
check("the first visit registers the service worker on the public site, from the page's address with site=public, at the site's root",
  registered && scriptURL === `${PUB}/sw.js?v=${swVersion}&site=public` && await P.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope === location.origin + "/").catch(() => false),
  `registered ${registered}, ${JSON.stringify(scriptURL)}`);
const filled = await waitFor(() => holds(P, PUB + "/", "/_plugins/tiddlywikicore.js?v=", "/status", "/recipes/default/tiddlers.json"), 15000);
check("...and fills its cache by itself: the page, the core file, the status file and the tiddler list", filled, (await cached(P)).map(u => u.replace(PUB, "")).join(", "));
check("the tiddler shown was read from the public site, the other not (the fill is off), and nothing was asked of the worker",
  (await text(P, "Note one")) === "the first note" && await skinny(P, "Note two") && requests.filter(r => r.tag === "P" && r.origin === "worker").length === 0,
  `one ${JSON.stringify(await text(P, "Note one"))}, two skinny ${await skinny(P, "Note two")}, worker requests ${requests.filter(r => r.tag === "P" && r.origin === "worker").map(r => r.path).join(", ") || "none"}`);

// --- 2b. The cloud icon's dropdown on the public site (design 2.41): TiddlyWeb's Login, whose prompt led
// nowhere, replaced by a link to the admin site; the override leaves nothing to send
const LOGIN_ITEM = "$:/plugins/tiddlywiki/tiddlyweb/syncer-actions/login", OFFLINE_ITEM = "$:/temp/cfworker/public-offline";
const render = (p, title, type = "text/html") => p.evaluate(([t, kind]) => $tw.wiki.renderTiddler(kind, t), [title, type]).catch(() => "?");
const adminUrl = () => P.evaluate(() => $tw.wiki.getTiddlerText("$:/cfworker/admin-url")).catch(() => null);
const loginHtml = await render(P, LOGIN_ITEM);
check("the dropdown's Login item is a link to the admin site, Log in to edit, in a new tab, in place of TiddlyWeb's prompt that led nowhere; the page carries the admin address the shell was published from",
  (await adminUrl()) === BASE + "/" && loginHtml.includes(`href="${BASE}/"`) && /Log in to edit/.test(loginHtml) && /target="_blank"/.test(loginHtml) && !/tm-login/.test(loginHtml) && !/>\s*Login\s*</.test(loginHtml),
  `admin-url ${JSON.stringify(await adminUrl())}; ${loginHtml.replace(/\s+/g, " ").slice(0, 220)}`);
check("...online, the dropdown says nothing of offline, and the override leaves nothing to send: not dirty, no PUT from the public page",
  (await render(P, OFFLINE_ITEM, "text/plain")).trim() === "" && !(await P.evaluate(() => $tw.syncer.isDirty()).catch(() => true)) && !requests.some(r => r.tag === "P" && r.method === "PUT"),
  `offline line ${JSON.stringify((await render(P, OFFLINE_ITEM, "text/plain")).trim().slice(0, 60))}, dirty ${await P.evaluate(() => $tw.syncer.isDirty()).catch(() => "?")}, PUTs ${requests.filter(r => r.tag === "P" && r.method === "PUT").length}`);

// --- 3. No network: the page from the cache, the tiddler read from the device copy, the unread one empty
await sleep(1500);   // (the device copy's write of the tiddler read lands behind the tab)
await site.stopPublic();
await contextP.setOffline(true);
let mark = responses.length;
const { response: offlineResponse, error: offlineError } = await reloadSafely(P);
check("with no network, the public page opens from the cache, served by the service worker",
  !!offlineResponse && offlineResponse.fromServiceWorker() && offlineResponse.status() === 200 && !offlineError && await P.evaluate(() => !!(window.$tw && $tw.wiki)).catch(() => false),
  offlineError || `status ${offlineResponse?.status()}, from the service worker ${offlineResponse?.fromServiceWorker()}`);
check("...with the tiddler read there, from the device copy, and the one never read empty until the network is back",
  (await text(P, "Note one")) === "the first note" && await skinny(P, "Note two"),
  `one ${JSON.stringify(await text(P, "Note one"))}, two skinny ${await skinny(P, "Note two")}`);
check("...the list from the cache, marked X-Served-From: cache for the list sync", listResponses(mark).some(r => r.served === "cache"), JSON.stringify(listResponses(mark).map(r => [r.status, r.served])));
const offlineLine = (await render(P, OFFLINE_ITEM, "text/plain")).trim();
check("...and the dropdown says offline, in the admin site's words: what this device has loaded is here", /^Offline: what this device has loaded is here/.test(offlineLine), JSON.stringify(offlineLine.slice(0, 120)));

// --- 4. Online again: the kept page at once, the current one fetched behind it, the list from the network
await contextP.setOffline(false);
await site.startPublic();
const original = await (await bucket.get("baked.html")).text();
const html = body => ({ body, headers: { "Content-Type": "text/html; charset=utf-8" } });
overrides.set("baked.html", html(original.replace("</head>", '<meta name="cfworker-test" content="rebuilt"></head>')));   // (the site serves a rebuilt page now)
mark = responses.length;
const shownRebuilt = () => P.evaluate(() => !!document.querySelector('meta[name="cfworker-test"]')).catch(() => false);
const { response: onlineResponse, error: onlineError } = await reloadSafely(P);
check("online, the page shown is the kept one, at once, served by the service worker (stale while revalidate)",
  !!onlineResponse && onlineResponse.fromServiceWorker() && !onlineError && !(await shownRebuilt()), onlineError || `from the service worker ${onlineResponse?.fromServiceWorker()}, rebuilt shown ${await shownRebuilt()}`);
const refreshed = await waitFor(async () => (await keptPage(P)).includes('name="cfworker-test"'), 15000);
check("...the current page fetched behind it and kept for the next load", refreshed, `kept page carries the rebuilt mark: ${refreshed}`);
check("...online again, the offline line is gone", (await render(P, OFFLINE_ITEM, "text/plain")).trim() === "", JSON.stringify((await render(P, OFFLINE_ITEM, "text/plain")).trim().slice(0, 80)));
check("...the list fetched from the network meanwhile, not from the cache (no timed-out fast path for a page served stale)",
  listResponses(mark).some(r => r.status === 200 && r.served !== "cache") && !listResponses(mark).some(r => r.served === "cache"), JSON.stringify(listResponses(mark).map(r => [r.status, r.served])));
const next = await reloadSafely(P);
check("...and the next load shows the current page", !next.error && await shownRebuilt(), next.error || `rebuilt shown ${await shownRebuilt()}`);

// --- 5. A 200 page that isn't the wiki's is never kept ------------------------------------------------
overrides.set("baked.html", html("<!doctype html><html><head><title>Maintenance</title></head><body><h1>Maintenance</h1></body></html>"));
const maintenance = await reloadSafely(P);
await sleep(1500);   // (the fetch behind the kept page, refused)
const kept = await keptPage(P);
check("a 200 page that isn't the wiki (an interstitial, a maintenance page) opens as the kept wiki page and is never kept: the cache still holds a page carrying the plugin's sw-url mark",
  !maintenance.error && kept.includes("$:/cfworker/sw-url") && !/Maintenance/.test(kept) && await P.evaluate(() => !!window.$tw && document.title !== "Maintenance").catch(() => false),
  maintenance.error || `kept page ${kept.length} bytes, maintenance ${/Maintenance/.test(kept)}, title ${JSON.stringify(await P.evaluate(() => document.title).catch(() => "?"))}`);
overrides.delete("baked.html");

// --- 6. The admin site in the same browser keeps its own worker, from memory ----------------------------
const contextA = await browser.newContext();
const { p: A } = await open(contextA, "A", BASE + "/");
await waitFor(() => A.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }).catch(() => false), 15000);
const adminScript = await scriptOf(A);
check("the admin site in the same browser keeps its own service worker, served by the worker, registered without the site parameter",
  /\/sw\.js\?v=[\w-]+$/.test(adminScript || "") && (adminScript || "").startsWith(BASE + "/"), JSON.stringify(adminScript));

await finish({ check, results, pageErrors, browser, site });
