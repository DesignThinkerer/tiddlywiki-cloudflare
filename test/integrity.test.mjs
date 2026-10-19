// The tiddler list's integrity under failure: a save whose list update failed, a damaged or missing
// list rebuilt, a page build that fails, list writes out of order, and titles that only look like drafts.
// Run: npm run test:integrity
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST = "recipes/default/tiddlers.json";

// The worker behind test/r2-counter.mjs, which can make chosen R2 calls fail. Cache purges are
// recorded: { time, files (their URLs) }
const purges = [];
// The worker's in-process waits (the second purge after a rebuild, 5 s; the outdated mark tried
// again, 1.1 s), scaled by this for the tests (TEST_WAIT_SCALE, design 2.25); the checks on them use it
const WAIT_SCALE = 0.2, scaled = ms => Math.round(ms * WAIT_SCALE);
const mf = new Miniflare({
  modules: true, scriptPath: "test/r2-counter.mjs", modulesRoot: ROOT,
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }],
  compatibilityDate: "2024-09-23", r2Buckets: ["WIKI_BUCKET"], port: 0,
  bindings: { ACCESS: "off", PUBLIC_WIKI_URL: "https://wiki.example.com", CF_ZONE_ID: "zone", CF_API_TOKEN: "token", TEST_WAIT_SCALE: String(WAIT_SCALE) },
  outboundService: async req => {
    // (A purged file is a URL, or { url, headers } for a copy cached with those request headers)
    if (req.url.includes("/purge_cache")) purges.push({ time: Date.now(), files: ((await req.json()).files || []).map(f => typeof f === "string" ? f : f.url) });
    return new Response('{"success":true}');
  },
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
// A retry with other content (the tab edited again before retrying, or a stale tab): refused, as it
// isn't based on the stored version, but the list is brought up to that version, with its fields,
// and the public cache purged, rather than left behind until something else saves that title
res = await save("Edited note", { color: "red", text: "e1" });
const e1 = etagRevision(res);
const entryE1 = await entry("Edited note");
res = await save("Edited note", { color: "blue", text: "e2" }, { "If-Match": `"default/Edited%20note/${e1}:auto"` });
const e2 = etagRevision(res);
await undoListUpdate("Edited note", entryE1);
const purgesBeforeEdited = purges.length;
res = await save("Edited note", { color: "green", text: "e3, edited again" }, { "If-Match": `"default/Edited%20note/${e1}:auto"` });
await new Promise(r => setTimeout(r, 300));
const repairedEntry = await entry("Edited note");
check("a retry with other content after a failed list update: refused (412), the list brought up to the stored version, and purged",
  res.status === 412 && repairedEntry?.revision === e2 && repairedEntry?.color === "blue" && await storedRevision("Edited note") === e2 &&
  purges.slice(purgesBeforeEdited).some(p => p.files.some(f => f.includes("Edited%20note"))),
  `status ${res.status}, listed ${repairedEntry?.revision} (stored ${e2}), color ${repairedEntry?.color}`);

// A save whose list update loses the race five times running (the stand-in answers each conditional
// write of the list null, as R2 does when another save got there first): 500, saying the tiddler
// list couldn't be updated and to try again, in those words. The tiddler itself is stored, so the
// same save again finishes it: listed, 204
const refuseList = times => mf.dispatchFetch(`${base}/__r2fail`, { method: "POST", body: JSON.stringify({ call: "put list", times, refuse: true }) });
await refuseList(5);
res = await save("Contested note", { text: "c1" });
const contestedText = await res.text();
const contestedStored = await storedRevision("Contested note");
const contestedRetry = await save("Contested note", { text: "c1" });
check("a save whose list update loses the race five times running: 500 saying the tiddler list couldn't be updated and to try again (not \"Manifest\"); the tiddler stored, and the same save again finishes it, listed",
  res.status === 500 && /tiddler list couldn't be updated/.test(contestedText) && /[Tt]ry again/.test(contestedText) && !/Manifest/.test(contestedText) &&
  !!contestedStored && contestedRetry.status === 204 && (await entry("Contested note"))?.revision === etagRevision(contestedRetry),
  `status ${res.status}: ${contestedText.slice(0, 160)}; stored ${contestedStored}; retry ${contestedRetry.status}, listed ${(await entry("Contested note"))?.revision}`);

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
const rebuiltAt = Date.now();
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
// Purged from the public cache at once, and again a little later (a public request that read the
// damaged list just before could put it back in the cache). Nothing else is saved meanwhile.
await new Promise(r => setTimeout(r, Math.max(0, rebuiltAt + scaled(5000) + 1500 - Date.now())));
const listPurges = purges.filter(p => p.time >= rebuiltAt && p.files.some(f => f.includes("/recipes/default/tiddlers.json")));
check("...and the list purged from the public cache at once, then again 5 seconds later (scaled here: once more, no sooner than the wait, and well before 5 s)",
  listPurges.length === 2 && listPurges[0].time - rebuiltAt < 2000 && listPurges[1].time - listPurges[0].time >= scaled(5000) * 0.9 && listPurges[1].time - listPurges[0].time < scaled(5000) + 1500,
  JSON.stringify(listPurges.map(p => p.time - rebuiltAt)));

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
  pageMeta?.bakeVersion === "outdated" && /^\d+-/.test((await bucket.head("baked.html"))?.customMetadata?.bakeVersion || ""), JSON.stringify(pageMeta));
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
// R2 keys are at most 1024 bytes: a longer title is refused, not an error; up to that, stored
const LONGEST = "x".repeat(1024 - "recipes/default/tiddlers/".length), TOO_LONG = "é".repeat(500);
res = await save(TOO_LONG, { text: "t" });
got = await getList();
check("a title too long for an R2 key is refused (400) with a reason, and the list keeps working",
  res.status === 400 && /too long/.test(await res.text()) && got.status === 200 && !JSON.parse(got.text).some(e => e.title === TOO_LONG), `save ${res.status}, list ${got.status}`);
