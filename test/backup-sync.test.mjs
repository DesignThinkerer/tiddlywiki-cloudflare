// The full backup from the admin wiki (design 1.7): the control panel's Cloudflare tab, the hint when
// backups are on and none has run, the button that starts one, the progress the tab shows, GitHub
// ending up with every tiddler; and the tab asking GitHub for the newest release when shown (design
// 1.17); a real TiddlyWiki in Chromium, the worker with its queue, GitHub imitated.
// Run: npm run test:sync
import crypto from "node:crypto";
import { createChecks, createWatcher, finish, launchBrowser, readWikiFile, releases, RELEASES_PATH, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

// ---- GitHub, imitated: the Contents API and the tree ------------------------------------------------
const blobSha = buf => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const files = new Map();   // decoded path -> { sha, text }
const commits = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
async function fakeGitHub(req) {
  const url = new URL(req.url);
  if (req.headers.get("authorization") !== "Bearer ghtoken") return json({ message: "Bad credentials" }, 401);
  if (req.method === "GET" && url.pathname === "/repos/o/r/git/trees/main") {
    return json({ sha: "t", truncated: false, tree: [...files].map(([path, f]) => ({ path, type: "blob", sha: f.sha })) });
  }
  const m = url.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
  if (!m) return json({ message: "unexpected " + url.pathname }, 400);
  const path = decodeURIComponent(m[1]), file = files.get(path);
  if (req.method === "GET") return file ? json({ sha: file.sha, encoding: "base64", content: Buffer.from(file.text).toString("base64") }) : json({ message: "Not Found" }, 404);
  const body = await req.json();
  if (req.method === "PUT") {
    if (file && body.sha !== file.sha) return json({ message: "sha mismatch" }, 409);
    const buf = Buffer.from(body.content, "base64");
    files.set(path, { sha: blobSha(buf), text: buf.toString("utf8") });
    commits.push({ message: body.message, path });
    return json({ content: { sha: files.get(path).sha } }, file ? 200 : 201);
  }
  if (req.method === "DELETE") {
    if (!file) return json({ message: "Not Found" }, 404);
    files.delete(path);
    commits.push({ message: body.message, path, deleted: true });
    return json({});
  }
  return json({}, 405);
}

const site = await startSite({
  index: readWikiFile(), publicStatus: true, queue: true,
  bindings: { GITHUB_REPO: "o/r", GITHUB_TOKEN: "ghtoken", BACKUP_RETRY_SECONDS: "1" },
  outbound: async req => req.url.startsWith("https://api.github.com/") ? fakeGitHub(req) : new Response('{"success":true}')
});
const { base, pub: PUB, bucket } = site;
const { check, results } = createChecks();
const { requests, pageErrors, watch } = createWatcher(site);
const browser = await launchBrowser();
const context = await browser.newContext();

const TAB = "$:/temp/cfworker/ControlPanel", STATUS = "$:/temp/cfworker/backup-status", HINT = "$:/temp/cfworker/backup-hint", MESSAGE = "$:/temp/cfworker/backup-sync-message";
const field = (page, title, name) => page.evaluate(([t, n]) => { const x = $tw.wiki.getTiddler(t); return x ? x.fields[n] : undefined; }, [title, name]);
const exists = (page, title) => page.evaluate(t => $tw.wiki.tiddlerExists(t), title);
const tabText = page => page.evaluate(t => $tw.wiki.renderTiddler("text/plain", t), TAB);
const press = (page, message) => page.evaluate(m => { $tw.rootWidget.dispatchEvent({ type: m }); }, message);
async function openTab(url, tag) {
  const page = await context.newPage();
  await watch(page, tag);
  page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
  return page;
}

// Content that predates the backup: stored tiddlers the worker never backed up (put in the bucket
// directly, as a wiki had them before GITHUB_REPO and GITHUB_TOKEN were set), listed
const predating = new Map();
const entries = [];
for (let i = 1; i <= 12; i++) {
  const title = i === 12 ? "Old with/slash" : `Old ${String(i).padStart(2, "0")}`, revision = String(1700000000000 + i);
  const body = `{"title":${JSON.stringify(title)},"type":"text/vnd.tiddlywiki","tags":["old"],"text":${JSON.stringify("old text " + i)},"revision":"${revision}","bag":"default","recipe":"default"}`;
  await bucket.put(`recipes/default/tiddlers/${title}`, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { revision, layout: "flat" } });
  predating.set(title, body);
  entries.push({ title, revision, bag: "default", recipe: "default", type: "text/vnd.tiddlywiki", tags: ["old"] });
}
await bucket.put("recipes/default/tiddlers.json", JSON.stringify(entries));
files.set("tiddlers/Gone.json", { sha: blobSha(Buffer.from("gone")), text: "gone" });   // on GitHub, not in the wiki

