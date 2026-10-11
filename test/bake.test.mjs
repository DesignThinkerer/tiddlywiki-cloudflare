// Tests how the wiki page is served and rebuilt (baked.html), plus a few small worker responses.
// Run: npm run test:bake
import { Miniflare } from "miniflare";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutAccess } from "../src/worker/access.js";
import { publicSiteError } from "../src/worker/settings.js";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));
// The worker's modules: worker.js, and the empty wiki as a text module (seed/empty.html), as Wrangler uploads them
const MODULE_RULES = [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }];

const mf = new Miniflare({
  modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  // No Cloudflare Access in front of the tests, and the public site's address (see the end of this file)
  bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://my-tiddlywiki.theophile.dev" },
  outboundService: async () => new Response("{}", { status: 404 }),
});
const base = (await mf.ready).toString().replace(/\/$/, "");
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const html = body => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

await bucket.put("index.html", html("v1"));
await bucket.put("baked.html", html("old baked page without the guard"));   // a baked.html from an older worker
let page = await (await mf.dispatchFetch(base + "/baked.html")).text();
check("an outdated baked.html is rebuilt on the first visit", page.includes("v1") && page.includes("$:/cfworker/conflict-guard.js"));
check("the public URL is baked in for the browser module", page.includes("$:/cfworker/public-url") && page.includes("https://my-tiddlywiki.theophile.dev/"));
page = await (await mf.dispatchFetch(base + "/")).text();
check("the next visit is served from the stored bake", page.includes("v1") && page.includes("conflict-guard.js"));
await bucket.put("index.html", html("v2"));
page = await (await mf.dispatchFetch(base + "/")).text();
check("a new index.html is picked up automatically", page.includes("v2") && page.includes("conflict-guard.js"));
// The browser keeps the page and asks whether it changed: an unchanged page answers 304, no body
const first = await mf.dispatchFetch(base + "/");
const pageEtag = first.headers.get("ETag");
await first.arrayBuffer();
let again = await mf.dispatchFetch(base + "/", { headers: { "If-None-Match": pageEtag || "none" } });
let againBody = await again.text();
check("an unchanged page answers 304 to a browser that has it", !!pageEtag && again.status === 304 && againBody === "", `ETag ${pageEtag}, status ${again.status}`);
again = await mf.dispatchFetch(base + "/", { headers: { "If-None-Match": "W/" + (pageEtag || "none") } });
await again.arrayBuffer();
check("...also when Cloudflare's compression has weakened the ETag (W/)", again.status === 304, `status ${again.status}`);
await bucket.put("index.html", html("v3"));
again = await mf.dispatchFetch(base + "/", { headers: { "If-None-Match": pageEtag || "none" } });
againBody = await again.text();
check("...but a page that has to be rebuilt is sent in full", again.status === 200 && againBody.includes("v3"), `status ${again.status}`);
// The rebuilt page carries its ETag too, so the very next load (the first after a deploy, say) is a 304
const rebuiltEtag = again.headers.get("ETag");
const rebuiltDate = again.headers.get("Last-Modified");
const storedPage = await bucket.head("baked.html");
check("...with the ETag of the page it stored", rebuiltEtag === `"${storedPage.etag}-page"`, `ETag ${rebuiltEtag}, stored ${storedPage.etag}`);
again = await mf.dispatchFetch(base + "/", { headers: { "If-None-Match": rebuiltEtag || "none" } });
againBody = await again.text();
check("...so the next load is already a 304", again.status === 304 && againBody === "", `status ${again.status}`);
// Cloudflare features that rewrite HTML (Replace insecure JavaScript libraries is on by default on
// the Free plan) remove the ETag on the way out, but not Last-Modified: the browser then asks with
// If-Modified-Since alone
check("the page also carries a Last-Modified date", !!rebuiltDate && !isNaN(Date.parse(rebuiltDate)), `Last-Modified ${rebuiltDate}`);
again = await mf.dispatchFetch(base + "/");
await again.arrayBuffer();
check("...the same when it's served from the stored page", again.headers.get("Last-Modified") === rebuiltDate, `${again.headers.get("Last-Modified")} vs ${rebuiltDate}`);
again = await mf.dispatchFetch(base + "/", { headers: { "If-Modified-Since": rebuiltDate || "none" } });
againBody = await again.text();
check("an unchanged page answers 304 to If-Modified-Since alone (the ETag removed on the way)", again.status === 304 && againBody === "", `status ${again.status}`);
// The date is the page's version, so it only goes forward: a page built within the same second as
// the last one (here: the last one dated ahead) still gets a later date
const last = await bucket.get("baked.html");
const ahead = Number(last.customMetadata.pageTime) + 50;
await bucket.put("baked.html", await last.arrayBuffer(), { httpMetadata: last.httpMetadata, customMetadata: { ...last.customMetadata, pageTime: String(ahead) } });
const dateA = new Date(ahead * 1000).toUTCString();
await bucket.put("index.html", html("v5"));
const buildB = await mf.dispatchFetch(base + "/");
await buildB.arrayBuffer();
const dateB = buildB.headers.get("Last-Modified");
check("a page built within the same second as the last one gets a later date", Date.parse(dateB) === (ahead + 1) * 1000, `${dateA} then ${dateB}`);
again = await mf.dispatchFetch(base + "/", { headers: { "If-Modified-Since": dateA || "none" } });
againBody = await again.text();
check("...so a browser holding the earlier page gets the new one", again.status === 200 && againBody.includes("v5"), `status ${again.status}`);
again = await mf.dispatchFetch(base + "/", { headers: { "If-Modified-Since": "not a date" } });
await again.arrayBuffer();
check("an If-Modified-Since that isn't a date gets the page", again.status === 200, `status ${again.status}`);
const meta = (await bucket.head("baked.html")).customMetadata;
check("bake metadata records the guard version, source etag and page date", /^\d+-/.test(meta.bakeVersion) && !!meta.sourceEtag && !!meta.pageTime, JSON.stringify(meta));

