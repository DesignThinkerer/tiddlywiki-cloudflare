// The page, published from the admin wiki: a real TiddlyWiki in Chromium renders the shell (TiddlyWiki's
// $:/core/templates/tiddlywiki5-external-js.html) and the core file, sends them to the worker by
// itself, and both sites then run from them. Covers the first publish, saves that change the page
// and saves that don't, several tabs, tiddlers still loading, failures, a new index.html and safe mode.
// Run: npm run test:publish   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
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
const ENGINE = fs.readFileSync(WIKI_HTML, "utf8");

const PORT = 8786, PUBLIC_PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const PUB = `http://127.0.0.1:${PUBLIC_PORT}`;
const mf = new Miniflare({
  modules: true, scriptPath: WORKER, compatibilityDate: "2024-09-23", port: PORT, r2Buckets: ["WIKI_BUCKET"],
  bindings: { PUBLIC_WIKI_URL: PUB },
  outboundService: async () => new Response('{"success":true}'),
});
await mf.ready;
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
await bucket.put("index.html", ENGINE);
await bucket.put("recipes/default/tiddlers.json", "[]");
await bucket.put("status", JSON.stringify({ username: "GUEST", read_only: true, anonymous: true, logout_is_available: false, space: { recipe: "default" } }), { httpMetadata: { contentType: "application/json" } });

// Stand-in for the public site: the R2 bucket served directly, "/" rewritten to baked.html
const publicServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUB);
  const obj = await bucket.get(decodeURIComponent(url.pathname.slice(1)) || "baked.html");
  if (!obj) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" });
  res.end(Buffer.from(await obj.arrayBuffer()));
});
await new Promise(resolve => publicServer.listen(PUBLIC_PORT, "127.0.0.1", resolve));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const pageErrors = [];
const requests = [];   // { tag, host: "worker" | "public", method, path }
function watch(p, tag) {
  p.on("pageerror", e => pageErrors.push(`${tag}: ${e.message}`));
  p.on("request", q => {
    const url = new URL(q.url());
    const host = url.origin === BASE ? "worker" : url.origin === PUB ? "public" : "other";
    requests.push({ tag, host, method: q.method(), path: url.pathname + url.search });
  });
}
const count = (tag, method, path, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.host === "worker" && r.method === method && r.path.startsWith(path)).length;
const shellPuts = (tag, from) => count(tag, "PUT", "/page/shell", from);
const corePuts = (tag, from) => count(tag, "PUT", "/page/core", from);
async function settle(p) {
  await p.waitForFunction(() => {
    const s = window.$tw && $tw.syncer;
    if (!s) return false;
    const quiet = !s.isDirty() && s.numTasksInProgress === 0 && Object.keys(s.titlesToBeLoaded).length === 0 && !s.forceSyncFromServer;
    window.__quiet = quiet ? (window.__quiet || 0) + 1 : 0;
    return window.__quiet >= 3;
  }, null, { timeout: 30000, polling: 300 });
}
async function waitFor(condition, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(200);
  }
  return false;
}
// The admin wiki publishes a moment after a save: long enough for that to have happened
const QUIET_WINDOW = 3500;
const add = (p, fields) => p.evaluate(f => $tw.wiki.addTiddler(new $tw.Tiddler(f)), fields);
const status = p => p.evaluate(() => {
  const t = $tw.wiki.getTiddler("$:/temp/cfworker/page-publisher");
  return t ? { state: t.fields.state, text: t.fields.text } : null;
});
const shell = async () => { const obj = await bucket.get("_page/shell.html"); return obj ? obj.text() : ""; };
const MARK = name => `<!--~~ ${name} ~~-->`;
const after = (html, name) => {
  const at = (html || "").indexOf(MARK(name));
  return at < 0 ? "" : html.slice(at + MARK(name).length).trimStart();
};
const RAW = "\\rules only filteredtranscludeinline transcludeinline\n";
async function openAdmin(tag, context, hash = "") {
  const p = await context.newPage();
  watch(p, tag);
  const response = await p.goto(BASE + "/" + hash);
  await p.waitForFunction(() => window.$tw && $tw.wiki && $tw.rootWidget, null, { timeout: 30000 });
  return { p, response };
}

