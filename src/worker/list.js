// The tiddler list (recipes/default/tiddlers.json, design 1.2): what TiddlyWiki loads at boot, one
// entry per stored tiddler with every field but the text. Changed with conditional writes, so two
// saves can't lose each other's entry, and rebuilt from the stored tiddlers when missing or damaged.
//
// The list is an index: every tiddler is also stored on its own, with all its fields. If the list
// is missing or damaged (a bad upload or hand edit), the worker rebuilds it from the stored
// tiddlers wherever it needs it (serving it, a save, a delete, a page build) and carries on. The
// damaged copy is kept in _repair/. Nothing runs in the background: the requests do the work.
//
// A request may make 1,000 R2 calls and use about 10 ms of CPU (Free plan), so a big wiki is
// rebuilt a step per request, its progress kept in _repair/. Until the last step the damaged list
// stays as it is, and the list, saves and deletes answer 503 without changing anything, so the
// browser simply asks again: the conflict guard at once, TiddlyWiki itself every 5 seconds.

import { concatBytes, decoder, encoder } from "./bytes.js";
import { listPurgeUrls, purgePublicCache } from "./cache.js";
import { waitMs } from "./settings.js";
import { BadSave, FLAT_LAYOUT, readStoredFields } from "./layout.js";
import { LIST_KEY, REPAIR_PROGRESS_KEY, TIDDLER_PREFIX, mapLimit, markPageOutdated, putIfAbsent } from "./storage.js";
import { getTwTimestamp, isDraft, isEphemeralTitle, isNewerRevision, revisionOf, tiddlerKey } from "./tiddlers.js";

// Drops anything that should never have been listed (drafts, story list, state...)
function scrubList(list) {
  return list.filter(t => !isEphemeralTitle(t.title || "") && !isDraft(t));
}

// The list's entries, or null if it isn't a JSON array of tiddlers
export function parseList(text) {
  try {
    const entries = JSON.parse(text);
    return Array.isArray(entries) && entries.every(e => e !== null && typeof e === "object" && typeof e.title === "string") ? entries : null;
  } catch (e) {
    return null;
  }
}

// The list as stored: entries is null if it's missing (object null) or damaged
async function getList(env) {
  const object = await env.WIKI_BUCKET.get(LIST_KEY);
  if (!object) return { object: null, text: null, entries: null };
  const text = await object.text();
  return { object, text, entries: parseList(text) };
}

// The revision a list (readableList) has for a title, or null if it isn't listed
export function listedRevision(list, title) {
  const entry = list.entries.find(e => e.title === title);
  return entry && entry.revision !== undefined && entry.revision !== null ? String(entry.revision) : null;
}

// The list, readable: { object, text, entries }. A missing or damaged list is rebuilt from the
// stored tiddlers first; throws ListRebuilding while that takes more requests.
export async function readableList(env, ctx, options) {
  const list = await getList(env);
  if (list.entries) return list;
  const rebuilt = await rebuildList(env, ctx, list, options);
  const entries = rebuilt?.entries;   // parsed once
  if (!entries) throw new ListRebuilding();
  return { object: rebuilt.object, text: rebuilt.text, entries };
}

// mutator(entries, attempt) returns the new list, or null when nothing needs to change (it may look
// something up first: a retried attempt means another request changed the list meanwhile). list: the
// list already read (readableList), used for the first attempt. Returns the list as now stored,
// { object, text, entries }, so a page build right after needn't read it again.
async function changeList(env, ctx, mutator, list = null, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { object: existing, text: existingText, entries } = list || await readableList(env, ctx);
    list = null;
    const etag = existing.etag || existing.httpEtag.replace(/"/g, "");

    const current = scrubList(entries);
    const changed = await mutator(current, attempt);
    if (changed === null) return { object: existing, text: existingText, entries: current };

    // Only if the list is still the one we read
    const text = JSON.stringify(changed);   // compact: a third smaller than indented, cheaper to write and read
    const written = await env.WIKI_BUCKET.put(LIST_KEY, text, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: etag }
    });

    if (written !== null) return { object: written, text, entries: changed };

    console.warn(`[Tiddler list] Write conflict detected, retrying (${attempt}/${attempts})...`);
    // A short, growing, slightly random pause, so saves that collided don't collide again
    await new Promise(resolve => setTimeout(resolve, 25 * attempt + Math.random() * 25));
  }

  throw new Error(`The tiddler list couldn't be updated: ${attempts} saves in a row got to it first. Try again.`);
}

// A tiddler's entry in the list: every field but the text. title: the title it's stored under
// (always text, whatever the body says); fields: the tiddler without its text.
// date fills in a missing modified or created date.
function listEntry(title, fields, revision, date = getTwTimestamp()) {
  const rest = { ...fields };
  delete rest.text;
  delete rest.revision;
  delete rest.bag;
  delete rest.recipe;
  return {
    ...rest,
    title,
    bag: "default",
    recipe: "default",
    modified: fields.modified || date,
    created: fields.created || date,
    tags: fields.tags || [],
    type: fields.type || "text/vnd.tiddlywiki",
    revision: String(revision),
    _is_skinny: ""
  };
}