await bucket.put("index.html", "\uFEFF" + html("with a byte order mark"));
page = await (await mf.dispatchFetch(base + "/")).text();
check("a byte order mark doesn't shift where the script goes", /<head>\s*<script>/.test(page) && page.includes("with a byte order mark"));

const options = await mf.dispatchFetch(base + "/recipes/default/tiddlers/x", { method: "OPTIONS" });
check("CORS preflight allows If-Match and If-None-Match", /If-Match/.test(options.headers.get("access-control-allow-headers")) && /If-None-Match/.test(options.headers.get("access-control-allow-headers")));
const bad = await mf.dispatchFetch(base + "/nope", { method: "PUT", body: "{}" });
check("bad PUT path answers 400 with CORS headers", bad.status === 400 && bad.headers.get("access-control-allow-origin") === "*");
const statusRes = await mf.dispatchFetch(base + "/status");
const status = await statusRes.json(), statusCache = statusRes.headers.get("Cache-Control") || "";
check("/status reports a logged-in, writable TiddlyWeb space", status.username === "admin" && status.read_only === false);
check("...and the browser keeps it for a week, for itself only (private)",
  /\bprivate\b/.test(statusCache) && Number((/max-age=(\d+)/.exec(statusCache) || [])[1]) >= 7 * 24 * 3600, statusCache);
check("...so it isn't baked into the page", !page.includes("$:/cfworker/status"));