// --- 1. The first admin load publishes the core file and the shell by itself ----------------------
const contextA = await browser.newContext();
let { p: A } = await openAdmin("A", contextA);
await settle(A);
const version = await A.evaluate(() => $tw.version);
const CORE_V = `${version}-1`;
const CORE_URL = `${PUB}/_plugins/tiddlywikicore.js?v=${CORE_V}`;
await waitFor(async () => !!(await bucket.head("_page/shell.html")));
const coreObj = await bucket.get("_plugins/tiddlywikicore.js");
const coreText = coreObj ? await coreObj.text() : "";
let html = await shell();
check("the first admin load publishes the core file and the shell, by itself", corePuts("A") === 1 && shellPuts("A") === 1 && !!coreObj && !!html,
  `core ${corePuts("A")}, shell ${shellPuts("A")}`);
check("the core file is TiddlyWiki's core and boot code, for this version, cached for a year",
  coreObj?.customMetadata?.v === CORE_V && coreText.includes('"$:/core"') && coreText.includes("$:/boot/boot.js") && /immutable/.test(coreObj?.httpMetadata?.cacheControl || ""),
  `v ${coreObj?.customMetadata?.v}, ${coreText.length} chars`);
check("...without TiddlyWiki's line that would change TiddlyWeb's offline snapshot", !/SaveWikiButton\/Template",\s*text: "\$:\/core\/save\/offline-external-js"/.test(coreText));
check("the shell is TiddlyWiki's external-core page: the core loaded at the end, TiddlyWeb and the themes inside, not the core",
  !!html && html.includes(`<script src="${CORE_URL}"`) && after(html, "Load external JavaScripts").startsWith(`<script src="${CORE_URL}"`) &&
  /"title":"\$:\/plugins\/tiddlywiki\/tiddlyweb"/.test(html) && /"title":"\$:\/themes\/tiddlywiki\/vanilla"/.test(html) && !/"title":"\$:\/core"/.test(html),
  `${html?.length} chars`);
check("...a fraction of index.html's size", !!html && html.length < ENGINE.length / 5, `${html?.length} vs ${ENGINE.length}`);
check("index.html is left as uploaded", (await (await bucket.get("index.html")).text()) === ENGINE);

// --- 2. From then on, the admin wiki runs from the light page ---------------------------------------
let mark = requests.length;
const reloaded = await A.reload();
await A.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
await settle(A);
const body = await reloaded.body();
const loadRequests = requests.slice(mark).filter(r => r.tag === "A" && r.host === "worker").map(r => `${r.method} ${r.path.split("?")[0]}`);
check("an admin reload gets the light page, with the core file from the public site", body.length < ENGINE.length / 5 && body.toString().includes(`<script src="${CORE_URL}"`) &&
  requests.slice(mark).some(r => r.tag === "A" && r.host === "public" && r.path.startsWith("/_plugins/tiddlywikicore.js")), `${body.length} bytes`);
check("...still 2 worker requests (the page, the tiddler list), and nothing published again", loadRequests.length === 2 && shellPuts("A", mark) === 0 && corePuts("A", mark) === 0, JSON.stringify(loadRequests));
check("...TiddlyWiki started, with TiddlyWeb's offline snapshot setting unchanged",
  await A.evaluate(() => $tw.wiki.tiddlerExists("$:/core") && !!$tw.syncadaptor && $tw.wiki.getTiddlerText("$:/config/SaveWikiButton/Template") === "$:/plugins/tiddlywiki/tiddlyweb/save/offline"));

// --- 3. A plugin installed from the wiki stays a file, loaded right before the core -----------------
const HELLO = "$:/plugins/test/hello";
mark = requests.length;
await add(A, {
  title: HELLO, "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { [HELLO + "/startup.js"]: {
    type: "application/javascript", "module-type": "startup",
    text: "exports.name='hello-test';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__helloRan=true;};"
  } } })
});
await settle(A);
await sleep(QUIET_WINDOW);
check("installing a plugin doesn't publish the page (the plugin is a file, not part of the shell)", shellPuts("A", mark) === 0 && !(await shell()).includes(HELLO));
await A.reload();
await A.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
await settle(A);
const baked = await (await bucket.get("baked.html")).text();
const helloTag = baked.indexOf(`${PUB}/_plugins/${encodeURIComponent(HELLO)}.js?v=`);
check("...it works after a reload, its file loaded after the tiddlers and before the core", await A.evaluate(() => window.__helloRan === true) &&
  helloTag > baked.indexOf(MARK("Ordinary tiddlers")) && helloTag < baked.indexOf(MARK("Load external JavaScripts")), `tag at ${helloTag}`);

