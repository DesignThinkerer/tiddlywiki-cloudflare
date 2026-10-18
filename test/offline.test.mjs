// Editing offline, with the page open (design 1.10): a real TiddlyWiki in Chromium, the network cut
// and restored. TiddlyWiki retries by itself; what the outbox module adds is that every change is
// kept on the device the moment it's made and sent at the next load if the tab didn't get to, the
// cloud icon's dropdown says what's waiting, and the network's return is acted on at once.
// Run: npm run test:offline
import { addTiddler, createChecks, createWatcher, finish, launchBrowser, readWikiFile, settle, sleep, startSite, waitFor } from "./browser-harness.mjs";

const site = await startSite({ index: readWikiFile(), privateWiki: true });
const { base: BASE, bucket } = site;
const { check, results } = createChecks();
const browser = await launchBrowser();
const { requests, pageErrors, watch } = createWatcher(site);
const STATUS = "$:/temp/cfworker/outbox", ITEM = "$:/temp/cfworker/outbox-status";
const TIDDLER = "/recipes/default/tiddlers/";

async function open(context, tag, path = "/") {
  const p = await context.newPage();
  await watch(p, tag);
  p.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`${tag} console: ${m.text()}`); });
  p.on("dialog", d => d.accept());   // the "unsaved changes" warning on reload or close
  await p.goto(BASE + path);
  await ready(p);
  return p;
}
async function ready(p) {
  await p.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(p);
}
const stored = async title => { const obj = await bucket.get(TIDDLER.slice(1) + title); return obj ? (await obj.json()).text : null; };
const revisionOf = async title => { const obj = await bucket.head(TIDDLER.slice(1) + title); return obj ? obj.customMetadata.revision : null; };
const status = p => p.evaluate(t => { const x = $tw.wiki.getTiddler(t); return x ? { waiting: x.fields.waiting, since: x.fields.since, online: x.fields.online } : null; }, STATUS);
// What the cloud icon's dropdown says about the outbox (its item, rendered)
const line = p => p.evaluate(t => $tw.wiki.tiddlerExists(t) && $tw.wiki.getTiddler(t).fields.tags.includes("$:/tags/SyncerDropdown") ? $tw.wiki.renderTiddler("text/plain", t).replace(/\s+/g, " ").trim() : null, ITEM);
const alerts = p => p.evaluate(() => $tw.wiki.getTiddlersWithTag("$:/tags/Alert").map(t => { const f = $tw.wiki.getTiddler(t).fields; return { component: f.component, text: String(f.text).slice(0, 60) }; }));
// What the device holds in its outbox: [{title, kind, base, fields}]
const outbox = p => p.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open("cfworker-tiddlers");
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("outbox")) { db.close(); return resolve(null); }
    const get = db.transaction("outbox").objectStore("outbox").getAll();
    get.onsuccess = () => { db.close(); resolve(get.result.map(e => ({ title: e.title, kind: e.kind, base: e.base, text: e.fields && e.fields.text }))); };
    get.onerror = () => { db.close(); resolve("error"); };
  };
  req.onerror = () => resolve("open error");
}));
const sent = (tag, method, title, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.origin === "worker" && r.method === method && r.path === TIDDLER + title);
const deletes = (tag, title, from = 0) => requests.slice(from).filter(r => r.tag === tag && r.origin === "worker" && r.method === "DELETE" && r.path.endsWith("/tiddlers/" + title));