// A tiddler or a file read from the worker: the browser keeps it (no-cache) and asks with its ETag,
// and one that hasn't changed is answered 304 without a body, like the list and the page
const keptUrl = base + "/recipes/default/tiddlers/Kept";
let res = await mf.dispatchFetch(keptUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Kept", text: "v1" }) });
const keptEtag = res.headers.get("ETag");
res = await mf.dispatchFetch(keptUrl);
check("a tiddler read carries its revision as its ETag", res.status === 200 && !!keptEtag && res.headers.get("ETag") === keptEtag && (await res.json()).text === "v1", `${res.status} ${res.headers.get("ETag")} vs ${keptEtag}`);
res = await mf.dispatchFetch(keptUrl, { headers: { "If-None-Match": keptEtag } });
check("an unchanged tiddler answers 304 to a browser that has it, with its ETag and no body", res.status === 304 && res.headers.get("ETag") === keptEtag && (await res.text()) === "", `status ${res.status}`);
res = await mf.dispatchFetch(keptUrl, { headers: { "If-None-Match": "W/" + keptEtag } });
check("...also with the ETag weakened (W/)", res.status === 304, `status ${res.status}`);
res = await mf.dispatchFetch(keptUrl, { method: "HEAD", headers: { "If-None-Match": keptEtag } });
check("...and to a HEAD", res.status === 304 && res.headers.get("ETag") === keptEtag, `status ${res.status}`);
res = await mf.dispatchFetch(keptUrl, { headers: { "If-None-Match": '"default/Kept/1:auto"' } });
check("a browser with another revision gets the tiddler", res.status === 200 && res.headers.get("ETag") === keptEtag && (await res.json()).text === "v1", `status ${res.status}`);
await bucket.put("files/note.txt", "a file", { httpMetadata: { contentType: "text/plain" } });
res = await mf.dispatchFetch(base + "/files/note.txt");
const fileEtag = res.headers.get("ETag");
check("a file read carries R2's ETag", res.status === 200 && fileEtag === (await bucket.head("files/note.txt")).httpEtag && (await res.text()) === "a file", `${res.status} ${fileEtag}`);
res = await mf.dispatchFetch(base + "/files/note.txt", { headers: { "If-None-Match": fileEtag } });
check("an unchanged file answers 304, with its ETag and no body", res.status === 304 && res.headers.get("ETag") === fileEtag && (await res.text()) === "", `status ${res.status}`);
res = await mf.dispatchFetch(base + "/files/note.txt", { headers: { "If-None-Match": "W/" + fileEtag } });
check("...also weakened (W/)", res.status === 304, `status ${res.status}`);
await bucket.put("files/note.txt", "a changed file", { httpMetadata: { contentType: "text/plain" } });
res = await mf.dispatchFetch(base + "/files/note.txt", { headers: { "If-None-Match": fileEtag } });
check("a changed file is sent, with its new ETag", res.status === 200 && !!res.headers.get("ETag") && res.headers.get("ETag") !== fileEtag && (await res.text()) === "a changed file", `status ${res.status}`);
await mf.dispatchFetch(keptUrl, { method: "DELETE" });
await bucket.delete("files/note.txt");

// --- The page shell, published from the admin wiki ------------------------------------------------
// The admin wiki renders the page with TiddlyWiki's $:/core/templates/tiddlywiki5-external-js.html:
// everything but the core, which is a separate file (_plugins/tiddlywikicore.js?v=<version>-<format>).
// The worker keeps the shell in _page/shell.html and builds the page from it while it matches the
// current index.html. These stand-ins have the parts the worker relies on.
const PUB = "https://my-tiddlywiki.theophile.dev";
const CORE_V = "5.4.1-1";
const coreUrl = v => `${PUB}/_plugins/tiddlywikicore.js?v=${v}`;
// (The core plugin mentions the save template setting, escaped; snapshot: with TiddlyWiki's line that
// switches it to the external-core one, which the admin wiki takes out)
const fakeCore = (v = CORE_V, { snapshot = false } = {}) => [
  "/*\nTiddlyWiki created by Jeremy Ruston\n*/", "$tw = (typeof $tw === 'undefined') ? Object.create(null) : $tw;",
  "$tw.preloadTiddlers = $tw.preloadTiddlers || [];", `// core ${v} `.padEnd(5000, "x"),
  '$tw.preloadTiddlerArray([{"title":"$:/core","text":"{\\"tiddlers\\":{\\"$:/config/SaveWikiButton/Template\\":{\\"title\\":\\"$:/config/SaveWikiButton/Template\\"}}}"}]);',
  snapshot ? '$tw.preloadTiddlerArray([{\n\ttitle: "$:/config/SaveWikiButton/Template",\n\ttext: "$:/core/save/offline-external-js"\n}]);' : "",
  '_load(window,{"title":"$:/boot/boot.js","type":"application/javascript","text":"/* boot */"});'
].join("\n");
const MARK = name => `<!--~~ ${name} ~~-->`;
const fakeShell = ({ title = "Published title", v = CORE_V, tiddlyweb = true, external = true, store = true } = {}) => [
  "<!doctype html>", '<html lang="en-GB">', "<head>", '<meta http-equiv="Content-Type" content="text/html;charset=utf-8" />',
  MARK("Raw markup for the top of the head section"), `<title>${title}</title>`, MARK("Raw markup"), "</head>", '<body class="tc-body">',
  MARK("Raw markup for the top of the body section"), MARK("Ordinary tiddlers"),
  store ? '<script class="tiddlywiki-tiddler-store" type="application/json">[' + (tiddlyweb ? '{"title":"$:/plugins/tiddlywiki/tiddlyweb","plugin-type":"plugin","text":"{}"},' : "") +
    '{"title":"$:/themes/tiddlywiki/vanilla","plugin-type":"theme","text":"{}"}\n]</script>' : "",
  MARK("Raw markup for the bottom of the body section"),
  external ? MARK("Load external JavaScripts") : "", `<script src="${coreUrl(v)}" onerror="alert('Error: Cannot load ${coreUrl(v)}');"></script>`,
  "</body>", "</html>"
].join("\n");
const indexEtag = async () => (await bucket.head("index.html")).etag;
// index: the index.html it's sent for (X-Page-Index): the current one by default, none with null
const putCore = async (body, v = CORE_V, index) => mf.dispatchFetch(`${base}/page/core?v=${encodeURIComponent(v)}`, { method: "PUT", body,
  headers: { "Content-Type": "application/javascript", ...(index === null ? {} : { "X-Page-Index": index ?? await indexEtag() }) } });
// shell: the stored shell the page was built from (X-Page-Shell), as the admin wiki sends it: the
// one the worker's answers gave last (knownShell), "" for a page built from index.html, null to leave
// the header out (a tab from before this worker)
let knownShell = "";
const putShell = async (body, { fingerprint = "f1", index, shell = knownShell } = {}) => {
  try {
    const res = await mf.dispatchFetch(`${base}/page/shell`, {
      method: "PUT", body,
      headers: { "Content-Type": "text/html", ...(fingerprint ? { "X-Page-Fingerprint": fingerprint } : {}), "X-Page-Index": index ?? await indexEtag(), ...(shell === null ? {} : { "X-Page-Shell": shell }) }
    });
    if (res.headers.get("X-Page-Shell") !== null) knownShell = res.headers.get("X-Page-Shell");
    return res;
  } catch (e) {
    return new Response(`request failed: ${e.message}`, { status: 599 });
  }
};
// The tiddlers the worker preloads in the page
const preloads = text => {
  const at = text.indexOf("preloadTiddlers.concat(");
  if (at < 0) return [];
  const from = at + "preloadTiddlers.concat(".length;
  return JSON.parse(text.slice(from, text.indexOf(");\n", from)));
};
const pageSource = text => {
  const tiddler = preloads(text).find(t => t.title === "$:/cfworker/page-source");
  return tiddler ? JSON.parse(tiddler.text) : null;
};
await bucket.put("index.html", html("full engine"));
page = await (await mf.dispatchFetch(base + "/")).text();
let source = pageSource(page);
check("a page built from index.html carries its source: that index.html, no shell", !!source && source.index === await indexEtag() && source.fingerprint === "", JSON.stringify(source));

// The core file
res = await putCore(fakeCore());
let core = await bucket.head("_plugins/tiddlywikicore.js");
check("the core file is stored, cached for a year, with its version", res.status === 204 && core?.customMetadata?.v === CORE_V &&
  /immutable/.test(core?.httpMetadata?.cacheControl || "") && /javascript/.test(core?.httpMetadata?.contentType || ""), `status ${res.status}`);
const coreEtag = core?.etag;
res = await putCore(fakeCore());
await res.arrayBuffer();
check("...the same version again isn't rewritten", res.status === 204 && (await bucket.head("_plugins/tiddlywikicore.js"))?.etag === coreEtag, `status ${res.status}`);
for (const [what, body, v, says] of [
  ["a version that isn't <version>-<format>", fakeCore(), "latest"],
  ["something that isn't TiddlyWiki's core file", "console.log('hi')", "5.4.2-1"],
  ["too big", fakeCore("5.4.2-1") + "x".repeat(21 * 1024 * 1024), "5.4.2-1"],
  ["still switching the save template (a TiddlyWiki this worker can't publish yet), saying so", fakeCore("5.4.2-1", { snapshot: true }), "5.4.2-1", /save template.*update the worker/is]
]) {
  res = await putCore(body, v);
  const text = await res.text();
  check(`core file refused (400): ${what}`, res.status === 400 && text.length > 0 && (!says || says.test(text)) && (await bucket.head("_plugins/tiddlywikicore.js"))?.customMetadata?.v === CORE_V, `${res.status} ${text}`);
}
// An admin tab opened before index.html changed (an upgrade) mustn't replace the core file with its
// older version: the public site would serve it under the new version's URL, cached for a year
for (const [what, index] of [["sent for an index.html that has since changed (a tab opened before an upgrade)", '"old"'], ["without saying which index.html it's for", null]]) {
  res = await putCore(fakeCore("5.3.0-1"), "5.3.0-1", index);
  const text = await res.text();
  check(`core file refused (409): ${what}`, res.status === 409 && /reload/i.test(text) && (await bucket.head("_plugins/tiddlywikicore.js"))?.customMetadata?.v === CORE_V, `${res.status} ${text}`);
}

// The shell: refused unless it's a page that works
for (const [what, body, options, status, says] of [
  ["no TiddlyWeb plugin in its tiddlers, saying what to do", fakeShell({ tiddlyweb: false }), {}, 400, /delete it there and reload.*index\.html/s],
  ["no tiddler store", fakeShell({ store: false }), {}, 400],
  ["no place for the external scripts", fakeShell({ external: false }), {}, 400],
  ["a core file version that isn't stored", fakeShell({ v: "5.9.9-1" }), {}, 400],
  ["no fingerprint", fakeShell(), { fingerprint: "" }, 400],
  ["rendered for an index.html that has since changed", fakeShell(), { index: '"old"' }, 409],
  ["too big", fakeShell() + "<!--" + "x".repeat(3 * 1024 * 1024) + "-->", {}, 400]
]) {
  res = await putShell(body, options);
  const text = await res.text();
  check(`shell refused (${status}): ${what}`, res.status === status && text.length > 0 && (!says || says.test(text)) && !(await bucket.head("_page/shell.html")), `${res.status} ${text}`);
}

// Accepted: kept, and the page built from it
res = await putShell(fakeShell(), { fingerprint: "f1" });
const shellObj = await bucket.head("_page/shell.html");
page = await (await mf.dispatchFetch(base + "/")).text();
source = pageSource(page);
check("a shell is kept with the index.html it was rendered for and its fingerprint", res.status === 204 &&
  shellObj?.customMetadata?.index === await indexEtag() && shellObj?.customMetadata?.fingerprint === "f1", `status ${res.status} ${JSON.stringify(shellObj?.customMetadata)}`);
check("...the page is built from it", page.includes("<title>Published title</title>") && !page.includes("full engine") && page.includes(coreUrl(CORE_V)) && page.includes("$:/cfworker/conflict-guard.js"));
check("...and carries it as its source, with the stored core file's version, and the stored shell's version", source?.index === await indexEtag() && source?.fingerprint === "f1" && source?.core === CORE_V && !!shellObj?.etag && source?.shell === shellObj.etag, JSON.stringify(source));
check("...which the answer gave too", res.headers.get("X-Page-Shell") === shellObj?.etag, `${res.headers.get("X-Page-Shell")} vs ${shellObj?.etag}`);
check("index.html is left as uploaded", (await (await bucket.get("index.html")).text()) === html("full engine"));
let pageEtag2 = (await bucket.head("baked.html")).etag;
res = await putShell(fakeShell(), { fingerprint: "f1" });
await res.arrayBuffer();
check("the same shell again: nothing written, the page not rebuilt", res.status === 204 && (await bucket.head("baked.html")).etag === pageEtag2, `status ${res.status}`);
check("the page carries the module that publishes", page.includes("$:/cfworker/page-publisher.js"));
// The browser code is nine modules: a library the others require, startup modules for the
// admin tab's sync (the conflict guard, the tiddler list, the backup alert), the page publisher,
// the restore import, the control panel's tab, the outbox and the cold start (the service worker)
const BROWSER_MODULES = [["$:/cfworker/lib.js", "library"], ["$:/cfworker/conflict-guard.js", "startup"], ["$:/cfworker/list-sync.js", "startup"], ["$:/cfworker/backup-alert.js", "startup"], ["$:/cfworker/page-publisher.js", "startup"], ["$:/cfworker/restore-import.js", "startup"], ["$:/cfworker/control-panel.js", "startup"], ["$:/cfworker/outbox.js", "startup"], ["$:/cfworker/cold-start.js", "startup"]];
const preloaded = preloads(page);
check("the page preloads the nine browser modules, each the right kind of module, each a JavaScript tiddler",
  BROWSER_MODULES.every(([title, kind]) => { const t = preloaded.find(t => t.title === title); return t && t["module-type"] === kind && t.type === "application/javascript" && t.text.length > 200; }),
  preloaded.filter(t => t.title.startsWith("$:/cfworker/")).map(t => `${t.title} (${t["module-type"]})`).join(", "));
// Two admin tabs: the shell says which stored shell its page was built from, or last published over
// (X-Page-Shell). One from a page older than the shell stored is refused, with the current version
// in the answer, so the tab syncs and sends its page again, with the other tab's change in it;
// otherwise the older page would replace the newer one, and no tab would know.
const current = knownShell;
res = await putShell(fakeShell({ title: "From an older page" }), { fingerprint: "f1b", shell: "" });
let text = await res.text();
check("a shell from a page older than the one stored (built before it was published) is refused: 409, saying another tab published, with the current version",
  res.status === 409 && /another tab|published since/i.test(text) && res.headers.get("X-Page-Shell") === current && (await bucket.head("_page/shell.html")).etag === current && (await bucket.head("baked.html")).etag === pageEtag2,
  `${res.status} ${text.slice(0, 80)}, version ${res.headers.get("X-Page-Shell")} vs ${current}`);
res = await putShell(fakeShell({ title: "From an older page" }), { fingerprint: "f1b", shell: "stale" });
await res.text();
check("...the same for one built from a shell since replaced", res.status === 409 && res.headers.get("X-Page-Shell") === current && (await bucket.head("_page/shell.html")).etag === current, `status ${res.status}`);
res = await putShell(fakeShell({ title: "From an older page" }), { fingerprint: "f1b", shell: null });
await res.text();
check("...and for one that doesn't say (a tab from before this worker): reload", res.status === 409 && (await bucket.head("_page/shell.html")).etag === current, `status ${res.status}`);
res = await putShell(fakeShell({ title: "Sent again with the current version" }), { fingerprint: "f1c", shell: current });
const rebased = await bucket.head("_page/shell.html");
page = await (await mf.dispatchFetch(base + "/")).text();
check("sent again with the current version: kept, the page built from it, and the answer gives the new version", res.status === 204 && rebased?.customMetadata?.fingerprint === "f1c" && rebased.etag !== current &&
  res.headers.get("X-Page-Shell") === rebased.etag && pageSource(page)?.shell === rebased.etag && page.includes("<title>Sent again with the current version</title>"), `status ${res.status}`);
res = await putShell(fakeShell({ title: "Sent again with the current version" }), { fingerprint: "f1c", shell: "whatever" });
await res.text();
check("the same shell again, whatever it says: 204 with the current version", res.status === 204 && res.headers.get("X-Page-Shell") === rebased.etag, `status ${res.status}`);

// Plugins load from their files right before the core, not from <head>
const PLUGIN = "$:/plugins/test/placed";
await bucket.put(`recipes/default/tiddlers/${PLUGIN}`, JSON.stringify({ title: PLUGIN, "plugin-type": "plugin", type: "application/json", text: "{\"tiddlers\":{}}" }).slice(0, -1) + ',"revision":"111","bag":"default","recipe":"default"}', { customMetadata: { revision: "111", layout: "flat" } });
await bucket.put("recipes/default/tiddlers.json", JSON.stringify([{ title: PLUGIN, "plugin-type": "plugin", type: "application/json", revision: "111" }]));
res = await putShell(fakeShell({ title: "With a plugin" }), { fingerprint: "f2" });
page = await (await mf.dispatchFetch(base + "/")).text();
const tag = `<script src="${PUB}/_plugins/${encodeURIComponent(PLUGIN)}.js?v=111"></script>`;
const tagAt = page.indexOf(tag), externalAt = page.indexOf(MARK("Load external JavaScripts")), headEnd = page.indexOf("</head>");
check("in a page built from a shell, plugin tags go right before the core, after the tiddlers", res.status === 204 && tagAt > headEnd && tagAt < externalAt && page.indexOf(MARK("Ordinary tiddlers")) < tagAt,
  `tag at ${tagAt}, head ends ${headEnd}, marker at ${externalAt}`);

// A new index.html: the shell is for the old one, so the page is built from the new one until a shell for it is published.
// (Plugins go in <head> there, even if raw markup at the bottom has TiddlyWiki's marker for external scripts: TiddlyWiki
// starts from code inside a full page, before that.)
await bucket.put("index.html", html(`new engine<script>/* boot */</script>${MARK("Load external JavaScripts")}`));
page = await (await mf.dispatchFetch(base + "/")).text();
source = pageSource(page);
check("a new index.html: the page is built from it, not from the older shell", page.includes("new engine") && !page.includes("With a plugin") && source?.fingerprint === "" && source?.index === await indexEtag(), JSON.stringify(source));
check("...plugin tags back in <head> for a full index.html", page.indexOf(tag) > -1 && page.indexOf(tag) < page.indexOf("</head>") && page.indexOf(tag) === page.lastIndexOf(tag));
res = await putShell(fakeShell({ title: "For the new engine" }), { fingerprint: "f3" });
page = await (await mf.dispatchFetch(base + "/")).text();
check("...and a shell for it is used once published", res.status === 204 && page.includes("<title>For the new engine</title>") && pageSource(page)?.fingerprint === "f3");

// CONFLICT_GUARD = "off": the page is built without the browser modules (and still served)
const mfOff = new Miniflare({
  modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://my-tiddlywiki.theophile.dev", CONFLICT_GUARD: "off" },
  outboundService: async () => new Response("{}", { status: 404 }),
});
const baseOff = (await mfOff.ready).toString().replace(/\/$/, "");
await (await mfOff.getR2Bucket("WIKI_BUCKET")).put("index.html", html("engine without the modules"));
const offResponse = await mfOff.dispatchFetch(baseOff + "/");
const offPage = await offResponse.text();
check("CONFLICT_GUARD off: the page is served without the browser modules", offResponse.status === 200 && offPage.includes("engine without the modules") &&
  !offPage.includes("$:/cfworker/conflict-guard.js") && !offPage.includes("$:/cfworker/page-publisher.js") && !offPage.includes("$:/cfworker/lib.js") && !offPage.includes("$:/cfworker/list-sync.js") && !offPage.includes("$:/cfworker/backup-alert.js") && !offPage.includes("$:/cfworker/restore-import.js") && !offPage.includes("$:/cfworker/control-panel.js") && !offPage.includes("$:/cfworker/outbox.js") && !offPage.includes("$:/cfworker/cold-start.js"), `status ${offResponse.status}`);
await mfOff.dispose();

// --- Cloudflare Access ----------------------------------------------------------------------------
// The worker refuses any request that didn't come through Cloudflare Access (Cloudflare gives those
// a ctx.access), unless ACCESS = "off", which every instance above sets. Miniflare never sets
// ctx.access, so this instance, without the switch, must refuse everything, and build nothing.
const mfClosed = new Miniflare({
  modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  outboundService: async () => new Response("{}", { status: 404 }),
});
const baseClosed = (await mfClosed.ready).toString().replace(/\/$/, "");
const bucketClosed = await mfClosed.getR2Bucket("WIKI_BUCKET");
await bucketClosed.put("index.html", html("engine behind Access"));
const refusals = [];
for (const [method, path, body] of [
  ["GET", "/"], ["GET", "/status"], ["GET", "/recipes/default/tiddlers.json"], ["GET", "/recipes/default/tiddlers/x"],
  ["PUT", "/recipes/default/tiddlers/x", JSON.stringify({ title: "x", text: "t" })], ["DELETE", "/bags/default/tiddlers/x"],
  ["OPTIONS", "/recipes/default/tiddlers/x"], ["HEAD", "/index.html"], ["GET", "/manifest.webmanifest"], ["GET", "/_app/icon-192.png"]
]) {
  const res = await mfClosed.dispatchFetch(baseClosed + path, { method, body, headers: body ? { "Content-Type": "application/json" } : {} });
  const text = await res.text();
  refusals.push(`${method} ${path} → ${res.status}`);
  if (res.status !== 403 || (method !== "HEAD" && !text.includes("Cloudflare Access"))) refusals.push("WRONG: " + text.slice(0, 80));
}
check("without Access, every request is refused with 403 and says why", refusals.every(r => r.endsWith("403")), refusals.join(", "));
check("...and nothing was built or stored for them", !(await bucketClosed.head("baked.html")) && !(await bucketClosed.head("recipes/default/tiddlers/x")));
await mfClosed.dispose();
// ACCESS = off counts only for a local address (what the tests and wrangler dev use): a deployed
// worker, reached by a real hostname, refuses all the same, so the switch can't open a wiki by mistake
for (const deployed of ["https://admin.example.com/status", "https://wiki-admin.someone.workers.dev/", "https://admin.example.com/recipes/default/tiddlers.json"]) {
  const res = await mf.dispatchFetch(deployed);
  const text = await res.text();
  check(`ACCESS = off on a deployed hostname still refuses: ${new URL(deployed).hostname}`, res.status === 403 && text.includes("Cloudflare Access") && /local/i.test(text), `status ${res.status}: ${text.slice(0, 100)}`);
}
for (const local of ["http://localhost:8787/status", "http://[::1]:8787/status", "http://wiki.localhost:8787/status"]) {
  const res = await mf.dispatchFetch(local);
  check(`...and lets a local address through: ${new URL(local).hostname}`, res.status === 200, `status ${res.status}`);
}
// The decision itself, for a request Access did authenticate, which Miniflare can't make: the
// worker's own function, from its module
const decide = (url, ctx, env) => { try { return withoutAccess(new Request(url), ctx, env); } catch { return "error"; } };
check("a request Access authenticated (ctx.access) is let through", decide("https://admin.example.com/", { access: { aud: "app" } }, {}) === false);
check("one without ctx.access is refused", decide("https://admin.example.com/", {}, {}) === true);
check("ACCESS = off lets it through on a local address, for tests and local runs", decide("http://127.0.0.1:8787/", {}, { ACCESS: "off" }) === false && decide("http://localhost:8787/", {}, { ACCESS: "off" }) === false);
check("...not on a deployed hostname", decide("https://admin.example.com/", {}, { ACCESS: "off" }) === true && decide("https://wiki-admin.someone.workers.dev/", {}, { ACCESS: "off" }) === true);
check("...and nothing else does (not ACCESS = no), even locally", decide("http://127.0.0.1:8787/", {}, { ACCESS: "no" }) === true && decide("http://127.0.0.1:8787/", {}, { ACCESS: "" }) === true);

// --- The public site's address --------------------------------------------------------------------
// PUBLIC_WIKI_URL is optional. Without it the worker is a private wiki (README 2.1): the page, the
// core file and the plugin files are served by the worker itself, at root-relative URLs, the page
// carries an empty public address, and nothing is purged. Set, it must be a site's address: the page
// loads its plugin files and TiddlyWiki's core from it, so a wiki must never fall back to someone
// else's site. With one that isn't, every request answers 500 saying so, and nothing is built or stored.
async function withPublicUrl(value, run, bindings = {}) {
  const calls = [];
  const instance = new Miniflare({
    modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
    bindings: { ACCESS: "off", ...(value === undefined ? {} : { PUBLIC_WIKI_URL: value }), ...bindings },
    outboundService: async req => { calls.push(req.url); return new Response("{}", { status: 404 }); },
  });
  const root = (await instance.ready).toString().replace(/\/$/, "");
  const store = await instance.getR2Bucket("WIKI_BUCKET");
  await store.put("index.html", html("engine"));
  try { return await run(root, instance, store, calls); } finally { await instance.dispose(); }
}
await withPublicUrl(undefined, async (root, instance, store, calls) => {
  const page = await instance.dispatchFetch(root + "/"), pageText = await page.text();
  check("PUBLIC_WIKI_URL missing: a private wiki; the page is built and served, with an empty public address", page.status === 200 && pageText.includes('"title":"$:/cfworker/public-url","text":""') && !!(await store.head("baked.html")), `status ${page.status}`);
  const plugin = "$:/plugins/test/private";
  const save = await instance.dispatchFetch(root + "/recipes/default/tiddlers/" + encodeURIComponent(plugin), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: plugin, type: "application/json", "plugin-type": "plugin", text: '{"tiddlers":{}}' }) });
  await save.text();
  const bakedObj = await store.get("baked.html"), baked = bakedObj ? await bakedObj.text() : "";
  check("...a plugin saved gets its file, which the page loads from this site at a root-relative URL", save.status === 204 && !!(await store.head(`_plugins/${plugin}.js`)) && baked.includes(`<script src="/_plugins/${encodeURIComponent(plugin)}.js?v=`), `status ${save.status}: ${baked.match(/<script src="[^"]*"/)?.[0]}`);
  await new Promise(r => setTimeout(r, 300));
  check("...and nothing was purged, though the purge settings are there: no public site to purge", !calls.some(url => url.includes("purge_cache")), calls.join(", "));
}, { CF_ZONE_ID: "zone", CF_API_TOKEN: "token" });
for (const [value, why] of [["wiki.example.com", "without https://"], ["https://wiki.example.com/wiki", "with a path"]]) {
  await withPublicUrl(value, async (root, instance) => {
    const page = await instance.dispatchFetch(root + "/"), pageText = await page.text();
    check(`PUBLIC_WIKI_URL ${why} (${value}): 500, naming the variable and the value`, page.status === 500 && pageText.includes("PUBLIC_WIKI_URL") && pageText.includes(value), `status ${page.status}: ${pageText.slice(0, 80)}`);
  });
}
await withPublicUrl("https://wiki.example.com/", async (root, instance) => {
  const page = await instance.dispatchFetch(root + "/"), pageText = await page.text();
  check("a trailing slash is fine: the page is built, with the address baked in once", page.status === 200 && pageText.includes('"https://wiki.example.com/"') && !pageText.includes("wiki.example.com//"), `status ${page.status}`);
});
// The check itself, including the case Miniflare can't show: the address being this worker's own
const site = (value, origin = "https://admin.example.com") => { try { return publicSiteError(value === undefined ? {} : { PUBLIC_WIKI_URL: value }, origin); } catch { return "error"; } };
check("the public site's address: a site is accepted, with or without a trailing slash", site("https://wiki.example.com") === null && site("https://wiki.example.com/") === null && site("http://127.0.0.1:8787") === null);
check("...and so is none at all, or blank: a private wiki", site(undefined) === null && site("") === null && site("  ") === null);
check("...the worker's own address is refused, saying so", /own address|this worker/.test(site("https://admin.example.com") || "") && /own address|this worker/.test(site("https://admin.example.com/", "https://admin.example.com") || ""));
check("...and so are no scheme, another scheme, a path, a query", ["wiki.example.com", "ftp://wiki.example.com", "https://wiki.example.com/wiki", "https://wiki.example.com/?x"].every(v => typeof site(v) === "string" && site(v).includes("PUBLIC_WIKI_URL")));

