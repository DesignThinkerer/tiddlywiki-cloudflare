// The tiddler list's integrity, tiddlers whose title looks like a draft, and files git must not commit.
// Run: npm run test:integrity
import { Miniflare } from "miniflare";
import fs from "node:fs";
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
const list = async () => {
  try { return JSON.parse(await (await bucket.get(LIST)).text()); } catch (e) { return []; }   // missing or damaged
};
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
check("the tiddler list is written as compact JSON", !(await (await bucket.get(LIST)).text()).includes("\n"));
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

// --- 2. A damaged or missing tiddler list is rebuilt from the stored tiddlers ---------------------
// Every tiddler is stored on its own in R2, so the worker can rebuild the list by itself
await save("$:/SiteTitle", { text: "Title before the damage" });
await save("To delete", { text: "bye" });
await save("No text", { note: "only fields" });
await save("Big head", { big: "x".repeat(20000), text: "after a big field" });
// TiddlyWeb's layout (custom fields under "fields", the text anywhere), as TiddlyWiki sends it
// without the conflict guard: stored flat like any other save
await mf.dispatchFetch(url("Nested one"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "nested", title: "Nested one", tags: ["a b"], fields: { color: "red" } }) });
// Not in the form the worker stores (older versions, hand uploads): an older layout, a URL-encoded
// key, no metadata. Never guessed at: left out of a rebuilt list.
await bucket.put("recipes/default/tiddlers/" + encodeURIComponent("Café à"), JSON.stringify({ title: "Café à", text: "old", revision: "123", bag: "default", recipe: "default" }));
await bucket.put("recipes/default/tiddlers/Text first", JSON.stringify({ text: "x", title: "Text first", fields: { color: "blue" }, revision: "91" }), { customMetadata: { revision: "91" } });
await bucket.put("recipes/default/tiddlers/$:/StoryList", JSON.stringify({ title: "$:/StoryList", list: "x" }));
await bucket.put("recipes/default/tiddlers/Draft of 'X'", JSON.stringify({ title: "Draft of 'X'", "draft.of": "X", text: "d" }));
let page = await (await mf.dispatchFetch(base + "/")).text();
check("setup: the page contains the startup tiddlers", page.includes("Title before the damage"));

// title -> revision, to compare lists (dates the save didn't send differ: the worker fills them in)
const summary = entries => Object.fromEntries(entries.map(e => [e.title, String(e.revision)]));
function differences(actual, expected) {
  const titles = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
  const wrong = titles.filter(t => actual[t] !== expected[t]);
  return wrong.slice(0, 5).map(t => `${t}: ${actual[t]} instead of ${expected[t]}`).join("; ") + (wrong.length > 5 ? ` (+${wrong.length - 5})` : "");
}
const getList = async () => {
  const r = await mf.dispatchFetch(base + "/" + LIST);
  return { status: r.status, text: await r.text(), retryAfter: r.headers.get("Retry-After"), exposed: r.headers.get("Access-Control-Expose-Headers") || "" };
};
const repairFiles = async () => (await bucket.list({ prefix: "_repair/" })).objects.map(o => o.key);
const damagedCopies = new Set();

let expected = summary(await list());
const damaged = '[{"title": "Old note", "revision": ';
damagedCopies.add(damaged);
await bucket.put(LIST, damaged);
let got = await getList();
let served = got.status === 200 ? summary(JSON.parse(got.text)) : {};
check("a damaged list is rebuilt from the stored tiddlers when it's read", got.status === 200 && !differences(served, expected),
  `status ${got.status} ${differences(served, expected)}`);
const rebuilt = await list();
check("...and the rebuilt list is stored in R2", !differences(summary(rebuilt), expected));
const rebuiltEntry = title => rebuilt.find(e => e.title === title);
check("...with every field but the text",
  rebuiltEntry("No text")?.note === "only fields" && rebuiltEntry("Big head")?.big?.length === 20000 &&
  rebuilt.every(e => e.text === undefined && e.bag === "default"));
check("...a save in TiddlyWeb's layout among them, stored flat (its custom fields at the top level)",
  rebuiltEntry("Nested one")?.color === "red" && rebuiltEntry("Nested one")?.fields === undefined && rebuiltEntry("Nested one")?.tags?.[0] === "a b",
  JSON.stringify(rebuiltEntry("Nested one")));