// --- 1. Offline: a new tiddler, a change and a delete, retried by TiddlyWiki, shown and kept -------
const contextA = await browser.newContext();
const A = await open(contextA, "A");
await addTiddler(A, { title: "Note A", text: "online text" });
await addTiddler(A, { title: "Note B", text: "to be deleted offline" });
await settle(A);
const noteARevision = await revisionOf("Note A"), noteBRevision = await revisionOf("Note B");
check("online, nothing waits: the cloud icon's dropdown says nothing of the outbox, the device's outbox is empty", (await line(A)) === "" && JSON.stringify(await outbox(A)) === "[]", `item ${JSON.stringify(await line(A))}, outbox ${JSON.stringify(await outbox(A))}`);
// TiddlyWiki's own retry made slow, so that what happens when the network is back is the online event's doing
await A.evaluate(() => { $tw.syncer.errorRetryInterval = 20000; });
await contextA.setOffline(true);
let mark = requests.length;
await addTiddler(A, { title: "Offline 1", text: "written offline" });
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Note A"), { text: "changed offline" })));
await A.evaluate(() => $tw.wiki.deleteTiddler("Note B"));
await waitFor(async () => (await status(A))?.waiting === "3", 10000);
const s1 = await status(A), l1 = await line(A), a1 = await alerts(A);
check("offline, the cloud icon's dropdown says 3 changes are waiting since when, kept on this device, offline", s1?.waiting === "3" && s1?.online === "no" && /3 changes waiting since \d\d:\d\d/.test(l1 || "") && /offline/.test(l1 || "") && /this device/.test(l1 || ""), `${JSON.stringify(s1)} ${JSON.stringify(l1)}`);
// (TiddlyWiki's own "Network Error" alert isn't shown on the admin wiki: the red cloud icon and its dropdown say it, design 2.17)
check("...TiddlyWiki retried a save, and no alert is shown: the icon and the dropdown say offline (TiddlyWiki's network alert would come back at every retry)", sent("A", "PUT", "Offline 1", mark).length + sent("A", "PUT", "Note A", mark).length >= 1 && a1.length === 0, JSON.stringify(a1));
const o1 = await outbox(A);
const entry = title => (o1 || []).find(e => e.title === title);
check("...each change is on the device the moment it's made, with the revision it's based on",
  entry("Offline 1")?.kind === "save" && entry("Offline 1")?.base === null && entry("Offline 1")?.text === "written offline" &&
  entry("Note A")?.kind === "save" && entry("Note A")?.base === noteARevision && entry("Note A")?.text === "changed offline" &&
  entry("Note B")?.kind === "delete" && entry("Note B")?.base === noteBRevision && (o1 || []).length === 3,
  JSON.stringify(o1));

// --- 2. The network back: sent at once, the line gone -----------------------------------------------
const back = Date.now();
await contextA.setOffline(false);
const arrived = await waitFor(async () => (await stored("Offline 1")) === "written offline" && (await stored("Note A")) === "changed offline" && (await stored("Note B")) === null, 10000);
const took = (Date.now() - back) / 1000;
check("the network back: the three changes reach the worker at once (the online event, not the retry 20 s away)", arrived && took < 4, `${took.toFixed(1)} s`);
await settle(A);
await waitFor(async () => (await status(A))?.waiting === "0", 5000);
check("...the dropdown says nothing more, no alert, the device's outbox empty", (await line(A)) === "" && (await alerts(A)).length === 0 && JSON.stringify(await outbox(A)) === "[]" && (await status(A))?.online === "yes",
  `item ${JSON.stringify(await line(A))}, alerts ${(await alerts(A)).length}, outbox ${JSON.stringify(await outbox(A))}`);

// --- 3. A reload once the network is back: the changes come back from the device and are sent ------
await contextA.setOffline(true);
await addTiddler(A, { title: "Offline reload", text: "survives a reload" });
await A.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Note A"), { text: "changed twice" })));
await waitFor(async () => (await status(A))?.waiting === "2", 10000);
await sleep(800);   // (a retry, if one came, would come within this)
check("offline again: still no alert, the dropdown saying offline", (await alerts(A)).length === 0 && /offline/.test((await line(A)) || ""), `alerts ${JSON.stringify(await alerts(A))}, item ${JSON.stringify(await line(A))}`);
const noteARevision2 = await revisionOf("Note A");
await contextA.setOffline(false);
mark = requests.length;
await A.reload();
await ready(A);
const replayed = await waitFor(async () => (await stored("Offline reload")) === "survives a reload" && (await stored("Note A")) === "changed twice", 15000);
await settle(A);
const putNoteA = sent("A", "PUT", "Note A", mark)[0], putReload = sent("A", "PUT", "Offline reload", mark)[0];
check("a change made offline, the tab reloaded: it comes back from the device, is sent, stored and listed", replayed &&
  await A.evaluate(() => $tw.wiki.getTiddlerText("Offline reload") === "survives a reload" && $tw.wiki.getTiddlerText("Note A") === "changed twice") &&
  (await (await bucket.get("recipes/default/tiddlers.json")).json()).some(t => t.title === "Offline reload"));
