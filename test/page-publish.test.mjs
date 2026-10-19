// The page, published from the admin wiki: a real TiddlyWiki in Chromium renders the shell (TiddlyWiki's
// $:/core/templates/tiddlywiki5-external-js.html) and the core file, sends them to the worker by
// itself, and both sites then run from them. Covers the first publish, saves that change the page
// and saves that don't, plugins with raw markup, several tabs, what other tabs deleted, tiddlers still
// loading, failures, a new index.html and safe mode.
// Run: npm run test:publish   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const ENGINE = readWikiFile();
const site = await startSite({
  index: ENGINE, publicStatus: true,
  publicSite: {
    // ?https: the page as built for a public URL on https, visited over http (the setting travels in
    // the admin plugin's text: its quotes escaped once more)
    rewrite: (url, body) => url.searchParams.has("https")
      ? Buffer.from(body.toString("utf8").replace('\\"title\\":\\"$:/cfworker/public-url\\",\\"text\\":\\"http:', '\\"title\\":\\"$:/cfworker/public-url\\",\\"text\\":\\"https:'))
      : body
  }
});
const { base: BASE, pub: PUB, bucket } = site;
const { check, results } = createChecks();
const browser = await launchBrowser();
const { requests, pageErrors, watch } = createWatcher(site);   // requests: those from pages, by tab (tag)
// Requests from a tab that reached the worker (not answered from the browser's cache)
const count = (tag, method, path, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.origin === "worker" && !r.cached && r.method === method && r.path.startsWith(path)).length;
const shellPuts = (tag, from) => count(tag, "PUT", "/page/shell", from);
const corePuts = (tag, from) => count(tag, "PUT", "/page/core", from);
// The admin wiki publishes a moment after a save (the publisher's pause, 200 ms in the test pages, then its look at
// the page): long enough for that to have happened
const QUIET_WINDOW = 1500;
const add = addTiddler;
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
// Whether text is in the page, after the marker named from and before the text to
const between = (html, text, from, to) => {
  const at = (html || "").indexOf(text), start = (html || "").indexOf(MARK(from));
  return at >= 0 && start >= 0 && at > start && at < html.indexOf(to, start);
};
async function openAdmin(tag, context, hash = "") {
  const p = await context.newPage();
  await watch(p, tag);
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
const loadRequests = requests.slice(mark).filter(r => r.tag === "A" && r.origin === "worker" && !r.cached).map(r => `${r.method} ${r.path.split("?")[0]}`);
check("an admin reload gets the light page, with the core file from the public site", body.length < ENGINE.length / 5 && body.toString().includes(`<script src="${CORE_URL}"`) &&
  requests.slice(mark).some(r => r.tag === "A" && r.origin === "public" && r.path.startsWith("/_plugins/tiddlywikicore.js")), `${body.length} bytes`);
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
check("the admin plugin itself, the worker's, is never published as a file: no file of it in the bucket, no tag for it in the page", !(await bucket.head("_plugins/$:/plugins/cfworker/admin.js")) && !(await (await bucket.get("baked.html")).text()).includes("_plugins/%24%3A%2Fplugins%2Fcfworker%2Fadmin.js"));
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
// The tiddlers in a page's tiddler stores (TiddlyWiki reads every one, in order)
const storeOf = text => [...text.matchAll(/<script class="tiddlywiki-tiddler-store" type="application\/json"[^>]*>(\[[\s\S]*?\])<\/script>/g)].flatMap(m => JSON.parse(m[1]));
const listedRevision = async title => JSON.parse(await (await bucket.get("recipes/default/tiddlers.json")).text()).find(e => e.title === title)?.revision;
const splashCopy = storeOf(html).find(t => t.title === "Splash");
check("...the copies in the shell carry the worker's revision", !!splashCopy && splashCopy.revision === await listedRevision("Splash"),
  `${splashCopy?.revision} vs ${await listedRevision("Splash")}`);

// The public site runs from the same page
const contextP = await browser.newContext();
const P = await contextP.newPage();
await watch(P, "public");
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
// The public site visited over http while its URL is set with https (or the other way round): still
// the public site, read-only, with nothing sent anywhere
const contextQ = await browser.newContext();
const Q = await contextQ.newPage();
await watch(Q, "public-http");
await Q.goto(PUB + "/?https");
await Q.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("Splash") && $tw.wiki.tiddlerExists("$:/status/IsReadOnly"), null, { timeout: 30000 });
await sleep(QUIET_WINDOW);
const overHttp = await Q.evaluate(() => ({ url: $tw.wiki.getTiddlerText("$:/cfworker/public-url"), readOnly: $tw.wiki.getTiddlerText("$:/status/IsReadOnly") }));
const httpRequests = requests.filter(r => r.tag === "public-http");
check("the public site visited over http with its URL set on https is still read-only, and sends nothing",
  overHttp.url.startsWith("https:") && overHttp.readOnly === "yes" && !httpRequests.some(r => r.method !== "GET" || r.origin === "worker"),
  JSON.stringify({ ...overHttp, sent: httpRequests.filter(r => r.method !== "GET" || r.origin === "worker").map(r => r.method + " " + r.origin + r.path) }));