// Returns { previous: the entry it replaced, or null; list: the list as now stored; superseded: a
// newer save of the tiddler is already listed (this save's list write was retried after it), so the
// list keeps that one; gone: the tiddler is no longer stored at this revision (a delete, or a
// recreate, landed while this save's list write was retried), so it isn't listed }
export async function updateList(env, ctx, title, fields, revision, list = null) {
  const entry = listEntry(title, fields, revision);
  let previous = null, superseded = false, gone = false;
  const stored = await changeList(env, ctx, async (entries, attempt) => {
    const idx = entries.findIndex(t => t.title === title);
    previous = idx >= 0 ? entries[idx] : null;
    superseded = !!previous && isNewerRevision(String(previous.revision), revision);
    if (superseded) return null;
    if (idx < 0) {
      // Unlisted on a retried attempt: a delete may have landed meanwhile (its list write is what
      // made this one fail) and removed the object with it, R2 deletes being unconditional. Only
      // what's stored is listed, and a version recreated since is listed by its own save
      if (attempt > 1) {
        const object = await env.WIKI_BUCKET.head(tiddlerKey(title));
        gone = !object || revisionOf(object) !== String(revision);
        if (gone) return null;
      }
      entries.push(entry);
      return entries;
    }
    entries[idx] = entry;
    // Listed twice (a hand edit, say): listed once from now on
    return entries.some((t, i) => i > idx && t.title === title) ? entries.filter((t, i) => i <= idx || t.title !== title) : entries;
  }, list);
  return { previous, list: stored, superseded, gone };
}

// Returns { removed: the entry it removed, or null if the title wasn't listed; list: the list as now
// stored; recreated: the title was saved again since the deleted revision (this delete's list write
// was retried after that save), so its entry stays }
export async function removeFromList(env, ctx, title, list = null, deletedRevision = null) {
  let removed = null, recreated = false;
  const stored = await changeList(env, ctx, (entries) => {
    removed = entries.find(t => t.title === title) || null;
    recreated = !!removed && !!deletedRevision && isNewerRevision(String(removed.revision), deletedRevision);
    if (recreated) removed = null;
    return removed ? entries.filter(t => t.title !== title) : null;
  }, list);
  return { removed, list: stored, recreated };
}

const REPAIR_STEP_TIDDLERS = 100;

const REPAIR_STALE_MS = 2 * 60 * 1000;

const LIST_REBUILDING = "The tiddler list is being rebuilt from the stored tiddlers. Try again in a moment.";

// Stands in for a missing list during a rebuild, so that each rebuild has its own list to replace
// (hence the time and random part). Public tabs read it straight from R2, so it isn't JSON:
// TiddlyWiki would take any JSON for a list and remove every tiddler not in it. The conflict guard
// recognises the first words and asks again a little later (it has the same text: keep both in step).
const LIST_STAND_IN_MARK = "Tiddler list being rebuilt";

function listStandIn() {
  return `${LIST_STAND_IN_MARK} (${new Date().toISOString()} ${crypto.randomUUID()})\n` +
    "The list was missing: the worker is rebuilding it from the stored tiddlers.\n";
}

function isListStandIn(text) {
  return typeof text === "string" && text.startsWith(LIST_STAND_IN_MARK);
}

class ListRebuilding extends Error {
  constructor() {
    super(LIST_REBUILDING);
  }
}

// The header tells the conflict guard this 503 is the rebuild (nothing was changed): it asks again
export function rebuildingResponse(corsHeaders) {
  return new Response(LIST_REBUILDING, {
    status: 503,
    headers: {
      ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
      "Retry-After": "1", "X-Tiddler-List": "rebuilding"
    }
  });
}

// The list entry for a stored tiddler (item: from list()), or null if it isn't listed. Its fields
// come before "text", so usually only the start of the object is read. An object not in the form
// the worker stores (an older version's file, a hand upload) is left out, never guessed at.
async function storedEntry(env, item) {
  const title = item.key.slice(TIDDLER_PREFIX.length);
  if (item.customMetadata?.layout !== FLAT_LAYOUT) {
    console.error(`Rebuilding the tiddler list: ${item.key} isn't stored the way the worker stores tiddlers, left out`);
    return null;
  }
  const read = await readStoredFields(env, item);
  if (!read) return null;
  const { fields, obj } = read;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    console.error(`Rebuilding the tiddler list: ${item.key} is not a readable tiddler, left out`);
    return null;
  }
  if (isEphemeralTitle(title) || isDraft(fields)) return null;
  // Listed under the title it's stored under (a save's body always has the same one)
  return listEntry(title, fields, revisionOf(obj), getTwTimestamp(obj.uploaded));
}