// --- The first visit ------------------------------------------------------------------------------
// A new bucket is empty. The build makes seed/empty.html (an empty TiddlyWiki with the TiddlyWeb
// plugin), uploaded with the worker as a text module: on the first page request the worker puts it
// in the bucket as index.html, with the public site's status file, and the wiki starts. Nothing to
// upload (README 2.8). (Not a static asset: those put a router in front of the worker that doesn't
// pass ctx.access on, which the Access check needs.)
const emptyWiki = fs.readFileSync(fileURLToPath(new URL("../seed/empty.html", import.meta.url)));
function withAssets(extra = {}) {
  return new Miniflare({
    modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
    bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com" },
    outboundService: async () => new Response("{}", { status: 404 }),
    ...extra,
  });
}
{
  const mfNew = withAssets();
  const root = (await mfNew.ready).toString().replace(/\/$/, "");
  const store = await mfNew.getR2Bucket("WIKI_BUCKET");
  const first = await mfNew.dispatchFetch(root + "/"), firstPage = await first.text();
  const stored = await store.get("index.html"), status = await store.get("status");
  const storedBytes = stored ? Buffer.from(await stored.arrayBuffer()) : null;
  check("first visit of an empty bucket: the page is served, a TiddlyWiki with TiddlyWeb and the browser modules",
    first.status === 200 && firstPage.includes('"title":"$:/plugins/tiddlywiki/tiddlyweb"') && firstPage.includes("$:/cfworker/conflict-guard.js"), `status ${first.status}`);
  check("...the empty wiki (seed/empty.html) is stored as index.html, byte for byte, as HTML", storedBytes?.equals(emptyWiki) && stored.httpMetadata?.contentType?.startsWith("text/html"), `${storedBytes?.length} bytes, ${stored?.httpMetadata?.contentType}`);
  const statusJson = status ? await status.json().catch(() => null) : null;
  check("...and the public site's status file: a read-only, anonymous view of the recipe", statusJson?.read_only === true && statusJson?.anonymous === true && statusJson?.space?.recipe === "default" && status.httpMetadata?.contentType === "application/json", JSON.stringify(statusJson));
  const indexEtag = stored?.etag, statusEtag = status?.etag;
  const second = await mfNew.dispatchFetch(root + "/");
  await second.text();
  check("the next visit changes nothing: the same index.html and status", second.status === 200 && !!indexEtag && (await store.head("index.html"))?.etag === indexEtag && (await store.head("status"))?.etag === statusEtag);
  const direct = await mfNew.dispatchFetch(root + "/seed/empty.html");
  await direct.text();
  check("the empty wiki isn't served at a path of its own (the worker answers, and has no such object)", direct.status === 404, `status ${direct.status}`);
  await mfNew.dispose();
}
{
  // An index.html already there is never replaced (nor its status file), asset or not
  const mfOwn = withAssets();
  const root = (await mfOwn.ready).toString().replace(/\/$/, "");
  const store = await mfOwn.getR2Bucket("WIKI_BUCKET");
  await store.put("index.html", html("my own engine"));
  await store.put("status", '{"custom":true}', { httpMetadata: { contentType: "application/json" } });
  const own = await mfOwn.dispatchFetch(root + "/"), ownPage = await own.text();
  check("an index.html already in the bucket is used, not replaced", own.status === 200 && ownPage.includes("my own engine") && (await store.get("status").then(o => o?.text())) === '{"custom":true}');
  await mfOwn.dispose();
}
{
  // An engine deleted by hand (the tiddlers stay): the next visit puts a fresh one there, and the
  // page served is built from it, not the old page
  const mfLost = withAssets();
  const root = (await mfLost.ready).toString().replace(/\/$/, "");
  const store = await mfLost.getR2Bucket("WIKI_BUCKET");
  await store.put("baked.html", html("the old page"), { customMetadata: { bakeVersion: "0-old", sourceEtag: "gone" } });
  const lost = await mfLost.dispatchFetch(root + "/"), lostPage = await lost.text();
  check("index.html deleted by hand: a fresh engine is put there and the page rebuilt from it", lost.status === 200 && lostPage.includes('"title":"$:/plugins/tiddlywiki/tiddlyweb"') && !lostPage.includes("the old page") && !!(await store.head("index.html")));
  await mfLost.dispose();
}
{
  // Without the module (worker.js pasted into the dashboard, alone): the 404 says what to upload
  const mfNoAsset = new Miniflare({
    modules: [{ type: "ESModule", path: WORKER, contents: fs.readFileSync(WORKER, "utf8") }], compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
    bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com" },
    outboundService: async () => new Response("{}", { status: 404 }),
  });
  const root = (await mfNoAsset.ready).toString().replace(/\/$/, "");
  const none = await mfNoAsset.dispatchFetch(root + "/"), noneText = await none.text();
  check("the worker alone (pasted, without the empty wiki) and no index.html: 404 saying to upload one", none.status === 404 && noneText.includes("index.html") && /TiddlyWeb/.test(noneText), `status ${none.status}: ${noneText.slice(0, 80)}`);
  await mfNoAsset.dispose();
}

