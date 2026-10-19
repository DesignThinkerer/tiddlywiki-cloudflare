// Plugins and JavaScript modules as files in R2, loaded by the page before TiddlyWiki boots, on the
// admin site and on the public site. Uses real plugins shipped with TiddlyWiki (markdown, KaTeX).
// Run: npm run test:plugins   (WIKI_HTML=path/to/your/index.html to test with your own wiki file)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle as settleTab, startSite, waitFor } from "./browser-harness.mjs";

const require = createRequire(import.meta.url);
const ENGINE = readWikiFile();

// Real plugins, read from the tiddlywiki package the same way TiddlyWiki builds them
const TW_DIR = path.dirname(require.resolve("tiddlywiki/package.json"));
const twNode = require("tiddlywiki/boot/boot.js").TiddlyWiki();
twNode.boot.argv = ["--version"];
await new Promise(resolve => twNode.boot.boot(resolve));
const MARKDOWN = twNode.loadPluginFolder(path.join(TW_DIR, "plugins/tiddlywiki/markdown"));
const KATEX = twNode.loadPluginFolder(path.join(TW_DIR, "plugins/tiddlywiki/katex"));

let r2Dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "wiki-r2-"));
let bucket = null;
const outbound = [];
const site = await startSite({
  index: ENGINE, r2Persist: r2Dir,
  bindings: { CF_ZONE_ID: "zone123", CF_API_TOKEN: "token" },
  outbound: async (req) => {
    outbound.push({ url: req.url, body: req.method === "GET" ? "" : await req.text() });
    return new Response('{"success":true}');
  }
});
const { mf, base: BASE, pub: PUB, publicRequests } = site;
bucket = site.bucket;
// A purged file is a URL, or { url, headers } for a copy cached with those request headers
const purgedUrls = () => outbound.filter(o => o.url.includes("purge_cache")).flatMap(o => JSON.parse(o.body).files || []).map(f => typeof f === "string" ? f : f.url);

const { check, results } = createChecks();
const browser = await launchBrowser();
let context = await browser.newContext();
const { requests, pageErrors, watch } = createWatcher(site);   // every request the pages make
let page = await context.newPage();
await watch(page, "admin");

const settle = (p = page) => settleTab(p);
async function load(url = BASE + "/") {
  await page.goto(url);
  await settle();
}
const add = fields => addTiddler(page, fields);
const remove = title => page.evaluate(t => $tw.wiki.deleteTiddler(t), title);
const render = (text, type = "text/vnd.tiddlywiki", p = page) =>
  p.evaluate(([t, ty]) => $tw.wiki.renderText("text/html", ty, t), [text, type]);
const renderPlain = text => page.evaluate(t => $tw.wiki.renderText("text/plain", "text/vnd.tiddlywiki", t), text);
// Imports tiddlers the way dropping a file on the wiki does: the import dialog, then its Import button
const importViaUI = fields => page.evaluate(f => {
  const find = w => w.parseTreeNode && w.parseTreeNode.type === "navigator" ? w : (w.children || []).map(find).find(Boolean);
  const navigator = find($tw.rootWidget);
  navigator.dispatchEvent({ type: "tm-import-tiddlers", param: JSON.stringify([f]) });
  navigator.dispatchEvent({ type: "tm-perform-import", param: "$:/Import" });
}, fields);
const reloadAsked = () => page.evaluate(() => $tw.wiki.getTiddlerText("$:/status/RequireReloadDueToPluginChange"));
const stored = async title => {
  const obj = await bucket.get("recipes/default/tiddlers/" + title);
  return obj ? { meta: obj.customMetadata, text: await obj.text() } : null;
};
const pluginFile = async title => {
  const obj = await bucket.get("_plugins/" + title + ".js");
  return obj ? { meta: obj.customMetadata, http: obj.httpMetadata, text: await obj.text() } : null;
};
const bakedPage = async () => (await bucket.get("baked.html")).text();
const scriptTag = (title, revision) => `<script src="${PUB}/_plugins/${encodeURIComponent(title)}.js?v=${revision}"></script>`;
// Runs a plugin file the way the browser does and returns what it preloads
function runFile(source) {
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox.$tw.preloadTiddlers;
}
const isMarkdownActive = async (p = page) => /<h1[^>]*>Hi<\/h1>/.test(await render("# Hi", "text/markdown", p));
const isKatexActive = async (p = page) => (await render("<$latex text='x^2'/>", "text/vnd.tiddlywiki", p)).includes('class="katex"');

const ML = MARKDOWN.title, KT = KATEX.title;

await load();

