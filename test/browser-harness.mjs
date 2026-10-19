// Shared setup for the browser suites (test:tabs, test:plugins, test:publish): the worker in
// Miniflare with a local R2 bucket, a stand-in for the public site, Chromium, and the helpers every
// suite uses. Each server takes a free port, so the suites can run at the same time.
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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

// The public site's TiddlyWeb status, the file uploaded once (setup 2.8)
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
//   privateWiki: no PUBLIC_WIKI_URL: a private wiki (setup 2.1); the stand-in still runs, so a
//     request that reaches it shows up in publicRequests
//   publicSite: hooks for the stand-in: cors(url) returns false to leave the CORS header out,
//     cacheStatus(url) returns the CF-Cache-Status to send (HIT by default; DYNAMIC is Cloudflare's
//     for a path no cache rule covers), etag(url) and lastModified(url) return false to leave those
//     headers out (Cloudflare removes an HTML answer's ETag when a feature of the zone rewrites the
//     page: Email Address Obfuscation, on by default), override(key, url) returns text to serve
//     instead of the object (or { body, headers } to serve it with headers of its own: an earlier
//     build of the page from Cloudflare's cache, with its ETag), rewrite(url, bytes) returns the
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
    // The CORS header as the zone's rule sends it (setup 2.7): under /recipes/ and /_plugins/ only
    const corsPath = url.pathname.startsWith("/recipes/") || url.pathname.startsWith("/_plugins/");
    const headers = corsPath && !(publicSite.cors && !publicSite.cors(url)) ? { "Access-Control-Allow-Origin": "*" } : {};
    // As Cloudflare's edge sends them: whether the cache answered, and the object's ETag
    headers["CF-Cache-Status"] = publicSite.cacheStatus ? publicSite.cacheStatus(url) : "HIT";
    try {
      const key = decodeURIComponent(url.pathname.slice(1)) || "baked.html";
      const wait = publicSite.delay ? publicSite.delay(url) : 0;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      let body = publicSite.override ? publicSite.override(key, url) : undefined;
      if (body !== undefined && typeof body === "object" && !Buffer.isBuffer(body)) {
        Object.assign(headers, body.headers || {});
        body = body.body;
      }
      if (body === undefined) {
        const obj = await bucket.get(key);
        if (!obj) {
          res.writeHead(404, headers);
          return res.end("Not found");
        }
        headers["Content-Type"] = obj.httpMetadata?.contentType || "application/octet-stream";
        if (obj.httpMetadata?.cacheControl) headers["Cache-Control"] = obj.httpMetadata.cacheControl;
        if (!(publicSite.etag && !publicSite.etag(url))) headers.ETag = obj.httpEtag;
        if (!(publicSite.lastModified && !publicSite.lastModified(url))) headers["Last-Modified"] = obj.uploaded.toUTCString();
        body = Buffer.from(await obj.arrayBuffer());
      } else if (!headers["Content-Type"]) {
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
    // The worker's own requests: to the public stand-in as they are (the setup check asks it), the
    // rest (GitHub, Cloudflare's API) to the suite's stub, or a bare success
    outboundService: async request => {
      if (new URL(request.url).origin === pub) {
        // (The stand-in down: as Cloudflare's edge answers for a site that doesn't, a 5xx)
        return fetch(request.url, { method: request.method, headers: request.headers }).catch(e => new Response("public stand-in down: " + e.message, { status: 523 }));
      }
      return outbound ? outbound(request) : new Response('{"success":true}');
    },
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
// Every page of a context opens with the waits shortened (design 2.25), through a script run before
// the page's own: TiddlyWiki's syncer looks for work every 50 ms rather than 250, saves a tiddler
// saved less than 50 ms before rather than 1 s, and retries after an error in 1 s rather than 5 —
// its class's defaults, set as $tw is put together, so a stored $:/config/SyncThrottleInterval
// still wins, as in production — and the modules' own waits (the publisher's pause, the public
// read's timeout, the retries while the worker rebuilds the list) are scaled by
// $tw.cfworkerTestTimeScale, which only a script run before boot can set: nothing stored in a wiki
// does. newContext({ fast: false }) gives a context the production waits.
export const FAST = { throttle: 50, taskTimer: 50, errorRetry: 1000, scale: 0.2 };
function fastPage(fast) {
  const tw = globalThis.$tw ??= Object.create(null);
  tw.cfworkerTestTimeScale = fast.scale;
  let Syncer;
  Object.defineProperty(tw, "Syncer", {
    configurable: true, enumerable: true,
    get() { return Syncer; },
    set(value) {
      Syncer = value;
      if (value && value.prototype) {
        value.prototype.throttleInterval = fast.throttle;
        value.prototype.taskTimerInterval = fast.taskTimer;
        value.prototype.errorRetryInterval = fast.errorRetry;
      }
    }
  });
}
// When a check failed, finish() leaves two things to read under test-results/ (TRACE=1 leaves them
// always): <suite>.requests.log, every request the suite's pages made (createWatcher), in order,
// with the time, the tab, the method, the path and how it ended; and traces/<suite>/<n>.zip, a
// Playwright trace of each browser context — the test's actions and the page's console messages
// in time — written when the context closes, opened with: npx playwright show-trace <file>.
// (TRACE=full adds screenshots and a DOM snapshot at every action to the traces: a snapshot of a
// TiddlyWiki page at each of the tests' polls slows the page down enough to upset timing checks.)
const SUITE = path.basename(process.argv[1] || "suite").replace(/\.test\.mjs$/, "");
const RESULTS = fileURLToPath(new URL("../test-results", import.meta.url));
const TRACES = path.join(RESULTS, "traces", SUITE);
const tracing = { contexts: new Set(), count: 0, files: [] };
const watchers = [];   // the requests of every createWatcher(), for the log finish() writes

function writeRequestsLog() {
  const asked = watchers.flat().sort((a, b) => a.at - b.at);
  if (!asked.length) return "";
  const file = path.join(RESULTS, `${SUITE}.requests.log`);
  const ended = r => r.failed ? `failed: ${r.failed}` : r.cached ? "cached" : r.status ?? "(no answer)";
  const lines = asked.map(r => `${((r.at - asked[0].at) / 1000).toFixed(3).padStart(9)}  ${r.tag.padEnd(8)}  ${r.origin.padEnd(6)}  ${r.method} ${r.path}  ${ended(r)}`);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(file, `time (s)   tab       origin  request  outcome\n${lines.join("\n")}\n`);
  return file;
}
async function stopTrace(context) {
  if (!tracing.contexts.has(context)) return;
  tracing.contexts.delete(context);
  const file = path.join(TRACES, `${++tracing.count}.zip`);
  await context.tracing.stop({ path: file }).catch(() => {});
  tracing.files.push(file);
}

export function launchBrowser({ serviceWorkers = "block" } = {}) {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}).then(browser => {
    const newContext = browser.newContext.bind(browser);
    fs.rmSync(TRACES, { recursive: true, force: true });
    fs.mkdirSync(TRACES, { recursive: true });
    browser.newContext = async ({ fast = true, ...options } = {}) => {
      const context = await newContext({ serviceWorkers, ...options });
      if (fast) await context.addInitScript(fastPage, FAST);
      const full = process.env.TRACE === "full";
      await context.tracing.start({ screenshots: full, snapshots: full }).then(() => tracing.contexts.add(context), () => {});
      const close = context.close.bind(context);
      context.close = async (...args) => { await stopTrace(context); return close(...args); };
      return context;
    };
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
// "other", method, url, path (decoded, with the query), headers, cached, status, failed }, where
// cached means the browser answered it from its cache (Chromium tells, through its DevTools
// protocol), so it never reached a server, status is the answer's once it has arrived, and failed
// is set (the reason) when the browser gave up on it; and every page error.
export function createWatcher(site) {
  const requests = [], pageErrors = [];
  watchers.push(requests);
  async function watch(page, tag) {
    page.on("pageerror", e => pageErrors.push(`${tag}: ${e.message}`));
    // Two streams that aren't ordered with each other: Playwright's request events (one entry each)
    // and the DevTools session's events, which say how each request ended (from the cache, from the
    // network, or failed). Per URL, entries and outcomes are paired in order, whichever comes first
    // waiting for the other: a request's outcome can't land on an older request for the same URL (a
    // load before this one, served by the network), which is what matching the latest entry did when
    // the outcome arrived first — a race lost on a slow machine, both files of a reload at once. (Seen
    // failing, and this passing, with Playwright's event delayed by 30 ms here.)
    const entries = new Map(), outcomes = new Map();   // url -> [{ entry }] / [{ cached, at }], waiting for the other
    const queue = (map, url) => { if (!map.has(url)) map.set(url, []); return map.get(url); };
    const pair = url => {
      const es = entries.get(url), os = outcomes.get(url);
      while (es && es.length && os && os.length) es.shift().cached = os.shift().cached;
    };
    const byRequest = new WeakMap();
    page.on("request", q => {
      const url = new URL(q.url());
      const origin = url.origin === site.base ? "worker" : url.origin === site.pub ? "public" : "other";
      const entry = { tag, origin, method: q.method(), url: q.url(), path: decodeURIComponent(url.pathname) + url.search, headers: q.headers(), cached: false, at: Date.now() };
      requests.push(entry);
      byRequest.set(q, entry);
      const os = outcomes.get(entry.url);
      if (os) while (os.length && entry.at - os[0].at > 10000) os.shift();   // (an outcome that never got an entry)
      queue(entries, entry.url).push(entry);
      pair(entry.url);
    });
    page.on("response", r => { const entry = byRequest.get(r.request()); if (entry) entry.status = r.status(); });
    // A request the browser gave up on (aborted by the page, refused, no answer): failed says why
    page.on("requestfailed", q => { const entry = byRequest.get(q); if (entry) entry.failed = (q.failure() || {}).errorText || "failed"; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const urls = new Map(), ended = new Set();
    const end = (id, cached) => {
      if (ended.has(id) || !urls.has(id)) return;
      ended.add(id);
      const url = urls.get(id), now = Date.now(), es = entries.get(url);
      if (es) while (es.length && now - es[0].at > 10000) es.shift();   // (an entry that never got an outcome: a redirect's first address)
      queue(outcomes, url).push({ cached, at: now });
      pair(url);
    };
    cdp.on("Network.requestWillBeSent", e => urls.set(e.requestId, e.request.url));
    cdp.on("Network.requestServedFromCache", e => end(e.requestId, true));
    cdp.on("Network.responseReceived", e => end(e.requestId, !!e.response.fromDiskCache));
    cdp.on("Network.loadingFailed", e => end(e.requestId, false));
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

// Waits until TiddlyWiki has nothing left to save or load: quiet at three looks in a row, 100 ms
// apart (a change is dirty from its event, before the throttle, so one look would do; three cover
// a task's answer and the next task it brings). The fill loads a list brings are held back for a
// moment, out of TiddlyWiki's queue (list-sync.js, the fill pause), so they count too — unless the
// tab is hidden, which holds them for good.
export async function settle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const s = window.$tw && $tw.syncer;
    if (!s) return false;
    const held = !document.hidden && s.syncadaptor && s.syncadaptor.cfworkerHeld ? s.syncadaptor.cfworkerHeld() : 0;
    const quiet = !s.isDirty() && s.numTasksInProgress === 0 && Object.keys(s.titlesToBeLoaded).length === 0 && !s.forceSyncFromServer && held === 0;
    window.__quiet = quiet ? (window.__quiet || 0) + 1 : 0;
    return window.__quiet >= 3;
  }, null, { timeout, polling: 100 });
}

export const addTiddler = (page, fields) => page.evaluate(f => $tw.wiki.addTiddler(new $tw.Tiddler(f)), fields);

// The last check (no page errors), the summary line and the exit code. cleanup: run before exiting
export async function finish({ check, results, pageErrors, browser, site, note = "", cleanup }) {
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  const passed = results.every(r => r.ok);
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed${note}`);
  if (passed && !process.env.TRACE) {
    for (const context of [...tracing.contexts]) await stopTrace(context);
    fs.rmSync(TRACES, { recursive: true, force: true });
    fs.rmSync(path.join(RESULTS, `${SUITE}.requests.log`), { force: true });   // (a failed run's, stale now)
  } else await leaveEvidence();
  await browser.close();
  await site.close();
  if (cleanup) cleanup();
  process.exit(passed ? 0 : 1);
}

// What a failure leaves to read: the traces so far, and the request log
async function leaveEvidence() {
  for (const context of [...tracing.contexts]) await stopTrace(context);
  const log = writeRequestsLog();
  if (log) console.log(`requests: ${path.relative(process.cwd(), log)}`);
  if (tracing.files.length) console.log(`traces: ${tracing.files.map(f => path.relative(process.cwd(), f)).join(", ")} (npx playwright show-trace <file>)`);
}

// A suite that dies on an error (a wait that timed out, say) leaves the same, then exits 1
for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, async error => {
    console.error(error);
    await leaveEvidence().catch(() => {});
    process.exit(1);
  });
}
// So does one the runner stops (tools/run-suites.mjs, its --timeout: SIGTERM)
process.on("SIGTERM", async () => {
  console.error("stopped by the runner (its timeout)");
  await leaveEvidence().catch(() => {});
  process.exit(1);
});