// 1. The admin wiki: the tab, the status, the hint
const A = await openTab(base + "/", "A");
const tab = await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); return x ? { caption: x.fields.caption, tags: x.fields.tags, listed: $tw.wiki.filterTiddlers("[all[shadows+tiddlers]tag[$:/tags/ControlPanel/Saving]]").includes(t) } : null; }, TAB);
check("the admin wiki has a Cloudflare tab under the control panel's Saving tab", tab?.caption === "Cloudflare" && (tab.tags || []).includes("$:/tags/ControlPanel/Saving") && tab.listed, JSON.stringify(tab));
let text = await tabText(A);
check("...that says backups are on, no full backup yet, with the button", (await field(A, STATUS, "backups")) === "on" && /committed to GitHub as it happens/.test(text) && /No full backup yet/.test(text) && /Back up everything to GitHub/.test(text), text.slice(0, 300));
// (The section sits in a <$list> widget: without a blank line after its opening tag, TiddlyWiki
// parses it inline, and the heading showed as "!!! Full backup" in the text)
const tabHtml = await A.evaluate(t => $tw.wiki.renderTiddler("text/html", t), TAB);
check("...its Full backup heading rendered as a heading, its sentences as paragraphs", /<h3[^>]*>Full backup<\/h3>/.test(tabHtml) && !/!!!/.test(text) && /<p>A full backup makes GitHub mirror the wiki/.test(tabHtml),
  (tabHtml.match(/.{0,60}Full backup.{0,60}/) || [])[0]);
await A.waitForFunction(t => $tw.wiki.tiddlerExists(t), HINT, { timeout: 10000 }).catch(() => {});
const hint = await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); return x ? { tags: x.fields.tags, text: x.fields.text } : null; }, HINT);
check("backups on and no full backup ever: an alert says tiddlers saved before aren't on GitHub, and where the button is",
  !!hint && (hint.tags || []).includes("$:/tags/Alert") && /full backup/.test(hint.text) && /Cloudflare/.test(hint.text), JSON.stringify(hint));
// Closing the alert is remembered on the device: a reload doesn't bring it back
// The module's own removal of the hint (backups reported off) isn't the user closing it: on again,
// with no full backup still, the hint is back
await A.evaluate(() => $tw.syncadaptor.cfworkerNoteBackupStatus({ backups: "off", problem: null, stuck: null, sync: null }));
await sleep(200);
const goneWhenOff = !(await exists(A, HINT));
await A.evaluate(() => $tw.syncadaptor.cfworkerNoteBackupStatus({ backups: "on", problem: null, stuck: null, sync: null }));
await sleep(200);
check("...the hint goes when backups are reported off, and is back when they're on again: the module's own removal isn't a closing",
  goneWhenOff && (await exists(A, HINT)), `gone when off ${goneWhenOff}, back ${await exists(A, HINT)}`);
// While backups fail, the tab says so in place of "every save is committed", from the same answer the
// alert comes from, and the hint waits; a full backup's answer, which says nothing of problems, leaves
// the lines as they are; the worker reporting none brings the sentence and the hint back
const failingSince = Date.now() - 3 * 3600 * 1000, nextTry = Date.now() + 2 * 3600 * 1000;
await A.evaluate(([since, next]) => $tw.syncadaptor.cfworkerNoteBackupStatus({ backups: "on", problem: { count: 2, title: "Old 01", since, error: "Bad credentials", status: 401, next }, stuck: null, sync: null }), [failingSince, nextTry]);
await sleep(200);
text = await tabText(A);
const nextTryText = await A.evaluate(ms => $tw.utils.formatDateString(new Date(ms), "DDth MMM YYYY 0hh:0mm"), nextTry);
check("backups failing: the tab says since when, how many, the oldest, GitHub's answer, what to do and the next try, in place of \"every save is committed\", and the hint waits",
  /Backups to GitHub have been failing since/.test(text) && /2 tiddlers/.test(text) && /Old 01/.test(text) && /Bad credentials/.test(text) && /GITHUB_TOKEN/.test(text) &&
  text.includes("Next try: " + nextTryText) && /sends the current versions now/.test(text) && !/committed to GitHub as it happens/.test(text) && !(await exists(A, HINT)), text.slice(0, 600));