// --- 1. Installing a real plugin with JavaScript (markdown) by dropping it on the wiki --------------
requests.length = 0;
await importViaUI(MARKDOWN);
await settle();
check("TiddlyWiki asks for a reload after installing", (await reloadAsked()) === "yes");
const report = await stored("$:/Import");
check("the import report is saved as an ordinary tiddler", report && JSON.parse(report.text).status === "complete" && !JSON.parse(report.text)["plugin-type"]);
// (Tiddler saves only: the first load may still be publishing the page, a PUT of its own)
const savesSent = () => requests.filter(r => r.method === "PUT" && r.path.startsWith("/recipes/default/tiddlers/"));
check("two saves for the import: the plugin and the report", savesSent().map(r => r.path.replace("/recipes/default/tiddlers/", "")).sort().join(" | ") === ["$:/Import", ML].sort().join(" | "),
  savesSent().map(r => r.path).join(", "));
const put = requests.find(r => r.method === "PUT" && r.path.endsWith(ML));
check("the save is sent in the flat layout", put && put.headers["x-tiddler-layout"] === "flat");
let saved = await stored(ML);
let body = JSON.parse(saved.text);
check("stored flat: custom fields at the top level, no 'fields' object", body["plugin-type"] === "plugin" && body.fields === undefined && body.version === MARKDOWN.version);
check("stored with the worker's revision, bag and recipe", saved.meta.layout === "flat" && body.revision === saved.meta.revision && body.bag === "default" && body.recipe === "default");
check("the plugin text is stored byte for byte", body.text === MARKDOWN.text);
check("the received bytes are kept, with revision, bag and recipe appended", saved.text.endsWith(`","revision":"${saved.meta.revision}","bag":"default","recipe":"default"}`) && saved.text.startsWith('{"title":'));
let file = await pluginFile(ML);
check("plugin file written to _plugins/<title>.js", !!file && file.meta.revision === saved.meta.revision, file && JSON.stringify(file.meta));
check("plugin file is your template's format, around the stored tiddler untouched",
  file.text === "{\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([" + saved.text + "]);\n}\n");
check("plugin file served as JavaScript, cacheable for a year", /^text\/javascript/.test(file.http.contentType) && /immutable/.test(file.http.cacheControl || ""));
let preloaded = runFile(file.text);
check("running the file preloads exactly the stored tiddler", preloaded.length === 1 && preloaded[0].title === ML && preloaded[0].text === MARKDOWN.text && preloaded[0]["plugin-type"] === "plugin");
let baked = await bakedPage();
check("baked.html loads it from the public site with ?v=<revision>", baked.includes(scriptTag(ML, saved.meta.revision)));
check("plugin files are never purged (?v= changes instead)", !purgedUrls().some(u => u.includes("/_plugins/")));

// --- 2. After a reload, the plugin works, with no reload loop and no extra worker requests ---------
requests.length = 0;
await load();
check("markdown plugin is active after the reload", await isMarkdownActive());
check("no reload asked after it", (await reloadAsked()) === "no");
check("the plugin file came from the public site", requests.some(r => r.origin === "public" && r.path.startsWith("/_plugins/" + ML + ".js?v=")));
check("the worker never served plugin code", !requests.some(r => r.origin === "worker" && (r.path.includes("_plugins") || r.path.includes(ML))));
check("the sync didn't download the plugin again", !requests.some(r => r.path.includes("tiddlers/" + ML)));
const workerOnLoad = requests.filter(r => r.origin === "worker" && !r.cached).map(r => r.method + " " + r.path.split("?")[0]);
check("page load still costs only the usual worker requests (page, tiddler list)", workerOnLoad.length <= 2, workerOnLoad.join(", "));
publicRequests.length = 0;
await load();
check("next load: the plugin file comes from the browser cache", !publicRequests.some(p => p.includes("/_plugins/")), publicRequests.join(", "));

// --- 3. The public site ----------------------------------------------------------------------------
const pub = await context.newPage();
await watch(pub, "public");
requests.length = 0;
await pub.goto(PUB + "/");
await pub.waitForFunction(() => window.$tw && $tw.wiki && $tw.wiki.getTiddler("$:/StoryList"), null, { timeout: 30000 });
check("public site: markdown plugin is active", await isMarkdownActive(pub));
check("public site: no request reaches the worker", !requests.some(r => r.tag === "public" && r.origin === "worker"));
await pub.close();

// --- 4. A big plugin (KaTeX, ~700 KB) --------------------------------------------------------------
await add(KATEX);
await settle();
saved = await stored(KT);
check("big plugin stored flat and intact", saved.meta.layout === "flat" && JSON.parse(saved.text).text === KATEX.text, `${(saved.text.length / 1024).toFixed(0)} KB`);
await load();
check("KaTeX widget works after the reload", await isKatexActive());