check("...based on the revision it was made from (If-Match for the change, If-None-Match: * for the new tiddler)",
  !!putNoteA && (putNoteA.headers["if-match"] || "").includes(noteARevision2) && !!putReload && putReload.headers["if-none-match"] === "*",
  `${JSON.stringify(putNoteA?.headers["if-match"])} ${JSON.stringify(putReload?.headers["if-none-match"])}`);
await waitFor(async () => (await status(A))?.waiting === "0", 5000);
check("...and nothing waits any more", (await status(A))?.waiting === "0" && JSON.stringify(await outbox(A)) === "[]", JSON.stringify(await outbox(A)));

// --- 4. The tab closed while offline, a new one opened once the network is back --------------------
await contextA.setOffline(true);
await addTiddler(A, { title: "Offline closed", text: "the tab was closed" });
await waitFor(async () => ((await outbox(A)) || []).some(e => e.title === "Offline closed"), 10000);
await A.close({ runBeforeUnload: true });
await sleep(500);
await contextA.setOffline(false);
const A2 = await open(contextA, "A2");
const afterClose = await waitFor(async () => (await stored("Offline closed")) === "the tab was closed", 15000);
check("the tab closed while offline: a new tab sends what it had kept", afterClose && await A2.evaluate(() => $tw.wiki.getTiddlerText("Offline closed") === "the tab was closed"));

// --- 5. A delete made offline, then a reload: deleted on the worker, not brought back by the list ---
await contextA.setOffline(true);
await A2.evaluate(() => $tw.wiki.deleteTiddler("Offline 1"));
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === "Offline 1" && e.kind === "delete"), 10000);
const offline1Revision = await revisionOf("Offline 1");
await contextA.setOffline(false);
mark = requests.length;
await A2.reload();
await ready(A2);
const deleted = await waitFor(async () => (await stored("Offline 1")) === null, 15000);
await settle(A2);
const del = deletes("A2", "Offline 1", mark)[0];
check("a delete made offline, then a reload: deleted on the worker, with its revision checked, and gone from the wiki", deleted && !!del && (del.headers["if-match"] || "").includes(offline1Revision) &&
  await A2.evaluate(() => !$tw.wiki.tiddlerExists("Offline 1")) && !(await (await bucket.get("recipes/default/tiddlers.json")).json()).some(t => t.title === "Offline 1"),
  `${JSON.stringify(del?.headers["if-match"])}`);

// --- 6. Changed elsewhere while this browser was offline: a conflict copy, as online ----------------
await contextA.setOffline(true);
await A2.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Note A"), { text: "changed here, offline" })));
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === "Note A"), 10000);
const contextC = await browser.newContext();
const C = await open(contextC, "C");
await C.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler("Note A"), { text: "changed elsewhere" })));
await settle(C);
check("(another browser changed the tiddler meanwhile)", (await stored("Note A")) === "changed elsewhere");
await contextA.setOffline(false);
const copied = await waitFor(() => A2.evaluate(() => $tw.wiki.filterTiddlers("[conflict-of[Note A]]").length === 1), 15000);
await settle(A2);
check("back online, the change made offline gets a conflict copy and an alert; the other browser's version stays", copied &&
  await A2.evaluate(() => $tw.wiki.getTiddlerText($tw.wiki.filterTiddlers("[conflict-of[Note A]]")[0]) === "changed here, offline" && $tw.wiki.getTiddlerText("Note A") === "changed elsewhere" && $tw.wiki.getTiddlersWithTag("$:/tags/Alert").some(t => /conflict/i.test($tw.wiki.getTiddlerText(t)))) &&
  (await stored("Note A")) === "changed elsewhere");