// --- 4. A save that changes the page publishes it, once for a burst ----------------------------------
mark = requests.length;
await add(A, { title: "$:/SiteTitle", text: "Théo's notes" });
await add(A, { title: "$:/SiteSubtitle", text: "published from the admin wiki" });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
const expectedTitle = (await A.evaluate(() => $tw.wiki.renderText("text/plain", "text/vnd.tiddlywiki", "{{$:/core/wiki/title}}"))).replace(/&/g, "&amp;").replace(/</g, "&lt;");
check("changing the title and subtitle publishes the page, once", shellPuts("A", mark) === 1 && corePuts("A", mark) === 0, `${shellPuts("A", mark)} publishes`);
check("...with the title TiddlyWiki renders, and its Open Graph tags", html.includes(`<title>${expectedTitle}</title>`) && /<meta property="og:title" content="Théo/.test(html),
  `expected ${expectedTitle}, got ${(/<title>[^<]*<\/title>/.exec(html) || [])[0]} ${(/<meta property="og:title"[^>]*>/.exec(html) || [])[0]}`);

mark = requests.length;
const SPLASH = '<div class="tc-remove-when-wiki-loaded" id="cfw-splash">Loading {{$:/SiteTitle}}</div>';
await add(A, { title: "Splash", tags: "$:/tags/RawMarkupWikified/TopBody", text: RAW + SPLASH });
await add(A, { title: "Description", tags: "$:/tags/RawMarkup", type: "text/plain", text: '<meta name="description" content="A test wiki">' });
await add(A, { title: "Top of head", tags: "$:/tags/RawMarkupWikified/TopHead", text: RAW + '<meta name="cfw-top" content="1">' });
await add(A, { title: "Footer script", tags: "$:/tags/RawMarkupWikified/BottomBody", text: RAW + "<script>window.__footerRan = true;</script>" });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("adding four raw markup tiddlers publishes once", shellPuts("A", mark) === 1, `${shellPuts("A", mark)} publishes`);
check("...each where TiddlyWiki puts it, transclusions filled in",
  after(html, "Raw markup for the top of the body section").startsWith(SPLASH.replace("{{$:/SiteTitle}}", "Théo's notes")) &&
  after(html, "Raw markup").startsWith('<meta name="description" content="A test wiki">') &&
  after(html, "Raw markup for the top of the head section").startsWith('<meta name="cfw-top" content="1">') &&
  after(html, "Raw markup for the bottom of the body section").startsWith("<script>window.__footerRan = true;</script>"),
  after(html, "Raw markup for the top of the body section").slice(0, 100));

// The copies in the shell carry the worker's revision (TiddlyWeb would write a count of this tab's
// changes, different in every tab): every tab renders the same page, and a page load doesn't reload them
const storeOf = text => JSON.parse(/<script class="tiddlywiki-tiddler-store" type="application\/json">(\[[\s\S]*?\])<\/script>/.exec(text)[1]);
const listedRevision = async title => JSON.parse(await (await bucket.get("recipes/default/tiddlers.json")).text()).find(e => e.title === title)?.revision;
const splashCopy = storeOf(html).find(t => t.title === "Splash");
check("...the copies in the shell carry the worker's revision", !!splashCopy && splashCopy.revision === await listedRevision("Splash"),
  `${splashCopy?.revision} vs ${await listedRevision("Splash")}`);

