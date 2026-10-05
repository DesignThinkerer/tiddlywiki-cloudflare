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
const meta = (await bucket.head("baked.html")).customMetadata;
check("bake metadata records the guard version and source etag", /^3-/.test(meta.bakeVersion) && !!meta.sourceEtag, JSON.stringify(meta));

const options = await mf.dispatchFetch(base + "/recipes/default/tiddlers/x", { method: "OPTIONS" });
check("CORS preflight allows If-Match and If-None-Match", /If-Match/.test(options.headers.get("access-control-allow-headers")) && /If-None-Match/.test(options.headers.get("access-control-allow-headers")));
const bad = await mf.dispatchFetch(base + "/nope", { method: "PUT", body: "{}" });
check("bad PUT path answers 400 with CORS headers", bad.status === 400 && bad.headers.get("access-control-allow-origin") === "*");
const status = await (await mf.dispatchFetch(base + "/status")).json();
check("/status reports a logged-in, writable TiddlyWeb space", status.username === "admin" && status.read_only === false);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