await contextQ.close();

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

// --- 6. A plugin with raw markup is written into the page too, so TiddlyWiki renders its markup -------
// (Its file is still loaded: TiddlyWiki reads the page's tiddlers first, then the files, which hold
// the same plugin.) One without JavaScript works at once; one with JavaScript after a reload.
const FONTS = "$:/plugins/test/fonts";
const fonts = v => ({
  title: FONTS, "plugin-type": "plugin", type: "application/json", version: v,
  text: JSON.stringify({ tiddlers: {
    [FONTS + "/head"]: { tags: "$:/tags/RawMarkup", type: "text/plain", text: `<meta name="cfw-fonts" content="${v}">` },
    [FONTS + "/body"]: { tags: "$:/tags/RawMarkupWikified/TopBody", text: RAW + `<div class="tc-remove-when-wiki-loaded" id="cfw-fonts">fonts ${v}</div>` },
    [FONTS + "/readme"]: { text: "A plugin that adds a meta tag and a block" }
  } })
});
async function reloadAdmin(p) {
  await p.reload();
  await p.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
  await settle(p);
}
mark = requests.length;
await add(A, fonts("1.0.0"));
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("installing a plugin that has raw markup publishes the page once, its markup where TiddlyWiki puts it",
  shellPuts("A", mark) === 1 && between(html, '<meta name="cfw-fonts" content="1.0.0">', "Raw markup", "</head>") &&
  between(html, '<div class="tc-remove-when-wiki-loaded" id="cfw-fonts">fonts 1.0.0</div>', "Raw markup for the top of the body section", MARK("Static styles")),
  `${shellPuts("A", mark)} publishes`);
let store = storeOf(html);
check("...the plugin is in the page, with the worker's revision; a plugin without raw markup still isn't",
  !!store.find(t => t.title === FONTS) && store.find(t => t.title === FONTS).revision === await listedRevision(FONTS) && !store.some(t => t.title === HELLO),
  `${store.find(t => t.title === FONTS)?.revision} vs ${await listedRevision(FONTS)}`);
mark = requests.length;
await reloadAdmin(A);
await sleep(QUIET_WINDOW);
const served = await (await bucket.get("baked.html")).text();
check("...the page served has its markup and still loads its file, and a reload publishes nothing",
  served.includes('<meta name="cfw-fonts" content="1.0.0">') && served.includes(`${PUB}/_plugins/${encodeURIComponent(FONTS)}.js?v=`) &&
  shellPuts("A", mark) === 0 && await A.evaluate(t => $tw.wiki.isShadowTiddler(t), FONTS + "/head"), `${shellPuts("A", mark)} publishes`);

mark = requests.length;
await add(A, fonts("2.0.0"));
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("updating it publishes the page once, with the new markup", shellPuts("A", mark) === 1 &&
  html.includes('<meta name="cfw-fonts" content="2.0.0">') && html.includes('id="cfw-fonts">fonts 2.0.0</div>') &&
  !html.includes('<meta name="cfw-fonts" content="1.0.0">') && !html.includes('id="cfw-fonts">fonts 1.0.0</div>'), `${shellPuts("A", mark)} publishes`);

// A plugin with JavaScript (a widget loading a library from <head>, say): TiddlyWiki only starts it
// after a reload, and only then has its raw markup to render
const WIDGET = "$:/plugins/test/widget";
mark = requests.length;
await add(A, {
  title: WIDGET, "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: {
    [WIDGET + "/library"]: { tags: "$:/tags/RawMarkup", type: "text/plain", text: "<script>window.__widgetLibrary = true;</script>" },
    [WIDGET + "/startup.js"]: { type: "application/javascript", "module-type": "startup",
      text: "exports.name='widget-test';exports.platforms=['browser'];exports.synchronous=true;exports.startup=function(){window.__widgetRan=window.__widgetLibrary===true;};" }
  } })
});
await settle(A);
await sleep(QUIET_WINDOW);
check("a plugin with JavaScript and raw markup: TiddlyWiki asks for a reload, nothing is published yet",
  shellPuts("A", mark) === 0 && await A.evaluate(() => $tw.wiki.getTiddlerText("$:/status/RequireReloadDueToPluginChange") === "yes"));