// The public site runs from the same page
const contextP = await browser.newContext();
const P = await contextP.newPage();
watch(P, "public");
await P.goto(PUB + "/");
await P.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("Splash"), null, { timeout: 30000 });
const onPublic = await P.evaluate(() => ({
  splashGone: !document.getElementById("cfw-splash"), footer: window.__footerRan === true, hello: window.__helloRan === true,
  description: document.querySelector('meta[name="description"]')?.content
}));
check("the public site runs from the light page: plugins, raw markup, the splash removed once TiddlyWiki started",
  onPublic.splashGone && onPublic.footer && onPublic.hello && onPublic.description === "A test wiki", JSON.stringify(onPublic));
check("...and never publishes", requests.filter(r => r.tag === "public" && r.method === "PUT").length === 0);
await contextP.close();

// --- 5. Saves that don't change the page send nothing ----------------------------------------------
mark = requests.length;
await add(A, { title: "A note", text: "nothing to do with the page" });
await settle(A);
await sleep(QUIET_WINDOW);
check("a save that doesn't change the page: nothing published, not even a tiddler list request",
  shellPuts("A", mark) === 0 && count("A", "GET", "/recipes/default/tiddlers.json", mark) === 0, JSON.stringify(requests.slice(mark).filter(r => r.tag === "A").map(r => r.method + " " + r.path)));
mark = requests.length;
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Splash"), { title: "Draft of 'Splash'", "draft.of": "Splash", "draft.title": "Splash", text: "\\rules only filteredtranscludeinline transcludeinline\n<p>typing...</p>" })));
await sleep(QUIET_WINDOW);
check("typing in a draft of a raw markup tiddler: nothing published", shellPuts("A", mark) === 0 && !(await shell()).includes("typing..."));
await A.evaluate(() => $tw.wiki.deleteTiddler("Draft of 'Splash'"));

// --- 6. Several tabs: the tab that saved publishes, with what other tabs saved before ---------------
const contextB = await browser.newContext();
mark = requests.length;
const { p: B } = await openAdmin("B", contextB);
await settle(B);
await sleep(QUIET_WINDOW);
check("opening another admin tab publishes nothing (its page is current)", shellPuts("B", mark) === 0 && corePuts("B", mark) === 0);
mark = requests.length;
await add(A, { title: "Splash", tags: "$:/tags/RawMarkupWikified/TopBody", text: RAW + '<div class="tc-remove-when-wiki-loaded" id="cfw-splash">From A</div>' });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await B.evaluate(() => $tw.syncer.syncFromServer());
await settle(B);
await sleep(QUIET_WINDOW);
check("a change saved in tab A is published by A, not by tab B once it has it", shellPuts("A", mark) === 1 && shellPuts("B", mark) === 0 &&
  await B.evaluate(() => $tw.wiki.getTiddlerText("Splash").includes("From A")));