check("...leaving out anything not in the form the worker stores (an older layout, an encoded key, no metadata)",
  !rebuiltEntry("Café à") && !rebuiltEntry("Caf%C3%A9%20%C3%A0") && !rebuiltEntry("Text first") && !rebuiltEntry("$:/StoryList") && !rebuiltEntry("Draft of 'X'"));
const keptCopies = await Promise.all((await repairFiles()).map(async key => (await bucket.get(key)).text()));
check("...and keeping the damaged list aside in _repair/", keptCopies.includes(damaged));

await bucket.put(LIST, damaged + " ");
damagedCopies.add(damaged + " ");
res = await save("Saved while damaged", { text: "x" });
expected["Saved while damaged"] = etagRevision(res);
check("a save with a damaged list rebuilds it and succeeds", res.status === 204 && !differences(summary(await list()), expected), `status ${res.status}`);
await bucket.put(LIST, damaged + "  ");
damagedCopies.add(damaged + "  ");
res = await del("To delete");
delete expected["To delete"];
check("a delete with a damaged list rebuilds it and succeeds", res.status === 204 && !differences(summary(await list()), expected), `status ${res.status}`);
await bucket.delete(LIST);
got = await getList();
check("a missing list is rebuilt too", got.status === 200 && !differences(summary(JSON.parse(got.text)), expected), `status ${got.status}`);
// The page may have been built from a list that missed a plugin: it's built again on the next load
let pageMeta = null;
for (let i = 0; i < 20 && pageMeta?.bakeVersion !== "outdated"; i++) {
  await new Promise(r => setTimeout(r, 100));
  pageMeta = (await bucket.head("baked.html"))?.customMetadata;
}
await mf.dispatchFetch(base + "/");
check("after a rebuild, the page is built again on the next load",
  pageMeta?.bakeVersion === "outdated" && /^4-/.test((await bucket.head("baked.html"))?.customMetadata?.bakeVersion || ""), JSON.stringify(pageMeta));
const withNull = JSON.stringify([...await list(), null]);
damagedCopies.add(withNull);
await bucket.put(LIST, withNull);
got = await getList();
check("a list with an entry that isn't a tiddler counts as damaged, and is rebuilt",
  got.status === 200 && !differences(summary(JSON.parse(got.text)), expected), `status ${got.status}`);
// A title that isn't text (no browser sends one): listed as is, it would make the list unreadable,
// and every rebuild would put it back
res = await mf.dispatchFetch(url("12345"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: 12345, text: "a number" }) });
got = await getList();
check("a save whose title isn't text is refused (400), and the list keeps working",
  res.status === 400 && !(await storedRevision("12345")) && got.status === 200, `save ${res.status}, list ${got.status}`);