mark = requests.length;
await reloadAdmin(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("...the next admin load publishes the page with its markup", shellPuts("A", mark) === 1 &&
  between(html, "<script>window.__widgetLibrary = true;</script>", "Raw markup", "</head>"), `${shellPuts("A", mark)} publishes`);
mark = requests.length;
await reloadAdmin(A);
await sleep(QUIET_WINDOW);
check("...from then on its markup runs before the plugin starts, and loads publish nothing",
  await A.evaluate(() => window.__widgetRan === true) && shellPuts("A", mark) === 0, `${shellPuts("A", mark)} publishes`);

mark = requests.length;
await A.evaluate(titles => titles.forEach(title => $tw.wiki.deleteTiddler(title)), [FONTS, WIDGET]);
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
store = storeOf(html);
check("deleting both publishes the page once, without them or their markup", shellPuts("A", mark) === 1 &&
  !html.includes('<meta name="cfw-fonts"') && !html.includes("<script>window.__widgetLibrary") && !store.some(t => t.title === FONTS || t.title === WIDGET),
  `${shellPuts("A", mark)} publishes`);

// --- 7. Several tabs: the tab that saved publishes, with what other tabs saved before ---------------
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
// Two tabs publishing moments apart: A's page reaches the worker after B's, though rendered before
// B's change (held back here). The worker refuses it, since another tab published since the page A
// sends was built, and A syncs and sends its page again, with B's change. Otherwise the older page
// would replace the newer one, and neither tab would know.
mark = requests.length;
let releaseA, aHeld = false, aAttempted = false;
const held = new Promise(resolve => { releaseA = resolve; });
await A.route("**/page/shell", async route => {
  aAttempted = true;
  if (!aHeld) {
    aHeld = true;
    await held;
  }
  await route.continue();
});
const aAnswers = [];
A.on("response", r => { if (r.request().method() === "PUT" && r.url().endsWith("/page/shell")) aAnswers.push(r.status()); });
await add(A, { title: "$:/SiteSubtitle", text: "subtitle A2" });
await waitFor(async () => aAttempted, 15000);
await add(B, { title: "Footer B2", tags: "$:/tags/RawMarkupWikified/BottomBody", text: RAW + "<script>window.__footerB2 = true;</script>" });
await settle(B);
await waitFor(async () => shellPuts("B", mark) > 0, 15000);
await sleep(QUIET_WINDOW);
const bPublished = (await shell()).includes("__footerB2") && (await shell()).includes("subtitle A2");
releaseA();
await waitFor(async () => aAnswers.length >= 2 && (await status(A))?.state !== "waiting", 20000);
await sleep(QUIET_WINDOW);
html = await shell();
check("a page that reaches the worker after another tab's, rendered before that tab's change, is refused, and the tab sends it again with the change",
  bPublished && aAnswers[0] === 409 && aAnswers[1] === 204 && shellPuts("A", mark) === 2 && html.includes("subtitle A2") && html.includes("__footerB2") && (await status(A))?.state === "published",
  `B published both ${bPublished}, A's answers ${aAnswers.join(", ")}, A's PUTs ${shellPuts("A", mark)}, shell has A's ${html.includes("subtitle A2")} and B's ${html.includes("__footerB2")}, A ${JSON.stringify(await status(A))}`);
await A.unroute("**/page/shell");
// A change another tab published, undone in this one: this tab then renders the page it published
// last, but that's no longer the one published, so it publishes
const UNDONE = "$:/cfw-test/undone";
mark = requests.length;
await add(A, { title: UNDONE, tags: "$:/tags/RawMarkup", type: "text/plain", text: '<meta name="cfw-undone" content="1">' });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
const undonePublished = (await shell()).includes("cfw-undone");
await B.evaluate(() => $tw.syncer.syncFromServer());
await settle(B);
mark = requests.length;
await B.evaluate(t => $tw.wiki.deleteTiddler(t), UNDONE);
await settle(B);
await waitFor(async () => shellPuts("B", mark) > 0, 10000);
await sleep(QUIET_WINDOW);
// (B's page was built before A published, so B's first send is refused and it sends again: two PUTs)
check("a change another tab published, undone in this one, is published by it (its last page is no longer the one published)",
  undonePublished && shellPuts("B", mark) >= 1 && shellPuts("B", mark) <= 2 && !(await shell()).includes("cfw-undone") && (await status(B))?.state === "published",
  `published by A ${undonePublished}, B's publishes ${shellPuts("B", mark)}, still in the shell ${(await shell()).includes("cfw-undone")}, B ${JSON.stringify(await status(B))}`);
await contextB.close();

// --- 8. What was deleted stays deleted ----------------------------------------------------------------
// TiddlyWiki keeps $:/ tiddlers that disappear from the server in the tabs already open: the page
// mustn't bring them back. A plugin this tab deleted and another tab installed again is an installed
// plugin, not one that came with the page. And a page left with a deleted tiddler by a failed publish
// is corrected by the next admin load.
const GONE_MARKUP = "$:/cfw-test/gone-markup", GONE_PLUGIN = "$:/plugins/test/gone", AGAIN = "$:/plugins/test/again";
const plainPlugin = (title, v) => ({ title, "plugin-type": "plugin", type: "application/json", version: v,
  text: JSON.stringify({ tiddlers: { [title + "/readme"]: { text: "A plugin without raw markup, " + v } } }) });
const inStore = (text, title) => storeOf(text).some(t => t.title === title);
// This tab saves the raw markup tiddler and installs a plugin; another tab installs a second plugin
mark = requests.length;
await add(A, { title: GONE_MARKUP, tags: "$:/tags/RawMarkup", type: "text/plain", text: '<meta name="cfw-gone" content="1">' });
await add(A, plainPlugin(AGAIN, "1.0.0"));
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
const markupPublished = (await shell()).includes('<meta name="cfw-gone" content="1">');
await A.evaluate(t => $tw.wiki.deleteTiddler(t), AGAIN);
await settle(A);
const contextE = await browser.newContext();
const { p: E } = await openAdmin("E", contextE);
await settle(E);
await add(E, plainPlugin(GONE_PLUGIN, "1.0.0"));
await settle(E);
await A.evaluate(() => $tw.syncer.syncFromServer());
await settle(A);
mark = requests.length;
await E.evaluate(titles => titles.forEach(t => $tw.wiki.deleteTiddler(t)), [GONE_MARKUP, GONE_PLUGIN]);
await add(E, plainPlugin(AGAIN, "2.0.0"));
await settle(E);
await waitFor(async () => shellPuts("E", mark) > 0);
await sleep(QUIET_WINDOW);
await A.evaluate(() => $tw.syncer.syncFromServer());
await settle(A);
const leftInA = await A.evaluate(titles => titles.map(t => $tw.wiki.tiddlerExists(t)), [GONE_MARKUP, GONE_PLUGIN, AGAIN]);
mark = requests.length;
await add(A, { title: "$:/SiteSubtitle", text: "after deletes in another tab" });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
check("a raw markup tiddler and a plugin deleted in another tab, still in this one, aren't published again by it",
  markupPublished && leftInA[0] && leftInA[1] && html.includes("after deletes in another tab") &&
  !html.includes('<meta name="cfw-gone" content="1">') && !inStore(html, GONE_MARKUP) && !inStore(html, GONE_PLUGIN),
  `published before ${markupPublished}, still in A ${JSON.stringify(leftInA)}, in the shell: markup ${html.includes('cfw-gone')}, plugin ${inStore(html, GONE_PLUGIN)}`);
check("...a plugin this tab deleted and another installed again is an installed plugin (a file), not part of the page",
  leftInA[2] && !inStore(html, AGAIN), `loaded again in A ${leftInA[2]}, in the shell ${inStore(html, AGAIN)}`);
check("...what came with the page is still in it", inStore(html, "$:/plugins/tiddlywiki/tiddlyweb") && inStore(html, "$:/themes/tiddlywiki/vanilla"));
await contextE.close();

// A failed publish leaves a deleted raw markup tiddler in the page: the next admin load takes it out
const STALE = "$:/cfw-test/stale-markup";
mark = requests.length;
await add(A, { title: STALE, tags: "$:/tags/RawMarkup", type: "text/plain", text: '<meta name="cfw-stale" content="1">' });
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
const stalePublished = (await shell()).includes('<meta name="cfw-stale" content="1">');
const refuse = url => url.pathname === "/page/shell";
await A.route(refuse, route => route.fulfill({ status: 500, body: "unavailable" }));
await A.evaluate(t => $tw.wiki.deleteTiddler(t), STALE);
await settle(A);
await waitFor(async () => (await status(A))?.state === "failed");
await A.unroute(refuse);
const staleLeft = (await shell()).includes('<meta name="cfw-stale" content="1">');
const contextF = await browser.newContext();
mark = requests.length;
await openAdmin("F", contextF);
await waitFor(async () => shellPuts("F", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
html = await shell();
check("a page that kept a deleted tiddler after a failed publish is corrected by the next admin load",
  stalePublished && staleLeft && shellPuts("F", mark) === 1 && !html.includes('<meta name="cfw-stale" content="1">') && !inStore(html, STALE),
  `published before ${stalePublished}, left by the failure ${staleLeft}, publishes ${shellPuts("F", mark)}, still there ${html.includes("cfw-stale")}`);
await contextF.close();
// (tab A publishes again at its next save)
await add(A, { title: "A note after the failure", text: "publishes again" });
await settle(A);
await waitFor(async () => (await status(A))?.state === "published");

// A plugin that came with index.html, updated from the wiki (the plugin library replaces it this way).
// The page carries it with revision "0", which the worker never gave: the save creates it on the
// worker, instead of being taken for a tiddler another tab deleted (which made a conflict copy and
// published a page without the plugin)
const BUNDLED = "$:/plugins/tiddlywiki/highlight";
const contextW = await browser.newContext();
const { p: W } = await openAdmin("W", contextW);   // a tab that still has the version from the page
await settle(W);
const bundledOriginal = await A.evaluate(t => $tw.wiki.getTiddler(t)?.fields.version, BUNDLED);
mark = requests.length;
await A.evaluate(t => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(t), { version: "9.9.9" })), BUNDLED);
await settle(A);
await sleep(QUIET_WINDOW);
await settle(A);
const bundledStored = await bucket.get("recipes/default/tiddlers/" + BUNDLED);
const bundledVersion = bundledStored ? JSON.parse(await bundledStored.text()).version : null;
const bundledCopies = await A.evaluate(t => $tw.wiki.filterTiddlers("[field:conflict-of[" + t + "]]"), BUNDLED);
check("a plugin that came with index.html, updated from the wiki, is saved like an installed one: no conflict, kept in the tab",
  bundledVersion === "9.9.9" && bundledCopies.length === 0 && await A.evaluate(t => $tw.wiki.tiddlerExists(t), BUNDLED),
  `stored ${bundledVersion}, copies ${JSON.stringify(bundledCopies)}`);
const contextU = await browser.newContext();
const { p: U } = await openAdmin("U", contextU);
await settle(U);
check("...and a fresh tab has the updated version", await U.evaluate(t => $tw.wiki.getTiddler(t)?.fields.version, BUNDLED) === "9.9.9");
await contextU.close();
await W.evaluate(t => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(t), { version: "8.8.8" })), BUNDLED);
await settle(W);
const otherStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/" + BUNDLED)).text()).version;
const otherCopies = await W.evaluate(t => $tw.wiki.filterTiddlers("[field:conflict-of[" + t + "]]"), BUNDLED);
check("...while a tab that updated it from the page's version too gets a conflict, not an overwrite",
  otherStored === "9.9.9" && otherCopies.length === 1, `stored ${otherStored}, copies ${JSON.stringify(otherCopies)}`);
