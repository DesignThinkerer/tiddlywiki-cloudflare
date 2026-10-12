// R2 operations per request: what each kind of request costs in R2 calls, so a change that adds
// some fails here. The worker runs unchanged behind test/r2-counter.mjs, which counts its calls.
// Run: npm run test:r2
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST = "recipes/default/tiddlers.json";

// The most each request may make, by call ("get list": one read of the tiddler list). Lower is fine;
// if a change lowers one for good, lower it here too.
const BUDGETS = {
  "page load (page up to date)": { "get baked.html": 1, "head index.html": 1 },
  // The page's body isn't read at all
  "page load, browser has the page (304)": { "get baked.html": 1, "head index.html": 1 },
  // Asked by date (Cloudflare removed the ETag): the body is read, but not sent
  "page load, browser has the page (304 by date)": { "get baked.html": 1, "head index.html": 1 },
  "tiddler list, first fetch": { "get list": 1 },
  "tiddler list, unchanged (304)": { "get list": 1 },
  "tiddler list, asking how backups go (page load, then hourly)": { "get list": 1, "get backup status": 1 },
  "tiddler list, unchanged (304), asking how backups go": { "get list": 1, "get backup status": 1 },
  // The fallback read (a public copy that's stale or missing, or the conflict guard reading the
  // server's version): one read, which the 304 doesn't save (the revision is in the object's
  // metadata), only the transfer
  "tiddler read": { "get tiddler": 1 },
  "tiddler read, unchanged (304)": { "get tiddler": 1 },
  "save a new tiddler": { "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1 },
  "save an update": { "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1 },
  // Different content, so different bytes: the stored tiddler isn't read to compare them. (The list
  // is read at the same time as the lookup, for every save: one round trip less when it goes through.)
  "save refused (412)": { "head tiddler": 1, "get list": 1 },
  // The same bytes as stored: read once to compare, then the list update is finished, and a look for
  // a plugin file the first attempt may have left (a plugin saved as an ordinary tiddler whose page
  // build failed twice): the one place that can repair it, on a path only retries take
  "save sent again, already stored": { "head tiddler": 1, "get tiddler": 1, "get list": 1, "put list": 1, "head plugin file": 1 },
  "delete": { "get list": 1, "head tiddler": 1, "delete tiddler": 1, "put list": 1 },
  // Once per wiki: the page request's two reads, the engine and the status file written (create-only), the
  // engine looked up again, then the page build: its sources, the engine read in full, the missing list
  // made from the stored tiddlers (none), the page written
  // ...and the app's files for the public site, once: the manifest (the wiki's title read for it) and the two default icons
  "first visit of a new wiki (empty bucket)": { "get baked.html": 1, "head index.html": 3, "put index.html": 1, "put status": 1, "get page shell": 1, "head core file": 1, "get index.html": 1, "get list": 1, "list tiddlers": 1, "get repair": 1, "put list": 2, "head baked.html": 1, "put baked.html": 1,
    "head manifest.webmanifest": 1, "get tiddler": 1, "put manifest.webmanifest": 1, "head app icon": 2, "put app icon": 2 },
  // The page build reuses the list the save has just written. It's built from the published shell
  // when there is one for the current index.html (looked up at the same time as index.html's
  // version and the stored core file's), from index.html otherwise.
  // (Each page build also looks at the public site's manifest, one head, and rewrites it only when
  // the page's source changed: "publish a shell" below)
  "save a plugin (page rebuilt)": {
    "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "get index.html": 1, "head plugin file": 1, "get tiddler": 1, "put plugin file": 1, "head baked.html": 1, "put baked.html": 1,
    "head manifest.webmanifest": 1
  },
  "delete a plugin (page rebuilt)": {
    "get list": 1, "head tiddler": 1, "delete tiddler": 1, "put list": 1, "delete plugin file": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "get index.html": 1, "head baked.html": 1, "put baked.html": 1,
    "head manifest.webmanifest": 1
  },
  // The core file: once per TiddlyWiki version, checked against index.html and the stored one, at the
  // same time. The page is then marked outdated (copied with that mark), so the next load's page says
  // the core is stored, even if the shell that follows is refused
  "publish the core file": { "head index.html": 1, "head core file": 1, "put core file": 1, "get baked.html": 1, "put baked.html": 1 },
  "publish the same core file again": { "head index.html": 1, "head core file": 1 },
  // A shell: checked against index.html, the core file and the shell already kept, then the page is
  // built from it (without reading it back)
  // (A new shell is a new page source: the public site's manifest is written again, the wiki's
  // title read for it)
  "publish a shell (page rebuilt)": {
    "head index.html": 1, "head core file": 1, "head page shell": 1, "put page shell": 1, "get list": 1, "head baked.html": 1, "put baked.html": 1,
    "head manifest.webmanifest": 1, "get tiddler": 1, "put manifest.webmanifest": 1
  },
  "publish the same shell again": { "head index.html": 1, "head core file": 1, "head page shell": 1, "head baked.html": 1 },
  // The setup check (on demand): the rewrite rule is checked by comparing the public page's ETag with
  // the stored page's, one head; the rest is requests to the public site, GitHub and Cloudflare
  "setup check": { "head baked.html": 1 },
  // The engine updated from the Cloudflare tab (on demand): the engine's head read for its version,
  // the shipped empty wiki written over it; the page build follows at the next load, as above
  "engine update": { "get index.html": 1, "put index.html": 1 },
  // With a shell, index.html itself isn't read
  "save a plugin, page built from the shell": {
    "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "head plugin file": 1, "get tiddler": 1, "put plugin file": 1, "head baked.html": 1, "put baked.html": 1,
    "head manifest.webmanifest": 1
  },
};

const mf = new Miniflare({
  modules: true, scriptPath: "test/r2-counter.mjs", modulesRoot: ROOT,
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }],
  compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com" },
  queueProducers: { BACKUP_QUEUE: "wiki-backup" },   // as deployed: backups run later, in the queue consumer
  outboundService: async () => new Response('{"success":true}'),
});
const base = (await mf.ready).toString().replace(/\/$/, "");
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
await bucket.put("index.html", "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>engine</body></html>");
await bucket.put(LIST, "[]");

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const url = title => `${base}/recipes/default/tiddlers/${encodeURIComponent(title)}`;
const save = (title, fields, headers = {}) => mf.dispatchFetch(url(title), {
  method: "PUT", headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat", ...headers },
  body: JSON.stringify({ title, type: "text/vnd.tiddlywiki", ...fields })
});
const del = (title, headers = {}) => mf.dispatchFetch(`${base}/bags/default/tiddlers/${encodeURIComponent(title)}`, { method: "DELETE", headers });
const etagOf = (title, res) => `"default/${encodeURIComponent(title)}/${((res.headers.get("ETag") || "").match(/\/([^/]+):auto"$/) || [])[1]}:auto"`;