// --- 5. Upgrading: same file name, new ?v= ---------------------------------------------------------
const oldRevision = (await stored(ML)).meta.revision;
const upgraded = JSON.parse(MARKDOWN.text);
upgraded.tiddlers["$:/plugins/tiddlywiki/markdown/upgrade-marker"] = { title: "$:/plugins/tiddlywiki/markdown/upgrade-marker", text: "v2" };
await add({ ...MARKDOWN, version: "9.9.9", text: JSON.stringify(upgraded) });
await settle();
saved = await stored(ML);
baked = await bakedPage();
check("upgrade: page now points to the new ?v=", baked.includes(scriptTag(ML, saved.meta.revision)) && !baked.includes(scriptTag(ML, oldRevision)));
check("upgrade: same file, overwritten in place", (await pluginFile(ML)).meta.revision === saved.meta.revision);
await load();
check("upgrade: new version active after the reload", (await page.evaluate(() => $tw.wiki.getTiddlerText("$:/plugins/tiddlywiki/markdown/upgrade-marker"))) === "v2");

// --- 6. Disabling and enabling ---------------------------------------------------------------------
const FLAG = "$:/config/Plugins/Disabled/" + ML;
await add({ title: FLAG, text: "yes" });
await settle();
check("disable flag is baked into the page", (await bakedPage()).includes(JSON.stringify(FLAG).slice(1, -1)));
await load();
check("disabled plugin is not active after the reload", !(await isMarkdownActive()));
check("disabled plugin: still listed (so it can be re-enabled), no reload asked",
  (await page.evaluate(t => $tw.wiki.tiddlerExists(t), ML)) && (await reloadAsked()) === "no");
await add({ title: FLAG, text: "no" });
await settle();
await load();
check("re-enabled plugin is active again", await isMarkdownActive());

// --- 7. A theme plugin and $:/theme ----------------------------------------------------------------
await add({ title: "$:/themes/test/red", type: "application/json", "plugin-type": "theme",
  text: JSON.stringify({ tiddlers: { "$:/themes/test/red/style": {
    title: "$:/themes/test/red/style", tags: "$:/tags/Stylesheet", text: "body.tc-body { background: rgb(255, 0, 0); }" } } }) });
await add({ title: "$:/theme", text: "$:/themes/test/red" });
await settle();
await load();
check("theme is applied at boot", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 0, 0)");
await add({ title: "$:/theme", text: "$:/themes/tiddlywiki/vanilla" });
await settle();
// The syncer reads its settings once, when it starts: they have to be in the page
const SYNC_SETTINGS = { "$:/config/SyncPollingInterval": "7000", "$:/config/SyncThrottleInterval": "1500",
  "$:/config/SyncFilter": "[all[tiddlers]!prefix[$:/temp/]!prefix[$:/state/]!prefix[$:/status/]!is[draft]!prefix[Local/]]",
  "$:/config/SyncDisableLazyLoading": "yes" };
for (const [title, text] of Object.entries(SYNC_SETTINGS)) await add({ title, text });
await settle();
await load();
await add({ title: "Local/note", text: "kept in this tab" });
await settle();
await new Promise(r => setTimeout(r, 2000));
const syncer = { ...await page.evaluate(() => ({ poll: $tw.syncer.pollTimerInterval, throttle: $tw.syncer.throttleInterval,
  lazyListeners: (($tw.wiki.eventListeners || {}).lazyLoad || []).length })), localSaved: !!(await stored("Local/note")) };
check("the sync settings are in the page, so the syncer starts with them",
  syncer.poll === 7000 && syncer.throttle === 1500 && !syncer.localSaved && syncer.lazyListeners === 0, JSON.stringify(syncer));
for (const title of ["Local/note", ...Object.keys(SYNC_SETTINGS)]) await remove(title);
await settle();
await load();

// --- 8. A standalone JavaScript module, with characters JSON and JavaScript treat differently ------
const MACRO = "$:/test/greet.js";
await add({ title: MACRO, type: "application/javascript", "module-type": "macro",
  text: 'exports.name = "greet"; exports.params = []; exports.run = function() { return "hi from \\"macro\\" ,\\"text\\": 😀"; };' });
await settle();
await load();
check("standalone macro module works after the reload", (await renderPlain("<<greet>>")).includes('hi from "macro" ,"text": 😀'));