res = await save(LONGEST, { text: "t" });
const longestStored = res.status === 204 && !!(await storedRevision(LONGEST));
res = await del(LONGEST);
check("...the longest title that fits is stored and deleted", longestStored && res.status === 204 && !(await storedRevision(LONGEST)), `stored ${longestStored}, delete ${res.status}`);
res = await del(TOO_LONG);
const read = await mf.dispatchFetch(url(TOO_LONG));
check("...deleting one too long answers 204, reading it 404: it can't be there", res.status === 204 && read.status === 404, `delete ${res.status}, read ${read.status}`);
// A path that isn't valid percent-encoding is refused, not an exception
const BROKEN = `${base}/recipes/default/tiddlers/%E0%A4%A`;
const broken = [await mf.dispatchFetch(BROKEN), await mf.dispatchFetch(BROKEN, { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"title":"x"}' }),
  await mf.dispatchFetch(BROKEN.replace("/recipes/", "/bags/"), { method: "DELETE" })];
check("a path that isn't valid percent-encoding is refused (400) by reads, saves and deletes, with CORS headers",
  broken.every(r => r.status === 400 && r.headers.get("access-control-allow-origin") === "*"), broken.map(r => r.status).join(", "));
// Tags must be text too: a number in the tags (a script's addTiddler can make one) was stored, then
// broke every page build ("tag.includes is not a function")
const badTags = [await save("Numeric tag", { tags: [2024], text: "x" }), await save("Null tag", { tags: [null], text: "x" }),
  await mf.dispatchFetch(url("Old layout tag"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Old layout tag", tags: [1], text: "x" }) })];
check("a tag that isn't text is refused (400), in either layout", badTags.every(r => r.status === 400) &&
  !(await storedRevision("Numeric tag")) && !(await storedRevision("Null tag")) && !(await storedRevision("Old layout tag")), badTags.map(r => r.status).join(", "));
// (A tag or field that reads as a number is text like any other: TiddlyWiki sends "2024", not 2024)
res = await save("Tagged 2024", { tags: ["2024", "year 2024"], year: "2024", text: "x" });
const tagged2024 = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Tagged 2024")).text());
check("...while a tag or field that reads as a number (\"2024\") is stored like any other", res.status === 204 &&
  JSON.stringify(tagged2024.tags) === '["2024","year 2024"]' && tagged2024.year === "2024" && JSON.stringify((await entry("Tagged 2024"))?.tags) === '["2024","year 2024"]',
  `status ${res.status} ${JSON.stringify(tagged2024)}`);
await del("Tagged 2024");
// ...and one already stored (before this check, or by hand) doesn't stop the page from being built
await bucket.put("recipes/default/tiddlers/Hand tag", '{"title":"Hand tag","tags":[2024],"text":"x","revision":"79","bag":"default","recipe":"default"}', { customMetadata: { revision: "79", layout: "flat" } });
const withHandTag = await list();
withHandTag.push({ title: "Hand tag", tags: [2024], revision: "79", type: "text/vnd.tiddlywiki" });
await bucket.put(LIST, JSON.stringify(withHandTag));
res = await save("$:/SiteSubtitle", { text: "Built despite a numeric tag" });
const builtPage = await (await bucket.get("baked.html")).text();
check("...and one already listed doesn't stop the page from being built", res.status === 204 && builtPage.includes("Built despite a numeric tag"), `status ${res.status}`);
await del("$:/SiteSubtitle");
await del("Hand tag");
// A body sent as the flat layout (text last) that doesn't follow it: a field after the text is listed
// (the body is read in full, and stored in the right order), a text that isn't text is refused, in
// either layout, and so is a body that isn't JSON after its text
const putRaw = (title, raw, flat = true) => mf.dispatchFetch(url(title), { method: "PUT", body: raw,
  headers: { "Content-Type": "application/json", ...(flat ? { "X-Tiddler-Layout": "flat" } : {}) } });
const afterText = await putRaw("After text", '{"title":"After text","text":"abc","color":"x","tags":["late"]}');
const afterTextEntry = await entry("After text");
const afterTextStored = await (await bucket.get("recipes/default/tiddlers/After text"))?.text();
const notTextFlat = await putRaw("Object text", '{"title":"Object text","text":{"a":1}}');
const notTextTiddlyWeb = await putRaw("Object text", '{"title":"Object text","text":{"a":1}}', false);
const garbage = await putRaw("Garbage after", '{"title":"Garbage after","text":"abc" garbage}');
check("a flat body that isn't (a field after the text, a text that isn't text, garbage after it): the field listed, the others refused (400)",
  afterText.status === 204 && afterTextEntry?.color === "x" && JSON.stringify(afterTextEntry?.tags) === '["late"]' && /"text":"abc","revision":/.test(afterTextStored || "") &&
  notTextFlat.status === 400 && notTextTiddlyWeb.status === 400 && garbage.status === 400 && !(await storedRevision("Object text")) && !(await storedRevision("Garbage after")),
  JSON.stringify({ after: [afterText.status, afterTextEntry?.color, afterTextEntry?.tags], objectText: [notTextFlat.status, notTextTiddlyWeb.status], garbage: garbage.status }));
await del("After text");
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
await getList();
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
// The list is served as stored when every entry has its bag and recipe (the worker writes them),
// not parsed and written out again; entries without them (a list written by hand) get them
const asStored = JSON.stringify(await list(), null, 1);
await bucket.put(LIST, asStored);
got = await getList();
const handWritten = (await list()).map(({ bag, recipe, ...rest }, i) => i === 0 ? rest : { ...rest, bag, recipe });
await bucket.put(LIST, JSON.stringify(handWritten));
const patched = await getList();
const firstServed = JSON.parse(patched.text)[0];
check("a list whose entries all have bag and recipe is served byte for byte as stored; one without them gets them",
  got.status === 200 && got.text === asStored && patched.status === 200 && firstServed.bag === "default" && firstServed.recipe === "default",
  `${got.text === asStored ? "as stored" : "rewritten"}, first entry ${JSON.stringify(firstServed).slice(0, 80)}`);
await bucket.put(LIST, JSON.stringify(JSON.parse(asStored)));
const leftovers = await Promise.all((await repairFiles()).map(async key => (await bucket.get(key)).text()));
check("no rebuild progress is left behind in _repair/", leftovers.every(text => damagedCopies.has(text)), (await repairFiles()).join(", "));

// --- 3. A page build that fails after a save or delete is done again at the next page load --------
// The save or delete is stored and confirmed; the page it needed rebuilt (with or without a plugin's
// script tag) mustn't stay as it was
const failNext = call => mf.dispatchFetch(`${base}/__r2fail`, { method: "POST", body: JSON.stringify({ call }) });
const pagePlugin = title => ({ "plugin-type": "plugin", type: "application/json", version: "1.0.0",
  text: JSON.stringify({ tiddlers: { [title + "/readme"]: { text: "readme" } } }) });
const storedPageMeta = async () => (await bucket.head("baked.html"))?.customMetadata || {};
const waitForOutdated = async () => {
  for (let i = 0; i < 40 && (await storedPageMeta()).bakeVersion !== "outdated"; i++) await new Promise(r => setTimeout(r, 50));
  return (await storedPageMeta()).bakeVersion === "outdated";
};
const loadPage = async () => (await mf.dispatchFetch(base + "/")).text();
const tagOf = title => `/_plugins/${encodeURIComponent(title)}.js?v=`;
await loadPage();   // the page exists
const P1 = "$:/plugins/test/page-one", P2 = "$:/plugins/test/page-two";
await failNext("put baked.html");
res = await save(P1, pagePlugin(P1));
let outdated = await waitForOutdated();
let text = await loadPage();
check("a plugin save whose page build failed is still confirmed, and the page is marked outdated", res.status === 204 && outdated, `status ${res.status}, page ${JSON.stringify(await storedPageMeta())}`);
check("...so the next page load builds it again, with the plugin", text.includes(tagOf(P1)));
await failNext("put plugin file");
res = await save(P2, pagePlugin(P2));
outdated = await waitForOutdated();
text = await loadPage();
check("a plugin save whose file couldn't be written: the next page load writes it and loads it",
  res.status === 204 && outdated && text.includes(tagOf(P2)) && !!(await bucket.head(`_plugins/${P2}.js`)), `status ${res.status}, outdated ${outdated}`);
await failNext("put baked.html");
res = await del(P1);
outdated = await waitForOutdated();
text = await loadPage();
check("a plugin delete whose page build failed: the next page load builds the page without it",
  res.status === 204 && outdated && !text.includes(tagOf(P1)), `status ${res.status}, outdated ${outdated}`);
// A plugin file that can't be deleted (its plugin deleted, or saved as an ordinary tiddler) doesn't
// stop the page build: the page stops loading it, and the file is only left behind
const P3 = "$:/plugins/test/page-three", P4 = "$:/plugins/test/page-four";
await save(P3, pagePlugin(P3));
await save(P4, pagePlugin(P4));
const storedPage = async () => (await bucket.get("baked.html"))?.text() ?? "";
const loadedBefore = (await storedPage()).includes(tagOf(P3)) && (await storedPage()).includes(tagOf(P4));
await failNext("delete plugin file");
const deletedP3 = await del(P3);
const afterDelete = await storedPage();
await failNext("delete plugin file");
const plainP4 = await save(P4, { text: "an ordinary tiddler now" });
const afterPlain = await storedPage();
check("a plugin whose file can't be deleted, deleted or saved as an ordinary tiddler: confirmed, and the page built without it",
  loadedBefore && deletedP3.status === 204 && !afterDelete.includes(tagOf(P3)) && plainP4.status === 204 && !afterPlain.includes(tagOf(P4)) &&
  (await storedPageMeta()).bakeVersion !== "outdated",
  `before ${loadedBefore}, delete ${deletedP3.status} (page loads it: ${afterDelete.includes(tagOf(P3))}), plain ${plainP4.status} (page loads it: ${afterPlain.includes(tagOf(P4))})`);
// A page load whose build fails too: the last page built is served (with the browser modules and the
// plugin files), not the bare index.html
const P5 = "$:/plugins/test/page-five";
await failNext("put baked.html");
await save(P5, pagePlugin(P5));
outdated = await waitForOutdated();
await failNext("put baked.html");
const servedWhileFailing = await loadPage();
text = await loadPage();
check("a page load whose build fails serves the last page built, not the bare index.html; the next load builds it",
  outdated && servedWhileFailing.includes(tagOf(P2)) && text.includes(tagOf(P5)),
  `outdated ${outdated}, served the last page ${servedWhileFailing.includes(tagOf(P2))}, then built ${text.includes(tagOf(P5))}`);

// A page build that fails twice: the page can't be written, nor marked outdated right after (R2
// allows one write a second to a key, and the mark writes the same one). The mark is tried again a
// second later; if that fails too, the delete or save answers 500 (the change itself is stored), and
// its retry finds the plugin file still there, the only trace left, and finishes: the page built
// without the plugin, the file deleted. Without that, the deleted plugin stayed in the page and in
// its file, loaded at every page load on both sites, and nothing would ever take it out.
const failTimes = (call, times) => mf.dispatchFetch(`${base}/__r2fail`, { method: "POST", body: JSON.stringify({ call, times }) });
const P6 = "$:/plugins/test/page-six", P7 = "$:/plugins/test/page-seven", P8 = "$:/plugins/test/page-eight";
await save(P6, pagePlugin(P6));
await save(P7, pagePlugin(P7));
await save(P8, pagePlugin(P8));
const builtWithAll = (await storedPage()).includes(tagOf(P6)) && (await storedPage()).includes(tagOf(P7)) && (await storedPage()).includes(tagOf(P8));
await failTimes("put baked.html", 2);
const deleteP6At = Date.now();
const deletedP6 = await del(P6);
const deleteP6Ms = Date.now() - deleteP6At;
outdated = (await storedPageMeta()).bakeVersion === "outdated";
text = await loadPage();
check("a plugin delete whose page build and outdated mark both fail: the mark is tried again, and the next page load builds the page without it",
  builtWithAll && deletedP6.status === 204 && outdated && !text.includes(tagOf(P6)), `status ${deletedP6.status}, outdated ${outdated}, page loads it: ${text.includes(tagOf(P6))}`);
check("...the mark tried again after the wait (a second in production, scaled here): the delete answered after it, and well before a second",
  deleteP6Ms >= scaled(1100) && deleteP6Ms < 1000, `answered after ${deleteP6Ms} ms`);
await failTimes("put baked.html", 3);
const failedP7 = await del(P7);
const stillLoaded = (await storedPage()).includes(tagOf(P7)) && !!(await bucket.head(`_plugins/${P7}.js`));
const retriedP7 = await del(P7);   // as TiddlyWiki retries a failed delete
text = await loadPage();
check("...and if that fails too, the delete answers 500 while the page still loads the plugin; its retry builds the page without it and deletes the file",
  failedP7.status === 500 && stillLoaded && retriedP7.status === 204 && !text.includes(tagOf(P7)) && !(await bucket.head(`_plugins/${P7}.js`)),
  `first ${failedP7.status} (page loads it: ${stillLoaded}), retry ${retriedP7.status}, page loads it: ${text.includes(tagOf(P7))}, file ${!!(await bucket.head(`_plugins/${P7}.js`))}`);
await failTimes("put baked.html", 3);
const plainP8 = { text: "an ordinary tiddler now" };
const pluginRevision = (await bucket.head(`recipes/default/tiddlers/${P8}`)).customMetadata.revision;
const failedP8 = await save(P8, plainP8, { "If-Match": pluginRevision });
const stillLoadedP8 = (await storedPage()).includes(tagOf(P8)) && !!(await bucket.head(`_plugins/${P8}.js`));
// The same save again, based on the plugin's revision as the tab still has it: finished, not refused
const retriedP8 = await save(P8, plainP8, { "If-Match": pluginRevision });
text = await loadPage();
check("the same for a plugin saved as an ordinary tiddler: the retried save builds the page without it and deletes the file",
  failedP8.status === 500 && stillLoadedP8 && retriedP8.status === 204 && !text.includes(tagOf(P8)) && !(await bucket.head(`_plugins/${P8}.js`)),
  `first ${failedP8.status} (page loads it: ${stillLoadedP8}), retry ${retriedP8.status}, page loads it: ${text.includes(tagOf(P8))}, file ${!!(await bucket.head(`_plugins/${P8}.js`))}`);

// --- 4. List updates follow revisions --------------------------------------------------------------
// Two requests for the same title can update the list in the other order (a list write retried after
// another one): the list keeps the newer version
const delayNext = (call, delay) => mf.dispatchFetch(`${base}/__r2fail`, { method: "POST", body: JSON.stringify({ call, delay }) });
const pause = ms => new Promise(r => setTimeout(r, ms));
// A save purges the public tiddler list only once the list is updated (a public request in between
// would put the old list back in Cloudflare's cache): with the list write held up, the purge waits
await delayNext("put list", 800);
const orderStart = Date.now();
res = await save("Purge order", { text: "listed before its purge?" });
await pause(300);
const orderPurge = purges.find(p => p.time >= orderStart && p.files.some(f => f.includes(encodeURIComponent("Purge order"))));
check("a save purges the public cache only once the tiddler list is updated (the list write held up 800 ms)",
  res.status === 204 && !!orderPurge && orderPurge.time - orderStart >= 800 && orderPurge.files.some(f => f.includes("/recipes/default/tiddlers.json")),
  orderPurge ? `purged after ${orderPurge.time - orderStart} ms` : "no purge");
await save("Raced", { text: "first" });
await delayNext("put list", 600);
const deleting = del("Raced");
await pause(200);
res = await save("Raced", { text: "again" }, { "If-None-Match": "*" });
const againRevision = etagRevision(res);
const deleted = await deleting;
check("a delete whose list update lands after the title was created again leaves the new tiddler listed",
  deleted.status === 204 && res.status === 204 && (await entry("Raced"))?.revision === againRevision && await storedRevision("Raced") === againRevision,
  `listed ${JSON.stringify((await entry("Raced"))?.revision)}, stored ${await storedRevision("Raced")}, created ${againRevision}`);
await delayNext("put list", 600);
const older = save("Twice", { text: "older" });
await pause(200);
res = await save("Twice", { text: "newer" });
const newerRevision = etagRevision(res);
await older;
check("an older save whose list update lands after a newer one's doesn't put its revision back in the list",
  (await entry("Twice"))?.revision === newerRevision && await storedRevision("Twice") === newerRevision,
  `listed ${(await entry("Twice"))?.revision}, stored ${await storedRevision("Twice")}, newer ${newerRevision}`);

// A save that lands between a delete's check and its removal: the delete removes that save's
// version too (R2 deletes can't be conditional), so it doesn't keep the entry as "saved again since"
res = await save("Squeezed", { text: "v1" });
await delayNext("delete tiddler", 600);
const squeezedDelete = del("Squeezed");
await pause(200);
res = await save("Squeezed", { text: "v2" }, { "If-Match": res.headers.get("ETag") });
const squeezedDeleted = await squeezedDelete;
check("a save landing between a delete's check and its removal: removed with it, so not listed either",
  res.status === 204 && squeezedDeleted.status === 204 && !(await storedRevision("Squeezed")) === !(await entry("Squeezed")),
  `save ${res.status}, delete ${squeezedDeleted.status}, stored ${await storedRevision("Squeezed")}, listed ${(await entry("Squeezed"))?.revision}`);

// A save whose list write is retried after a delete's: the delete removed the object (this save's
// version, or the one it was based on: R2 deletes can't be conditional) and the entry, and its list
// write is what made the save's fail. Retried, the save finds its title unlisted: it must not list
// what isn't stored. Here the delete's removal is delayed past the save's store, and the save's list
// write held until after the delete's
res = await save("Phantom", { text: "v1" }, { "If-None-Match": "*" });
const phantomV1 = res.headers.get("ETag");
await delayNext("delete tiddler", 600);
await delayNext("put list", 900);
const phantomDelete = del("Phantom", { "If-Match": phantomV1 });
await pause(150);
const phantomSave = save("Phantom", { text: "v2" }, { "If-Match": phantomV1 });
const [phantomDeleted, phantomSaved] = await Promise.all([phantomDelete, phantomSave]);
await pause(300);
check("a save whose list write is retried after a delete's removal doesn't list the deleted tiddler again",
  phantomDeleted.status === 204 && phantomSaved.status === 204 && !(await storedRevision("Phantom")) && !(await entry("Phantom")),
  `delete ${phantomDeleted.status}, save ${phantomSaved.status}, stored ${await storedRevision("Phantom")}, listed ${(await entry("Phantom"))?.revision}`);
// ...the same with a delete based on the version the save stored, landing while that write is held
res = await save("Phantom 2", { text: "v1" }, { "If-None-Match": "*" });
await delayNext("put list", 700);
const phantomSave2 = save("Phantom 2", { text: "v2" }, { "If-Match": res.headers.get("ETag") });
await pause(200);
const phantomDeleted2 = await del("Phantom 2", { "If-Match": `"default/Phantom%202/${await storedRevision("Phantom 2")}:auto"` });
const phantomSaved2 = await phantomSave2;
await pause(300);
check("...nor one whose stored version a delete removed while its list write was held",
  phantomDeleted2.status === 204 && phantomSaved2.status === 204 && !(await storedRevision("Phantom 2")) && !(await entry("Phantom 2")),
  `delete ${phantomDeleted2.status}, save ${phantomSaved2.status}, stored ${await storedRevision("Phantom 2")}, listed ${(await entry("Phantom 2"))?.revision}`);
// ...while a save whose list write is retried after another tiddler's save is listed as before
await delayNext("put list", 600);
const heldSave = save("Held beside", { text: "held" });
await pause(200);
res = await save("Beside it", { text: "lands first" });
const heldSaved = await heldSave;
check("...while a save whose list write is retried after another tiddler's save is still listed",
  heldSaved.status === 204 && res.status === 204 && !!(await entry("Held beside")) && (await entry("Held beside")).revision === await storedRevision("Held beside") && !!(await entry("Beside it")),
  `listed ${(await entry("Held beside"))?.revision}, stored ${await storedRevision("Held beside")}`);

// --- 4b. Overlapping page builds keep the newest shell -----------------------------------------------
// A save's page build that read the shell before a new one was published, and stores its page after
// that one's: the page stays built from the new shell (with the save's change, which it read too)
const PUBLIC = "https://wiki.example.com", CORE_V = "5.4.1-1";
const coreSrc = `${PUBLIC}/_plugins/tiddlywikicore.js?v=${CORE_V}`;
const MARK = name => `<!--~~ ${name} ~~-->`;
const shellNamed = name => ["<!doctype html>", "<html>", "<head>", `<title>${name}</title>`, "</head>", "<body>", MARK("Ordinary tiddlers"),
  '<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/tiddlywiki/tiddlyweb","plugin-type":"plugin","text":"{}"}\n]</script>',
  MARK("Load external JavaScripts"), `<script src="${coreSrc}"></script>`, "</body>", "</html>"].join("\n");
const indexEtag = async () => (await bucket.head("index.html")).etag;
// (X-Page-Shell: the stored shell the page was built from, as the admin wiki sends it: the one stored now)
const putShell = async (text, fingerprint) => mf.dispatchFetch(`${base}/page/shell`, { method: "PUT", body: text,
  headers: { "Content-Type": "text/html", "X-Page-Fingerprint": fingerprint, "X-Page-Index": await indexEtag(), "X-Page-Shell": (await bucket.head("_page/shell.html"))?.etag || "" } });
res = await mf.dispatchFetch(`${base}/page/core?v=${CORE_V}`, { method: "PUT", headers: { "Content-Type": "application/javascript", "X-Page-Index": await indexEtag() }, body: [
  "/*\nTiddlyWiki\n*/", "$tw.preloadTiddlers = $tw.preloadTiddlers || [];", '_load(window,{"title":"$:/boot/boot.js","text":""});'].join("\n") });
const firstShell = await putShell(shellNamed("Shell one"), "s1");
await delayNext("put baked.html", 800);
const titleSave = save("$:/SiteTitle", { text: "Raced title" });
await pause(300);
const secondShell = await putShell(shellNamed("Shell two"), "s2");
await titleSave;
text = await (await bucket.get("baked.html")).text();
check("a page build that read the shell before a new one was published doesn't put the old shell back",
  res.status === 204 && firstShell.status === 204 && secondShell.status === 204 && text.includes("<title>Shell two</title>") && text.includes("Raced title"),
  `core ${res.status}, shells ${firstShell.status} ${secondShell.status}, page from ${(/<title>(.*?)<\/title>/.exec(text) || [])[1]}, title ${text.includes("Raced title")}`);

// --- 4c. A tiddler changed before its text arrived keeps its stored text ---------------------------
// TiddlyWiki marks a tiddler whose fields came with the list but whose text hasn't loaded yet with
// _is_skinny. Changed then (a checkbox during the first sync), it's saved without its text: the
// worker keeps the stored text, as TiddlyWiki's own server does, and doesn't store the mark (the
// tiddler list marks every entry so, by design: it never carries the text)
res = await save("Skinny", { tags: ["todo"], text: "text that must stay" });
let skinnyBase = res.headers.get("ETag");
res = await save("Skinny", { tags: ["todo", "done"], _is_skinny: "" }, { "If-Match": skinnyBase });
let skinnyStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny")).text());
check("a save of a tiddler whose text never loaded keeps the stored text, with the new fields, without the mark",
  res.status === 204 && skinnyStored.text === "text that must stay" && JSON.stringify(skinnyStored.tags) === '["todo","done"]' &&
  !("_is_skinny" in skinnyStored), `status ${res.status} ${JSON.stringify(skinnyStored)}`);
res = await mf.dispatchFetch(url("Skinny"), { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": res.headers.get("ETag") },
  body: JSON.stringify({ title: "Skinny", tags: ["todo", "done", "again"], fields: { _is_skinny: "" } }) });
skinnyStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny")).text());
check("...also in TiddlyWeb's layout", res.status === 204 && skinnyStored.text === "text that must stay" && skinnyStored.tags.length === 3 && !("_is_skinny" in skinnyStored),
  `status ${res.status} ${JSON.stringify(skinnyStored)}`);
res = await save("Skinny, not stored", { tags: ["x"], _is_skinny: "" });
const notStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny, not stored")).text());
check("...and one the worker doesn't have is stored without text, without the mark", res.status === 204 && !("text" in notStored) && !("_is_skinny" in notStored),
  JSON.stringify(notStored));
// A text sent with the mark was typed into the empty editor of a tiddler whose text hadn't loaded
// (opened offline, say: limits 5): it's what was meant, and is stored as sent. Only a save without a
// text, or with an empty one (that editor starts empty), keeps the stored text
res = await save("Skinny", { tags: ["todo", "done", "again"], _is_skinny: "", text: "typed into the empty editor" });
skinnyStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny")).text());
check("a save with the mark and a text typed in stores that text, without the mark", res.status === 204 && skinnyStored.text === "typed into the empty editor" && !("_is_skinny" in skinnyStored),
  `status ${res.status} ${JSON.stringify(skinnyStored)}`);
res = await mf.dispatchFetch(url("Skinny"), { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": res.headers.get("ETag") },
  body: JSON.stringify({ title: "Skinny", tags: ["todo"], text: "typed, in TiddlyWeb's layout", fields: { _is_skinny: "" } }) });
skinnyStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny")).text());
check("...also in TiddlyWeb's layout", res.status === 204 && skinnyStored.text === "typed, in TiddlyWeb's layout" && !("_is_skinny" in skinnyStored), `status ${res.status} ${JSON.stringify(skinnyStored)}`);
res = await save("Skinny", { tags: ["todo"], _is_skinny: "", text: "" }, { "If-Match": res.headers.get("ETag") });
skinnyStored = JSON.parse(await (await bucket.get("recipes/default/tiddlers/Skinny")).text());
check("...while one with an empty text keeps the stored text", res.status === 204 && skinnyStored.text === "typed, in TiddlyWeb's layout" && JSON.stringify(skinnyStored.tags) === '["todo"]' && !("_is_skinny" in skinnyStored),
  `status ${res.status} ${JSON.stringify(skinnyStored)}`);
for (const title of ["Skinny", "Skinny, not stored"]) await del(title);

// --- 5. A tiddler whose title only looks like a draft is saved like any other ---------------------
const NOT_A_DRAFT = "Draft of 'Chapter 1'";
res = await save(NOT_A_DRAFT, { text: "my chapter" });
check("a tiddler titled \"Draft of '…'\" is stored", !!(await storedRevision(NOT_A_DRAFT)) && !!(await entry(NOT_A_DRAFT)), `status ${res.status}`);
res = await save("Draft of 'Old note'", { "draft.of": "Old note", "draft.title": "Old note", text: "editing" });
check("a real draft (draft.of field) still isn't stored", res.status === 204 && !(await storedRevision("Draft of 'Old note'")));
// Only $:/StoryList itself is a tab's own: a second story river's $:/StoryList/2, or a tiddler named
// $:/StoryListBackup, is stored like any other (the browser sends them, as TiddlyWiki syncs them)
const storyLike = ["$:/StoryList/2", "$:/StoryListBackup"];
const storyLikeSaves = [];
for (const t of storyLike) storyLikeSaves.push((await save(t, { list: "A B", text: "" })).status);
res = await save("$:/StoryList", { list: "A B" });
const storyLikeStored = await Promise.all(storyLike.map(async t => !!(await storedRevision(t)) && !!(await entry(t))));
check("titles that start like $:/StoryList are stored and listed; $:/StoryList itself isn't",
  storyLikeSaves.every(s => s === 204) && storyLikeStored.every(Boolean) && res.status === 204 && !(await storedRevision("$:/StoryList")) && !(await entry("$:/StoryList")),
  `saves ${JSON.stringify(storyLikeSaves)}, stored ${JSON.stringify(storyLikeStored)}`);
await bucket.put("recipes/default/tiddlers/Draft 2 of 'Ideas'", JSON.stringify({ title: "Draft 2 of 'Ideas'", text: "kept", revision: "5" }), { customMetadata: { revision: "5" } });
const withIdeas = await list();
withIdeas.push({ title: "Draft 2 of 'Ideas'", revision: "5", tags: [], type: "text/vnd.tiddlywiki" });
await bucket.put(LIST, JSON.stringify(withIdeas));
res = await del("Draft 2 of 'Ideas'");
check("deleting a tiddler titled \"Draft 2 of '…'\" deletes it", !(await storedRevision("Draft 2 of 'Ideas'")) && !(await entry("Draft 2 of 'Ideas'")), `status ${res.status}`);

// --- 5b. Awkward titles go through every step as TiddlyWiki sends them ------------------------------
// TiddlyWiki percent-encodes a title in the URL and in the ETag (TiddlyWeb's convention: the conflict
// guard builds If-Match the same way), so a comma or a slash in a title never splits anything, and the
// purge must name exactly the URL the browser asks the public site for
const AWKWARD = ["Hello, World", "100% sure?", "C# & F#", "a+b=c", "Café crème", "Emoji 🎉 title", "  spaced  ", 'He said "hi"', "It's",
  "a/b/c", "ünïcödé/sub", "Tilde~ (parens) *stars* !bang", "semi;colon:and=equals", "back\\slash"];
const awkward = [];
for (const title of AWKWARD) {
  const purgesBefore = purges.length;
  const first = await save(title, { text: "v1 of " + title }, { "If-None-Match": "*" });
  const etag = first.headers.get("ETag");
  const read = await mf.dispatchFetch(url(title));
  const readBody = read.status === 200 ? await read.json() : null;
  const second = await save(title, { text: "v2 of " + title }, { "If-Match": etag });   // the ETag as the browser sends it back
  const stale = await save(title, { text: "v3" }, { "If-Match": etag });                 // the old one: refused
  const listed = await entry(title);
  await new Promise(r => setTimeout(r, 150));   // (purges run after the answer)
  const purgeUrl = `https://wiki.example.com/recipes/default/tiddlers/${encodeURIComponent(title)}`;
  const purged = purges.slice(purgesBefore).some(p => p.files.includes(purgeUrl));
  const gone = await del(title, { "If-Match": second.headers.get("ETag") });
  const problems = [];
  if (first.status !== 204) problems.push(`create ${first.status}`);
  if (etag !== `"default/${encodeURIComponent(title)}/${etagRevision(first)}:auto"`) problems.push(`etag ${etag}`);
  if (read.status !== 200 || readBody?.title !== title || readBody?.text !== "v1 of " + title) problems.push(`read ${read.status}`);
  if (second.status !== 204) problems.push(`update with If-Match ${second.status}`);
  if (stale.status !== 412) problems.push(`stale save ${stale.status}`);
  if (!listed || String(listed.revision) !== etagRevision(second)) problems.push("not listed with the new revision");
  if (!purged) problems.push("purge URL");
  if (gone.status !== 204 || await storedRevision(title) || await entry(title)) problems.push(`delete ${gone.status}`);
  if (problems.length) awkward.push(`${JSON.stringify(title)}: ${problems.join(", ")}`);
}
check("awkward titles (comma, %, #, &, +, accents, emoji, spaces, quotes, slashes, a backslash) go through create, read, If-Match, 412, list, purge and delete",
  awkward.length === 0, awkward.join(" | "));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await mf.dispose();
process.exit(results.every(Boolean) ? 0 : 1);