await A.evaluate(() => $tw.syncadaptor.cfworkerNoteBackupStatus({ backups: "on", sync: null }));
await sleep(200);
text = await tabText(A);
check("...a full backup's answer, which says nothing of problems, leaves the lines as they are", /Backups to GitHub have been failing since/.test(text) && !/committed to GitHub as it happens/.test(text) && !(await exists(A, HINT)), text.slice(0, 300));
await A.evaluate(() => $tw.syncadaptor.cfworkerNoteBackupStatus({ backups: "on", problem: null, stuck: null, sync: null }));
await sleep(200);
text = await tabText(A);
check("...and once the worker reports none, \"every save is committed\" and the hint are back", /committed to GitHub as it happens/.test(text) && !/have been failing/.test(text) && (await exists(A, HINT)), text.slice(0, 300));
await A.evaluate(t => $tw.wiki.deleteTiddler(t), HINT);
await A.reload();
await A.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
await settle(A);
check("...closed, it stays closed in this browser after a reload", (await field(A, STATUS, "backups")) === "on" && !(await exists(A, HINT)));

// 2. The button: the full backup runs in the queue, the tab follows it, GitHub ends up with everything
await press(A, "tm-cfworker-backup-sync");
const started = (await waitFor(async () => !!(await field(A, STATUS, "sync-id")), 10000)) ? await field(A, STATUS, "sync-phase") : null;
const runningText = await tabText(A);
check("the button starts a full backup: the tab shows it running, with the total", !!started && (await field(A, STATUS, "sync-total")) === String(entries.length) && (/Running:/.test(runningText) || !!(await field(A, STATUS, "sync-finished"))), `phase ${started}: ${runningText.slice(0, 200)}`);
// (Refresh asks the worker; a tab left alone learns from its minute's list request)
const finished = await waitFor(async () => { await press(A, "tm-cfworker-backup-status"); await settle(A); return !!(await field(A, STATUS, "sync-finished")); }, 60000);
text = await tabText(A);
const allThere = [...predating].every(([title, body]) => files.get(`tiddlers/${title}.json`)?.text === body);
check("...it finishes: every tiddler is on GitHub, byte for byte, the file of a title not in the wiki removed, and the tab says so, counting the tiddlers not backed up (refused by GitHub, or too big to back up)",
  finished && allThere && !files.has("tiddlers/Gone.json") && /Last full backup:/.test(text) && new RegExp(`${entries.length} committed, 1 removed, 0 not backed up \\(refused by GitHub, or too big`).test(text), `finished ${finished}, all there ${allThere}: ${text.slice(0, 300)}`);
check("...the hint is gone for good", !(await exists(A, HINT)));
// A second run changes nothing
const commitsBefore = commits.length;
await press(A, "tm-cfworker-backup-sync");
await waitFor(async () => { await press(A, "tm-cfworker-backup-status"); await settle(A); return !!(await field(A, STATUS, "sync-finished")) && (await field(A, STATUS, "sync-committed")) === "0"; }, 60000);
text = await tabText(A);
check("a second full backup commits nothing and removes nothing", commits.length === commitsBefore && /0 committed, 0 removed/.test(text), text.slice(0, 200));
// The ordinary backup still runs: a save made now is committed by itself
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), { title: "Saved after", text: "committed by its own message" }, $tw.wiki.getModificationFields())));
await settle(A);
check("a save after that is committed by its own backup message", await waitFor(async () => files.has("tiddlers/Saved after.json"), 20000));

// A step's error while a full backup runs, as the worker reports it in the status, is shown in the
// tab as text, the step tried again by itself
await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); $tw.wiki.addTiddler(new $tw.Tiddler(x, { "sync-running": "yes", "sync-error": "GitHub answered 502: <bad gateway> {{not wikitext}}" })); }, STATUS);
text = await tabText(A);
check("a step's error while a full backup runs is shown in the tab, as text, the step tried again by itself",
  /Running:/.test(text) && /didn't go through/.test(text) && /tried again by itself/.test(text) && text.includes("GitHub answered 502: <bad gateway> {{not wikitext}}"),
  text.replace(/\s+/g, " ").slice(text.indexOf("didn't go through") - 20, text.indexOf("didn't go through") + 160));