// The same for a title in the body that isn't the one in the URL: listed under one, stored under the other
res = await mf.dispatchFetch(url("Title A"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Title B", text: "which one?" }) });
check("a save whose body names another title than its URL is refused (400)", res.status === 400 && !(await storedRevision("Title A")), `status ${res.status}`);
// A field called "fields" stays nested, the way TiddlyWeb's layout has it: TiddlyWiki reads it from there
res = await mf.dispatchFetch(url("Fields field"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Fields field", text: "t", fields: { fields: "x", other: "o" } }) });
if (res.status === 204) expected["Fields field"] = etagRevision(res);
const fieldsStored = await bucket.get("recipes/default/tiddlers/Fields field");
const fieldsText = fieldsStored ? await fieldsStored.text() : "";
check("a field called \"fields\" is stored nested, as TiddlyWeb's layout has it, the other fields flat",
  res.status === 204 && JSON.parse(fieldsText || "{}").fields?.fields === "x" && JSON.parse(fieldsText || "{}").other === "o" && fieldsText.includes(',"text":"t","revision":') &&
  (await entry("Fields field"))?.fields?.fields === "x", `status ${res.status} ${fieldsText}`);
// Converted faithfully: custom fields named like built-in properties are kept; a "text" (or
// revision, bag, recipe) under "fields" doesn't move the text; a field that isn't text is refused
res = await mf.dispatchFetch(url("Odd fields"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Odd fields", text: "real text", fields: { constructor: "kept", toString: "kept too", text: "nested", b: "2" } }) });
if (res.status === 204) expected["Odd fields"] = etagRevision(res);
const oddStored = await bucket.get("recipes/default/tiddlers/Odd fields");
const oddText = oddStored ? await oddStored.text() : "";
const oddEntry = await entry("Odd fields");
check("a save in TiddlyWeb's layout keeps fields named like built-in properties, and its text stays last",
  res.status === 204 && oddEntry?.constructor === "kept" && oddEntry?.toString === "kept too" && oddEntry?.b === "2" &&
  oddText.includes(',"text":"real text","revision":') && !oddText.includes("nested"), `status ${res.status} ${oddText}`);
res = await mf.dispatchFetch(url("Object field"), { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Object field", text: "t", fields: { meta: { text: "inside" } } }) });
check("a field whose value isn't text (an object) is refused (400)", res.status === 400 && !(await storedRevision("Object field")), `status ${res.status}`);
const flatMeta = revision => ({ customMetadata: { revision, layout: "flat" } });
await bucket.put("recipes/default/tiddlers/67890", '{"title":67890,"text":"uploaded by hand","revision":"77","bag":"default","recipe":"default"}', flatMeta("77"));
await bucket.put("recipes/default/tiddlers/Key title", '{"title":"Body title","text":"uploaded by hand","revision":"78","bag":"default","recipe":"default"}', flatMeta("78"));
await bucket.put(LIST, damaged);
got = await getList();
check("...and ones stored by hand don't stop a rebuild: they're listed under their key, as text",
  got.status === 200 && !differences(summary(JSON.parse(got.text)), { ...expected, 67890: "77", "Key title": "78" }),
  `status ${got.status} ${got.status === 200 ? differences(summary(JSON.parse(got.text)), { ...expected, 67890: "77", "Key title": "78" }) : ""}`);
for (const key of ["12345", "67890", "Key title"]) await bucket.delete("recipes/default/tiddlers/" + key);
await bucket.put(LIST, damaged);
await bucket.put("index.html", html("engine v2"));   // forces a page rebuild on the next load
page = await (await mf.dispatchFetch(base + "/")).text();
check("a page rebuild with a damaged list rebuilds the list first and keeps the startup tiddlers",
  page.includes("engine v2") && page.includes("Title before the damage") && !differences(summary(await list()), expected));

// A list too big to rebuild in one request (each request reads a limited number of tiddlers)
res = await save("Delete mid-rebuild", { text: "d" });
expected["Delete mid-rebuild"] = etagRevision(res);
const FILLERS = 400;
for (let i = 0; i < FILLERS; i += 50) {
  await Promise.all(Array.from({ length: 50 }, (_, j) => {
    const title = `Filler ${String(i + j).padStart(3, "0")}`, revision = String(1700000000000 + i + j);
    expected[title] = revision;
    return bucket.put(`recipes/default/tiddlers/${title}`,
      `{"title":"${title}","type":"text/vnd.tiddlywiki","n":"${i + j}","text":"f","revision":"${revision}","bag":"default","recipe":"default"}`,
      { customMetadata: { revision, layout: "flat" } });
  }));
}
await bucket.put(LIST, damaged);
got = await getList();
check("a big list is rebuilt over several requests: meanwhile the list answers 503 with Retry-After",
  got.status === 503 && !!got.retryAfter, `status ${got.status}`);
check("...and a page on another origin may read why (X-Tiddler-List is exposed)", /X-Tiddler-List/i.test(got.exposed), got.exposed);
check("...and the damaged list stays as it is until the new one is complete", (await (await bucket.get(LIST)).text()) === damaged);
res = await save("Saved mid-rebuild", { text: "m" }, { "If-None-Match": "*" });
check("a save during the rebuild answers 503 \"rebuilding\" and stores nothing (so its retry can't conflict)",
  res.status === 503 && res.headers.get("X-Tiddler-List") === "rebuilding" && !(await storedRevision("Saved mid-rebuild")), `status ${res.status}`);
res = await del("Delete mid-rebuild");
check("a delete during the rebuild answers 503 \"rebuilding\" and deletes nothing",
  res.status === 503 && res.headers.get("X-Tiddler-List") === "rebuilding" && !!(await storedRevision("Delete mid-rebuild")), `status ${res.status}`);
let requests = 1;
while (got.status !== 200 && requests < 40) {
  const both = await Promise.all([getList(), getList()]);   // two tabs driving the rebuild at once
  got = both.find(r => r.status === 200) || both[0];
  requests += 2;
}
served = got.status === 200 ? JSON.parse(got.text) : [];
const titles = served.map(e => e.title);
check("...it completes, every tiddler listed once, even with two tabs driving it",
  got.status === 200 && titles.length === new Set(titles).size && !differences(summary(served), expected),
  `${requests} requests, status ${got.status} ${differences(summary(served), expected)}`);
res = await save("Saved mid-rebuild", { text: "m, edited while it waited" }, { "If-None-Match": "*" });
check("...then the save sent again, even edited meanwhile, succeeds", res.status === 204 &&
  (await entry("Saved mid-rebuild"))?.revision === etagRevision(res), `status ${res.status}`);
expected["Saved mid-rebuild"] = etagRevision(res);
res = await del("Delete mid-rebuild");
delete expected["Delete mid-rebuild"];
check("...and so does the delete", res.status === 204 && !(await storedRevision("Delete mid-rebuild")) && !(await entry("Delete mid-rebuild")), `status ${res.status}`);

// A rebuild left unfinished, then the list repaired by hand: the same damage later starts over
// (resuming would miss what was saved in between)
async function rebuildToEnd() {
  let r = await getList();
  for (let i = 0; i < 40 && r.status !== 200; i++) r = await getList();
  return r;
}
await bucket.put(LIST, damaged);
got = await getList();
check("setup: a rebuild left after one step", got.status === 503, `status ${got.status}`);
await bucket.put(LIST, JSON.stringify(Object.entries(expected).map(([title, revision]) => ({ title, revision }))));   // repaired by hand
res = await save("AAA saved in between", { text: "a" });
expected["AAA saved in between"] = etagRevision(res);
await bucket.put(LIST, damaged);   // the same content: the same R2 etag
got = await rebuildToEnd();
check("the same damage again later starts a new rebuild: a tiddler saved in between is listed",
  got.status === 200 && !differences(summary(JSON.parse(got.text)), expected), `status ${got.status} ${got.status === 200 ? differences(summary(JSON.parse(got.text)), expected) : ""}`);
await bucket.delete(LIST);
got = await getList();
await bucket.put(LIST, JSON.stringify(Object.entries(expected).map(([title, revision]) => ({ title, revision }))));
res = await save("AAB saved in between", { text: "b" });
expected["AAB saved in between"] = etagRevision(res);
await bucket.delete(LIST);
got = await rebuildToEnd();
check("...and the same for a list deleted twice",
  got.status === 200 && !differences(summary(JSON.parse(got.text)), expected), `status ${got.status} ${got.status === 200 ? differences(summary(JSON.parse(got.text)), expected) : ""}`);
// While a missing list is rebuilt, R2 holds a stand-in in its place (public tabs read it there)
await bucket.delete(LIST);
await getList();
const standIn = await bucket.get(LIST);
const standInText = standIn ? await standIn.text() : "";
await bucket.delete(LIST);
await getList();
const secondStandIn = await bucket.head(LIST);
check("each rebuild of a missing list has its own stand-in in R2",
  !!standIn && !!secondStandIn && standIn.etag !== secondStandIn.etag, `${standIn?.etag} / ${secondStandIn?.etag}`);
let standInParses = true;
try { JSON.parse(standInText); } catch (e) { standInParses = false; }
check("...which isn't JSON: even a tab without the conflict guard stops with an error rather than emptying itself",
  !!standIn && !standInParses, standInText.slice(0, 80));
got = await rebuildToEnd();
check("...and the rebuild completes", got.status === 200 && !differences(summary(JSON.parse(got.text)), expected), `status ${got.status}`);
// A title listed twice anyway (a hand edit) is listed once after its next save
const twice = await list();
twice.push({ ...twice.find(e => e.title === "Old note"), revision: "1" });
await bucket.put(LIST, JSON.stringify(twice));
res = await save("Old note", { text: "saved again" });
check("a title listed twice is listed once after its next save", (await list()).filter(e => e.title === "Old note").length === 1, `status ${res.status}`);
const leftovers = await Promise.all((await repairFiles()).map(async key => (await bucket.get(key)).text()));
check("no rebuild progress is left behind in _repair/", leftovers.every(text => damagedCopies.has(text)), (await repairFiles()).join(", "));

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
