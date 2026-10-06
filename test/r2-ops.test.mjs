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
  "save a new tiddler": { "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1 },
  "save an update": { "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1 },
  // Different content, so different bytes: the stored tiddler isn't read to compare them. (The list
  // is read at the same time as the lookup, for every save: one round trip less when it goes through.)
  "save refused (412)": { "head tiddler": 1, "get list": 1 },
  // The same bytes as stored: read once to compare, then the list update is finished
  "save sent again, already stored": { "head tiddler": 1, "get tiddler": 1, "get list": 1, "put list": 1 },
  "delete": { "get list": 1, "head tiddler": 1, "delete tiddler": 1, "put list": 1 },
  // The page build reuses the list the save has just written. It's built from the published shell
  // when there is one for the current index.html (looked up at the same time as index.html's
  // version and the stored core file's), from index.html otherwise.
  "save a plugin (page rebuilt)": {
    "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "get index.html": 1, "head plugin file": 1, "get tiddler": 1, "put plugin file": 1, "head baked.html": 1, "put baked.html": 1
  },
  "delete a plugin (page rebuilt)": {
    "get list": 1, "head tiddler": 1, "delete tiddler": 1, "put list": 1, "delete plugin file": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "get index.html": 1, "head baked.html": 1, "put baked.html": 1
  },
  // The core file: once per TiddlyWiki version
  "publish the core file": { "head core file": 1, "put core file": 1 },
  "publish the same core file again": { "head core file": 1 },
  // A shell: checked against index.html, the core file and the shell already kept, then the page is
  // built from it (without reading it back)
  "publish a shell (page rebuilt)": {
    "head index.html": 1, "head core file": 1, "head page shell": 1, "put page shell": 1, "get list": 1, "head baked.html": 1, "put baked.html": 1
  },
  "publish the same shell again": { "head index.html": 1, "head core file": 1, "head page shell": 1, "head baked.html": 1 },
  // With a shell, index.html itself isn't read
  "save a plugin, page built from the shell": {
    "head tiddler": 1, "get list": 1, "put tiddler": 1, "put list": 1,
    "head index.html": 1, "get page shell": 1, "head core file": 1, "head plugin file": 1, "get tiddler": 1, "put plugin file": 1, "head baked.html": 1, "put baked.html": 1
  },
};

const mf = new Miniflare({
  modules: true, scriptPath: "test/r2-counter.mjs", modulesRoot: ROOT,
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
  compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
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
const notModified = await measure("page load, browser has the page (304)", () => mf.dispatchFetch(base + "/", { headers: { "If-None-Match": pageLoad.headers.get("ETag") || "none" } }));
check("...answered 304", notModified.status === 304, `status ${notModified.status}`);
const byDate = await measure("page load, browser has the page (304 by date)", () => mf.dispatchFetch(base + "/", { headers: { "If-Modified-Since": pageLoad.headers.get("Last-Modified") || "none" } }));
check("...answered 304", byDate.status === 304, `status ${byDate.status}`);
const first = await measure("tiddler list, first fetch", () => mf.dispatchFetch(`${base}/${LIST}`));
const listEtag = first.headers.get("ETag");
await measure("tiddler list, unchanged (304)", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "If-None-Match": listEtag } }));
const asked = await measure("tiddler list, asking how backups go (page load, then hourly)", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "X-Backup-Status": "ask" } }));
check("...the list and the backup status read at the same time, and the answer says how backups go",
  asked.overlaps.includes("get backup status + get list") && asked.headers.get("X-Backup-Status") === "ok", `${JSON.stringify(asked.overlaps)} ${asked.headers.get("X-Backup-Status")}`);
const askedUnchanged = await measure("tiddler list, unchanged (304), asking how backups go", () => mf.dispatchFetch(`${base}/${LIST}`, { headers: { "If-None-Match": listEtag, "X-Backup-Status": "ask" } }));
check("...answered 304, with the backup status", askedUnchanged.status === 304 && askedUnchanged.headers.get("X-Backup-Status") === "ok", `${askedUnchanged.status} ${askedUnchanged.headers.get("X-Backup-Status")}`);

let res = await measure("save a new tiddler", () => save("Note", { text: "v1" }, { "If-None-Match": "*" }));
check("...the lookup and the list read run at the same time", res.overlaps.includes("get list + head tiddler"), JSON.stringify(res.overlaps));
const v1 = etagOf("Note", res);
res = await measure("save an update", () => save("Note", { text: "v2" }, { "If-Match": v1 }));
const v2 = etagOf("Note", res);
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
const publishCore = () => mf.dispatchFetch(`${base}/page/core?v=${CORE_V}`, { method: "PUT", headers: { "Content-Type": "application/javascript" }, body: coreBody });
res = await measure("publish the core file", publishCore);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("publish the same core file again", publishCore);
check("...published", res.status === 204, `status ${res.status}`);
const shellBody = ["<!doctype html>", '<html lang="en-GB">', "<head>", "<title>Shell</title>", "</head>", '<body class="tc-body">', "<!--~~ Ordinary tiddlers ~~-->",
  '<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/tiddlywiki/tiddlyweb","plugin-type":"plugin","text":"{}"}\n]</script>',
  "<!--~~ Load external JavaScripts ~~-->", '<script src="https://my-tiddlywiki.theophile.dev/_plugins/tiddlywikicore.js?v=' + CORE_V + '"></script>', "</body>", "</html>"].join("\n");
const indexEtag = (await bucket.head("index.html")).etag;
const publishShell = () => mf.dispatchFetch(`${base}/page/shell`, { method: "PUT", headers: { "Content-Type": "text/html", "X-Page-Fingerprint": "counted", "X-Page-Index": indexEtag }, body: shellBody });
res = await measure("publish a shell (page rebuilt)", publishShell);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("publish the same shell again", publishShell);
check("...published", res.status === 204, `status ${res.status}`);
res = await measure("save a plugin, page built from the shell", () => save(PLUGIN, {
  "plugin-type": "plugin", type: "application/json", version: "1.0.1",
  text: JSON.stringify({ tiddlers: { "$:/plugins/test/counted/readme": { text: "again" } } })
}, { "If-None-Match": "*" }));
check("...saved", res.status === 204, `status ${res.status}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
