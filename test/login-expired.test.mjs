// "Log in again", not "offline", when the Cloudflare Access session has expired (design 1.10, 2.26).
// A real TiddlyWiki in Chromium behind a stand-in for Access: a proxy in front of the worker that
// lets a request through with a valid session cookie, answers Access's own identity path at the edge
// (the identity while the session stands, 400 "no app token set" once it's gone, as a real Access
// application does) and redirects anything else to a login page on another origin, which the browser
// blocks for the page's own requests, so they end with no answer, as with no network. The service
// worker is in place, so what the tab sees is what a real tab sees: the list poll going on from the
// cache, a save ending with no answer.
// Run: npm run test:login
import http from "node:http";
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, listen, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const site = await startSite({ index: readWikiFile(), privateWiki: true });
const { check, results } = createChecks();
const STATUS = "$:/temp/cfworker/outbox", ITEM = "$:/temp/cfworker/outbox-status";
const TIDDLER = "recipes/default/tiddlers/";
const SETUP = "$:/temp/cfworker/setup-check", TAB = "$:/temp/cfworker/ControlPanel";

// --- The stand-in for Access -------------------------------------------------------------------------
let sessions = 1;
let token = "session-1";   // what a valid cookie carries; a new value ends every session, as an expiry does
const expire = () => { token = `session-${++sessions}`; };
const arrived = [];        // every request that reached the worker: { method, path, status }
const refused = [];        // every request sent to the login page instead: { method, path }
const probes = [];         // every request for the identity path: { status, cookie }
// Access's login page, on the team domain: another origin, which sends no CORS header
const loginServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://login");
  if (url.pathname.startsWith("/cdn-cgi/access/login/")) {
    const back = `${FRONT}/cdn-cgi/access/callback?redirect_url=${encodeURIComponent(url.searchParams.get("redirect_url") || "/")}`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><title>Log in</title><h1>Log in to the wiki</h1><p><a id="login" href="${back}">Log in</a></p>`);
  }
  res.writeHead(404);
  res.end();
});
const LOGIN = await listen(loginServer);
// Access in front of the worker, on the admin site's address
const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, "http://front");
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]*)/.exec(req.headers.cookie || "");
  const valid = !!cookie && cookie[1] === token;
  if (url.pathname === "/cdn-cgi/access/get-identity") {
    probes.push({ status: valid ? 200 : 400, cookie: cookie ? cookie[1] : null });
    res.writeHead(valid ? 200 : 400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(valid ? { email: "someone@example.com" } : { err: "no app token set" }));
  }
  if (url.pathname === "/cdn-cgi/access/callback") {
    const back = url.searchParams.get("redirect_url") || "/";
    res.writeHead(302, { "Set-Cookie": `CF_Authorization=${token}; Path=/; HttpOnly; SameSite=Lax`, Location: back.startsWith("/") ? back : "/" });
    return res.end();
  }
  if (!valid) {
    refused.push({ method: req.method, path: url.pathname });
    res.writeHead(302, { Location: `${LOGIN}/cdn-cgi/access/login/front?redirect_url=${encodeURIComponent(req.url)}` });
    return res.end();
  }
  const target = new URL(req.url, site.base);
  const out = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, answer => {
    arrived.push({ method: req.method, path: url.pathname, status: answer.statusCode });
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  out.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(out);
});
const FRONT = await listen(proxy);
const PORT = Number(new URL(FRONT).port);

const browser = await launchBrowser({ serviceWorkers: "allow" });
const { pageErrors, watch } = createWatcher(site);
const listAnswers = [];   // every answer a tab got to its list request: { tag, fromCache, at }

async function open(context, tag, url = FRONT + "/") {
  const p = await context.newPage();
  await watch(p, tag);
  // (The browser's own line for a request Access redirected is the expected symptom, not an error of the page's)
  p.on("console", m => { if (m.type() === "error" && !/^Failed to load resource|^Access to (XMLHttpRequest|fetch) at /.test(m.text())) pageErrors.push(`${tag} console: ${m.text()}`); });
  p.on("dialog", d => d.accept());   // the "unsaved changes" warning on reload
  p.on("response", r => { if (r.url().includes("/recipes/default/tiddlers.json")) listAnswers.push({ tag, fromCache: r.headers()["x-served-from"] === "cache", at: Date.now() }); });
  await p.goto(url);
  return p;
}
async function ready(p) {
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
}
// On the stand-in's login page: the click Access's identity provider would take
async function login(p) {
  await p.waitForSelector("#login", { timeout: 15000 });
  await p.click("#login");
  await ready(p);
}
const pollEvery = (p, ms) => p.evaluate(ms => { $tw.syncer.pollTimerInterval = ms; $tw.syncer.processTaskQueue(); }, ms);
const stored = async title => { const obj = await site.bucket.get(TIDDLER + title); return obj ? (await obj.json()).text : null; };
const status = p => p.evaluate(t => { const x = $tw.wiki.getTiddler(t); return x ? { waiting: x.fields.waiting, online: x.fields.online, login: x.fields.login } : null; }, STATUS);
// What the cloud icon's dropdown says about the outbox (its item, rendered)
const line = p => p.evaluate(t => $tw.wiki.tiddlerExists(t) && $tw.wiki.getTiddler(t).fields.tags.includes("$:/tags/SyncerDropdown") ? $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " ").trim() : null, ITEM);
const alerts = p => p.evaluate(() => $tw.wiki.getTiddlersWithTag("$:/tags/Alert").map(t => { const f = $tw.wiki.getTiddler(t).fields; return { component: f.component, text: String(f.text).slice(0, 60) }; }));
// What the device holds in its outbox: [{title, kind}]
const outbox = p => p.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open("cfworker-tiddlers");
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("outbox")) { db.close(); return resolve(null); }
    const get = db.transaction("outbox").objectStore("outbox").getAll();
    get.onsuccess = () => { db.close(); resolve(get.result.map(e => ({ title: e.title, kind: e.kind }))); };
    get.onerror = () => { db.close(); resolve("error"); };
  };
  req.onerror = () => resolve("open error");
}));
const loginIs = (p, value) => p.evaluate(([t, v]) => { const x = $tw.wiki.getTiddler(t); return !!x && x.fields.login === v; }, [STATUS, value]);
const since = (list, from) => list.slice(from);
// The Cloudflare tab's "Check the setup" button, and the lines it then shows
async function setupCheck(p) {
  await p.evaluate(t => { $tw.wiki.deleteTiddler(t); $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-setup-check" }); }, SETUP);
  const done = await waitFor(() => p.evaluate(t => $tw.wiki.tiddlerExists(t) && $tw.wiki.getTiddler(t).fields.checked !== undefined, SETUP), 20000);
  const tab = done ? await p.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), TAB) : "";
  return { done, lines: (tab.match(/[✓✗–] [^✓✗–]+/g) || []).map(l => l.trim()) };
}

// --- 1. Logged in through Access: the login page, then the wiki; nothing in the dropdown -------------
const contextA = await browser.newContext();
const A = await open(contextA, "A");
check("a tab without a session is sent to the login page, on another origin", A.url().startsWith(LOGIN + "/cdn-cgi/access/login/"), A.url());
await login(A);
check("...logged in, the wiki opens on the admin site, behind Access", A.url().startsWith(FRONT + "/") && await A.evaluate(() => !!$tw.syncer), A.url());
await waitFor(() => A.evaluate(() => !!navigator.serviceWorker.controller), 15000);
await waitFor(async () => !!(await site.bucket.head("_page/shell.html")), 30000);   // (the first load publishes the core file and the page)
await addTiddler(A, { title: "Note A", text: "saved while logged in" });
await settle(A);
const s1 = await status(A), l1 = await line(A);
check("a save goes through; the dropdown says nothing of the outbox; the status says the login stands", (await stored("Note A")) === "saved while logged in" && l1 === "" && s1?.waiting === "0" && s1?.login === "ok", `${JSON.stringify(s1)} ${JSON.stringify(l1)}`);
check("...the service worker is in place, and Access wasn't asked anything", await A.evaluate(() => !!navigator.serviceWorker.controller) && probes.length === 0, `${probes.length} probes`);
const setup1 = await setupCheck(A);
check("\"Check the setup\" runs, through Access: its Access line is fine", setup1.done && setup1.lines.some(l => /^✓ .*Access/.test(l)), setup1.lines.join(" | ") || `done ${setup1.done}`);
await pollEvery(A, 1000);

// --- 2. The session expires: the list goes on from the cache, one probe, the dropdown's words --------
expire();
let probesMark = probes.length, refusedMark = refused.length, listMark = listAnswers.length;
await waitFor(() => refused.length > refusedMark, 10000);   // (the first request Access turns away)
await sleep(300);                                            // (one that had passed it before can still land)
let mark = arrived.length;
const noticed = await waitFor(() => loginIs(A, "expired"), 15000);
const s2 = await status(A), l2 = await line(A), a2 = await alerts(A);
check("the next list poll is redirected to the login page, which the browser blocks; the service worker answers it from its cache; nothing reached the worker",
  since(refused, refusedMark).some(r => r.path === "/recipes/default/tiddlers.json") && since(listAnswers, listMark).some(a => a.tag === "A" && a.fromCache) && arrived.length === mark,
  `refused ${since(refused, refusedMark).map(r => r.method + " " + r.path).join(", ")}; lists ${JSON.stringify(since(listAnswers, listMark))}; arrived ${arrived.length - mark}`);
check("...the tab asked Access once whether the session stands, and was told it doesn't (400, \"no app token set\")", since(probes, probesMark).length === 1 && probes[probesMark]?.status === 400, JSON.stringify(since(probes, probesMark)));
check("...and, nothing waiting, the dropdown says the login has expired and to log in again, not \"offline\"; no alert",
  noticed && s2?.online === "yes" && s2?.waiting === "0" && /login has expired/i.test(l2 || "") && /log in again/i.test(l2 || "") && !/offline/i.test(l2 || "") && a2.length === 0,
  `${JSON.stringify(s2)} ${JSON.stringify(l2)} alerts ${JSON.stringify(a2)}`);
await sleep(2500);
check("...the polls go on from the cache, and Access isn't asked again while the login is known to have expired", since(probes, probesMark).length === 1 && since(listAnswers, listMark).filter(a => a.tag === "A" && a.fromCache).length >= 2, `${since(probes, probesMark).length} probes, ${since(listAnswers, listMark).filter(a => a.fromCache).length} cached lists`);

// --- 3. A change made meanwhile: kept on the device, retried by TiddlyWiki, the dropdown's words ------
mark = arrived.length; refusedMark = refused.length;
await addTiddler(A, { title: "Expired note", text: "typed after the session ended" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
await waitFor(() => since(refused, refusedMark).filter(r => r.method === "PUT").length >= 2, 10000);   // (the save, and a retry: 1 s apart in the tests)
const s3 = await status(A), l3 = await line(A), a3 = await alerts(A), o3 = await outbox(A);
check("a change made then: its save is redirected like the rest and ends with no answer; TiddlyWiki retries it; nothing reaches the worker",
  since(refused, refusedMark).filter(r => r.method === "PUT").length >= 2 && arrived.length === mark, `${since(refused, refusedMark).filter(r => r.method === "PUT").length} PUTs refused, ${arrived.length - mark} arrived`);
check("...the dropdown says 1 change waiting since when, the login expired, kept on this device until the login; not \"offline\"; no network alert",
  s3?.waiting === "1" && s3?.login === "expired" && /1 change waiting since \d\d:\d\d/.test(l3 || "") && /login has expired/i.test(l3 || "") && /this device/.test(l3 || "") && !/offline/i.test(l3 || "") && a3.length === 0,
  `${JSON.stringify(s3)} ${JSON.stringify(l3)} alerts ${JSON.stringify(a3)}`);
check("...the change is on the device", Array.isArray(o3) && o3.some(e => e.title === "Expired note" && e.kind === "save"), JSON.stringify(o3));
check("...and Access wasn't asked again at each retry", since(probes, probesMark).length === 1, `${since(probes, probesMark).length} probes`);

// --- 4. A login in another tab: this tab's own retry goes through, the item goes, the next list is real
const B = await open(contextA, "B");
check("another tab of this browser opened on the wiki gets the login page", B.url().startsWith(LOGIN), B.url());
const loginAt = Date.now();
await login(B);
const sent = await waitFor(async () => (await stored("Expired note")) === "typed after the session ended", 10000);
const took = (Date.now() - loginAt) / 1000;
await waitFor(async () => { const s = await status(A); return s?.waiting === "0" && s?.login === "ok"; }, 10000);
const s4 = await status(A), l4 = await line(A), o4 = await outbox(A);
check("logged in there, the first tab's own retry goes through within a retry interval, with no reload", sent && took < 6, `${took.toFixed(1)} s`);
check("...the item is gone, nothing waits, the login stands, the device's outbox is empty", l4 === "" && s4?.waiting === "0" && s4?.login === "ok" && s4?.online === "yes" && JSON.stringify(o4) === "[]", `${JSON.stringify(s4)} ${JSON.stringify(l4)} ${JSON.stringify(o4)}`);
const realList = await waitFor(() => listAnswers.some(a => a.tag === "A" && !a.fromCache && a.at > loginAt), 10000);
check("...and the next list is the worker's, not the cache's", realList, JSON.stringify(listAnswers.filter(a => a.at > loginAt)));
check("...the second tab left the first tab's change to it (no copy, no conflict)", (await alerts(B)).length === 0 && (await stored("Expired note")) === "typed after the session ended", JSON.stringify(await alerts(B)));
await B.close();

// --- 5. Expired again, before the tab has noticed: "Check the setup" says why, and tells the tab ------
await pollEvery(A, 600000);   // (no poll for a while: nothing tells the tab by itself)
await sleep(1500);
expire();
await sleep(500);
probesMark = probes.length;
check("the session expired, no poll since: the tab still takes the login to stand, nothing in the dropdown", await loginIs(A, "ok") && (await line(A)) === "", `${JSON.stringify(await status(A))} ${JSON.stringify(await line(A))}`);
const setup5 = await setupCheck(A);
check("\"Check the setup\" gets no answer (its request sent to the login page): the tab asks Access once and the line says the login has expired, naming the operating guide's section, not that the worker is down",
  setup5.done && setup5.lines.some(l => /^✗ .*login has expired/i.test(l) && /operating 3\.14/.test(l)) && !setup5.lines.some(l => /^✗/.test(l) && /no network/i.test(l)) && since(probes, probesMark).length === 1,
  `${setup5.lines.join(" | ")}; ${since(probes, probesMark).length} probes`);
check("...and the dropdown says so from then on", await loginIs(A, "expired") && /login has expired/i.test((await line(A)) || ""), JSON.stringify(await line(A)));
await pollEvery(A, 1000);

// --- A reload instead: the login page, then the wiki with the change sent ------------------------------
await addTiddler(A, { title: "Reload note", text: "typed before the reload" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
check("a change waiting, the dropdown says so", await waitFor(async () => /login has expired/i.test((await line(A)) || ""), 10000), JSON.stringify(await line(A)));
await A.reload();
check("a reload shows the login page: the page is asked from the network first, and the service worker never shows the cached wiki in its place", A.url().startsWith(LOGIN), A.url());
await login(A);
const replayed = await waitFor(async () => (await stored("Reload note")) === "typed before the reload", 15000);
await waitFor(async () => (await status(A))?.waiting === "0", 10000);
check("...logged in, the wiki is back and the change kept on the device is sent", replayed && (await status(A))?.waiting === "0" && (await line(A)) === "" && (await status(A))?.login === "ok", `${JSON.stringify(await status(A))} ${JSON.stringify(await line(A))}`);
await pollEvery(A, 1000);

// --- 6. The network gone instead: "offline", as today ---------------------------------------------------
// (The proxy taken down: nothing answers, Access's path included, as with no network; the browser's
// offline mode wouldn't cut the service worker's own requests)
proxy.closeAllConnections();
await new Promise(resolve => proxy.close(resolve));
const wentOffline = await waitFor(async () => (await status(A))?.online === "no", 15000);
const s6 = await status(A);
check("no network: the probe gets no answer either, the status says offline and the login stands; nothing in the dropdown while nothing waits", wentOffline && s6?.online === "no" && s6?.login === "ok" && (await line(A)) === "", `${JSON.stringify(s6)} ${JSON.stringify(await line(A))}`);
const setup6 = await setupCheck(A);
check("...\"Check the setup\" then says the worker didn't answer, no network, and nothing of the login", setup6.done && setup6.lines.some(l => /^✗ .*didn't answer/.test(l) && /no network/i.test(l)) && !setup6.lines.some(l => /login/i.test(l)), setup6.lines.join(" | "));
await addTiddler(A, { title: "Offline note", text: "typed with the network gone" });
await waitFor(async () => (await status(A))?.waiting === "1", 10000);
const l6 = await line(A);
check("...a change made: the dropdown says offline, kept on this device, as it always did, nothing of the login", /offline/.test(l6 || "") && /this device/.test(l6 || "") && !/login/i.test(l6 || ""), JSON.stringify(l6));
await new Promise(resolve => proxy.listen(PORT, "127.0.0.1", resolve));
const back = await waitFor(async () => (await stored("Offline note")) === "typed with the network gone", 15000);
await waitFor(async () => (await status(A))?.waiting === "0", 10000);
check("the network back: the change is sent at the next retry, nothing waits, the status says online", back && (await status(A))?.waiting === "0" && (await status(A))?.online === "yes", JSON.stringify(await status(A)));

await finish({ check, results, pageErrors, browser, site, cleanup: () => { proxy.close(); loginServer.close(); } });