// Deleting that update removes the plugin, as in a single-file wiki (where the update replaced the
// page's version), and so does deleting a plugin that came with the page, never updated
const NEVER_UPDATED = "$:/themes/tiddlywiki/snowwhite";
mark = requests.length;
await A.evaluate(titles => titles.forEach(t => $tw.wiki.deleteTiddler(t)), [BUNDLED, NEVER_UPDATED]);
await settle(A);
await waitFor(async () => shellPuts("A", mark) > 0);
await sleep(QUIET_WINDOW);
html = await shell();
const contextV = await browser.newContext();
const { p: V } = await openAdmin("V", contextV);
await settle(V);
const leftInV = await V.evaluate(titles => titles.map(t => $tw.wiki.getTiddler(t)?.fields.version ?? null), [BUNDLED, NEVER_UPDATED]);
check("deleting the update of a plugin that came with the page removes it, as in a single-file wiki; one never updated too",
  !inStore(html, BUNDLED) && !inStore(html, NEVER_UPDATED) && leftInV[0] === null && leftInV[1] === null && !(await bucket.head("recipes/default/tiddlers/" + BUNDLED)),
  `in the shell ${inStore(html, BUNDLED)} / ${inStore(html, NEVER_UPDATED)}, in a new tab ${JSON.stringify(leftInV)}`);