// The calls a request made, including what it left running after answering
async function measure(name, request) {
  await (await mf.dispatchFetch(base + "/__r2ops")).json();   // start a new count
  const res = await request();
  await res.arrayBuffer();
  await new Promise(r => setTimeout(r, 300));
  const { calls, overlaps } = await (await mf.dispatchFetch(base + "/__r2ops")).json();
  const counts = {};
  for (const call of calls) counts[call] = (counts[call] || 0) + 1;
  const budget = BUDGETS[name];
  const over = Object.entries(counts).filter(([call, n]) => n > (budget[call] ?? 0)).map(([call, n]) => `${call} ×${n} (budget ${budget[call] ?? 0})`);
  check(`${name}: ${calls.length} R2 calls`, over.length === 0,
    (over.length ? "over budget: " + over.join(", ") + " | " : "") + Object.entries(counts).map(([c, n]) => `${c} ×${n}`).join(", "));
  res.overlaps = overlaps;
  return res;
}

// Setup: the page built once
await (await mf.dispatchFetch(base + "/")).arrayBuffer();
await new Promise(r => setTimeout(r, 300));

const pageLoad = await measure("page load (page up to date)", () => mf.dispatchFetch(base + "/"));
await measure("setup check", () => mf.dispatchFetch(base + "/setup/check"));
const notModified = await measure("page load, browser has the page (304)", () => mf.dispatchFetch(base + "/", { headers: { "If-None-Match": pageLoad.headers.get("ETag") || "none" } }));
check("...answered 304", notModified.status === 304, `status ${notModified.status}`);
const byDate = await measure("page load, browser has the page (304 by date)", () => mf.dispatchFetch(base + "/", { headers: { "If-Modified-Since": pageLoad.headers.get("Last-Modified") || "none" } }));
check("...answered 304", byDate.status === 304, `status ${byDate.status}`);
const first = await measure("tiddler list, first fetch", () => mf.dispatchFetch(`${base}/${LIST}`));
const listEtag = first.headers.get("ETag");
await measure("tiddler list, unchanged (304)", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "If-None-Match": listEtag } }));
const asked = await measure("tiddler list, asking how backups go (page load, then hourly)", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "X-Backup-Status": "ask" } }));
// (This worker has no GITHUB_REPO: the answer says backups are off)
check("...the list and the backup status read at the same time, and the answer says how backups go",
  asked.overlaps.includes("get backup status + get list") && asked.headers.get("X-Backup-Status") === "off", `${JSON.stringify(asked.overlaps)} ${asked.headers.get("X-Backup-Status")}`);