await waitFor(async () => (await status(A2))?.waiting === "0", 5000);
check("...and nothing waits", (await status(A2))?.waiting === "0", JSON.stringify(await outbox(A2)));
await A2.evaluate(() => $tw.wiki.getTiddlersWithTag("$:/tags/Alert").forEach(t => $tw.wiki.deleteTiddler(t)));

// --- 7. A draft open while offline, then a reload: it comes back, and never reaches the worker ------
await contextA.setOffline(true);
const draftTitle = "Draft of 'Note A'";
await A2.evaluate(([title, draft]) => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(title), { title: draft, "draft.of": title, "draft.title": title, text: "typing offline, not saved yet" })), ["Note A", draftTitle]);
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === draftTitle && e.kind === "draft"), 10000);
check("a draft is kept on the device as a draft, and doesn't count as a change waiting", (await status(A2))?.waiting === "0" && (await line(A2)) === "", JSON.stringify(await status(A2)));
await contextA.setOffline(false);
await A2.reload();
await ready(A2);
await sleep(800);   // (a send, if one came, would come as the tab starts)
check("...after a reload it's back, with its text, and the worker never received it",
  await A2.evaluate(([draft]) => $tw.wiki.getTiddlerText(draft) === "typing offline, not saved yet" && $tw.wiki.getTiddler(draft).fields["draft.of"] === "Note A", [draftTitle]) &&
  requests.filter(r => r.method === "PUT" && r.path.includes("Draft")).length === 0 && !(await bucket.head(TIDDLER.slice(1) + draftTitle)));
await A2.evaluate(draft => $tw.wiki.deleteTiddler(draft), draftTitle);
await waitFor(async () => !((await outbox(A2)) || []).some(e => e.title === draftTitle), 5000);
check("...cancelled, it leaves the device", Array.isArray(await outbox(A2)) && !(await outbox(A2)).some(e => e.title === draftTitle), JSON.stringify(await outbox(A2)));

// --- 8. Two tabs in one browser, a change made offline: stored once, no copy, both tabs clear ------
const A3 = await open(contextA, "A3");
await contextA.setOffline(true);
await addTiddler(A2, { title: "Offline twice", text: "one change, two tabs" });
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === "Offline twice"), 10000);
await contextA.setOffline(false);
await A3.reload();
await ready(A3);
await waitFor(async () => (await stored("Offline twice")) === "one change, two tabs", 15000);
await settle(A2);
await settle(A3);
await waitFor(async () => (await status(A2))?.waiting === "0" && (await status(A3))?.waiting === "0", 10000);
check("two tabs, a change made offline in one, the other reloaded: stored once, no conflict copy, nothing waiting in either",
  (await stored("Offline twice")) === "one change, two tabs" && await A2.evaluate(() => $tw.wiki.filterTiddlers("[conflict-of[Offline twice]]").length === 0) &&
  (await status(A2))?.waiting === "0" && (await status(A3))?.waiting === "0" && JSON.stringify(await outbox(A2)) === "[]");
await A3.close();

// --- 9. A save the worker refuses (500) isn't "offline": TiddlyWiki's own error, the change kept ----
await A2.route("**/recipes/default/tiddlers/**", route => route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "boom" }) : route.continue());
await addTiddler(A2, { title: "Refused", text: "the worker said 500" });
await waitFor(async () => (await alerts(A2)).length > 0 && (await status(A2))?.waiting === "1", 10000);
const s9 = await status(A2), a9 = await alerts(A2);
check("a save refused with 500: the dropdown says 1 change waiting, sending (still online), TiddlyWiki's own error alert (not the network one), kept on the device",
  s9?.waiting === "1" && s9?.online === "yes" && /1 change waiting since/.test((await line(A2)) || "") && /sending/.test((await line(A2)) || "") && a9.length >= 1 && a9.every(a => a.component !== "syncer-browser-tiddlyweb-connection") && ((await outbox(A2)) || []).some(e => e.title === "Refused"),
  `${JSON.stringify(s9)} ${JSON.stringify(await line(A2))} ${JSON.stringify(a9)}`);
