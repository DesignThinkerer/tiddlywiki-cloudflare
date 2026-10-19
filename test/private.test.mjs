// A private wiki: the worker with no public address (setup 2.1), a real TiddlyWiki in Chromium.
// Everything the page needs is served by the worker itself and nothing reaches any other site; no
// purge is sent; the page is published with root-relative URLs; the Cloudflare tab is there; a second
// browser reads from the worker; and a public site added afterwards takes over with nothing to migrate.
// Run: npm run test:private
import fs from "node:fs";
import path from "node:path";
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const r2Dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "wiki-private-"));
const outbound = [];
const site = await startSite({
  privateWiki: true, r2Persist: r2Dir,   // no index: the bucket starts empty, as a new wiki's does
  bindings: { CF_ZONE_ID: "zone123", CF_API_TOKEN: "token" },   // purges set up, with nothing to purge
  outbound: async req => {
    outbound.push({ url: req.url, body: req.method === "GET" ? "" : await req.text() });
    return new Response('{"success":true}');
  }
});
const { base: BASE, pub: PUB, publicRequests } = site;
let bucket = site.bucket;
const { check, results } = createChecks();
const browser = await launchBrowser();
const { requests, pageErrors, watch } = createWatcher(site);
const purges = () => outbound.filter(o => o.url.includes("purge_cache"));
// Requests from a tab that reached the worker (not answered from the browser's cache), from a mark on
const workerRequests = (tag, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.origin === "worker" && !r.cached);
const elsewhere = (tag, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.origin !== "worker");
const text = async key => { const obj = await bucket.get(key); return obj ? obj.text() : ""; };
const SHELL = "_page/shell.html", CORE = "_plugins/tiddlywikicore.js", TAB = "$:/temp/cfworker/ControlPanel";
async function open(context, tag, url = BASE + "/") {
  const p = await context.newPage();
  await watch(p, tag);
  p.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  const response = await p.goto(url);
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
  return { p, response };
}
async function reload(p) {
  const response = await p.reload();
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
  return response;
}

// --- 1. The first visit: a new wiki from an empty bucket, served by the worker --------------------
const contextA = await browser.newContext();
const { p: A, response: first } = await open(contextA, "A");
check("a new private wiki opens from an empty bucket, served by the worker, with the browser modules",
  first.status() === 200 && await A.evaluate(() => $tw.syncadaptor.conflictGuardInstalled === true && typeof $tw.syncadaptor.cfworkerListed === "function"));
check("...the engine and the status file are in the bucket (for the day a public site is added), and the page built",
  !!(await bucket.head("index.html")) && !!(await bucket.head("status")) && !!(await bucket.head("baked.html")));
check("...the page carries no public address (a part of the admin plugin, empty)", await A.evaluate(() => $tw.wiki.isShadowTiddler("$:/cfworker/public-url") && $tw.wiki.getTiddlerText("$:/cfworker/public-url", "x") === ""));
check("...the tab is logged in and can write", await A.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsLoggedIn") === "yes" && $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "no"));
const ENGINE = await text("index.html");
const version = await A.evaluate(() => $tw.version);
const CORE_PATH = `/${CORE}?v=${version}-1`;   // root-relative: this site, whichever it is
const published = await waitFor(async () => !!(await bucket.head(SHELL)) && !!(await bucket.head(CORE)), 30000);
let shell = await text(SHELL);
check("...and that load publishes the core file and the page by itself, the core loaded from this site at a root-relative URL",
  published && shell.includes(`<script src="${CORE_PATH}"`), `${shell.length} chars: ${shell.match(/<script src="[^"]*tiddlywikicore[^"]*"/)?.[0]}`);

// --- 2. A save, stored and listed, and nothing purged --------------------------------------------
await addTiddler(A, { title: "First note", text: "Hello from a private wiki", tags: "note" });
await settle(A);
const stored = await bucket.get("recipes/default/tiddlers/First note");
const storedFields = stored ? await stored.json() : null;
check("a tiddler saved is stored and listed", storedFields?.text === "Hello from a private wiki" && (await (await bucket.get("recipes/default/tiddlers.json")).json()).some(t => t.title === "First note"));

// --- 3. Reloads: the light page from the worker, then everything from the browser and the device ---
let mark = requests.length;
let body = await (await reload(A)).body();
check("a reload gets the light page, a fraction of index.html's size, with the core file loaded from the worker",
  body.length < ENGINE.length / 5 && body.toString().includes(`<script src="${CORE_PATH}"`) && workerRequests("A", mark).some(r => r.method === "GET" && r.path.startsWith(`/${CORE}?v=`)),
  `${body.length} bytes vs ${ENGINE.length}; ${workerRequests("A", mark).map(r => `${r.method} ${r.path.split("?")[0]}`).join(", ")}`);
check("...TiddlyWiki started from it, with the saved tiddler", await A.evaluate(() => $tw.wiki.tiddlerExists("$:/core") && $tw.wiki.getTiddlerText("First note") === "Hello from a private wiki"));
mark = requests.length;
await reload(A);
const loads = workerRequests("A", mark).map(r => `${r.method} ${r.path.split("?")[0]}`);
check("the next reload asks the worker for the page and the tiddler list only: the core file comes from the browser's cache, the tiddlers from the device copy",
  loads.length === 2 && loads.includes("GET /") && loads.some(l => l.endsWith("tiddlers.json")) && requests.slice(mark).some(r => r.tag === "A" && r.cached && r.path.startsWith(`/${CORE}?v=`)),
  loads.join(", "));

// --- 4. A plugin installed from the wiki: its file served by the worker, cached by the browser -------
const HELLO = "$:/plugins/test/hello";
await addTiddler(A, {
  title: HELLO, "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { [HELLO + "/startup.js"]: {
    type: "application/javascript", "module-type": "startup",
    text: "exports.name='hello-test';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__helloRan=true;};"
  } } })
});
await settle(A);
mark = requests.length;
await reload(A);
const baked = await text("baked.html");
const helloPath = `/_plugins/${encodeURIComponent(HELLO)}.js?v=`, helloFile = `/_plugins/${HELLO}.js?v=`;   // in the page; as a request's path (decoded)
check("a plugin installed from the wiki gets its file, which the page loads from the worker at a root-relative URL, and it runs",
  baked.includes(`<script src="${helloPath}`) && await A.evaluate(() => window.__helloRan === true) && workerRequests("A", mark).some(r => r.path.startsWith(helloFile)),
  `${baked.match(/<script src="[^"]*hello[^"]*"/)?.[0] || "no script tag"}; ran ${await A.evaluate(() => window.__helloRan)}; ${workerRequests("A", mark).map(r => r.path.split("?")[0]).join(", ")}`);
