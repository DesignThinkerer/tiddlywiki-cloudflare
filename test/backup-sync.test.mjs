// The full backup from the admin wiki (design 1.7): the control panel's Cloudflare tab, the hint when
// backups are on and none has run, the button that starts one, the progress the tab shows, GitHub
// ending up with every tiddler; a real TiddlyWiki in Chromium, the worker with its queue, GitHub imitated.
// Run: npm run test:sync
import crypto from "node:crypto";
import { createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, startSite, waitFor } from "./browser-harness.mjs";

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

const TAB = "$:/temp/cfworker/ControlPanel", STATUS = "$:/temp/cfworker/backup-status", HINT = "$:/temp/cfworker/backup-hint";
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

// A step's error, as the worker reports it in the status, is shown in the tab as text
await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); $tw.wiki.addTiddler(new $tw.Tiddler(x, { "sync-error": "GitHub answered 502: <bad gateway> {{not wikitext}}" })); }, STATUS);
text = await tabText(A);
check("a full backup step's error is shown in the tab, as text", /didn't go through/.test(text) && text.includes("GitHub answered 502: <bad gateway> {{not wikitext}}"), text.replace(/\s+/g, " ").slice(text.indexOf("didn't go through") - 20, text.indexOf("didn't go through") + 160));
await A.evaluate(t => { const x = $tw.wiki.getTiddler(t); const f = { ...x.fields }; delete f["sync-error"]; $tw.wiki.addTiddler(new $tw.Tiddler(f)); }, STATUS);

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
