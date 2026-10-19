// What reaches the worker per page load, measured at the worker (CONTRIBUTING.md, the first principle):
// a counting proxy in front of it, a real TiddlyWiki in Chromium with the service worker allowed.
// The page's own requests are counted elsewhere (first-visit, lazy-load); this counts what the page
// can't see: the browser checking the service worker's script on the registration's behalf, which
// cost a request per load until the script was registered with updateViaCache "all" and served
// fresh for a day (design 1.11). Chrome starts those checks a minute after installing, so the
// steady state is measured past that minute.
// Run: npm run test:budget
import http from "node:http";
import { addTiddler, createChecks, finish, launchBrowser, listen, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const site = await startSite({ index: readWikiFile(), publicStatus: true, privateWiki: true });
const { check, results } = createChecks();
const pageErrors = [];
// Every request that reaches the worker: { method, path, status, conditional, cookie (sent with the site's cookies) }
const arrived = [];
const proxy = http.createServer((req, res) => {
  const target = new URL(req.url, site.base);
  const out = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, answer => {
    arrived.push({ method: req.method, path: req.url.split("?")[0], status: answer.statusCode, conditional: !!(req.headers["if-none-match"] || req.headers["if-modified-since"]), cookie: /session=yes/.test(req.headers.cookie || "") });
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  out.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(out);
});
const FRONT = await listen(proxy);
const browser = await launchBrowser({ serviceWorkers: "allow" });
const context = await browser.newContext();
// A cookie on the admin site, as Cloudflare Access sets one: what the browser sends it with, and what it doesn't
await context.addCookies([{ name: "session", value: "yes", url: FRONT + "/" }]);
const page = await context.newPage();
page.on("pageerror", e => pageErrors.push(e.message));
// A visibility the test controls (headless Chromium doesn't hide a tab for real): window.__hidden, then a visibilitychange event
await page.addInitScript(() => {
  window.__hidden = false;
  Object.defineProperty(document, "hidden", { get: () => !!window.__hidden, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => window.__hidden ? "hidden" : "visible", configurable: true });
});
const setHidden = hidden => page.evaluate(h => { window.__hidden = h; document.dispatchEvent(new Event("visibilitychange")); }, hidden);
const since = mark => arrived.slice(mark).map(r => `${r.method} ${r.path} ${r.status}${r.conditional ? "*" : ""}`);
async function ready() {
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(page);
}

// --- 1. The first visit ------------------------------------------------------------------------------
const registeredAt = Date.now();   // (the browser checks the service worker's script at navigations after its first minute: section 4)
await page.goto(FRONT + "/");
await ready();
await waitFor(() => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }), 15000);
await waitFor(async () => !!(await site.bucket.head("_page/shell.html")), 30000);   // the first load publishes the core file and the page
await sleep(1500);
const first = since(0);
// (The browser also asks for /favicon.ico at this first visit, before the service worker is in charge: from then on the service worker answers it)
// (The service worker, once in place, takes its own copy of the page, revalidated (304), and of the list, asked for by its path
// alone, a full answer: two requests once per device. The status file it takes from the browser's cache: no request.)
check("the first visit: the page, the status file, the tiddler list, the service worker's script once, the page (304) and the list once more for the service worker's copy, the core file and the page published, and nothing else but the browser's favicon and manifest requests",
  first.filter(r => r === "GET / 200").length === 1 && first.filter(r => r === "GET / 304*").length === 1 && first.filter(r => r === "GET /status 200").length === 1 &&
  first.filter(r => r.startsWith("GET /recipes/default/tiddlers.json")).length === 2 && first.filter(r => /^GET \/recipes\/default\/tiddlers.json (200|304)/.test(r)).length === 2 &&
  first.filter(r => r.startsWith("GET /sw.js")).length === 1 && first.includes("PUT /page/core 204") && first.includes("PUT /page/shell 204") &&
  first.every(r => /^GET \/ |^GET \/status |^GET \/recipes\/default\/tiddlers.json |^GET \/sw.js |^GET \/manifest.webmanifest |^PUT \/page\/(core|shell) |^GET \/favicon.ico /.test(r)),
  first.join(", "));
