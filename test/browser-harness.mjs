// Shared setup for the browser suites (test:tabs, test:plugins, test:publish): the worker in
// Miniflare with a local R2 bucket, a stand-in for the public site, Chromium, and the helpers every
// suite uses. Each server takes a free port, so the suites can run at the same time.
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));

// The empty wiki the build makes (what a new wiki starts from), the file the suites start from too
export const EMPTY_WIKI = fileURLToPath(new URL("../assets/empty.html", import.meta.url));
export const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

// The wiki file the suites start from: assets/empty.html, or the one in WIKI_HTML
export function readWikiFile() {
  const file = process.env.WIKI_HTML || EMPTY_WIKI;
  if (!fs.existsSync(file)) {
    console.error(`No wiki file at ${file}. Run "npm run build" first, or set WIKI_HTML.`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

// Starts an HTTP server on a free local port and returns its origin
export async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// The public site's TiddlyWeb status, the file uploaded once (README 2.8)
export const PUBLIC_STATUS = { username: "GUEST", read_only: true, anonymous: true, logout_is_available: false, space: { recipe: "default" } };

// Starts the site: a stand-in for the public site, then the worker, which points at it.
// The stand-in serves the R2 bucket directly, as its custom domain does: "/" is baked.html, with the
// zone's CORS header, and each object's content type and cache control.
//   index: the index.html to start from (stored with an empty tiddler list); left out, the bucket
//     starts empty, as a new wiki's does
//   assets: true to deploy assets/empty.html as the worker's static asset, as Wrangler does (with the
//     worker answering every request first), so the first visit puts it in the bucket by itself
//   publicStatus: also store the public site's status file
//   bindings: the worker's other variables
//   outbound(request): answers the worker's own requests (Cloudflare's API, GitHub); {"success":true} by default
//   r2Persist: a folder to keep R2 in
//   publicSite: hooks for the stand-in: cors() returns false to leave the CORS header out,
//     override(key, url) returns text to serve instead of the object, rewrite(url, bytes) returns the
//     bytes to send, delay(url) returns milliseconds to wait before answering (a slow connection)
// Returns { mf, base, pub, bucket, publicRequests (each path and query, decoded), close() }
export async function startSite({ index, assets = false, publicStatus = false, bindings = {}, outbound, r2Persist, publicSite = {} } = {}) {
  let bucket = null;
  const publicRequests = [];
  const publicServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://public");
    publicRequests.push(decodeURIComponent(url.pathname) + url.search);
    const headers = publicSite.cors && !publicSite.cors() ? {} : { "Access-Control-Allow-Origin": "*" };
    try {
      const key = decodeURIComponent(url.pathname.slice(1)) || "baked.html";
      const wait = publicSite.delay ? publicSite.delay(url) : 0;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      let body = publicSite.override ? publicSite.override(key, url) : undefined;
      if (body === undefined) {
        const obj = await bucket.get(key);
        if (!obj) {
          res.writeHead(404, headers);
          return res.end("Not found");
        }
        headers["Content-Type"] = obj.httpMetadata?.contentType || "application/octet-stream";
        if (obj.httpMetadata?.cacheControl) headers["Cache-Control"] = obj.httpMetadata.cacheControl;
        body = Buffer.from(await obj.arrayBuffer());
      } else {
        headers["Content-Type"] = "application/json";
      }
      if (publicSite.rewrite) body = publicSite.rewrite(url, Buffer.from(body));
      res.writeHead(200, headers);
      res.end(body);
    } catch (e) {
      console.error("public stand-in:", e.message);
      res.writeHead(500, headers);
      res.end();
    }
  });
  const pub = await listen(publicServer);
  const mf = new Miniflare({
    modules: true, scriptPath: WORKER, compatibilityDate: "2024-09-23", port: 0,
    r2Buckets: ["WIKI_BUCKET"], ...(r2Persist ? { r2Persist } : {}),
    ...(assets ? { assets: { directory: ASSETS_DIR, binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } } } : {}),
    bindings: { ACCESS: "off", PUBLIC_WIKI_URL: pub, ...bindings },
    outboundService: outbound || (async () => new Response('{"success":true}')),
  });
  const base = (await mf.ready).toString().replace(/\/$/, "");
  bucket = await mf.getR2Bucket("WIKI_BUCKET");
  if (index !== undefined) {
    await bucket.put("index.html", index);
    await bucket.put("recipes/default/tiddlers.json", "[]");
  }
  if (publicStatus) {
    await bucket.put("status", JSON.stringify(PUBLIC_STATUS), { httpMetadata: { contentType: "application/json" } });
  }
  return {
    mf, base, pub, bucket, publicRequests,
    async close() {
      await mf.dispose();
      publicServer.close();
    }
  };
}

export function launchBrowser() {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

// check(name, ok, detail) prints a line and records the result
export function createChecks() {
  const results = [];
  function check(name, ok, detail = "") {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  }
  return { check, results };
}

// Records what the pages of a suite do: every request, as { tag, origin: "worker" | "public" |
// "other", method, url, path (decoded, with the query), headers, cached }, where cached means the
// browser answered it from its cache (Chromium tells, through its DevTools protocol), so it never
// reached a server; and every page error.
export function createWatcher(site) {
  const requests = [], pageErrors = [];
  async function watch(page, tag) {
    page.on("pageerror", e => pageErrors.push(`${tag}: ${e.message}`));
    page.on("request", q => {
      const url = new URL(q.url());
      const origin = url.origin === site.base ? "worker" : url.origin === site.pub ? "public" : "other";
      requests.push({ tag, origin, method: q.method(), url: q.url(), path: decodeURIComponent(url.pathname) + url.search, headers: q.headers(), cached: false });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const urls = new Map(), marked = new Set();
    const markCached = id => {
      if (marked.has(id) || !urls.has(id)) return;
      marked.add(id);
      for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        if (r.tag === tag && r.url === urls.get(id) && !r.cached) {
          r.cached = true;
          return;
        }
      }
    };
    cdp.on("Network.requestWillBeSent", e => urls.set(e.requestId, e.request.url));
    cdp.on("Network.requestServedFromCache", e => markCached(e.requestId));
    cdp.on("Network.responseReceived", e => { if (e.response.fromDiskCache) markCached(e.requestId); });
  }
  return { requests, pageErrors, watch };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitFor(condition, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(200);
  }
  return false;
}

// Waits until TiddlyWiki has nothing left to save or load (three polls in a row)
export async function settle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const s = window.$tw && $tw.syncer;
    if (!s) return false;
    const quiet = !s.isDirty() && s.numTasksInProgress === 0 && Object.keys(s.titlesToBeLoaded).length === 0 && !s.forceSyncFromServer;
    window.__quiet = quiet ? (window.__quiet || 0) + 1 : 0;
    return window.__quiet >= 3;
  }, null, { timeout, polling: 300 });
}

export const addTiddler = (page, fields) => page.evaluate(f => $tw.wiki.addTiddler(new $tw.Tiddler(f)), fields);

// The last check (no page errors), the summary line and the exit code. cleanup: run before exiting
export async function finish({ check, results, pageErrors, browser, site, note = "", cleanup }) {
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed${note}`);
  await browser.close();
  await site.close();
  if (cleanup) cleanup();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