// --- 9. Bodies the worker must cut correctly ---------------------------------------------------------
await add({ title: "Tricky", note: 'a,"text":"b', text: 'x,"text":"y"   😀 \\' });
await add({ title: "No text", tags: ["a b", "c"] });
await settle();
let t = await stored("Tricky");
body = JSON.parse(t.text);
check("',\"text\":' inside a field and the text: both intact", body.note === 'a,"text":"b' && body.text === 'x,"text":"y"   😀 \\' && t.meta.layout === "flat");
t = await stored("No text");
body = JSON.parse(t.text);
check("tiddler without text: stored with its revision", body.text === undefined && body.revision === t.meta.revision && body.tags.length === 2);
await add({ title: "Has a fields field", fields: "x", color: "red", text: "t" });
await settle();
t = await stored("Has a fields field");
check("a field called 'fields' is stored nested, as TiddlyWeb's layout has it, the other fields flat",
  !!t && t.meta.layout === "flat" && JSON.parse(t.text).fields?.fields === "x" && JSON.parse(t.text).color === "red", t?.text);
// The same on tiddlers the page loads at boot, which TiddlyWiki doesn't unpack itself
await add({ title: "$:/test/boot-fields", tags: ["$:/tags/StartupAction"], fields: "startup text", text: "" });
await add({ title: "$:/test/module-fields.js", type: "application/javascript", "module-type": "macro", fields: "module text",
  text: "exports.name = 'mf'; exports.params = []; exports.run = function() { return 'mf ok'; };" });
await settle();
for (const [name, json] of [["pretty-printed", JSON.stringify({ title: "Odd 1", text: "x", tags: ["z"] }, null, 2)],
                            ["revision before text", '{"title":"Odd 2","revision":"1","tags":["z"],"text":"x"}']]) {
  const t2 = JSON.parse(json).title;
  const r = await mf.dispatchFetch(BASE + "/recipes/default/tiddlers/" + encodeURIComponent(t2), { method: "PUT", headers: { "X-Tiddler-Layout": "flat" }, body: json });
  const o = await stored(t2);
  const entry = JSON.parse(await (await bucket.get("recipes/default/tiddlers.json")).text()).find(e => e.title === t2);
  check(`a "flat" body that isn't (${name}) is stored flat like any other save`, r.status === 204 && o.meta.layout === "flat" &&
    o.text.startsWith(`{"title":"${t2}","tags":["z"],"text":"x","revision":"${o.meta.revision}"`) && entry.tags[0] === "z" && entry.text === undefined, o?.text);
}
const viaWorker = await mf.dispatchFetch(BASE + "/recipes/default/tiddlers/" + encodeURIComponent("Tricky"));
body = await viaWorker.json();
check("GET of a flat tiddler is served as stored, with its ETag", body.note === 'a,"text":"b' && viaWorker.headers.get("ETag").includes((await stored("Tricky")).meta.revision));

// --- 10. Older clients still send TiddlyWeb JSON -------------------------------------------------------
const HELLO = "$:/plugins/test/hello wörld #1";
const helloPlugin = word => ({
  title: HELLO, type: "application/json", tags: [], fields: { "plugin-type": "plugin", version: "1.0.0" },
  text: JSON.stringify({ tiddlers: { [HELLO + "/widget.js"]: {
    title: HELLO + "/widget.js", type: "application/javascript", "module-type": "widget",
    text: 'var Widget = require("$:/core/modules/widgets/widget.js").widget;' +
      "function W(p, o) { this.initialise(p, o); } W.prototype = new Widget();" +
      'W.prototype.render = function(parent, next) { var n = this.document.createTextNode("' + word + '"); parent.insertBefore(n, next); this.domNodes.push(n); };' +
      "exports.hello = W;" } } })
});
let res = await mf.dispatchFetch(BASE + "/recipes/default/tiddlers/" + encodeURIComponent(HELLO), {
  method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(helloPlugin("Hello from a TiddlyWeb save"))
});
saved = await stored(HELLO);
file = await pluginFile(HELLO);
check("TiddlyWeb-layout save: stored flat, its custom fields at the top level", res.status === 204 && saved.meta.layout === "flat" &&
  JSON.parse(saved.text)["plugin-type"] === "plugin" && JSON.parse(saved.text).fields === undefined, saved.text.slice(0, 120));
check("its plugin file is the usual one", file.text === "{\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([" + saved.text + "]);\n}\n" &&
  runFile(file.text)[0]["plugin-type"] === "plugin");