// The app's manifest, as the browser fetches it for an install (through the DevTools protocol: a headless browser fetches none by itself)
const cdp = await context.newCDPSession(page);
const beforeManifest = arrived.length;
const appManifest = await cdp.send("Page.getAppManifest");
const manifestFetch = arrived.slice(beforeManifest).find(r => r.path === "/manifest.webmanifest");
check("the browser's fetch of the app's manifest reaches the worker with the site's cookies, as Cloudflare Access needs (a manifest it can't fetch means no install, silently), and reads clean",
  !!manifestFetch && manifestFetch.cookie && manifestFetch.status === 200 && appManifest.url.endsWith("/manifest.webmanifest") && (appManifest.errors || []).length === 0 && JSON.parse(appManifest.data || "{}").name === "My TiddlyWiki",
  `${JSON.stringify(manifestFetch)} ${JSON.stringify(appManifest.errors)}`);
const installability = await cdp.send("Page.getInstallabilityErrors").catch(() => null);
check("...and the browser finds the wiki installable (the one thing in its way here is the test browser's incognito mode)",
  !!installability && installability.installabilityErrors.every(e => e.errorId === "in-incognito"), JSON.stringify(installability && installability.installabilityErrors));
await addTiddler(page, { title: "A note", text: "so the list isn't empty" });
await settle(page);

// --- 2. The first reload: the light page and the core file, once -------------------------------------
let mark = arrived.length;
await page.reload();
await ready();
await sleep(1500);
const second = since(mark);
check("the first reload: the light page, the core file (once, kept by the service worker from then on), the list (changed by the save); nothing for the script, nothing for the favicon",
  second.includes("GET / 200*") && second.includes("GET /_plugins/tiddlywikicore.js 200") && second.some(r => /^GET \/recipes\/default\/tiddlers.json (200|304)\*$/.test(r)) && second.length === 3,
  second.join(", "));

// --- 3. A background tab asks nothing (during the browser's first minute: section 4 waits for its end) ----
await page.evaluate(() => { $tw.syncer.pollTimerInterval = 2000; $tw.syncer.processTaskQueue(); });   // polls every 2 s from now on (until the next reload)
mark = arrived.length;
await sleep(5000);
check("(shown, polls set to every 2 s: the list is asked for, 304)", since(mark).length >= 2 && since(mark).every(r => r === "GET /recipes/default/tiddlers.json 304*"), since(mark).join(", "));
await setHidden(true);
await sleep(1000);
mark = arrived.length;
await sleep(7000);
check("a tab in the background asks the worker nothing", since(mark).length === 0, since(mark).join(", "));
await setHidden(false);
const caughtUp = await waitFor(() => since(mark).some(r => r.startsWith("GET /recipes/default/tiddlers.json")), 10000);
check("...and catches up once shown: a list request, nothing else", caughtUp && since(mark).every(r => r.startsWith("GET /recipes/default/tiddlers.json")), since(mark).join(", "));

// --- 4. The steady state, past the browser's first minute: 2 requests a reload, both 304 -------------
await sleep(Math.max(0, registeredAt + 65000 - Date.now()));   // (the rest of the minute: section 3 ran during it)
const loads = [];
for (let i = 0; i < 3; i++) {
  mark = arrived.length;
  await page.reload();
  await ready();
  await sleep(1500);
  loads.push(since(mark));
}
check("every later reload reaches the worker exactly twice: the page and the tiddler list, both answered 304, nothing else",
  loads.every(load => load.length === 2 && load.includes("GET / 304*") && load.includes("GET /recipes/default/tiddlers.json 304*")),
  loads.map(load => load.join(", ")).join(" | "));
check("...the service worker's script is never asked for again (the browser's own check uses its cache, the script fresh for a day)",
  !arrived.slice(first.length).some(r => r.path === "/sw.js"), arrived.slice(first.length).filter(r => r.path === "/sw.js").map(r => `${r.status}${r.conditional ? "*" : ""}`).join(", "));

await finish({ check, results, pageErrors, browser, site, cleanup: () => proxy.close() });
