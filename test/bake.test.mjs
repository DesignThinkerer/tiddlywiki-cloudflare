// Tests how the wiki page is served and rebuilt (baked.html), plus a few small worker responses.
// Run: npm run test:bake
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));

const mf = new Miniflare({
  modules: true, scriptPath: WORKER, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 8796,
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
const status = await (await mf.dispatchFetch(base + "/status")).json();
check("/status reports a logged-in, writable TiddlyWeb space", status.username === "admin" && status.read_only === false);
check("...and the same answer is baked into the page, for the browser module", page.includes("$:/cfworker/status") && page.includes('\\"read_only\\":false'));

// --- The page shell, published from the admin wiki ------------------------------------------------
// The admin wiki renders the page with TiddlyWiki's $:/core/templates/tiddlywiki5-external-js.html:
// everything but the core, which is a separate file (_plugins/tiddlywikicore.js?v=<version>-<format>).
// The worker keeps the shell in _page/shell.html and builds the page from it while it matches the
// current index.html. These stand-ins have the parts the worker relies on.
const PUB = "https://my-tiddlywiki.theophile.dev";
const CORE_V = "5.4.1-1";
const coreUrl = v => `${PUB}/_plugins/tiddlywikicore.js?v=${v}`;
const fakeCore = (v = CORE_V) => [
  "/*\nTiddlyWiki created by Jeremy Ruston\n*/", "$tw = (typeof $tw === 'undefined') ? Object.create(null) : $tw;",
  "$tw.preloadTiddlers = $tw.preloadTiddlers || [];", `// core ${v} `.padEnd(5000, "x"),
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
const putCore = (body, v = CORE_V) => mf.dispatchFetch(`${base}/page/core?v=${encodeURIComponent(v)}`, { method: "PUT", headers: { "Content-Type": "application/javascript" }, body });
const putShell = async (body, { fingerprint = "f1", index } = {}) => {
  try {
    return await mf.dispatchFetch(`${base}/page/shell`, {
      method: "PUT", body,
      headers: { "Content-Type": "text/html", ...(fingerprint ? { "X-Page-Fingerprint": fingerprint } : {}), "X-Page-Index": index ?? await indexEtag() }
    });
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
let res = await putCore(fakeCore());
let core = await bucket.head("_plugins/tiddlywikicore.js");
check("the core file is stored, cached for a year, with its version", res.status === 204 && core?.customMetadata?.v === CORE_V &&
  /immutable/.test(core?.httpMetadata?.cacheControl || "") && /javascript/.test(core?.httpMetadata?.contentType || ""), `status ${res.status}`);
const coreEtag = core?.etag;
res = await putCore(fakeCore());
await res.arrayBuffer();
check("...the same version again isn't rewritten", res.status === 204 && (await bucket.head("_plugins/tiddlywikicore.js"))?.etag === coreEtag, `status ${res.status}`);
for (const [what, body, v] of [
  ["a version that isn't <version>-<format>", fakeCore(), "latest"],
  ["something that isn't TiddlyWiki's core file", "console.log('hi')", "5.4.2-1"],
  ["too big", fakeCore("5.4.2-1") + "x".repeat(21 * 1024 * 1024), "5.4.2-1"]
]) {
  res = await putCore(body, v);
  const text = await res.text();
  check(`core file refused (400): ${what}`, res.status === 400 && text.length > 0 && (await bucket.head("_plugins/tiddlywikicore.js"))?.customMetadata?.v === CORE_V, `${res.status} ${text}`);
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
check("...and carries it as its source, with the stored core file's version", source?.index === await indexEtag() && source?.fingerprint === "f1" && source?.core === CORE_V, JSON.stringify(source));
check("index.html is left as uploaded", (await (await bucket.get("index.html")).text()) === html("full engine"));
let pageEtag2 = (await bucket.head("baked.html")).etag;
res = await putShell(fakeShell(), { fingerprint: "f1" });
await res.arrayBuffer();
check("the same shell again: nothing written, the page not rebuilt", res.status === 204 && (await bucket.head("baked.html")).etag === pageEtag2, `status ${res.status}`);
check("the page carries the module that publishes", page.includes("$:/cfworker/page-publisher.js"));

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

// A new index.html: the shell is for the old one, so the page is built from the new one until a shell for it is published
await bucket.put("index.html", html("new engine"));
page = await (await mf.dispatchFetch(base + "/")).text();
source = pageSource(page);
check("a new index.html: the page is built from it, not from the older shell", page.includes("new engine") && !page.includes("With a plugin") && source?.fingerprint === "" && source?.index === await indexEtag(), JSON.stringify(source));
check("...plugin tags back in <head> for a full index.html", page.indexOf(tag) > -1 && page.indexOf(tag) < page.indexOf("</head>"));
res = await putShell(fakeShell({ title: "For the new engine" }), { fingerprint: "f3" });
page = await (await mf.dispatchFetch(base + "/")).text();
check("...and a shell for it is used once published", res.status === 204 && page.includes("<title>For the new engine</title>") && pageSource(page)?.fingerprint === "f3");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