const askedUnchanged = await measure("tiddler list, unchanged (304), asking how backups go", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "If-None-Match": listEtag, "X-Backup-Status": "ask" } }));
check("...answered 304, with the backup status", askedUnchanged.status === 304 && askedUnchanged.headers.get("X-Backup-Status") === "off", `${askedUnchanged.status} ${askedUnchanged.headers.get("X-Backup-Status")}`);

let res = await measure("save a new tiddler", () => save("Note", { text: "v1" }, { "If-None-Match": "*" }));
check("...the lookup and the list read run at the same time", res.overlaps.includes("get list + head tiddler"), JSON.stringify(res.overlaps));
const v1 = etagOf("Note", res);
res = await measure("save an update", () => save("Note", { text: "v2" }, { "If-Match": v1 }));
const v2 = etagOf("Note", res);
const read = await measure("tiddler read", () => mf.dispatchFetch(url("Note")));
check("...served with its revision as its ETag", read.status === 200 && read.headers.get("ETag") === v2, `${read.status} ${read.headers.get("ETag")} vs ${v2}`);
const unchanged = await measure("tiddler read, unchanged (304)", () => mf.dispatchFetch(url("Note"), { headers: { "If-None-Match": v2 } }));
check("...answered 304", unchanged.status === 304, `status ${unchanged.status}`);
await measure("save refused (412)", () => save("Note", { text: "from a stale tab" }, { "If-Match": v1 }));
await measure("save sent again, already stored", () => save("Note", { text: "v2" }, { "If-Match": v1 }));
await measure("delete", () => del("Note", { "If-Match": v2 }));

const PLUGIN = "$:/plugins/test/counted";
res = await measure("save a plugin (page rebuilt)", () => save(PLUGIN, {
  "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { "$:/plugins/test/counted/readme": { text: "hello" } } })
}, { "If-None-Match": "*" }));
const pluginEtag = etagOf(PLUGIN, res);
await measure("delete a plugin (page rebuilt)", () => del(PLUGIN, { "If-Match": pluginEtag }));