await load();
check("its widget works after the reload (title with spaces, # and non-ASCII)", (await renderPlain("<$hello/>")).includes("Hello from a TiddlyWeb save"));
check("...and a field called 'fields' reads back after the reload", await page.evaluate(() => {
  const t = $tw.wiki.getTiddler("Has a fields field");
  return !!t && t.fields.fields === "x" && t.fields.color === "red" && t.fields.text === "t";
}));
const bootFields = await page.evaluate(() => [$tw.wiki.getTiddler("$:/test/boot-fields"), $tw.wiki.getTiddler("$:/test/module-fields.js")].map(t => t && t.fields.fields));
check("...also on a startup tiddler and a JavaScript module, which the page loads at boot",
  bootFields[0] === "startup text" && bootFields[1] === "module text" && (await renderPlain("<<mf>>")) === "mf ok", JSON.stringify(bootFields));

// --- 11. A stored plugin whose file is missing: written on the next page build ------------------------
await bucket.delete("_plugins/" + HELLO + ".js");
await bucket.put("baked.html", "<html><head></head><body>old</body></html>", { customMetadata: { bakeVersion: "3-old", sourceEtag: "x" } });
await load();
check("the next page build writes the missing file", (await pluginFile(HELLO))?.meta.revision === saved.meta.revision);
check("...and the plugin works, with no reload asked", (await renderPlain("<$hello/>")).includes("Hello from a TiddlyWeb save") && (await reloadAsked()) === "no");

// --- 12. A plugin that becomes a normal tiddler, a startup action that loses its tag, deletes -------
await add({ title: HELLO, text: "just text now" });
await settle();
check("no longer a plugin: file deleted, tag gone", !(await pluginFile(HELLO)) && !(await bakedPage()).includes(encodeURIComponent(HELLO)));
await add({ title: "$:/test/startup", tags: ["$:/tags/StartupAction"], text: "" });
await settle();
check("startup action is baked", (await bakedPage()).includes("$:/test/startup"));
await add({ title: "$:/test/startup", tags: [], text: "" });
await settle();
check("removing its tag takes it out of the page", !(await bakedPage()).includes("$:/test/startup"));
await remove(KT);
await settle();
check("deleted plugin: file deleted and tag gone", !(await pluginFile(KT)) && !(await bakedPage()).includes(encodeURIComponent(KT)));
await load();
check("deleted plugin is gone after the reload", !(await isKatexActive()));

// --- 13. Overlapping page builds never go backwards ---------------------------------------------------
// (The tab's page publisher, looking at the page after a load, would publish a newer page over the
// one put here on purpose: the tab is sent away, the save goes through the worker's API, and the
// tab comes back for the next step)
await settle();
await page.goto("about:blank");
const current = await bucket.head("baked.html");
await bucket.put("baked.html", "<html><head></head><body>from a newer list</body></html>",
  { httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: { ...current.customMetadata, listVersion: "99999999999999" } });
await mf.dispatchFetch(`${BASE}/recipes/default/tiddlers/${encodeURIComponent("$:/SiteSubtitle")}`,
  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "$:/SiteSubtitle", text: "a startup tiddler, to trigger a build" }) });
check("an older build doesn't replace a page built from a newer tiddler list", (await bakedPage()).includes("from a newer list"));
await bucket.put("_plugins/" + ML + ".js", "/* a newer version */", { customMetadata: { revision: "9999999999999" } });
await bucket.delete("baked.html");
const rebuilt = await (await mf.dispatchFetch(BASE + "/")).text();
check("an older build doesn't overwrite a newer plugin file, and points to it", (await pluginFile(ML)).text === "/* a newer version */" && rebuilt.includes(scriptTag(ML, "9999999999999")));
const handList = await (await bucket.get("recipes/default/tiddlers.json")).text();
await bucket.put("recipes/default/tiddlers.json", handList, { httpMetadata: { contentType: "application/json" } });   // replaced by hand
await load();
const beforeSubtitle = requests.length;
await add({ title: "$:/SiteSubtitle", text: "after a hand-replaced list" });
await settle();
check("a tiddler list replaced by hand doesn't stop the page from being rebuilt", (await bakedPage()).includes("after a hand-replaced list"));