// One step of a rebuild. damaged: { object, text } of the list as found (object null if missing).
// Returns null while the rebuild needs more requests, otherwise the list as now stored
// ({ object, text, entries }: rebuilt here, with fresh: true and entries parsed on each access;
// or replaced meanwhile, entries null if still unreadable).
// pageBuild: called by the page build, which builds the page anyway.
export async function rebuildList(env, ctx, damaged, { pageBuild = false } = {}) {
  let list = damaged.object;
  if (!list) {
    // Missing: a stand-in takes its place, so this rebuild has a list of its own to replace
    list = await putIfAbsent(env, LIST_KEY, listStandIn(), { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    if (!list) return getList(env);   // created meanwhile
  }
  // Identifies this damaged list: the same content uploaded again later is another rebuild
  const rebuildId = `${list.etag}/${list.uploaded.getTime()}`;
  const progress = await env.WIKI_BUCKET.get(REPAIR_PROGRESS_KEY);
  const meta = progress?.customMetadata || {};
  const resume = progress !== null && meta.rebuild === rebuildId && Date.now() - progress.uploaded.getTime() < REPAIR_STALE_MS &&
    (meta.cursor !== undefined || meta.after !== undefined);   // a position this version wrote
  const done = resume ? new Uint8Array(await progress.arrayBuffer()) : new Uint8Array(0);
  if (progress && !resume) await progress.body.cancel();   // from another or an abandoned rebuild: start over
  if (!resume && damaged.object && !isListStandIn(damaged.text)) {
    // Kept, in case it holds a hand edit worth redoing
    await env.WIKI_BUCKET.put(`_repair/damaged-tiddler-list-${damaged.object.etag}.json`, damaged.text, {
      httpMetadata: { contentType: "application/json" }
    });
    console.error("The tiddler list can't be read: rebuilding it from the stored tiddlers. The damaged copy is in _repair/.");
  }

  // The next tiddlers, as many as this request can read
  const listing = await env.WIKI_BUCKET.list({
    prefix: TIDDLER_PREFIX, limit: REPAIR_STEP_TIDDLERS, include: ["customMetadata"],
    ...(resume ? (meta.cursor ? { cursor: meta.cursor } : { startAfter: decodeURIComponent(meta.after) }) : {})
  });
  const items = listing.objects;
  const entries = (await mapLimit(items, 6, item => storedEntry(env, item))).filter(Boolean);
  const added = encoder.encode(entries.map(entry => JSON.stringify(entry)).join(","));
  const all = concatBytes(done.length > 0 && added.length > 0 ? [done, encoder.encode(","), added] : [done, added]);
  const count = (resume ? Number(meta.count) || 0 : 0) + entries.length;

  if (listing.truncated) {
    // Only if the damaged list is still there (a request that read it just before another one
    // finished the rebuild would otherwise start a new one)
    if (!resume) {
      const current = await env.WIKI_BUCKET.head(LIST_KEY);
      if (!current || `${current.etag}/${current.uploaded.getTime()}` !== rebuildId) return getList(env);
    }
    // Where the next step starts (list() may return an empty page that isn't the last); the key is
    // encoded, as metadata may be sent as HTTP headers
    const position = items.length > 0 ? { after: encodeURIComponent(items[items.length - 1].key) } : { cursor: listing.cursor };
    const options = { customMetadata: { rebuild: rebuildId, count: String(count), ...position } };
    // Saved only if no other request took this step meanwhile (otherwise its progress stands)
    if (progress) await env.WIKI_BUCKET.put(REPAIR_PROGRESS_KEY, all, { ...options, onlyIf: { etagMatches: progress.etag } });
    else await putIfAbsent(env, REPAIR_PROGRESS_KEY, all, options);
    return null;
  }

  // Every tiddler read: the new list replaces the damaged one, unless it was replaced meanwhile.
  // It's written as is, without parsing it, so the last step costs no more than the others: each
  // key is read once (each step adds to the progress it read, and only if no other request did
  // meanwhile), and each key is one title.
  const text = `[${decoder.decode(all)}]`;
  const written = await env.WIKI_BUCKET.put(LIST_KEY, text, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: list.etag }
  });
  if (!written) return getList(env);
  if (progress) await env.WIKI_BUCKET.delete(REPAIR_PROGRESS_KEY);
  console.log(`Tiddler list rebuilt: ${count} tiddlers`);
  // Purged now, and again a little later: a public request that read the damaged list or the
  // stand-in just before could otherwise put it back in Cloudflare's cache for a day
  const urls = listPurgeUrls(env);
  ctx.waitUntil(purgePublicCache(env, urls));
  ctx.waitUntil(new Promise(resolve => setTimeout(resolve, waitMs(env, 5000))).then(() => purgePublicCache(env, urls)));
  if (!pageBuild) ctx.waitUntil(markPageOutdated(env));
  // Served as is; parsed only by callers that need the entries (a save, a page build)
  return { object: written, text, fresh: true, get entries() { return parseList(text); } };
}

export function failureResponse(what, error, corsHeaders) {
  if (error instanceof ListRebuilding) return rebuildingResponse(corsHeaders);
  return new Response(`${what}: ${error.message}`, { status: error instanceof BadSave ? 400 : 500, headers: corsHeaders });
}