await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); const f = { ...x.fields, "sync-running": "no" }; delete f["sync-error"]; $tw.wiki.addTiddler(new $tw.Tiddler(f)); }, STATUS);
// The states the worker records that aren't a run: a full backup the queue refused (finished at once,
// with the error), one whose steps were lost (no progress for 8 hours, unfinished), and one running
// when the button is pressed again (409). Each written to the status file as the worker writes it,
// and read by Refresh (GET) or by the button (POST).
const STATUS_KEY = "_backup/status.json";
const statusBefore = await (await bucket.get(STATUS_KEY))?.text();
const putSync = sync => bucket.put(STATUS_KEY, JSON.stringify({ failing: {}, sync }), { httpMetadata: { contentType: "application/json" } });
const refreshed = async id => { await press(A, "tm-cfworker-backup-status"); return waitFor(async () => (await field(A, STATUS, "sync-id")) === id, 10000); };
const message = () => A.evaluate(t => $tw.wiki.getTiddlerText(t, ""), MESSAGE);
const fromFullBackup = t => t.replace(/\s+/g, " ").replace(/^.*?Full backup/, "Full backup").slice(0, 400);
const now = Date.now();
await putSync({ id: "refused-1", startedAt: now, updatedAt: now, finished: now, phase: "push", total: 12, done: 0, committed: 0, removed: 0, failed: 0, steps: 0, error: "The queue didn't take the job: boom" });
const refusedSeen = await refreshed("refused-1");
text = await tabText(A);
check("a full backup the queue refused (recorded finished at once, with the error): the tab says it didn't go through and to start it again, not that it ran or is tried again",
  refusedSeen && /didn't go through: The queue didn't take the job: boom/.test(text) && /[Ss]tart it again/.test(text) && !/Last full backup:/.test(text) && !/tried again by itself/.test(text) && !/Running:/.test(text),
  fromFullBackup(text));
await putSync({ id: "lost-1", startedAt: now - 9 * 3600 * 1000, updatedAt: now - 9 * 3600 * 1000, phase: "push", total: 12, done: 3, committed: 2, removed: 0, failed: 0, steps: 1, error: "GitHub answered 502" });
const lostSeen = await refreshed("lost-1");
text = await tabText(A);
check("...one whose steps were lost (no progress for 8 hours): stopped without finishing, its last error shown, to start again, not tried again",
  lostSeen && /stopped without finishing/.test(text) && /GitHub answered 502/.test(text) && /[Ss]tart it again/.test(text) && !/tried again by itself/.test(text) && !/Last full backup:/.test(text),
  fromFullBackup(text));
await putSync({ id: "running-1", startedAt: now, updatedAt: now, phase: "push", total: 12, done: 1, committed: 1, removed: 0, failed: 0, steps: 1 });
await press(A, "tm-cfworker-backup-sync");
const saidRunning = await waitFor(async () => /already running/.test(await message()), 10000);
text = await tabText(A);
check("...the button pressed while one runs: the worker refuses (409), the tab says one is already running and shows it running",
  saidRunning && (await field(A, STATUS, "sync-id")) === "running-1" && (await field(A, STATUS, "sync-running")) === "yes" && /Running:/.test(text), `${JSON.stringify(await message())}: ${fromFullBackup(text).slice(0, 200)}`);
// An answer that isn't the worker's own text (an error page from the edge, say) shows as text, not as markup
await A.route(/\/backup\/sync$/, route => route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "text/html", body: "<b>an error page</b>" }) : route.continue());
await press(A, "tm-cfworker-backup-sync");
const saidError = await waitFor(async () => /500/.test(await message()), 10000);
await A.unroute(/\/backup\/sync$/);
text = await tabText(A);
check("an answer that isn't the worker's own text (an error page) shows as text in the tab's message, not as markup",
  saidError && text.includes("The worker answered 500: <b>an error page</b>"), text.replace(/\s+/g, " ").replace(/^.*?The worker answered/, "The worker answered").slice(0, 120));
// The status file as the real runs left it
if (statusBefore) {
  await bucket.put(STATUS_KEY, statusBefore, { httpMetadata: { contentType: "application/json" } });
  await refreshed((JSON.parse(statusBefore).sync || {}).id);
}

// 3. The public site has no tab (read-only, no worker behind it)
const P = await openTab(PUB + "/", "P");
check("the public site has no Cloudflare tab, no hint", !(await exists(P, TAB)) && !(await exists(P, HINT)));
await P.close();

