// The tiddler list's integrity, tiddlers whose title looks like a draft, and files git must not commit.
// Run: npm run test:integrity
import { Miniflare } from "miniflare";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER = path.join(ROOT, "worker.js");
const LIST = "recipes/default/tiddlers.json";

const mf = new Miniflare({
  modules: true, scriptPath: WORKER, compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 8797,
  outboundService: async () => new Response('{"success":true}'),
});
const base = (await mf.ready).toString().replace(/\/$/, "");
const bucket = await mf.getR2Bucket("WIKI_BUCKET");
const html = body => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
await bucket.put("index.html", html("engine v1"));
await bucket.put(LIST, "[]");

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const url = title => `${base}/recipes/default/tiddlers/${encodeURIComponent(title)}`;
// A save as the browser module sends it: flat, text last
const save = (title, fields, headers = {}) => mf.dispatchFetch(url(title), {
  method: "PUT", headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat", ...headers },
  body: JSON.stringify({ title, type: "text/vnd.tiddlywiki", ...fields })
});
const del = (title, headers = {}) => mf.dispatchFetch(`${base}/bags/default/tiddlers/${encodeURIComponent(title)}`, { method: "DELETE", headers });
const etagRevision = res => ((res.headers.get("ETag") || "").match(/\/([^/]+):auto"$/) || [])[1];
const list = async () => JSON.parse(await (await bucket.get(LIST)).text());
const entry = async title => (await list()).find(e => e.title === title);
const storedRevision = async title => (await bucket.head("recipes/default/tiddlers/" + title))?.customMetadata?.revision;
// Puts the list back as it was before a save, as if that save's list update had failed
async function undoListUpdate(title, previousEntry) {
  const entries = (await list()).filter(e => e.title !== title);
  if (previousEntry) entries.push(previousEntry);
  await bucket.put(LIST, JSON.stringify(entries));
}

// --- 1. A save whose list update failed is repaired by its retry ---------------------------------
// The worker writes the tiddler, then the list. If the list update fails, the browser retries the
// same save with the same precondition, which no longer matches the stored revision.
let res = await save("New note", { text: "hello" }, { "If-None-Match": "*" });
const newRevision = etagRevision(res);
await undoListUpdate("New note", null);
res = await save("New note", { text: "hello" }, { "If-None-Match": "*" });
check("retry of a new tiddler's save succeeds instead of 412", res.status === 204 && etagRevision(res) === newRevision, `status ${res.status}`);
check("...and puts it in the tiddler list", (await entry("New note"))?.revision === newRevision);
res = await save("New note", { text: "something else" }, { "If-None-Match": "*" });
check("a different tiddler with that title is still refused (412)", res.status === 412);

res = await save("Old note", { text: "v1" });
const r1 = etagRevision(res);
const entryV1 = await entry("Old note");
res = await save("Old note", { text: "v2" }, { "If-Match": `"default/Old%20note/${r1}:auto"` });
const r2 = etagRevision(res);
await undoListUpdate("Old note", entryV1);
res = await save("Old note", { text: "v2" }, { "If-Match": `"default/Old%20note/${r1}:auto"` });
check("retry of an update succeeds, keeping the stored revision", res.status === 204 && etagRevision(res) === r2, `status ${res.status}`);
check("...and the tiddler list shows the stored revision", (await entry("Old note"))?.revision === r2);
res = await save("Old note", { text: "v3 from a stale tab" }, { "If-Match": `"default/Old%20note/${r1}:auto"` });
check("a real conflict (different content, old revision) is still refused (412)", res.status === 412);
check("...and nothing was overwritten", (await storedRevision("Old note")) === r2);

// --- 2. An unreadable tiddler list is never wiped -------------------------------------------------
await save("$:/SiteTitle", { text: "Title before the damage" });
await save("To delete", { text: "bye" });
let page = await (await mf.dispatchFetch(base + "/")).text();
check("setup: the page contains the startup tiddlers", page.includes("Title before the damage"));
const goodList = await (await bucket.get(LIST)).text();
const damaged = '[{"title": "Old note", "revision": ';
await bucket.put(LIST, damaged);

res = await mf.dispatchFetch(base + "/" + LIST);
const listBody = await res.text();
check("serving an unreadable list fails instead of answering []", res.status >= 500 && listBody !== "[]", `status ${res.status}, body ${listBody.slice(0, 40)}`);
res = await save("Saved while damaged", { text: "x" });
check("a save doesn't overwrite an unreadable list", (await (await bucket.get(LIST)).text()) === damaged);
check("...and reports the failure", res.status >= 500, `status ${res.status}`);
res = await del("To delete");
check("a delete doesn't overwrite it either", (await (await bucket.get(LIST)).text()) === damaged && res.status >= 500, `status ${res.status}`);
await bucket.put("index.html", html("engine v2"));   // forces a page rebuild on the next load
page = await (await mf.dispatchFetch(base + "/")).text();
check("a page rebuild doesn't drop the startup tiddlers: the last good page is served",
  page.includes("Title before the damage") && page.includes("$:/cfworker/conflict-guard.js"));

await bucket.put(LIST, goodList);   // repaired
res = await save("Saved after repair", { text: "y" });
check("once the list is readable again, saves work", res.status === 204 && !!(await entry("Saved after repair")));
res = await del("To delete");   // the browser retries the failed delete
check("...and the retried delete takes the tiddler off the list", res.status === 204 && !(await entry("To delete")));

// The list can be rebuilt from the GitHub backup (this repository's tiddlers/ folder)
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
fs.mkdirSync(path.join(backupDir, "$:", "plugins", "x"), { recursive: true });
fs.writeFileSync(path.join(backupDir, "Flat one.json"), JSON.stringify({ title: "Flat one", tags: ["a"], type: "text/vnd.tiddlywiki", note: "n", revision: "1700000000001", bag: "default", recipe: "default", text: "t" }));
fs.writeFileSync(path.join(backupDir, "$:", "plugins", "x", "y.json"), JSON.stringify({ title: "$:/plugins/x/y", type: "application/json", text: "{}", fields: { "plugin-type": "plugin" }, revision: "1700000000002", bag: "default", recipe: "default" }));
let rebuilt = null;
try {
  rebuilt = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "tools", "rebuild-tiddler-list.mjs"), backupDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
} catch (e) {}
const flatOne = rebuilt?.find(e => e.title === "Flat one");
const plugin = rebuilt?.find(e => e.title === "$:/plugins/x/y");
check("tools/rebuild-tiddler-list.mjs rebuilds the list from the backup folder",
  rebuilt?.length === 2 && flatOne?.revision === "1700000000001" && flatOne.note === "n" && flatOne.text === undefined &&
  plugin?.fields?.["plugin-type"] === "plugin" && plugin.text === undefined);
fs.rmSync(backupDir, { recursive: true, force: true });

// --- 3. A tiddler whose title only looks like a draft is saved like any other ---------------------
const NOT_A_DRAFT = "Draft of 'Chapter 1'";
res = await save(NOT_A_DRAFT, { text: "my chapter" });
check("a tiddler titled \"Draft of '…'\" is stored", !!(await storedRevision(NOT_A_DRAFT)) && !!(await entry(NOT_A_DRAFT)), `status ${res.status}`);
res = await save("Draft of 'Old note'", { "draft.of": "Old note", "draft.title": "Old note", text: "editing" });
check("a real draft (draft.of field) still isn't stored", res.status === 204 && !(await storedRevision("Draft of 'Old note'")));
await bucket.put("recipes/default/tiddlers/Draft 2 of 'Ideas'", JSON.stringify({ title: "Draft 2 of 'Ideas'", text: "kept", revision: "5" }), { customMetadata: { revision: "5" } });
const withIdeas = await list();
withIdeas.push({ title: "Draft 2 of 'Ideas'", revision: "5", tags: [], type: "text/vnd.tiddlywiki" });
await bucket.put(LIST, JSON.stringify(withIdeas));
res = await del("Draft 2 of 'Ideas'");
check("deleting a tiddler titled \"Draft 2 of '…'\" deletes it", !(await storedRevision("Draft 2 of 'Ideas'")) && !(await entry("Draft 2 of 'Ideas'")), `status ${res.status}`);

// --- 4. Local secrets and Wrangler's files stay out of git ---------------------------------------
const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map(l => l.trim());
const missing = ["wrangler.toml", ".dev.vars", ".wrangler/"].filter(p => !ignored.includes(p));
check(".gitignore covers wrangler.toml, .dev.vars and .wrangler/", missing.length === 0, missing.length ? "missing: " + missing.join(", ") : "");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