// A saves a new title; B, which hasn't seen it yet, saves a footer: B's page includes both
mark = requests.length;
await add(A, { title: "$:/SiteSubtitle", text: "subtitle from A" });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
const bBefore = await B.evaluate(() => $tw.wiki.getTiddlerText("$:/SiteSubtitle"));
await add(B, { title: "Footer script", tags: "$:/tags/RawMarkupWikified/BottomBody", text: RAW + "<script>window.__footerRan = 'B';</script>" });
await settle(B);
await waitFor(async () => shellPuts("B", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("a tab that publishes after another includes that tab's change (it syncs first)", bBefore !== "subtitle from A" &&
  html.includes("subtitle from A") && html.includes("window.__footerRan = 'B'"), `B had "${bBefore}"`);
await contextB.close();

// --- 7. A tiddler whose text hasn't arrived yet is waited for ----------------------------------------
// Edited outside the admin wiki (in R2): the next admin load publishes it, once its text is there
const splashKey = "recipes/default/tiddlers/Splash";
const storedSplash = JSON.parse(await (await bucket.get(splashKey)).text());
const outsideRevision = String(Date.now());
storedSplash.text = RAW + '<div class="tc-remove-when-wiki-loaded" id="cfw-splash">Edited outside</div>';
storedSplash.revision = outsideRevision;
const { revision: _r, bag: _b, recipe: _rc, ...splashFields } = storedSplash;
await bucket.put(splashKey, JSON.stringify(splashFields).slice(0, -1) + `,"revision":"${outsideRevision}","bag":"default","recipe":"default"}`, { customMetadata: { revision: outsideRevision, layout: "flat" } });
const list = JSON.parse(await (await bucket.get("recipes/default/tiddlers.json")).text());
for (const entry of list) if (entry.title === "Splash") entry.revision = outsideRevision;
await bucket.put("recipes/default/tiddlers.json", JSON.stringify(list));
const contextC = await browser.newContext();
await contextC.route(url => url.pathname.endsWith("/tiddlers/Splash"), async route => {
  await sleep(4000);
  await route.continue().catch(() => {});
});
mark = requests.length;
const { p: C } = await openAdmin("C", contextC);
await waitFor(async () => shellPuts("C", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
html = await shell();
check("an edit made outside the admin wiki is published at the next admin load, once its text has arrived",
  shellPuts("C", mark) === 1 && after(html, "Raw markup for the top of the body section").includes("Edited outside"), `${shellPuts("C", mark)} publishes`);
await contextC.close();

// --- 8. A failed publish is reported and tried again -----------------------------------------------
let failNext = true;
await A.route(url => url.pathname === "/page/shell", async route => {
  if (failNext) {
    failNext = false;
    return route.fulfill({ status: 500, body: "worker unavailable" });
  }
  return route.continue();
});
mark = requests.length;
await add(A, { title: "$:/SiteSubtitle", text: "after a failure" });
await settle(A);
await waitFor(async () => (await status(A))?.state === "failed");
const failed = await status(A);
check("a failed publish is reported", failed?.state === "failed" && /worker unavailable/.test(failed?.text || ""), JSON.stringify(failed));
await add(A, { title: "Another note", text: "triggers the retry" });
await settle(A);
await waitFor(async () => (await shell()).includes("after a failure"));
check("...and tried again at the next save", (await shell()).includes("after a failure") && (await status(A))?.state === "published", JSON.stringify(await status(A)));
await A.unroute(url => url.pathname === "/page/shell");

// --- 9. A new index.html: the page is built from it, then published again ----------------------------
await bucket.put("index.html", ENGINE.replace("</head>", "<!-- new upload -->\n</head>"));
const contextD = await browser.newContext();
mark = requests.length;
const { p: D, response: firstD } = await openAdmin("D", contextD);
const firstBody = await firstD.body();
await waitFor(async () => shellPuts("D", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
check("a new index.html: the first load gets a page built from it", firstBody.toString().includes("<!-- new upload -->") && firstBody.length > ENGINE.length / 2);
check("...and that load publishes a shell for it (the stored core file reused, not sent again)", shellPuts("D", mark) === 1 && corePuts("D", mark) === 0 &&
  (await bucket.head("_page/shell.html"))?.customMetadata?.index === (await bucket.head("index.html")).etag);
await contextD.close();

// --- 10. Safe mode publishes nothing --------------------------------------------------------------
const contextS = await browser.newContext();
mark = requests.length;
const { p: S } = await openAdmin("S", contextS, "#:safe");
await sleep(QUIET_WINDOW);
// (TiddlyWiki's "put" saver still probes the page's address there: the browser module doesn't run
// without TiddlyWeb, which safe mode leaves out)
check("an admin tab in TiddlyWiki's safe mode doesn't publish or sync", requests.slice(mark).filter(r => r.tag === "S" && r.host === "worker" &&
  (r.method === "PUT" || r.method === "DELETE" || r.path.startsWith("/recipes/"))).length === 0 && await S.evaluate(() => $tw.safeMode === true),
  JSON.stringify(requests.slice(mark).filter(r => r.tag === "S").map(r => r.method + " " + r.path)));
await contextS.close();

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
await mf.dispose();
publicServer.close();
process.exit(results.every(Boolean) ? 0 : 1);