// --- The wiki as an installable app ---------------------------------------------------------------
// The page carries the app's manifest (design 1.12), which the worker serves: the wiki's title as
// the name, standalone, icons at 192 and 512 px inside the manifest as data URLs (a browser fetches
// a manifest's icons without cookies, which Access refuses). The link says use-credentials, for the
// same reason. The public site gets a copy in the bucket, with the icons at their own addresses.
const pngSize = base64 => {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || bytes.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const icon = (manifest, size) => ((manifest && manifest.icons) || []).find(i => i.sizes === `${size}x${size}`);
const dataPng = src => /^data:image\/png;base64,/.test(src || "") ? src.slice("data:image/png;base64,".length) : null;
{
  const mfApp = withAssets();
  const root = (await mfApp.ready).toString().replace(/\/$/, "");
  const store = await mfApp.getR2Bucket("WIKI_BUCKET");
  const page = await (await mfApp.dispatchFetch(root + "/")).text();
  check("the page links the app's manifest, with the site's cookies, and carries a theme colour and an iOS icon",
    page.includes('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">') && /<meta name="theme-color" content="#[0-9a-f]{6}">/.test(page) && page.includes('<link rel="apple-touch-icon" href="/_app/icon-192.png">'));
  const res = await mfApp.dispatchFetch(root + "/manifest.webmanifest");
  const manifest = await res.json().catch(() => null);
  check("the manifest is served as one: JSON, its content type, cached a day by the browser", res.status === 200 && !!manifest && (res.headers.get("Content-Type") || "").startsWith("application/manifest+json") && /max-age=86400/.test(res.headers.get("Cache-Control") || ""),
    `status ${res.status}, ${res.headers.get("Content-Type")}, ${res.headers.get("Cache-Control")}`);
  check("...complete: a name (the wiki's title, TiddlyWiki's own until set), start and scope at /, standalone, colours",
    manifest?.name === "My TiddlyWiki" && manifest?.start_url === "/" && manifest?.scope === "/" && manifest?.display === "standalone" && /^#[0-9a-f]{6}$/.test(manifest?.theme_color || "") && /^#[0-9a-f]{6}$/.test(manifest?.background_color || ""), JSON.stringify(manifest).slice(0, 200));
  const i192 = icon(manifest, 192) || {}, i512 = icon(manifest, 512) || {};
  check("...two PNG icons, 192 and 512 px, inside the manifest as data URLs, for any purpose and maskable",
    i192.type === "image/png" && i512.type === "image/png" && pngSize(dataPng(i192.src) || "")?.width === 192 && pngSize(dataPng(i512.src) || "")?.width === 512 && pngSize(dataPng(i512.src) || "")?.height === 512 && /maskable/.test(i512.purpose || ""),
    `${JSON.stringify(pngSize(dataPng(i192.src) || ""))} ${JSON.stringify(pngSize(dataPng(i512.src) || ""))}`);
  // The public site's copy: written with the page (after the answer), icons at their own addresses (no Access there)
  let copy = null;
  for (let i = 0; i < 20 && !copy; i++) { copy = await store.get("manifest.webmanifest"); if (!copy) await new Promise(r => setTimeout(r, 100)); }
  const copyJson = copy ? await copy.json().catch(() => null) : null;
  check("a page build writes the manifest into the bucket for the public site, with the icons at /_app/ addresses, and the default icons there",
    !!copyJson && copyJson.start_url === "/" && icon(copyJson, 192)?.src === "/_app/icon-192.png" && icon(copyJson, 512)?.src === "/_app/icon-512.png" && !!(await store.head("_app/icon-192.png")) && !!(await store.head("_app/icon-512.png")) && (copy?.httpMetadata?.contentType || "").startsWith("application/manifest+json"),
    JSON.stringify(copyJson).slice(0, 160));
  // The wiki's title, once set: the name follows, and a short name when it's short
  await store.put("recipes/default/tiddlers/$:/SiteTitle", JSON.stringify({ title: "$:/SiteTitle", text: "Notes" }), { customMetadata: { revision: "1", layout: "flat" } });
  const named = await (await mfApp.dispatchFetch(root + "/manifest.webmanifest")).json();
  await store.put("recipes/default/tiddlers/$:/SiteTitle", JSON.stringify({ title: "$:/SiteTitle", text: "A much longer title than fits" }), { customMetadata: { revision: "2", layout: "flat" } });
  const longNamed = await (await mfApp.dispatchFetch(root + "/manifest.webmanifest")).json();
  check("the wiki's title is the app's name, and its short name when it's 12 characters or fewer", named?.name === "Notes" && named?.short_name === "Notes" && longNamed?.name === "A much longer title than fits" && longNamed?.short_name === undefined,
    `${JSON.stringify(named?.name)}/${JSON.stringify(named?.short_name)} ${JSON.stringify(longNamed?.short_name)}`);
  // The owner's own icons, from the bucket
  const own = Buffer.from(dataPng(i192.src) || "iVBORw0KGgo=", "base64");
  own[own.length - 5] ^= 0xff;   // not the default's bytes (the test doesn't need a valid picture)
  await store.put("_app/icon-192.png", new Uint8Array(own).buffer, { httpMetadata: { contentType: "image/png" } });
  const customised = await (await mfApp.dispatchFetch(root + "/manifest.webmanifest")).json();
  check("the owner's icon in the bucket (_app/icon-192.png) replaces the default in the manifest", Buffer.from(dataPng((icon(customised, 192) || {}).src) || "", "base64").equals(own) && dataPng((icon(customised, 512) || {}).src) === dataPng(i512.src));
  const served = await mfApp.dispatchFetch(root + "/_app/icon-192.png");
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check("...and is what /_app/icon-192.png serves (the iOS icon), as PNG, cached", served.status === 200 && servedBytes.equals(own) && (served.headers.get("Content-Type") || "").startsWith("image/png") && /max-age/.test(served.headers.get("Cache-Control") || ""));
  await store.delete("_app/icon-192.png");
  const fallback = await mfApp.dispatchFetch(root + "/_app/icon-512.png");
  check("without an icon of the owner's, /_app/icon-<size>.png serves the default", fallback.status === 200 && pngSize(Buffer.from(await fallback.arrayBuffer()).toString("base64"))?.width === 512);
  await mfApp.dispose();
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