// The page shell and the core file, as the admin wiki publishes them
const CORE_V = "5.4.1-1";
const coreBody = "/*\nTiddlyWiki\n*/\n$tw.preloadTiddlers = $tw.preloadTiddlers || [];\n" + "x".repeat(5000) + '\n_load(window,{"title":"$:/boot/boot.js","text":""});';
const indexEtag = (await bucket.head("index.html")).etag;
const publishCore = () => mf.dispatchFetch(`${base}/page/core?v=${CORE_V}`, { method: "PUT", headers: { "Content-Type": "application/javascript", "X-Page-Index": indexEtag }, body: coreBody });
res = await measure("publish the core file", publishCore);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("publish the same core file again", publishCore);
check("...published", res.status === 204, `status ${res.status}`);
const shellBody = ["<!doctype html>", '<html lang="en-GB">', "<head>", "<title>Shell</title>", "</head>", '<body class="tc-body">', "<!--~~ Ordinary tiddlers ~~-->",
  '<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/tiddlywiki/tiddlyweb","plugin-type":"plugin","text":"{}"}\n]</script>',
  "<!--~~ Load external JavaScripts ~~-->", '<script src="https://wiki.example.com/_plugins/tiddlywikicore.js?v=' + CORE_V + '"></script>', "</body>", "</html>"].join("\n");
const publishShell = async () => mf.dispatchFetch(`${base}/page/shell`, { method: "PUT", headers: { "Content-Type": "text/html", "X-Page-Fingerprint": "counted", "X-Page-Index": indexEtag, "X-Page-Shell": (await bucket.head("_page/shell.html"))?.etag || "" }, body: shellBody });
res = await measure("publish a shell (page rebuilt)", publishShell);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("publish the same shell again", publishShell);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("save a plugin, page built from the shell", () => save(PLUGIN, {
  "plugin-type": "plugin", type: "application/json", version: "1.0.1",
  text: JSON.stringify({ tiddlers: { "$:/plugins/test/counted/readme": { text: "again" } } })
}, { "If-None-Match": "*" }));
check("...saved", res.status === 204, `status ${res.status}`);

// The first visit of a new wiki (an empty bucket, the empty wiki as the worker's static asset): the
// engine and the status file put in the bucket, then the page built as for any new index.html,
// which also makes the empty tiddler list from the (no) stored tiddlers. Once per wiki.
const mfNew = new Miniflare({
  modules: true, scriptPath: "test/r2-counter.mjs", modulesRoot: ROOT,
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }],
  compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com" },
  outboundService: async () => new Response('{"success":true}'),
});
const baseNew = (await mfNew.ready).toString().replace(/\/$/, "");
{
  const name = "first visit of a new wiki (empty bucket)";
  await (await mfNew.dispatchFetch(baseNew + "/__r2ops")).json();
  const res = await mfNew.dispatchFetch(baseNew + "/");
  await res.arrayBuffer();
  await new Promise(r => setTimeout(r, 300));
  const { calls } = await (await mfNew.dispatchFetch(baseNew + "/__r2ops")).json();
  const counts = {};
  for (const call of calls) counts[call] = (counts[call] || 0) + 1;
  const budget = BUDGETS[name];
  const over = Object.entries(counts).filter(([call, n]) => n > (budget[call] ?? 0)).map(([call, n]) => `${call} ×${n} (budget ${budget[call] ?? 0})`);
  check(`${name}: ${calls.length} R2 calls`, res.status === 200 && over.length === 0,
    (over.length ? "over budget: " + over.join(", ") + " | " : "") + `status ${res.status}, ` + Object.entries(counts).map(([c, n]) => `${c} ×${n}`).join(", "));
}
await mfNew.dispose();

// Last, since it replaces the engine: the next page load would be a rebuild
const engineUpdate = await measure("engine update", () => mf.dispatchFetch(base + "/engine/update", { method: "POST", headers: { "X-Requested-With": "TiddlyWiki" } }));
check("...answered 200", engineUpdate.status === 200, `status ${engineUpdate.status}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