// 4. A worker without backups: the tab says so, no button
const off = await startSite({ index: readWikiFile(), publicStatus: true, outbound: async () => new Response('{"success":true}') });
const B = await (async () => {
  const page = await context.newPage();
  await page.goto(off.base + "/");
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
  return page;
})();
text = await tabText(B);
check("a worker without GITHUB_REPO and GITHUB_TOKEN: the tab says backups are off, names them, says what the wiki lacks without them (a history), shows no button, no hint",
  (await field(B, STATUS, "backups")) === "off" && /Backups are off/.test(text) && /GITHUB_REPO/.test(text) && /the wiki's only history/.test(text) && !/Back up everything/.test(text) && !(await exists(B, HINT)), text.slice(0, 300));
await B.close();
await off.close();

// 5. The worker's release (design 1.17): when the tab is shown, the browser asks GitHub's releases API
// for this repository's newest release, at most once a day per browser, and the tab says whether a
// newer one is out, with the link to its notes and to operating 3.1. GitHub is the harness's stand-in
// (the page pointed at it before boot; this repository's version unless told otherwise), answering as
// each scenario says; a fresh browser context per scenario: nothing remembered from the one before.
const RELEASE = "$:/temp/cfworker/release", RELEASES_API = releases.url + RELEASES_PATH, CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const pluginVersion = await A.evaluate(() => { const p = $tw.wiki.getTiddler("$:/plugins/cfworker/admin"); return p ? p.fields.version : ""; });
const [WORKER_VERSION, BUILD] = String(pluginVersion).split("+");
const release = tag => ({ tag_name: tag, name: tag.slice(1), html_url: `https://github.com/DesignThinkerer/tiddlywiki-cloudflare/releases/tag/${tag}` });
const answering = tag => (req, res) => { res.writeHead(200, CORS); res.end(JSON.stringify(release(tag))); };
async function releaseContext(name, answer) {
  releases.answer = answer;
  const from = releases.asked.length, asked = () => releases.asked.slice(from);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await watch(page, name);
  await page.goto(base + "/");
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
  await settle(page);
  return { ctx, page, asked };
}
const showTab = page => page.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), TAB);   // (rendering the tab is showing it)
const tabAsHtml = page => page.evaluate(t => $tw.wiki.renderTiddler("text/html", t), TAB);
const stateOf = page => field(page, RELEASE, "state");
// The line alone, rendered without the tab: showing the tab after a failure asks GitHub again at once
const lineText = page => page.evaluate(t => $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " "), RELEASE);
const workerSection = t => t.replace(/^.*?The worker/, "The worker").replace(/The engine.*$/, "").slice(0, 400);

// 5a. A newer release, the tab opened as a reader opens it
const newer = await releaseContext("newer", answering("v2026.12.01"));
check("nothing is asked of GitHub at page load: the newest release is asked for when the tab is shown", newer.asked().length === 0 && (await stateOf(newer.page)) === undefined, `${newer.asked().length} requests, state ${await stateOf(newer.page)}`);
await newer.page.evaluate(() => new $tw.Story().navigateTiddler("$:/ControlPanel"));
await newer.page.locator('button[role="tab"][data-tab-title="$:/core/ui/ControlPanel/Saving"]').first().click();
await newer.page.locator('button[role="tab"]', { hasText: /^Cloudflare$/ }).first().click();
const announced = await waitFor(async () => (await stateOf(newer.page)) === "newer", 10000);
let rText = await showTab(newer.page), rHtml = await tabAsHtml(newer.page);
check("the tab shows the worker's version and build and, opened, asks GitHub for the newest release once: a newer one is announced with its date, the link to its notes and to operating 3.1",
  announced && newer.asked().length === 1 && rText.includes(`Version ${WORKER_VERSION} (build ${BUILD})`) && /A newer release is out: 2026\.12\.01/.test(rText) && /update your copy/.test(rText)
  && rHtml.includes("https://github.com/DesignThinkerer/tiddlywiki-cloudflare/releases/tag/v2026.12.01") && rHtml.includes("docs/operating.md#31-updating-your-copy"),
  `${newer.asked().length} requests, state ${await stateOf(newer.page)}, version ${pluginVersion}: ${workerSection(rText)}`);
