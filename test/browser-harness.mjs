// Shared setup for the browser suites (test:tabs, test:plugins, test:publish): the worker in
// Miniflare with a local R2 bucket, a stand-in for the public site, Chromium, and the helpers every
// suite uses. Each server takes a free port, so the suites can run at the same time.
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));

// The empty wiki the build makes (what a new wiki starts from, uploaded with the worker as a text
// module), the file the suites start from too
export const EMPTY_WIKI = fileURLToPath(new URL("../seed/empty.html", import.meta.url));

// The worker's modules as Wrangler uploads them: worker.js, and the empty wiki as text
const MODULE_RULES = [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }];

// The wiki file the suites start from: seed/empty.html, or the one in WIKI_HTML
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
//     starts empty, as a new wiki's does, and the first visit puts the empty wiki in it by itself
//   publicStatus: also store the public site's status file
//   bindings: the worker's other variables
//   outbound(request): answers the worker's own requests (Cloudflare's API, GitHub); {"success":true} by default
//   r2Persist: a folder to keep R2 in
//   queue: bind the backup queue, with its consumer, as deployed (backups then run in it)
//   privateWiki: no PUBLIC_WIKI_URL: a private wiki (README 2.1); the stand-in still runs, so a
//     request that reaches it shows up in publicRequests
//   publicSite: hooks for the stand-in: cors() returns false to leave the CORS header out,
//     override(key, url) returns text to serve instead of the object, rewrite(url, bytes) returns the
//     bytes to send, delay(url) returns milliseconds to wait before answering (a slow connection)
// Returns { mf, base, pub, bucket, publicRequests (each path and query, decoded), setBindings(extra),
// stop(), start(), stopPublic(), startPublic(), close() }. setBindings restarts the worker with other
// variables (the same bucket, the same address), as a change in the dashboard does: a wiki given a
// public site, say. stop() takes the worker down (its address refuses connections, as an unreachable
// server does: what a page's service worker sees with no network, which the browser's offline mode
// doesn't cut for it) and start() brings it back on the same address, with the same bucket when R2
// is kept on disk (r2Persist); stopPublic() and startPublic() do the same for the stand-in.
export async function startSite({ index, publicStatus = false, bindings = {}, outbound, r2Persist, queue = false, privateWiki = false, publicSite = {} } = {}) {
  let bucket = null;
  const publicRequests = [];
  const publicServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://public");
    publicRequests.push(decodeURIComponent(url.pathname) + url.search);
    // The CORS header as the zone's rule sends it (README 2.7): under /recipes/ and /_plugins/ only
    const corsPath = url.pathname.startsWith("/recipes/") || url.pathname.startsWith("/_plugins/");
    const headers = corsPath && !(publicSite.cors && !publicSite.cors()) ? { "Access-Control-Allow-Origin": "*" } : {};
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
  const options = {
    modules: true, scriptPath: WORKER, modulesRules: MODULE_RULES, compatibilityDate: "2024-09-23", port: 0,
    r2Buckets: ["WIKI_BUCKET"], ...(r2Persist ? { r2Persist } : {}),
    ...(queue ? { queueProducers: { BACKUP_QUEUE: "wiki-backup" }, queueConsumers: { "wiki-backup": { maxBatchSize: 10, maxBatchTimeout: 0.2, maxRetries: 3 } } } : {}),
    bindings: { ACCESS: "off", ...(privateWiki ? {} : { PUBLIC_WIKI_URL: pub }), ...bindings },
    outboundService: outbound || (async () => new Response('{"success":true}')),
  };
  let mf = new Miniflare(options);
  const base = (await mf.ready).toString().replace(/\/$/, "");
  bucket = await mf.getR2Bucket("WIKI_BUCKET");
  const port = Number(new URL(base).port);
  if (index !== undefined) {
    await bucket.put("index.html", index);
    await bucket.put("recipes/default/tiddlers.json", "[]");
  }
  if (publicStatus) {
    await bucket.put("status", JSON.stringify(PUBLIC_STATUS), { httpMetadata: { contentType: "application/json" } });
  }
  const site = {
    base, pub, bucket, publicRequests,
    get mf() { return mf; },
    async setBindings(extra) {
      options.bindings = { ...options.bindings, ...extra };
      await mf.setOptions({ ...options, port });
      await mf.ready;
      bucket = site.bucket = await mf.getR2Bucket("WIKI_BUCKET");
      return bucket;
    },
    async stop() {
      await mf.dispose();
    },
    async start() {
      mf = new Miniflare({ ...options, port });
      await mf.ready;
      bucket = site.bucket = await mf.getR2Bucket("WIKI_BUCKET");
      return bucket;
    },
    stopPublic() {
      publicServer.closeAllConnections();
      return new Promise(resolve => publicServer.close(() => resolve()));
    },
    startPublic() {
      return new Promise(resolve => publicServer.listen(Number(new URL(pub).port), "127.0.0.1", () => resolve()));
    },
    async close() {
      await mf.dispose();
      publicServer.close();
    }
  };
  return site;
}

// The admin wiki registers a service worker (design 1.11), which answers the page's requests from
// then on: what a suite watches at the page (the requests, their headers, the 304s) is no longer
// what reaches the worker. So the suites block it by default and watch the page as before; the
// cold-start suite, about the service worker, allows it and watches what comes from it.
export function launchBrowser({ serviceWorkers = "block" } = {}) {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}).then(browser => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = (options = {}) => newContext({ serviceWorkers, ...options });
    return browser;
  });
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