await A2.unroute("**/recipes/default/tiddlers/**");
await A2.evaluate(() => $tw.syncer.processTaskQueue());
const refusedStored = await waitFor(async () => (await stored("Refused")) === "the worker said 500", 25000);
await waitFor(async () => (await status(A2))?.waiting === "0", 5000);
check("...and goes through once the worker takes it, clearing the dropdown's item", refusedStored && (await status(A2))?.waiting === "0" && (await line(A2)) === "");

// --- 10. Another open tab holds a draft or a change: a tab opened meanwhile leaves it to that tab ---
await A2.evaluate(([title, draft]) => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(title), { title: draft, "draft.of": title, "draft.title": title, text: "still typing in the other tab" })), ["Note A", draftTitle]);
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === draftTitle && e.text === "still typing in the other tab"), 10000);
const A4 = await open(contextA, "A4");
const sharedInA4 = await waitFor(() => A4.evaluate(d => $tw.wiki.getTiddlerText(d) === "still typing in the other tab", draftTitle), 10000);
check("a tab opened while another tab is typing a draft shows the draft too: one draft for the browser (design 1.16), still in its tab, and on the device",
  sharedInA4 && await A2.evaluate(d => $tw.wiki.getTiddlerText(d) === "still typing in the other tab", draftTitle) && ((await outbox(A4)) || []).some(e => e.title === draftTitle),
  `in the new tab: ${JSON.stringify(await A4.evaluate(d => $tw.wiki.getTiddlerText(d, null), draftTitle))}`);
await A4.close();
const A4b = await open(contextA, "A4b", "/index.html");   // the same page at another path of the site
await waitFor(() => A4b.evaluate(d => $tw.wiki.tiddlerExists(d), draftTitle), 10000);
await A2.evaluate(d => $tw.wiki.setText(d, "text", null, "still typing, more"), draftTitle);   // (a keystroke in the first tab)
check("...so does one opened at another path of the site (/index.html), and it follows the typing: the tabs' channel is one per site, not per path",
  await waitFor(() => A4b.evaluate(d => $tw.wiki.getTiddlerText(d) === "still typing, more", draftTitle), 5000),
  `in the tab at /index.html: ${JSON.stringify(await A4b.evaluate(d => $tw.wiki.getTiddlerText(d, null), draftTitle))}`);
await A4b.close();
await waitFor(async () => ((await outbox(A2)) || []).some(e => e.title === draftTitle && e.text === "still typing, more"), 10000);   // (the device has the last keystroke after the pause)
await A2.close({ runBeforeUnload: true });   // the guard asks (the draft holds changes); accepted
await sleep(500);
const A5 = await open(contextA, "A5");
await waitFor(() => A5.evaluate(d => $tw.wiki.tiddlerExists(d), draftTitle), 10000);
check("...and once that tab is gone, the next tab gets the draft back", await A5.evaluate(d => $tw.wiki.getTiddlerText(d) === "still typing, more", draftTitle), JSON.stringify(await A5.evaluate(d => $tw.wiki.getTiddlerText(d, null), draftTitle)));
await A5.evaluate(d => $tw.wiki.deleteTiddler(d), draftTitle);
await A5.route("**/recipes/default/tiddlers/**", route => route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "boom" }) : route.continue());
await addTiddler(A5, { title: "Held change", text: "waiting in the first tab" });
await waitFor(async () => (await status(A5))?.waiting === "1", 10000);
mark = requests.length;
const A6 = await open(contextA, "A6");
await sleep(1000);   // (a send, if one came, would come as the tab starts)
check("a change an open tab is still trying to send isn't sent by a tab opened meanwhile", (await status(A6))?.waiting === "0" && sent("A6", "PUT", "Held change", mark).length === 0 && (await stored("Held change")) === null && ((await outbox(A6)) || []).some(e => e.title === "Held change"),
  `waiting ${(await status(A6))?.waiting}, sent by the new tab ${sent("A6", "PUT", "Held change", mark).length}, stored ${JSON.stringify(await stored("Held change"))}`);