// --- 14. Recovery: delete the file in R2, hard reload --------------------------------------------------
// That save changed the shell (the subtitle is in it), so the tab publishes the page a moment later,
// and a page build writes back any plugin file that's missing: wait for that publish — one sent after
// the save was, not the previous save's, which can land in between — to be answered before deleting
// the file on purpose. (Seen: the file written back between the delete and the reload, and the wiki
// starting with the plugin.)
const subtitleSave = requests.slice(beforeSubtitle).find(r => r.method === "PUT" && r.path === "/recipes/default/tiddlers/$:/SiteSubtitle");
await waitFor(() => requests.slice(beforeSubtitle).some(r => r.method === "PUT" && r.path === "/page/shell" && r.status && subtitleSave && r.at > subtitleSave.at));
await bucket.delete("_plugins/" + ML + ".js");
await context.close();
context = await browser.newContext();   // a hard reload: nothing cached
page = await context.newPage();
await watch(page, "recovery");
const errorsBefore = pageErrors.length;
await load();
const activeAfterRecovery = await isMarkdownActive();
check("recovery: the wiki starts without the plugin", !activeAfterRecovery && pageErrors.length === errorsBefore,
  `markdown active ${activeAfterRecovery}, page errors ${pageErrors.slice(errorsBefore).join(" | ") || "none"}`);
await remove(ML);
await settle();
check("recovery: deleting the plugin removes its tag", !(await bakedPage()).includes(encodeURIComponent(ML)));

// --- 15. A public tab while the tiddler list is missing or damaged -----------------------------------
// The public site reads the list straight from R2. While the worker rebuilds a missing list over
// several requests, R2 holds a stand-in; a damaged list is whatever was uploaded. Either way an open
// public tab must keep its tiddlers, and catch up once the list is back.
await add({ title: "Public note", text: "on the public site" });
await settle();
for (let i = 0; i < 250; i += 50) {   // enough tiddlers that the rebuild takes several requests
  await Promise.all(Array.from({ length: 50 }, (_, j) => {
    const title = `Filler ${i + j}`, revision = String(1600000000000 + i + j);
    return bucket.put(`recipes/default/tiddlers/${title}`,
      `{"title":"${title}","type":"text/vnd.tiddlywiki","text":"f","revision":"${revision}","bag":"default","recipe":"default"}`,
      { customMetadata: { revision, layout: "flat" } });
  }));
}
await page.goto("about:blank");   // only this test drives the rebuild
// The public site answers /status from R2 too (the file uploaded once, setup 2.8), so its tabs know the recipe
await bucket.put("status", JSON.stringify({ username: "GUEST", read_only: true, anonymous: true, logout_is_available: false, space: { recipe: "default" } }), { httpMetadata: { contentType: "application/json" } });
const tab = await context.newPage();
await watch(tab, "public tab");
await tab.goto(PUB + "/");
await tab.waitForFunction(() => window.$tw && $tw.syncer && $tw.wiki.tiddlerExists("Public note"), null, { timeout: 30000 });
await settle(tab);   // every tiddler loaded (a load still queued would bring back a tiddler the sync deleted)
await tab.evaluate(() => {
  window.__deleted = [];
  $tw.wiki.addEventListener("change", changes => {
    for (const title in changes) if (changes[title].deleted) window.__deleted.push(title);
  });
});
await tab.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").forEach(t => $tw.wiki.deleteTiddler(t)));
const tabState = () => tab.evaluate(() => ({
  note: $tw.wiki.tiddlerExists("Public note"),
  filler: $tw.wiki.tiddlerExists("Filler 7"),
  deleted: window.__deleted.slice(),
  crashed: !!document.querySelector(".tc-error-form"),
  alerts: $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").map(t => $tw.wiki.getTiddlerText(t))
}));
const rebuildList = async () => {
  for (let i = 0; i < 20; i++) if ((await mf.dispatchFetch(BASE + "/recipes/default/tiddlers.json")).status === 200) return true;
  return false;
};
const tabErrors = pageErrors.length;
const tabListGets = () => requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json")).length;
check("a public tab never asks how backups go (only the admin site does)", !requests.some(r => r.tag === "public tab" && r.headers["x-backup-status"]));
const listGetsBefore = tabListGets();
await bucket.delete("recipes/default/tiddlers.json");
await mf.dispatchFetch(BASE + "/recipes/default/tiddlers.json");   // an admin request: the first step
const syncedAt = Date.now();
await tab.evaluate(() => $tw.syncer.syncFromServer());
await new Promise(r => setTimeout(r, 1500));
let state = await tabState();
check("a missing list being rebuilt: an open public tab keeps its tiddlers, with no error",
  tabListGets() > listGetsBefore && state.note && state.deleted.length === 0 && !state.crashed && state.alerts.length === 0 && pageErrors.length === tabErrors,
  `${tabListGets() - listGetsBefore} list requests ` + JSON.stringify(state) + " " + pageErrors.slice(tabErrors).join(" | "));