await contextV.close();
// The tab that had the page's version, then loaded the update from the worker (W): it still holds the
// plugin, as TiddlyWiki keeps $:/ tiddlers that leave the server, but its copy now carries a revision
// from the worker, so it's a deleted plugin, not one that came with the page: left out of W's next publish
await W.evaluate(() => $tw.syncer.syncFromServer());
await settle(W);
const stillInW = await W.evaluate(t => $tw.wiki.tiddlerExists(t), BUNDLED);
mark = requests.length;
await add(W, { title: "$:/SiteSubtitle", text: "from the tab that loaded the update" });
await settle(W);
const publishedByW = await waitFor(async () => (await shell()).includes("from the tab that loaded the update"), 20000);
html = await shell();
check("...and a tab that had the page's version, then loaded the update, doesn't put the plugin back at its next publish",
  stillInW && publishedByW && !inStore(html, BUNDLED), `still in W ${stillInW}, published ${publishedByW}, in the shell ${inStore(html, BUNDLED)}`);
await contextW.close();
await A.evaluate(() => $tw.syncer.syncFromServer());   // (A takes W's subtitle, which it changes again later)
await settle(A);
// To get index.html's version back (operating 3): delete the published shell and the page in R2, then open
// the admin wiki. The page is built from index.html, with the plugin, and that tab publishes it again.
await bucket.delete("_page/shell.html");
await bucket.delete("baked.html");
const contextBack = await browser.newContext();
mark = requests.length;
const { p: Back } = await openAdmin("Back", contextBack);
await settle(Back);
await waitFor(async () => shellPuts("Back", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
html = await shell();
await contextBack.close();
const contextAfter = await browser.newContext();
const { p: After } = await openAdmin("After", contextAfter);
await settle(After);
const backInS = await After.evaluate(t => $tw.wiki.getTiddler(t)?.fields.version ?? null, BUNDLED);
check("...and deleting the published shell and the page in R2 brings back index.html's version, published by the next admin load",
  !!bundledOriginal && bundledOriginal !== "9.9.9" && inStore(html, BUNDLED) && backInS === bundledOriginal,
  `original ${bundledOriginal}, in the shell ${inStore(html, BUNDLED)}, in a new tab ${backInS}`);
await contextAfter.close();

// --- 9. A tiddler whose text hasn't arrived yet is waited for ----------------------------------------
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
  await sleep(1500);   // (slow: past the publisher's pause and its look after the list, scaled for the tests)
  await route.continue().catch(() => {});
});
mark = requests.length;
await openAdmin("C", contextC);
await waitFor(async () => shellPuts("C", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
html = await shell();
check("an edit made outside the admin wiki is published at the next admin load, once its text has arrived",
  shellPuts("C", mark) === 1 && after(html, "Raw markup for the top of the body section").includes("Edited outside"), `${shellPuts("C", mark)} publishes`);
await contextC.close();

// --- 10. A failed publish is reported and tried again -----------------------------------------------
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
// A publish the worker kept but whose answer was lost (the tab saw a failure), then undone: the tab
// doesn't know which page is published, so the undo is published too
let loseAnswer = true;
const lose = url => url.pathname === "/page/shell";
await A.route(lose, async route => {
  if (!loseAnswer) return route.continue();
  loseAnswer = false;
  await route.fetch();
  return route.fulfill({ status: 503, body: "answer lost" });
});
const subtitleBefore = await A.evaluate(() => $tw.wiki.getTiddlerText("$:/SiteSubtitle"));
await add(A, { title: "$:/SiteSubtitle", text: "kept, answer lost" });
await settle(A);
await waitFor(async () => (await status(A))?.state === "failed");
const keptDespite = (await shell()).includes("kept, answer lost");
await add(A, { title: "$:/SiteSubtitle", text: subtitleBefore });
await settle(A);
await waitFor(async () => !(await shell()).includes("kept, answer lost"), 10000);
check("...and a change whose publish failed, though the worker kept the page, is published when undone",
  keptDespite && !(await shell()).includes("kept, answer lost") && (await shell()).includes(subtitleBefore),
  `kept by the worker ${keptDespite}, still published ${(await shell()).includes("kept, answer lost")}`);
await A.unroute(lose);

// A page the worker refuses (400 or 409: final for that page) isn't sent again at every save, only once
// the page changes (or after a reload); a 5xx above is still retried at the next save
const refusing = url => url.pathname === "/page/shell";
await A.route(refusing, route => route.fulfill({ status: 400, body: "refused for the test" }));
mark = requests.length;
await add(A, { title: "$:/SiteSubtitle", text: "refused subtitle" });
await settle(A);
await waitFor(async () => (await status(A))?.state === "failed" && /refused for the test/.test((await status(A)).text));
await add(A, { title: "Unrelated 1", text: "x" }); await settle(A); await sleep(QUIET_WINDOW);
await add(A, { title: "Unrelated 2", text: "y" }); await settle(A); await sleep(QUIET_WINDOW);
const afterRefusal = shellPuts("A", mark), listGets = count("A", "GET", "/recipes/default/tiddlers.json", mark);
check("a refused page isn't sent again at the next saves that don't change it (no list request either)", afterRefusal === 1 && listGets <= 1,
  `${afterRefusal} shell PUTs, ${listGets} list requests`);
await add(A, { title: "$:/SiteSubtitle", text: "refused subtitle, changed" }); await settle(A); await sleep(QUIET_WINDOW);
check("...a change to the page is sent again", shellPuts("A", mark) === 2, `${shellPuts("A", mark)} shell PUTs`);
await A.unroute(refusing);
await add(A, { title: "$:/SiteSubtitle", text: "accepted again" }); await settle(A);
await waitFor(async () => (await shell()).includes("accepted again"));
// A core file the worker refuses isn't sent again at the next page changes either (no page can be
// published without it), only after a reload. (A tab that has to send the core: the stored one
// relabelled, and the page rebuilt so it says so.)
const CORE_KEY = "_plugins/tiddlywikicore.js";
const storedCoreFile = await bucket.get(CORE_KEY);
const storedCoreBytes = await storedCoreFile.arrayBuffer();
const relabel = v => bucket.put(CORE_KEY, storedCoreBytes, { httpMetadata: storedCoreFile.httpMetadata, customMetadata: { ...storedCoreFile.customMetadata, v } });
const markPageOutdated = async () => {
  const page = await bucket.get("baked.html");
  await bucket.put("baked.html", await page.arrayBuffer(), { httpMetadata: page.httpMetadata, customMetadata: { ...page.customMetadata, bakeVersion: "outdated" } });
};
await relabel("0.0.0-1");
await markPageOutdated();
const contextR = await browser.newContext();
await contextR.route(url => url.pathname === "/page/core", route => route.fulfill({ status: 400, body: "core refused for the test" }));
mark = requests.length;
const { p: R } = await openAdmin("R", contextR);
await settle(R);
await waitFor(async () => (await status(R))?.state === "failed" && /core refused for the test/.test((await status(R)).text));
await add(R, { title: "$:/SiteSubtitle", text: "while the core is refused" }); await settle(R); await sleep(QUIET_WINDOW);
await add(R, { title: "$:/SiteSubtitle", text: "while the core is refused, again" }); await settle(R); await sleep(QUIET_WINDOW);
check("a refused core file isn't sent again at the next page changes (nor the shell, which needs it)",
  corePuts("R", mark) === 1 && shellPuts("R", mark) === 0, `${corePuts("R", mark)} core PUTs, ${shellPuts("R", mark)} shell PUTs, ${JSON.stringify(await status(R))}`);
await contextR.close();
await relabel(CORE_V);
await add(A, { title: "$:/SiteSubtitle", text: "accepted again" }); await settle(A);
await markPageOutdated();
// While the worker keeps refusing the page (one too big, say), the core file the first load stores
// isn't sent again at every load: storing a new one marks the page outdated, so the next load's page
// says it's stored. (A tab that has to send the core: the stored one relabelled, as above.)
await relabel("0.0.0-1");
await markPageOutdated();
const contextRefused = await browser.newContext();
await contextRefused.route(url => url.pathname === "/page/shell", route => route.fulfill({ status: 400, body: "The shell is too big." }));
mark = requests.length;
const { p: Refused } = await openAdmin("Refused", contextRefused);
for (let load = 1; load <= 3; load++) {
  if (load > 1) {
    await Refused.reload();
    await Refused.waitForFunction(() => window.$tw && $tw.syncer, null, { timeout: 30000 });
  }
  await settle(Refused);
  await sleep(QUIET_WINDOW);
}
check("while the page keeps being refused, the core file is sent once, not at every load",
  corePuts("Refused", mark) === 1 && shellPuts("Refused", mark) >= 1 && (await bucket.head(CORE_KEY))?.customMetadata?.v === CORE_V,
  `${corePuts("Refused", mark)} core PUTs, ${shellPuts("Refused", mark)} shell PUTs over 3 loads`);
await contextRefused.close();

// An error while rendering the page (here an editor that takes focus, in raw markup: the page is
// rendered as text, where nothing can) is reported, and doesn't stop later publishes in that tab
await add(A, { title: "Breaks rendering", tags: "$:/tags/RawMarkupWikified", text: '<$edit-text tiddler="Some note" focus="yes"/>' });
await settle(A);
await waitFor(async () => (await status(A))?.state === "failed");
const broken = await status(A);
check("an error while rendering the page is reported", broken?.state === "failed" && /Page not published/.test(broken?.text || ""), JSON.stringify(broken));
await A.evaluate(() => $tw.wiki.deleteTiddler("Breaks rendering"));
await add(A, { title: "$:/SiteSubtitle", text: "after a rendering error" });
await settle(A);
await waitFor(async () => (await shell()).includes("after a rendering error"));
check("...and the tab publishes again at its next save", (await shell()).includes("after a rendering error") && (await status(A))?.state === "published", JSON.stringify(await status(A)));

// --- 11. A new index.html: the page is built from it, then published again ----------------------------
await bucket.put("index.html", ENGINE.replace("</head>", "<!-- new upload -->\n</head>"));
const contextD = await browser.newContext();
mark = requests.length;
const { response: firstD } = await openAdmin("D", contextD);
const firstBody = await firstD.body();
await waitFor(async () => shellPuts("D", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
check("a new index.html: the first load gets a page built from it", firstBody.toString().includes("<!-- new upload -->") && firstBody.length > ENGINE.length / 2);
check("...and that load publishes a shell for it (the stored core file reused, not sent again)", shellPuts("D", mark) === 1 && corePuts("D", mark) === 0 &&
  (await bucket.head("_page/shell.html"))?.customMetadata?.index === (await bucket.head("index.html")).etag);
await contextD.close();

// --- 11b. The engine updated from the Cloudflare tab (design 1.15) -----------------------------------
// An older engine in the bucket (the shipped one with a version tag of its own): the tab shows both
// versions and the button; the update replaces index.html with the shipped engine, and the next load
// runs it, publishes it, and still has the tiddlers.
const TAB = "$:/temp/cfworker/ControlPanel", ENGINE_STATE = "$:/temp/cfworker/engine", ENGINE_SAID = "$:/temp/cfworker/engine-message";
const shipped = (ENGINE.match(/<meta name="tiddlywiki-version" content="([^"]*)"/) || [])[1];
const tabText = p => p.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), TAB);
await bucket.put("index.html", ENGINE.replace(/<meta name="tiddlywiki-version" content="[^"]*"/, '<meta name="tiddlywiki-version" content="5.0.0"'));
const contextG = await browser.newContext();
mark = requests.length;
const { p: G } = await openAdmin("G", contextG);
await waitFor(async () => shellPuts("G", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
await add(G, { title: "Kept across engines", text: "saved before the update" });
await settle(G);
const tabBefore = await tabText(G);
check("the Cloudflare tab shows the engine's version and the one the worker ships, with the Update button, when they differ",
  !!shipped && tabBefore.includes(`TiddlyWiki 5.0.0`) && tabBefore.includes(`the worker ships ${shipped}`) && tabBefore.includes("Update the engine") && await G.evaluate(t => $tw.wiki.getTiddler(t)?.fields.same === "no", ENGINE_STATE),
  tabBefore.replace(/^.*?The engine/, "The engine").slice(0, 200));
await G.evaluate(() => $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-engine-update" }));
await waitFor(() => G.evaluate(t => $tw.wiki.tiddlerExists(t) && !/Replacing/.test($tw.wiki.getTiddlerText(t)), ENGINE_SAID), 20000);
const engineSaid = await G.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), ENGINE_SAID);
check("the update replaces the engine with the shipped one and says so, with both versions", engineSaid.includes("5.0.0") && engineSaid.includes(shipped) && (await (await bucket.get("index.html")).text()) === ENGINE, engineSaid.slice(0, 200));
const tabReplaced = await tabText(G);
check("...and until the reload runs it, the tab offers the reload and no longer the update", /Engine replaced/.test(tabReplaced) && /Reload/.test(tabReplaced) && !tabReplaced.includes("Update the engine"),
  tabReplaced.replace(/^.*?The engine/, "The engine").slice(0, 200));
mark = requests.length;
await G.reload();
await G.waitForFunction(() => window.$tw && $tw.wiki && $tw.rootWidget, null, { timeout: 30000 });
await waitFor(async () => shellPuts("G", mark) > 0, 30000);
await sleep(QUIET_WINDOW);
const tabAfter = await tabText(G);
check("...after the reload the wiki runs the shipped engine, the tab says the versions match (no button), the page is republished, and the tiddlers are still there",
  tabAfter.includes(`TiddlyWiki ${shipped}, the version the worker ships`) && !tabAfter.includes("Update the engine") && shellPuts("G", mark) === 1 &&
  (await bucket.head("_page/shell.html"))?.customMetadata?.index === (await bucket.head("index.html")).etag && await G.evaluate(() => $tw.wiki.getTiddlerText("Kept across engines") === "saved before the update"),
  `${tabAfter.replace(/^.*?The engine/, "The engine").slice(0, 160)} | shell puts ${shellPuts("G", mark)}`);
await contextG.close();

// --- 12. Safe mode publishes nothing --------------------------------------------------------------
const contextS = await browser.newContext();
mark = requests.length;
const { p: S } = await openAdmin("S", contextS, "#:safe");
await sleep(QUIET_WINDOW);
// (TiddlyWiki's "put" saver still probes the page's address there: the browser module doesn't run
// without TiddlyWeb, which safe mode leaves out)
check("an admin tab in TiddlyWiki's safe mode doesn't publish or sync", requests.slice(mark).filter(r => r.tag === "S" && r.origin === "worker" &&
  (r.method === "PUT" || r.method === "DELETE" || r.path.startsWith("/recipes/"))).length === 0 && await S.evaluate(() => $tw.safeMode === true),
  JSON.stringify(requests.slice(mark).filter(r => r.tag === "S").map(r => r.method + " " + r.path)));
await contextS.close();

// --- 13. The link-preview tags, whatever a tab has loaded ----------------------------------------------
// TiddlyWiki's Open Graph tags take the site URL and the preview image from $:/SiteUrl and
// $:/SitePreviewUrl, read in a way that loads nothing: a tab that hasn't loaded them would publish a
// page without the tags. The worker preloads them with the page, so every tab has them
const contextK = await browser.newContext();
const { p: K } = await openAdmin("K", contextK);
await settle(K);
await add(K, { title: "$:/config/cfworker/LoadAll", text: "no" });   // (from now on a tab loads only what it shows)
await add(K, { title: "$:/SiteUrl", text: "https://wiki.example.com/" });
await add(K, { title: "$:/SitePreviewUrl", text: "https://wiki.example.com/preview.png" });
await settle(K);
const tagsPublished = await waitFor(async () => (await shell()).includes('content="https://wiki.example.com/preview.png"'), 20000);
await contextK.close();
const contextL = await browser.newContext();
mark = requests.length;
const { p: L } = await openAdmin("L", contextL);
await settle(L);
await sleep(QUIET_WINDOW * 2);
html = await shell();
check("the Open Graph URL and image, from $:/SiteUrl and $:/SitePreviewUrl, stay in the page a tab that loads only what it shows publishes: the worker preloads them",
  tagsPublished && /<meta property="og:url" content="https:\/\/wiki\.example\.com\/"/.test(html) && /<meta property="og:image" content="https:\/\/wiki\.example\.com\/preview\.png"/.test(html) &&
  await L.evaluate(() => !$tw.wiki.getTiddler("$:/SiteUrl").hasField("_is_skinny")),
  `published by K ${tagsPublished}, og:url ${(/<meta property="og:url"[^>]*>/.exec(html) || ["none"])[0]}, shell puts by L ${shellPuts("L", mark)}`);
await contextL.close();

await finish({ check, results, pageErrors, browser, site });