mark = requests.length;
await reload(A);
check("...from the browser's cache at the next reload, which is still 2 worker requests",
  requests.slice(mark).some(r => r.tag === "A" && r.cached && r.path.startsWith(helloFile)) && workerRequests("A", mark).length === 2,
  workerRequests("A", mark).map(r => `${r.method} ${r.path.split("?")[0]}`).join(", "));

// --- 5. The Cloudflare tab ---------------------------------------------------------------------------
const tab = await A.evaluate(t => $tw.wiki.tiddlerExists(t) ? $tw.wiki.renderTiddler("text/plain", t) : null, TAB);
check("the Control Panel has the Cloudflare tab, and it says backups aren't set up", !!tab && tab.includes("Backups are off"), (tab || "no tab").slice(0, 80));

// --- 6. Nothing reached any other site, nothing was purged -----------------------------------------
check("every request the tab made went to the worker: none to a public site, none anywhere else",
  elsewhere("A").length === 0 && publicRequests.length === 0, elsewhere("A").map(r => r.url).concat(publicRequests).join(", "));
await sleep(500);
check("no purge was sent, though CF_ZONE_ID and CF_API_TOKEN are set: there's no public site to purge", purges().length === 0, purges().map(p => p.body).join(" "));

// --- 7. A second browser reads from the worker, and sees what the first saves -----------------------
const contextB = await browser.newContext();
const { p: B } = await open(contextB, "B");
check("a second browser gets the tiddler from the worker", await B.evaluate(() => $tw.wiki.getTiddlerText("First note") === "Hello from a private wiki") &&
  workerRequests("B").some(r => r.method === "GET" && r.path === "/recipes/default/tiddlers/First note"), workerRequests("B").map(r => r.path).join(", "));
await addTiddler(A, { title: "Second note", text: "Saved while another browser is open" });
await settle(A);
await B.evaluate(() => $tw.syncer.syncFromServer());
const seen = await waitFor(() => B.evaluate(() => $tw.wiki.getTiddlerText("Second note") === "Saved while another browser is open"));
check("...and a tiddler the first saves afterwards, at its next poll", seen);
check("...still without a request elsewhere", elsewhere("B").length === 0 && publicRequests.length === 0);

// --- 8. A public site given afterwards, in the dashboard: the next load takes it, nothing to migrate --
bucket = await site.setBindings({ PUBLIC_WIKI_URL: PUB });
await reload(A);
check("with PUBLIC_WIKI_URL set, the next load rebuilds the page with the public address, and every tiddler is still there",
  await A.evaluate(([pub, title]) => $tw.wiki.getTiddlerText("$:/cfworker/public-url") === pub + "/" && $tw.wiki.getTiddlerText(title) === "Hello from a private wiki", [PUB, "First note"]) &&
  await A.evaluate(() => $tw.wiki.getTiddlerText("Second note") === "Saved while another browser is open"));
const republished = await waitFor(async () => (await text(SHELL)).includes(`<script src="${PUB}${CORE_PATH}"`), 30000);
check("...the admin wiki publishes the page again, now loading the core from the public site", republished, (await text(SHELL)).match(/<script src="[^"]*tiddlywikicore[^"]*"/)?.[0]);
await waitFor(async () => (await text("baked.html")).includes(`<script src="${PUB}${CORE_PATH}"`), 30000);   // the page built from it
body = await (await reload(A)).body();
check("...and the page loads its core and plugin files from there", body.toString().includes(`<script src="${PUB}${CORE_PATH}"`) && body.toString().includes(`<script src="${PUB}${helloPath}`),
  body.toString().match(/<script src="[^"]*hello[^"]*"/)?.[0] || "no plugin tag");
const contextC = await browser.newContext();
mark = requests.length;
const { p: C } = await open(contextC, "C");
check("a new browser now reads the tiddlers from the public site, not the worker",
  await C.evaluate(() => $tw.wiki.getTiddlerText("First note") === "Hello from a private wiki") &&
  publicRequests.some(q => q === "/recipes/default/tiddlers/First note") && !workerRequests("C", mark).some(r => r.path.startsWith("/recipes/default/tiddlers/")),
  workerRequests("C", mark).map(r => r.path).join(", "));
await addTiddler(A, { title: "Third note", text: "Saved with a public site" });
await settle(A);
await waitFor(() => purges().length > 0);
check("a save now purges the public site", purges().some(p => p.body.includes("/recipes/default/tiddlers/Third%20note")), purges().map(p => p.body).join(" "));

await finish({ check, results, pageErrors, browser, site, cleanup: () => fs.rmSync(r2Dir, { recursive: true, force: true }) });