const retries = requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json") && r.path.includes("cfworker-retry="));
const standIn = requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json")).find(r => r.at > syncedAt);
check("...and asks again a moment later (a second in production, scaled for the tests), at a URL no cache holds (a cached stand-in can't outlive the rebuild)",
  retries.length >= 1 && !!standIn && retries[0].at - standIn.at < 600, `again after ${retries.length && standIn ? retries[0].at - standIn.at : "-"} ms; ` +
  requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json")).slice(-3).map(r => r.path.slice(0, 60) + "…" + r.path.slice(-30)).join(" | "));
const rebuiltInTime = await rebuildList();
await tab.waitForFunction(() => $tw.wiki.tiddlerExists("Filler 7"), null, { timeout: 15000 }).catch(() => {});
state = await tabState();
check("...and catches up by itself once the list is rebuilt", rebuiltInTime && state.note && state.filler && state.deleted.length === 0, JSON.stringify(state));
// Served the way the public site serves it: browsers keep it for 5 minutes (the cache rule's Browser TTL)
await bucket.put("recipes/default/tiddlers.json", '[{"title": "Public note", "rev', { httpMetadata: { contentType: "application/json", cacheControl: "max-age=300" } });
await tab.evaluate(() => $tw.syncer.syncFromServer());
await new Promise(r => setTimeout(r, 1500));
state = await tabState();
check("a damaged list: the tab keeps its tiddlers, with a sync error at most (no crash)",
  state.note && state.filler && state.deleted.length === 0 && !state.crashed && pageErrors.length === tabErrors, JSON.stringify(state) + " " + pageErrors.slice(tabErrors).join(" | "));
pageErrors.splice(tabErrors);   // reported above
await rebuildList();
// Its browser may keep the damaged copy for a few minutes: the next sync asks at a URL no cache holds
await tab.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").forEach(t => $tw.wiki.deleteTiddler(t)));
const beforeResync = tabListGets();
await tab.evaluate(() => $tw.syncer.syncFromServer());
await new Promise(r => setTimeout(r, 1500));
state = await tabState();
const resync = requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json")).slice(beforeResync);
check("...and once the list is repaired, its next sync bypasses caches and goes through",
  resync.length >= 1 && resync.every(r => r.path.includes("cfworker-retry=")) && state.alerts.length === 0 && state.note && state.filler,
  `${resync.length} requests ` + JSON.stringify(state));
const beforeCached = tabListGets();
await tab.evaluate(() => $tw.syncer.syncFromServer());   // the usual URL: the browser still has the damaged copy
await new Promise(r => setTimeout(r, 1500));
state = await tabState();
const cachedRound = requests.filter(r => r.tag === "public tab" && r.path.startsWith("/recipes/default/tiddlers.json")).slice(beforeCached);
check("...and a damaged copy the browser kept is passed over quietly (asked again at once, past it)",
  cachedRound.some(r => r.path.includes("cfworker-retry=")) && state.alerts.length === 0 && state.note && state.filler,
  `${cachedRound.length} requests ` + JSON.stringify(state));
await tab.close();

// --- 16. Installed in one admin tab, the other admin tab follows (design 1.16) ---------------------------
// The tabs of one browser hand each other their changes the moment they're made: the other tab gets the
// plugin tiddler at once and TiddlyWiki treats it there as in the installing tab. A plugin with
// JavaScript isn't unpacked in a running wiki: TiddlyWiki asks for a reload (RequireReloadDueToPluginChange),
// and after it the code runs in both tabs. A plugin without code is unpacked on the spot, in both. The
// markdown plugin was deleted in section 14: installed again here, with another admin tab open.
await load();   // (section 15 left this tab on about:blank)
const other = await context.newPage();
await watch(other, "other admin");
await other.goto(BASE + "/");
await settle(other);
const README_SHADOW = ML + "/readme";
const otherState = () => other.evaluate(([plugin, shadow]) => ({
  plugin: $tw.wiki.tiddlerExists(plugin), shadow: $tw.wiki.getShadowSource(shadow) === plugin, reload: $tw.wiki.getTiddlerText("$:/status/RequireReloadDueToPluginChange"),
  revision: ($tw.syncer.tiddlerInfo[plugin] || {}).revision || null
}), [ML, README_SHADOW]);
const otherRequests = from => requests.slice(from).filter(r => r.tag === "other admin");
let followMark = requests.length;
const followAt = Date.now();
await importViaUI(MARKDOWN);
const followedPlugin = await waitFor(async () => { const s = await otherState(); return s.plugin && s.reload === "yes"; }, 5000);
const followedIn = (Date.now() - followAt) / 1000;
const installingTabShadow = await page.evaluate(([plugin, shadow]) => $tw.wiki.getShadowSource(shadow) === plugin, [ML, README_SHADOW]);
check("installed in one admin tab, the other has the plugin within a second and TiddlyWiki asks for the reload there too (a plugin with JavaScript isn't unpacked in a running wiki, in either tab), with no request for it",
  followedPlugin && followedIn < 2 && !(await otherState()).shadow && !installingTabShadow && !otherRequests(followMark).some(r => r.method === "GET" && r.path.startsWith("/recipes/default/tiddlers/")),
  `${followedIn.toFixed(1)} s, other ${JSON.stringify(await otherState())}, installing tab's shadow ${installingTabShadow}, other's requests ${JSON.stringify(otherRequests(followMark).map(r => r.method + " " + r.path.split("?")[0]))}`);
await settle();
const installedRevision = (await stored(ML)).meta.revision;
const revisionFollowed = await waitFor(async () => (await otherState()).revision === installedRevision, 5000);
check("...and holds the worker's revision once the save is confirmed, still without a request", revisionFollowed && !otherRequests(followMark).some(r => r.method === "GET" && r.path.startsWith("/recipes/default/tiddlers/")),
  `${JSON.stringify(await otherState())} vs ${installedRevision}`);
followMark = requests.length;
await load();
await other.goto(BASE + "/");
await settle(other);
const otherWorkerLoad = otherRequests(followMark).filter(r => r.origin === "worker" && !r.cached).map(r => r.method + " " + r.path.split("?")[0]);
check("after a reload the plugin runs in both tabs, its shadow tiddlers in place, no reload asked any more, the other tab's load costing the usual worker requests and its code never coming through the worker",
  await isMarkdownActive() && await isMarkdownActive(other) && (await otherState()).shadow && (await reloadAsked()) === "no" && (await otherState()).reload === "no" &&
  otherWorkerLoad.length <= 2 && !otherWorkerLoad.some(r => r.includes("_plugins") || r.includes(ML)),
  `markdown: page ${await isMarkdownActive()}, other ${await isMarkdownActive(other)}, shadow ${(await otherState()).shadow}; other's worker requests ${otherWorkerLoad.join(", ")}`);
// A plugin without code: unpacked on the spot, in the installing tab and in the other. Deleted, the plugin
// tiddler goes from the other at once; its shadow tiddlers stay in both until a reload, as TiddlyWiki
// leaves them (its plugin change handler looks only at tiddlers that still exist)
const WT = "$:/plugins/test/wikitext-only", WT_SHADOW = WT + "/hello";
const wikitextPlugin = { title: WT, type: "application/json", "plugin-type": "plugin", version: "1.0.0", text: JSON.stringify({ tiddlers: { [WT_SHADOW]: { title: WT_SHADOW, text: "hello from a plugin without code" } } }) };
const otherShadow = () => other.evaluate(([plugin, shadow]) => ({ unpacked: $tw.wiki.getShadowSource(shadow) === plugin, text: $tw.wiki.getTiddlerText(shadow, null), reload: $tw.wiki.getTiddlerText("$:/status/RequireReloadDueToPluginChange") }), [WT, WT_SHADOW]);
followMark = requests.length;
await importViaUI(wikitextPlugin);
const unpackedInOther = await waitFor(async () => (await otherShadow()).unpacked, 5000);
check("a plugin without code installed in one tab is unpacked on the spot in the other: its shadow tiddler readable there, no reload asked, no request",
  unpackedInOther && (await otherShadow()).text === "hello from a plugin without code" && (await otherShadow()).reload === "no" && !otherRequests(followMark).some(r => r.method === "GET" && r.path.startsWith("/recipes/default/tiddlers/")),
  JSON.stringify(await otherShadow()) + " requests " + JSON.stringify(otherRequests(followMark).map(r => r.method + " " + r.path.split("?")[0])));
await settle();
await remove(WT);
const goneFromOther = await waitFor(() => other.evaluate(t => !$tw.wiki.tiddlerExists(t), WT), 5000);
const shadowsStay = await page.evaluate(([plugin, shadow]) => $tw.wiki.getShadowSource(shadow) === plugin, [WT, WT_SHADOW]) && (await otherShadow()).unpacked;
check("...and deleted in that tab, the plugin tiddler is gone from the other at once; its shadow tiddlers stay in both until a reload, as TiddlyWiki leaves them in the deleting tab too",
  goneFromOther && shadowsStay, `gone ${goneFromOther}, shadows stay ${shadowsStay}, other ${JSON.stringify(await otherShadow())}`);
await settle();
await other.close();

await finish({ check, results, pageErrors, browser, site, cleanup: () => fs.rmSync(r2Dir, { recursive: true, force: true }) });
