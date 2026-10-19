// The full backup from the admin wiki (design 1.7): the control panel's Cloudflare tab, the hint when
// backups are on and none has run, the button that starts one, the progress the tab shows, GitHub
// ending up with every tiddler; a real TiddlyWiki in Chromium, the worker with its queue, GitHub imitated.
// Run: npm run test:sync
import crypto from "node:crypto";
import { createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

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
const { pageErrors, watch } = createWatcher(site);
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
check("...it finishes: every tiddler is on GitHub, byte for byte, the file of a title not in the wiki removed, and the tab says so",
  finished && allThere && !files.has("tiddlers/Gone.json") && /Last full backup:/.test(text) && new RegExp(`${entries.length} committed, 1 removed, 0 refused`).test(text), `finished ${finished}, all there ${allThere}: ${text.slice(0, 300)}`);
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
check("a worker without GITHUB_REPO and GITHUB_TOKEN: the tab says backups are off, names them, shows no button, no hint",
  (await field(B, STATUS, "backups")) === "off" && /Backups are off/.test(text) && /GITHUB_REPO/.test(text) && !/Back up everything/.test(text) && !(await exists(B, HINT)), text.slice(0, 200));
await B.close();
await off.close();
await A.close();

await finish({ check, results, pageErrors, browser, site, note: `; ${commits.length} commits` });