await A5.unroute("**/recipes/default/tiddlers/**");
await A5.evaluate(() => $tw.syncer.processTaskQueue());
check("...the first tab sends it once the worker takes it", await waitFor(async () => (await stored("Held change")) === "waiting in the first tab", 25000));

// --- 11. The advanced setting: the pause before a draft is written to the device ---------------------
// ($:/config/cfworker/DraftPause, from the admin plugin's settings tab, read at each keystroke: no reload)
await A5.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/config/cfworker/DraftPause", text: "2500" })));
await settle(A5);
const slowDraft = "Draft of 'Slow draft'";
await A5.evaluate(t => $tw.wiki.addTiddler(new $tw.Tiddler({ title: t, "draft.of": "Slow draft", "draft.title": "Slow draft", text: "typed slowly" })), slowDraft);
await sleep(1200);
const early = ((await outbox(A5)) || []).some(e => e.title === slowDraft);
const late = await waitFor(async () => ((await outbox(A5)) || []).some(e => e.title === slowDraft), 6000);
check("the draft pause set to 2.5 s: a draft reaches the device after that pause, not after the default 300 ms", !early && late, `on the device at 1.2 s: ${early}, by 6 s: ${late}`);
await A5.evaluate(t => { $tw.wiki.deleteTiddler(t); $tw.wiki.deleteTiddler("$:/config/cfworker/DraftPause"); }, slowDraft);
await settle(A5);