const ask = newer.asked()[0];
check("...the request went from the browser to GitHub's releases API, no token, JSON asked for; nothing of it through the worker",
  !!ask && ask.path === RELEASES_PATH && ask.method === "GET" && !ask.headers.authorization && /application\/vnd\.github\+json/.test(ask.headers.accept || "")
  && requests.some(r => r.tag === "newer" && r.origin === "other" && r.url === RELEASES_API) && !requests.some(r => r.tag === "newer" && r.origin === "worker" && /release/i.test(r.path)),
  ask ? `${ask.method} ${ask.path} accept ${ask.headers.accept}` : "no request");
// 5b. Once a day: shown again, and after a reload, nothing more is asked; a day later it asks again
await showTab(newer.page);
await newer.page.reload();
await newer.page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer);
await settle(newer.page);
rText = await showTab(newer.page);
check("...shown again, and after a reload, nothing more is asked within a day: the answer is remembered on this device, the line still there",
  newer.asked().length === 1 && (await stateOf(newer.page)) === "newer" && /A newer release is out: 2026\.12\.01/.test(rText), `${newer.asked().length} requests, state ${await stateOf(newer.page)}: ${workerSection(rText)}`);
await newer.page.evaluate(() => { const k = "cfworker-release", r = JSON.parse(localStorage.getItem(k) || "{}"); r.at = (r.at || Date.now()) - 25 * 3600 * 1000; localStorage.setItem(k, JSON.stringify(r)); });
await showTab(newer.page);
check("...a day later, shown, it asks again", await waitFor(async () => newer.asked().length === 2, 10000), `${newer.asked().length} requests`);
await newer.ctx.close();

// 5c. The newest release being this worker's version
const same = await releaseContext("same", answering("v" + WORKER_VERSION));
await showTab(same.page);
const sameSeen = await waitFor(async () => (await stateOf(same.page)) === "same", 10000);
rText = await showTab(same.page);
check("the newest release being this worker's version: the line says so, with when it was checked, and nothing more is asked",
  sameSeen && same.asked().length === 1 && /This is the newest release/.test(rText) && /checked at \d\d:\d\d/.test(rText) && !/newer release is out/.test(rText), `${same.asked().length} requests: ${workerSection(rText)}`);
await same.ctx.close();

// 5d. A release older than this worker: a copy synced past it
const older = await releaseContext("older", answering("v2026.09.01"));
await showTab(older.page);
const aheadSeen = await waitFor(async () => (await stateOf(older.page)) === "ahead", 10000);
rText = await showTab(older.page);
check("a release older than this worker (a copy synced past it): said as newer than the newest release, no update offered",
  aheadSeen && /Newer than the newest release \(2026\.09\.01\)/.test(rText) && !/update your copy/.test(rText), workerSection(rText));
await older.ctx.close();

// 5e. GitHub not answering, then refusing: said with why, asked again at each showing, a good answer replacing the line
const down = await releaseContext("down", (req, res) => { res.socket.destroy(); });
await showTab(down.page);
const failedSeen = await waitFor(async () => (await stateOf(down.page)) === "failed", 10000);
rText = await lineText(down.page);
check("GitHub not answering: the line says it couldn't be asked, and why, and names the releases page",
  failedSeen && /couldn't be asked/.test(rText) && /no answer/.test(rText) && /releases page/.test(rText), rText.slice(0, 300));
releases.answer = (req, res) => { res.writeHead(403, CORS); res.end(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." })); };
const before403 = down.asked().length;
await showTab(down.page);
const refused403 = await waitFor(async () => /403/.test((await field(down.page, RELEASE, "error")) || ""), 10000);
rText = await lineText(down.page);
check("...shown again, it asks again (a failure isn't remembered for a day); GitHub refusing (403, the rate limit) is said in GitHub's words",
  refused403 && down.asked().length > before403 && /GitHub answered 403/.test(rText) && /rate limit exceeded/.test(rText), `${down.asked().length} requests: ${rText.slice(0, 300)}`);
releases.answer = answering("v2026.12.01");
await showTab(down.page);
const recovered = await waitFor(async () => (await stateOf(down.page)) === "newer", 10000);
rText = await showTab(down.page);
check("...a good answer at the next showing replaces the line", recovered && /A newer release is out: 2026\.12\.01/.test(rText) && !/couldn't be asked/.test(rText), workerSection(rText));
await down.ctx.close();
releases.answer = null;

await A.close();

await finish({ check, results, pageErrors, browser, site, note: `; ${commits.length} commits` });