// --- 12. A browser that refuses the write (no room, storage off): the dropdown doesn't promise -------
// The write to the device's outbox fails (every IndexedDB put throws, as a full quota does); the
// change is still sent at the network's return, but meanwhile the dropdown must say it isn't kept
// on this device, rather than promise it is.
const contextR = await browser.newContext();
await contextR.addInitScript(() => {
  IDBObjectStore.prototype.put = function() { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
});
const R = await open(contextR, "R");
await contextR.setOffline(true);
await addTiddler(R, { title: "Unkept change", text: "made offline, in a browser that refuses to store it" });
await waitFor(async () => (await status(R))?.waiting === "1", 10000);
const kept = await R.evaluate(t => $tw.wiki.getTiddler(t)?.fields.kept, STATUS);
const lineR = await line(R);
check("a change the device refused to store: the status says so, and the dropdown says it isn't kept on this device, to keep the tab open — rather than that it is",
  kept === "no" && /not kept on this device/.test(lineR || "") && /keep this tab open/i.test(lineR || "") && !/kept on this device until sent/.test(lineR || ""),
  `kept ${kept}: ${lineR}`);
await contextR.setOffline(false);
check("...and it still reaches the worker at the network's return", await waitFor(async () => (await stored("Unkept change")) === "made offline, in a browser that refuses to store it", 15000) && (await status(R))?.waiting === "0", JSON.stringify(await status(R)));
await contextR.close();

// --- 13. A tiddler created offline, the tab closed, the same title created elsewhere meanwhile -------
// The put-back at the next page load must say the tiddler mustn't exist yet (If-None-Match: *), as
// the tab that made the change would have: the other browser's version stays, and this one is kept
// as a conflict copy. (Section 3's header check can be met by the old page's own request, fired at
// the online event just before the reload; here the tab is closed first, so only the put-back sends.)
const contextP = await browser.newContext(), contextL = await browser.newContext();
const P = await open(contextP, "P");
await P.evaluate(() => { $tw.syncer.errorRetryInterval = 20000; });
await contextP.setOffline(true);
await addTiddler(P, { title: "Created on both", text: "written on the phone" });
await waitFor(async () => ((await outbox(P)) || []).some(e => e.title === "Created on both" && e.kind === "save"), 10000);
check("a tiddler created offline waits on the device with no base revision: the worker never had it", ((await outbox(P)) || []).some(e => e.title === "Created on both" && e.base === null), JSON.stringify(await outbox(P)));
await P.close({ runBeforeUnload: true });
await sleep(500);
const L = await open(contextL, "L");
await addTiddler(L, { title: "Created on both", text: "written on the laptop" });
await settle(L);
check("(another browser created the same title meanwhile)", (await stored("Created on both")) === "written on the laptop");
await contextP.setOffline(false);
mark = requests.length;
const P2 = await open(contextP, "P2");
const copiedP = await waitFor(() => P2.evaluate(() => $tw.wiki.filterTiddlers("[conflict-of[Created on both]]").length === 1), 15000);
await settle(P2);
const putBoth = sent("P2", "PUT", "Created on both", mark)[0];
check("the tab closed while offline, reopened online: the put-back says the tiddler mustn't exist yet (If-None-Match: *)",
  !!putBoth && putBoth.headers["if-none-match"] === "*" && !putBoth.headers["if-match"], JSON.stringify(putBoth?.headers || null));
check("...so the other browser's version stays, and the one made offline is kept as a conflict copy, with an alert", copiedP && (await stored("Created on both")) === "written on the laptop" &&
  await P2.evaluate(() => $tw.wiki.getTiddlerText("Created on both") === "written on the laptop" && $tw.wiki.getTiddlerText($tw.wiki.filterTiddlers("[conflict-of[Created on both]]")[0]) === "written on the phone" && $tw.wiki.getTiddlersWithTag("$:/tags/Alert").some(t => /conflict/i.test($tw.wiki.getTiddlerText(t)))),
  `stored ${JSON.stringify(await stored("Created on both"))}, copies ${JSON.stringify(await P2.evaluate(() => $tw.wiki.filterTiddlers("[conflict-of[Created on both]]")))}`);
await waitFor(async () => (await status(P2))?.waiting === "0", 5000);
check("...and nothing waits", (await status(P2))?.waiting === "0" && JSON.stringify(await outbox(P2)) === "[]", JSON.stringify(await outbox(P2)));
await contextP.close();
await contextL.close();

// --- 14. Forget this device's copy, offline: refused, saying to get online first -------------------
// The page reloads once the copy is gone, and with no network there's nothing to reload from: the
// browser would show its error page, the device copy already gone.
const contextF = await browser.newContext();
const F = await open(contextF, "F");
await contextF.setOffline(true);
await F.evaluate(() => { window.__stillHere = 1; $tw.rootWidget.dispatchEvent({ type: "tm-cfworker-device-forget" }); });
const forgetSaid = await waitFor(() => F.evaluate(() => { const t = $tw.wiki.getTiddler("$:/temp/cfworker/device-message"); return !!t && t.fields.about === "forget" && /online/.test(t.fields.text); }).catch(() => false), 5000);
await sleep(500);   // (a reload, if one came, would come at once)
const stillHere = await F.evaluate(() => window.__stillHere).catch(() => "gone");
const dbKept = await F.evaluate(() => indexedDB.databases().then(dbs => dbs.some(d => d.name === "cfworker-tiddlers"))).catch(() => "gone");
check("Forget this device's copy, offline: refused, saying to get online first; the copy stays and the page doesn't reload",
  forgetSaid && stillHere === 1 && dbKept === true,
  `said ${JSON.stringify(await F.evaluate(() => $tw.wiki.getTiddler("$:/temp/cfworker/device-message")?.fields.text).catch(() => null))}; still here ${stillHere}, database ${dbKept}`);
await contextF.close();

await finish({ check, results, pageErrors, browser, site });
