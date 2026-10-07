// TiddlyWiki on Cloudflare: the admin worker
//
// Serves the editable wiki (TiddlyWeb protocol) from an R2 bucket, protects against edit
// conflicts between tabs, keeps the public R2-served copy's cache fresh, writes plugins as files
// the page loads before TiddlyWiki boots, and backs every save up to GitHub through a Cloudflare
// Queue. See README.md for the full picture.
//
// worker.js is generated from src/worker.src.js by `npm run build`, which embeds the browser
// modules src/conflict-guard.js and src/page-publisher.js as CONFLICT_GUARD_SOURCE and
// PAGE_PUBLISHER_SOURCE.

function getTwTimestamp(date = new Date()) {
  return date.toISOString().replace(/\D/g, '').slice(0, 17);
}

// --- Edit-conflict protection ---------------------------------------------------------------
//
// How it works:
//  * Every tiddler has a revision: customMetadata.revision, a millisecond timestamp set on each
//    save. GET returns it in the body and in the ETag "default/<title>/<revision>:auto".
//  * The browser module below (baked into the wiki page) sends the revision its edit is based on
//    as If-Match, or If-None-Match: * for a brand new tiddler.
//  * PUT/DELETE answer 412 when that revision is no longer current, and the R2 write itself is
//    conditional, so two saves arriving at the same moment can't both win.
//  * Requests without If-Match/If-None-Match (old tabs, scripts) are still accepted, as before.

// Titles the wiki keeps only in the browser: never stored, never backed up. Drafts are recognised by
// their draft.of field (isDraft), not their title: a tiddler can be called "Draft of 'Chapter 1'".
function isEphemeralTitle(title) {
  return title.startsWith("$:/StoryList") ||
         title.startsWith("$:/HistoryList") ||
         title.startsWith("$:/state/") ||
         title.startsWith("$:/temp/") ||
         title.startsWith("$:/status/");
}

function isDraft(tiddler) {
  return tiddler["draft.of"] !== undefined;
}

// --- What the page needs at boot ---------------------------------------------------------------
// TiddlyWiki only runs startup actions, plugins and JavaScript modules that are present when it
// boots; anything that arrives later through sync is too late. Small startup tiddlers are baked
// into baked.html. Plugins and JavaScript modules each get a file in R2 (_plugins/<title>.js),
// which baked.html loads from the public site with a <script> tag before TiddlyWiki boots.

const STARTUP_TITLES = ["$:/DefaultTiddlers", "$:/SiteTitle", "$:/SiteSubtitle",
  // read at boot to choose the theme, language and palette
  "$:/theme", "$:/language", "$:/palette",
  // read once by TiddlyWiki's syncer, when it starts
  "$:/config/SyncPollingInterval", "$:/config/SyncThrottleInterval", "$:/config/SyncFilter", "$:/config/SyncDisableLazyLoading"];
const DISABLED_PLUGIN_PREFIX = "$:/config/Plugins/Disabled/";   // read at boot, when plugins are registered
const PLUGIN_FILE_TYPES = ["plugin", "theme", "language"];
const MODULE_TYPES = ["application/javascript", "application/json", "application/x-tiddler-dictionary"];   // TiddlyWiki defines modules from these at boot

// These take a saved tiddler or an entry of the tiddler list
function isStartupTiddler(tiddler) {
  const title = tiddler.title || "", tags = tiddler.tags;
  // (A list entry stored before field values had to be text, or by hand, may hold a tag that isn't)
  return STARTUP_TITLES.includes(title) || title.startsWith(DISABLED_PLUGIN_PREFIX) || (Array.isArray(tags)
    ? tags.some(tag => String(tag).includes("$:/tags/StartupAction"))
    : typeof tags === "string" && tags.includes("$:/tags/StartupAction"));
}

// Plugins (but not the core: it comes with index.html and is never synced) and JavaScript modules
function needsPluginFile(tiddler) {
  const pluginType = tiddler["plugin-type"];
  if (pluginType) {
    return PLUGIN_FILE_TYPES.includes(pluginType) && tiddler.title !== "$:/core" && tiddler.platform !== "server";
  }
  return MODULE_TYPES.includes(tiddler.type) && Boolean(tiddler["module-type"]);
}

function isPageTiddler(tiddler) {
  return isStartupTiddler(tiddler) || needsPluginFile(tiddler);
}

// Each tiddler is stored under its title
const TIDDLER_PREFIX = "recipes/default/tiddlers/";
function tiddlerKey(title) {
  return TIDDLER_PREFIX + title;
}

// R2 keys are at most 1024 bytes of UTF-8: a longer one can't be stored, so it isn't there either
const MAX_KEY_BYTES = 1024;
function keyTooLong(key) {
  // (A character is at most 3 bytes: most keys are cleared without encoding them)
  return key.length * 3 > MAX_KEY_BYTES && encoder.encode(key).length > MAX_KEY_BYTES;
}

// A path, or the title in one, decoded; null if it isn't valid percent-encoding
function decodePath(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function invalidPath(corsHeaders) {
  return new Response("Invalid path: it isn't valid percent-encoding", { status: 400, headers: corsHeaders });
}

// The revision of a stored tiddler, from the object's metadata. (An object without it isn't one
// the worker stored: its R2 etag stands in, so GET, PUT and DELETE still agree.)
function revisionOf(obj) {
  return obj.customMetadata?.revision || obj.etag;
}

function tiddlerEtag(title, revision) {
  return `"default/${encodeURIComponent(title)}/${revision}:auto"`;
}

// Turns an If-Match / If-None-Match header into revisions ("*" stays "*"). Accepts full TiddlyWeb
// ETags ("bag/title/revision:hash"), bare revisions, and weak (W/) or unquoted forms.
function parseEtagList(header) {
  if (!header) return [];
  return header.split(",")
    .map(token => token.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1").trim())
    .map(token => {
      if (token === "*") return token;
      const slash = token.lastIndexOf("/");
      const colon = token.lastIndexOf(":");
      return colon > slash ? token.substring(slash + 1, colon) : token.substring(slash + 1);
    })
    .filter(revision => revision && revision !== "undefined" && revision !== "null");
}

// Evaluates If-Match / If-None-Match against the current revision (null if the tiddler doesn't exist)
function checkPreconditions(request, currentRevision) {
  const ifMatch = parseEtagList(request.headers.get("If-Match"));
  const ifNoneMatch = parseEtagList(request.headers.get("If-None-Match"));
  let reason = null;
  if (ifMatch.length > 0) {
    if (currentRevision === null) reason = "it was deleted in another tab or browser";
    else if (!ifMatch.includes("*") && !ifMatch.includes(currentRevision)) reason = "it was changed in another tab or browser";
  }
  if (!reason && ifNoneMatch.length > 0 && currentRevision !== null &&
      (ifNoneMatch.includes("*") || ifNoneMatch.includes(currentRevision))) {
    reason = "a tiddler with this title was created in another tab or browser";
  }
  return { conditional: ifMatch.length > 0 || ifNoneMatch.length > 0, reason };
}

// Response headers for an R2 object: its stored HTTP metadata plus CORS
function objectHeaders(object, corsHeaders) {
  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  return headers;
}

function conflictResponse(title, reason, currentRevision, corsHeaders) {
  const headers = { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (currentRevision !== null) headers.ETag = tiddlerEtag(title, currentRevision);
  return new Response(`Edit conflict: '${title}' was not saved because ${reason}.`, { status: 412, headers });
}

// --- Reading a save ---------------------------------------------------------------------------
// Every tiddler is stored "flat": every field at the top level, compact JSON, "text" last, then the
// worker's revision, bag and recipe; customMetadata { revision, layout: "flat" }. The browser module
// sends exactly that, without revision, bag or recipe (header X-Tiddler-Layout: flat): the worker
// parses only the fields before "text" and appends its own, working on the raw bytes, so the text
// itself (a whole plugin, an image...) is never decoded, parsed or re-encoded. Anything else, such
// as TiddlyWeb JSON (custom fields under "fields", the text anywhere) from a tab without the module,
// is parsed and turned into the flat layout first.

const FLAT_LAYOUT = "flat";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEXT_KEY = encoder.encode(',"text":');

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Where ',"text":' starts in a flat body. Inside a JSON string every quote is escaped, so this
// sequence can only be the "text" key itself.
function textKeyOffset(bytes) {
  for (let i = bytes.indexOf(TEXT_KEY[0]); i !== -1; i = bytes.indexOf(TEXT_KEY[0], i + 1)) {
    if (TEXT_KEY.every((byte, j) => bytes[i + j] === byte)) return i;
  }
  return -1;
}

// A save whose body isn't a tiddler: answered 400, nothing stored
class BadSave extends Error {}

function isTiddlerObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string";
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadSave(`the body is not JSON (${e.message})`);
  }
}

// TiddlyWiki's field values are text, or lists of text (tags). An object can't be stored flat (a
// "text" key inside it would be taken for the tiddler's text), with one exception: a field called
// "fields" stays nested as { fields: value }, the way TiddlyWeb's layout has it, because a flat
// "fields" is where TiddlyWiki's loader looks for nested custom fields.
function isFieldValue(value) {
  return typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string"));
}
function isStorable(name, value) {
  if (name !== "fields") return isFieldValue(value);
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
    Object.hasOwn(value, "fields") && typeof value.fields === "string";
}

// TiddlyWiki unpacks that nested "fields" when it loads a tiddler through sync, but not the tiddlers
// the page hands it at boot (preloadTiddlers): the page build unpacks those
function hasNestedFields(tiddler) {
  return isStorable("fields", tiddler.fields);
}

const BOOKKEEPING = ["text", "revision", "bag", "recipe"];

// The fields before "text" of a body in the flat layout, or null if it isn't one
function flatFields(bytes, end) {
  let cut = textKeyOffset(bytes);
  if (cut === -1) cut = end - 1;   // no text: the fields run up to the closing brace
  if (bytes[0] !== 0x7b || bytes[end - 1] !== 0x7d || cut <= 0) return null;
  let fields = null;
  try { fields = JSON.parse(decoder.decode(bytes.subarray(0, cut)) + "}"); } catch (e) { return null; }
  // Pretty-printed, with these before "text", or with a value that isn't text: not the flat layout after all
  if (!isTiddlerObject(fields) || BOOKKEEPING.some(name => Object.hasOwn(fields, name)) ||
      !Object.entries(fields).every(([name, value]) => isStorable(name, value))) return null;
  return fields;
}

// Any other tiddler JSON, TiddlyWeb's layout included, turned into the flat layout
function toFlat(tiddler) {
  // A title that isn't text would make the tiddler list unreadable (and no browser sends one)
  if (!isTiddlerObject(tiddler)) throw new BadSave("the body is not a tiddler (a JSON object with a text title)");
  let { fields: custom = {}, text, revision, bag, recipe, ...fields } = tiddler;
  // In TiddlyWeb's layout, "fields" holds the custom fields (text there is a field called "fields")
  if (custom === null) custom = {};
  else if (typeof custom !== "object") custom = { fields: custom };
  else if (Array.isArray(custom)) throw new BadSave('"fields" must hold the custom fields');
  for (const [name, value] of Object.entries(custom)) {
    if (!Object.hasOwn(fields, name) && !BOOKKEEPING.includes(name)) fields[name] = value;
  }
  if (Object.hasOwn(fields, "fields")) fields.fields = { fields: fields.fields };   // see isStorable
  const notText = Object.keys(fields).find(name => !isStorable(name, fields[name]));
  if (notText !== undefined) throw new BadSave(`the field "${notText}" isn't text`);
  return { fields, bytes: encoder.encode(JSON.stringify(text === undefined ? fields : { ...fields, text })) };
}

// Returns { fields, stored(revision) }: fields = the tiddler without its text, stored(revision) =
// the bytes to store, with the worker's revision, bag and recipe
async function readSave(request) {
  let bytes = new Uint8Array(await request.arrayBuffer());
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] <= 0x20) end--;
  let fields = request.headers.get("X-Tiddler-Layout") === FLAT_LAYOUT ? flatFields(bytes, end) : null;
  if (!fields) {
    ({ fields, bytes } = toFlat(parseJsonBody(decoder.decode(bytes))));
    end = bytes.length;
  }
  return flatSave(fields, bytes.subarray(0, end));
}

// A save from its fields and its body in the flat layout (ending with "}")
function flatSave(fields, body) {
  return {
    fields,
    stored: revision => concatBytes([body.subarray(0, body.length - 1), storedSuffix(revision)])
  };
}

// What the worker appends to a stored tiddler, after its text
function storedSuffix(revision) {
  return encoder.encode(`,"revision":"${revision}","bag":"default","recipe":"default"}`);
}

// A tiddler TiddlyWiki has only the fields of (from the tiddler list; the text loads separately) is
// marked _is_skinny. Changed before its text arrives (a checkbox clicked during the first sync, say),
// it's saved without the text: the stored text is kept, as TiddlyWiki's own server does, rather than
// stored as nothing, and the mark isn't stored. current: the stored object, read with its body.
async function keepStoredText(save, current) {
  const { _is_skinny, ...fields } = save.fields;
  const head = encoder.encode(JSON.stringify(fields));
  let text = new Uint8Array(0);   // ',"text":"..."' of the stored tiddler
  if (current) {
    const stored = new Uint8Array(await current.arrayBuffer());
    const at = textKeyOffset(stored), suffix = storedSuffix(revisionOf(current));
    const tail = stored.subarray(stored.length - suffix.length);
    if (at !== -1 && suffix.every((byte, i) => tail[i] === byte)) {
      text = stored.subarray(at, stored.length - suffix.length);   // the stored layout: copied as bytes
    } else {
      // Stored by hand: read as JSON
      let value;
      try { value = JSON.parse(decoder.decode(stored)).text; } catch (e) {}
      if (typeof value === "string") text = encoder.encode(`,"text":${JSON.stringify(value)}`);
    }
  }
  return flatSave(fields, concatBytes([head.subarray(0, head.length - 1), text, encoder.encode("}")]));
}

// The rest of a save once the tiddler is stored: the tiddler list, the public cache and the page.
// list: the list as read before the tiddler was stored (readableList), or null to read it here.
// adminOrigin: the admin site's origin (where this request came to), see tiddlerPurgeUrls.
async function finishSave(env, ctx, title, fields, revision, list, adminOrigin) {
  const { previous, list: stored, superseded } = await updateManifest(env, ctx, title, fields, revision, list);
  // A newer save of this tiddler got there first: its purge, plugin file and page build are the ones
  if (superseded) return;
  // Only once the new list is in R2: a public request between the purge and the list update
  // would put the old list back in Cloudflare's cache
  ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title, adminOrigin)));
  const saved = { ...fields, title };
  if (previous && needsPluginFile(previous) && !needsPluginFile(saved)) {
    await env.WIKI_BUCKET.delete(pluginFileKey(title));
  }
  // Something the page needs at boot was added, changed or is no longer needed: rebuild the
  // page (which writes the plugin file) before confirming, so a reload right after has it
  if (isPageTiddler(saved) || (previous && isPageTiddler(previous))) {
    await rebuildPage(env, ctx, stored);
  }
}

// Rebuilds the page after a save or delete. If that fails (an R2 error), the change itself is
// stored: the page is marked outdated instead, so the next page load builds it (and writes any
// missing plugin file) rather than keep serving it without the change.
async function rebuildPage(env, ctx, list) {
  if (!(await rebakeHtml(env, ctx, list))) await markPageOutdated(env);
}

// Whether the stored object holds exactly what this save would store with that revision
// (current: the object as head() returned it)
async function storesSameContent(env, current, save, revision) {
  const wouldStore = save.stored(revision);
  // Different sizes, different content: no need to read it (a real conflict, nearly always)
  if (current.size !== wouldStore.length) return false;
  const obj = await env.WIKI_BUCKET.get(current.key);
  if (!obj) return false;
  const stored = new Uint8Array(await obj.arrayBuffer());
  if (stored.length !== wouldStore.length) return false;
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== wouldStore[i]) return false;
  }
  return true;
}

// Waits for work the response depends on, and keeps it running even if the browser disconnects
// first (a reload while the page is being rebuilt, say): without waitUntil it could be cancelled
function untilDone(ctx, promise) {
  ctx.waitUntil(promise.catch(() => {}));
  return promise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The admin page reads tiddlers from the public site too, so both answer cross-origin requests.
    // TiddlyWiki reads the ETag of each save, which a browser only shows a page that's told it may.
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, X-Tiddler-Layout, If-Match, If-None-Match, Accept",
      "Access-Control-Expose-Headers": "ETag, X-Tiddler-List, Retry-After",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 1. STATUS ENDPOINT: the same answer always, so the browser keeps it (ADMIN_STATUS)
    if (request.method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify(ADMIN_STATUS), { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": STATUS_CACHE } });
    }

    // 2. SERVE WIKI UI (baked.html is rebuilt automatically when index.html or the conflict guard changes)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/baked.html")) {
      return serveWiki(request, env, ctx, corsHeaders);
    }

    // 3. READS
    if (request.method === "GET" || request.method === "HEAD") {
      const key = decodePath(url.pathname.substring(1));
      if (key === null) return invalidPath(corsHeaders);
      if (key === MANIFEST_KEY) return serveManifest(request, env, ctx, corsHeaders);

      const object = keyTooLong(key) ? null : await env.WIKI_BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404, headers: corsHeaders });
      const headers = objectHeaders(object, corsHeaders);
      const body = request.method === "GET" ? object.body : null;

      if (key.startsWith(TIDDLER_PREFIX)) {
        // Stored with its revision, bag and recipe already in place: served as is
        headers.set("Cache-Control", "no-cache");
        headers.set("ETag", tiddlerEtag(key.slice(TIDDLER_PREFIX.length), revisionOf(object)));
        return new Response(body, { headers });
      }
      headers.set("ETag", object.httpEtag);
      return new Response(body, { headers });
    }

    // 4. WRITES
    if (request.method === "PUT" && url.pathname === "/page/core") return publishCoreFile(request, env, url, corsHeaders);
    if (request.method === "PUT" && url.pathname === "/page/shell") return publishShell(request, env, ctx, corsHeaders);
    if (request.method === "PUT") return handleSave(request, env, ctx, url, corsHeaders);

    // 5. DELETES
    if (request.method === "DELETE") return handleDelete(request, env, ctx, url, corsHeaders);

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  },

  // Queue consumer: commits queued saves and deletes to GitHub, one at a time
  async queue(batch, env, ctx) {
    await processBackupBatch(batch, env);
  }
};

// --- Saves and deletes ------------------------------------------------------------------------

// PUT recipes/default/tiddlers/<title>: a save (README 4.4)
async function handleSave(request, env, ctx, url, corsHeaders) {
  try {
    const match = url.pathname.match(/^\/recipes\/default\/tiddlers\/(.+)$/);
    if (!match) return new Response("Invalid PUT path", { status: 400, headers: corsHeaders });

    const title = decodePath(match[1]);
    if (title === null) return invalidPath(corsHeaders);
    let save = await readSave(request);
    // Stored and listed under the title in the URL: a different one in the body would make the
    // list disagree with the stored tiddlers (the browser always sends the same one)
    if (save.fields.title !== title) throw new BadSave("the title in the body isn't the one in the URL");

    if (isEphemeralTitle(title) || isDraft(save.fields)) {
      return savedResponse(title, Date.now().toString(), corsHeaders);
    }
    if (keyTooLong(tiddlerKey(title))) {
      throw new BadSave(`the title is too long: R2 keys hold at most ${MAX_KEY_BYTES - TIDDLER_PREFIX.length} bytes of it (UTF-8)`);
    }

    // The stored tiddler and the tiddler list, read at once (one round trip, not two). While a
    // damaged list is being rebuilt, readableList throws: the save is refused (503) without
    // changing anything, so the browser's retry can't conflict with it.
    // (A save without its text, keepStoredText, reads the stored text too.)
    const key = tiddlerKey(title), skinny = Object.hasOwn(save.fields, "_is_skinny");
    const [current, list] = await Promise.all([skinny ? env.WIKI_BUCKET.get(key) : env.WIKI_BUCKET.head(key), readableList(env, ctx)]);
    const currentRevision = current ? revisionOf(current) : null;
    if (skinny) save = await keepStoredText(save, current);

    const { conditional, reason } = checkPreconditions(request, currentRevision);
    if (reason) {
      // A retry of a save that was stored but whose list update then failed: the stored tiddler
      // is exactly what this save would store, so finish that save instead of refusing it.
      // (Otherwise the browser sees the identical copy, adopts it, and the list is never fixed.)
      if (current && await storesSameContent(env, current, save, currentRevision)) {
        await untilDone(ctx, finishSave(env, ctx, title, save.fields, currentRevision, list, url.origin));
        return savedResponse(title, currentRevision, corsHeaders);
      }
      return conflictResponse(title, reason, currentRevision, corsHeaders);
    }

    const newRevision = Date.now().toString();
    const body = save.stored(newRevision);
    const putOptions = {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { revision: newRevision, layout: FLAT_LAYOUT }
    };

    if (conditional) {
      // Only write if the object is still exactly the one we checked (or still absent)
      let written = await env.WIKI_BUCKET.put(key, body, {
        ...putOptions,
        onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" })
      });
      if (written === null && !current && !(await env.WIKI_BUCKET.head(key))) {
        // A create-only write was refused but nothing is there: write it normally
        written = await env.WIKI_BUCKET.put(key, body, putOptions);
      }
      if (written === null) {
        const latest = await env.WIKI_BUCKET.head(key);
        return conflictResponse(title, "it was changed in another tab or browser", latest ? revisionOf(latest) : null, corsHeaders);
      }
    } else {
      await env.WIKI_BUCKET.put(key, body, putOptions);
    }

    ctx.waitUntil(queueBackup(env, { action: "save", title, revision: newRevision, content: body }));
    await untilDone(ctx, finishSave(env, ctx, title, save.fields, newRevision, list, url.origin));

    return savedResponse(title, newRevision, corsHeaders);
  } catch (error) {
    return failureResponse("Save failed", error, corsHeaders);
  }
}

// The answer to a save: TiddlyWiki reads the new revision from the ETag
function savedResponse(title, revision, corsHeaders) {
  return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: tiddlerEtag(title, revision) } });
}

// DELETE bags/<bag>/tiddlers/<title> (or recipes/<recipe>/...): a delete (README 4.4)
async function handleDelete(request, env, ctx, url, corsHeaders) {
  try {
    const match = url.pathname.match(/^\/(?:bags|recipes)\/[^\/]+\/tiddlers\/(.+)$/);
    if (!match) return new Response("Invalid DELETE path", { status: 400, headers: corsHeaders });

    const title = decodePath(match[1]);
    if (title === null) return invalidPath(corsHeaders);
    // The story list, state and temp tiddlers are never stored, nor a title too long for a key,
    // so there is nothing to delete or back up
    if (isEphemeralTitle(title) || keyTooLong(tiddlerKey(title))) return new Response(null, { status: 204, headers: corsHeaders });

    // Read first, like a save (see there). The check below is then followed at once by the
    // delete, which can't be made conditional.
    const list = await readableList(env, ctx);
    const found = await env.WIKI_BUCKET.head(tiddlerKey(title));
    let currentRevision;
    if (found) {
      currentRevision = revisionOf(found);
      const { reason } = checkPreconditions(request, currentRevision);
      if (reason) return conflictResponse(title, reason, currentRevision, corsHeaders);
      await env.WIKI_BUCKET.delete(found.key);
    }
    // Queued before the list update, which may fail (the retry then finds nothing to delete)
    if (found) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
    await untilDone(ctx, (async () => {
      // If it was neither stored nor listed, there is nothing to back up or purge
      let { removed, list: stored, recreated } = await removeFromManifest(env, ctx, title, list, found ? currentRevision : null);
      if (recreated) {
        // Saved again since: that save's purge, plugin file and page build are the ones. Unless that
        // save landed between the check above and the delete, which then removed it too (an R2
        // delete can't be conditional): nothing is stored, so the entry goes as well
        if (await env.WIKI_BUCKET.head(tiddlerKey(title))) return;
        ({ removed, list: stored } = await removeFromManifest(env, ctx, title, stored));
      }
      if (!found && removed) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
      if (found || removed) ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title, url.origin)));
      // The list entry says what it was; if it wasn't listed, delete any plugin file anyway
      // (deleting a missing object is free) and rebuild the page for system tiddlers
      if (removed ? needsPluginFile(removed) : found) {
        await env.WIKI_BUCKET.delete(pluginFileKey(title));
      }
      if (removed ? isPageTiddler(removed) : found && title.startsWith("$:/")) {
        await rebuildPage(env, ctx, stored);
      }
    })());

    return new Response(null, { status: 204, headers: corsHeaders });
  } catch (error) {
    return failureResponse("Delete failed", error, corsHeaders);
  }
}

// --- Public site cache ----------------------------------------------------------------------
// The public wiki is served straight from the R2 bucket through Cloudflare's cache, so after a
// change we purge exactly the public URLs that serve it (single-file purge, not purge_everything).
// Set the worker variable PUBLIC_WIKI_URL to change the public address.

const DEFAULT_PUBLIC_WIKI_URL = "https://my-tiddlywiki.theophile.dev";

// The query string is part of the cache key, so the tiddler list is purged under each URL
// TiddlyWiki requests it with: the TiddlyWiki 5.4 filter, the filter of earlier versions, and bare.
const SKINNY_LIST_FILTERS = [
  "[all[tiddlers]] -[[$:/isEncrypted]] -[prefix[$:/temp/]] -[prefix[$:/status/]] -[[$:/boot/boot.js]] -[[$:/boot/bootprefix.js]] -[has[plugin-type]field:platform[server]] -[[$:/library/sjcl.js]] -[[$:/core]]",
  "[all[tiddlers]] -[[$:/isEncrypted]] -[prefix[$:/temp/]] -[prefix[$:/status/]] -[[$:/boot/boot.js]] -[[$:/boot/bootprefix.js]] -[[$:/library/sjcl.js]] -[[$:/core]]"
];

// URLs that serve the wiki page itself
const PUBLIC_PAGE_PATHS = ["/", "/baked.html"];

function publicUrl(env, path) {
  return (env.PUBLIC_WIKI_URL || DEFAULT_PUBLIC_WIKI_URL).replace(/\/+$/, "") + path;
}

// Encoded the same way TiddlyWiki encodes them when it requests them. The admin page reads tiddlers
// from the public site too, cross-origin: its requests carry an Origin header, which Cloudflare
// keeps in the cache key, so its copy is a separate cache entry, purged with that header.
function tiddlerPurgeUrls(env, title, adminOrigin) {
  const url = publicUrl(env, `/recipes/default/tiddlers/${encodeURIComponent(title)}`);
  return [url, { url, headers: { Origin: adminOrigin } }, ...listPurgeUrls(env)];
}

function listPurgeUrls(env) {
  return [
    publicUrl(env, "/recipes/default/tiddlers.json"),
    ...SKINNY_LIST_FILTERS.map(filter => publicUrl(env, `/recipes/default/tiddlers.json?filter=${encodeURIComponent(filter)}`))
  ];
}

async function purgePublicCache(env, urls) {
  if (!env.CF_ZONE_ID || !env.CF_API_TOKEN || urls.length === 0) return;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ files: urls })
    });
    if (!res.ok) console.error(`Cache purge failed (${res.status}):`, await res.text());
  } catch (e) {
    console.error("Cache purge exception:", e.message);
  }
}

// Serves the tiddler list, answering 304 when the browser already has the current version
async function serveManifest(request, env, ctx, corsHeaders) {
  // Our ETag is "<R2 etag>-patched"; Cloudflare's compression may hand it back weakened as W/"..."
  const known = parseEtagList(request.headers.get("If-None-Match")).find(token => token.endsWith("-patched"));
  // The admin wiki asks how backups go with this request (README 4.7): read at the same time
  const [listObject, backups] = await Promise.all([
    env.WIKI_BUCKET.get(MANIFEST_KEY, known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -"-patched".length) } } : undefined),
    request.headers.get("X-Backup-Status") === "ask" ? readBackupStatus(env) : null
  ]);
  let object = listObject;
  const listHeaders = obj => {
    const headers = listResponseHeaders(obj, corsHeaders);
    if (backups) headers.set("X-Backup-Status", backupReport(env, backups.failing));
    return headers;
  };
  // A conditional get that fails its precondition returns the object without a body
  if (object && !("body" in object)) return new Response(null, { status: 304, headers: listHeaders(object) });

  let text = object ? await object.text() : null;
  let manifest = text === null ? null : parseList(text);
  // Every entry the worker writes has its bag and recipe: then the list is served as stored, not
  // written out again (which costs about as much CPU as reading it)
  if (manifest && manifest.every(t => t.bag && t.recipe)) return new Response(text, { headers: listHeaders(object) });
  if (!manifest) {
    // Missing or damaged: rebuilt from the stored tiddlers. (Answering [] would make every open tab
    // remove all its tiddlers as "missing from the server".)
    const rebuilt = await untilDone(ctx, rebuildList(env, ctx, { object, text }));
    // Just rebuilt: served as written (every entry already has its bag and recipe)
    if (rebuilt?.fresh) return new Response(rebuilt.text, { headers: listHeaders(rebuilt.object) });
    manifest = rebuilt?.entries;
    if (!manifest) return rebuildingResponse(corsHeaders);
    object = rebuilt.object;
  }
  // Written by hand, say
  manifest = manifest.map(t => ({ ...t, bag: t.bag || "default", recipe: t.recipe || "default" }));
  return new Response(JSON.stringify(manifest), { headers: listHeaders(object) });
}

function listResponseHeaders(object, corsHeaders) {
  const headers = objectHeaders(object, corsHeaders);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", `"${object.etag}-patched"`);
  return headers;
}

// --- Browser-side conflict guard -------------------------------------------------------------
// A TiddlyWiki startup module baked into the page by rebakeHtml(). Set the worker variable
// CONFLICT_GUARD to "off" to stop including it.

const CONFLICT_GUARD_TITLE = "$:/cfworker/conflict-guard.js";

// Tells the browser module where the public copy is, so the admin wiki can load tiddler contents
// from there (no worker request) and only ask the worker when that copy isn't current
const PUBLIC_URL_TITLE = "$:/cfworker/public-url";

// What /status answers on the admin site: TiddlyWeb's status. TiddlyWiki asks for it at every page
// load, before the tiddler list. It never changes, so the browser keeps it for a week (private: for
// that browser only): the next loads don't ask the worker, nor wait for its answer. (The public site
// has its own file, README 3.1.)
const ADMIN_STATUS = { username: "admin", read_only: false, anonymous: false, logout_is_available: true, space: { recipe: "default" } };
const STATUS_CACHE = "private, max-age=604800";

const CONFLICT_GUARD_SOURCE = "__CONFLICT_GUARD_SOURCE__";   // replaced by the build

// The second browser module: publishes the page from the admin wiki (see "The page" below). Baked
// with the first, with what the page was built from, so it can tell when it needs publishing again.
const PAGE_PUBLISHER_TITLE = "$:/cfworker/page-publisher.js";
const PAGE_SOURCE_TITLE = "$:/cfworker/page-source";
const PAGE_PUBLISHER_SOURCE = "__PAGE_PUBLISHER_SOURCE__";   // replaced by the build

function conflictGuardEnabled(env) {
  return String(env.CONFLICT_GUARD || "").toLowerCase() !== "off";
}

// Changes whenever the browser modules or the public URL change, so baked.html is rebuilt after a
// deploy (the number in front changes when the way pages are built changes). Asked at every page
// load: worked out once while the worker runs (hashing the modules costs about 0.3 ms), again only
// if its settings change.
let lastBakeVersion = { settings: null, version: "" };
function bakeVersion(env) {
  const enabled = conflictGuardEnabled(env), settings = enabled + "\n" + publicUrl(env, "/");
  if (lastBakeVersion.settings !== settings) {
    const input = (enabled ? CONFLICT_GUARD_SOURCE + "\n" + PAGE_PUBLISHER_SOURCE : "off") + "\n" + publicUrl(env, "/");
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
    }
    lastBakeVersion = { settings, version: "7-" + hash.toString(36) };
  }
  return lastBakeVersion.version;
}

// The page's ETag is "<baked.html's R2 etag>-page". The browser asks with it (If-None-Match, maybe
// weakened to W/ by Cloudflare's compression), and an unchanged page answers 304: nothing to
// download, and its body isn't even read from R2.
// Cloudflare features that rewrite HTML remove the ETag on the way out, and one of them (Replace
// insecure JavaScript libraries) is on by default on the Free plan and can only be turned off for
// the whole zone. So the page also has a Last-Modified date, which they keep: the browser then
// asks with If-Modified-Since. The date is the page's version (pageTime, in seconds, set when it's
// stored, later than the previous page's even within the same second), and it has to match exactly.
const PAGE_ETAG_SUFFIX = "-page";

function pageHeaders(htmlHeaders, page) {
  const headers = { ...htmlHeaders, ETag: `"${page.etag}${PAGE_ETAG_SUFFIX}"` };
  const time = Number(page.customMetadata?.pageTime);
  if (time) headers["Last-Modified"] = new Date(time * 1000).toUTCString();
  return headers;
}

async function serveWiki(request, env, ctx, corsHeaders) {
  const htmlHeaders = { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
  const ifNoneMatch = request.headers.get("If-None-Match");
  const known = parseEtagList(ifNoneMatch).find(token => token.endsWith(PAGE_ETAG_SUFFIX));
  // Only without an ETag, as HTTP says
  const since = ifNoneMatch ? NaN : Math.floor(Date.parse(request.headers.get("If-Modified-Since") || "") / 1000);
  const [baked, source] = await Promise.all([
    env.WIKI_BUCKET.get("baked.html", known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -PAGE_ETAG_SUFFIX.length) } } : undefined),
    env.WIKI_BUCKET.head("index.html")
  ]);
  if (baked) {
    const meta = baked.customMetadata || {};
    // A conditional get whose precondition fails returns the object without a body: the browser has it
    const hasBody = "body" in baked;
    if (!source || (meta.bakeVersion === bakeVersion(env) && meta.sourceEtag === source.etag)) {
      const headers = pageHeaders(htmlHeaders, baked);
      if (hasBody && since !== Number(meta.pageTime)) return new Response(baked.body, { headers });
      if (hasBody) await baked.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (hasBody) await baked.body.cancel();
  }
  // (Finished even if the browser goes away first: a reload while it builds, say)
  const rebuilt = await untilDone(ctx, rebakeHtml(env, ctx));
  // With its ETag and date, so the next load is already a 304 (unless another build's page was kept)
  if (rebuilt) return new Response(rebuilt.html, { headers: rebuilt.page ? pageHeaders(htmlHeaders, rebuilt.page) : htmlHeaders });
  // The rebuild failed (see the logs): the last page built is better than the bare engine
  const lastPage = baked && await env.WIKI_BUCKET.get("baked.html");
  if (lastPage) return new Response(lastPage.body, { headers: htmlHeaders });
  const fallback = await env.WIKI_BUCKET.get("index.html");
  if (!fallback) return new Response("Wiki not found", { status: 404 });
  return new Response(fallback.body, { headers: htmlHeaders });
}

// --- Plugin files -------------------------------------------------------------------------------
// _plugins/<title>.js holds the stored tiddler, untouched, inside the same code the external-plugins
// export template produces: it adds the tiddler to $tw.preloadTiddlers before TiddlyWiki boots.
// The file name never changes; the page loads it as <title>.js?v=<revision>, so every version has
// its own URL and nothing needs purging. Files are served by the public site, never by the worker.

const PLUGIN_FILE_DIR = "_plugins/";
const PRELOAD_OPEN = "{\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([";
const PRELOAD_CLOSE = "]);\n}\n";
// A tiddler with a field called "fields" (stored nested: hasNestedFields) is unpacked first
const PRELOAD_NESTED_OPEN = "{\nconst t = ";
const PRELOAD_NESTED_CLOSE = ";\nt.fields = t.fields.fields;\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([t]);\n}\n";

function pluginFileKey(title) {
  return `${PLUGIN_FILE_DIR}${title}.js`;
}

// Encoded the same way as the tiddler URLs the public wiki already loads
function pluginFileUrl(env, title, revision) {
  return publicUrl(env, `/${PLUGIN_FILE_DIR}${encodeURIComponent(title)}.js?v=${encodeURIComponent(revision)}`);
}

// Writes the plugin file from the stored tiddler. entry: its list entry; file: what head()
// returned for the file (or null).
// Two page builds can overlap, so it doesn't replace a file holding a newer version, and writes
// only if the file is still the one it looked at. After two lost races, a missing file is written
// unconditionally (like the PUT handler's create-only fallback): best effort, not a guarantee.
// Returns the revision the file holds, or null.
async function writePluginFile(env, entry, file) {
  const title = entry.title;
  const obj = await env.WIKI_BUCKET.get(tiddlerKey(title));
  if (!obj) return null;
  const revision = revisionOf(obj);
  const nested = hasNestedFields(entry);
  const content = concatBytes([
    encoder.encode(nested ? PRELOAD_NESTED_OPEN : PRELOAD_OPEN), new Uint8Array(await obj.arrayBuffer()), encoder.encode(nested ? PRELOAD_NESTED_CLOSE : PRELOAD_CLOSE)
  ]);
  const key = pluginFileKey(title);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const held = file?.customMetadata?.revision;
    if (held && (held === revision || isNewerRevision(held, revision))) return held;
    const options = {
      httpMetadata: { contentType: "text/javascript; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { revision }
    };
    // Create-only if missing; on the last try, a missing file is written whatever happens
    if (file) options.onlyIf = { etagMatches: file.etag };
    else if (attempt < 3) options.onlyIf = new Headers({ "If-None-Match": "*" });
    if (await env.WIKI_BUCKET.put(key, content, options)) return revision;
    file = await env.WIKI_BUCKET.head(key);   // another build wrote it meanwhile: look again
  }
  return file?.customMetadata?.revision ?? null;
}

// Makes sure each listed plugin's file holds its current version (writing it if not) and returns
// the <script> tags that load them, in the order of the tiddler list. Disabled plugins are loaded
// too: their disable flag is baked into the page, so TiddlyWiki skips them at boot. (Leaving them
// out would make the sync fetch them after boot, and TiddlyWiki would then ask for a reload.)
async function pluginScriptTags(env, entries) {
  const tags = await Promise.all(entries.map(async (entry) => {
    const file = await env.WIKI_BUCKET.head(pluginFileKey(entry.title));
    let revision = file?.customMetadata?.revision;
    if (!revision || revision !== String(entry.revision)) {
      revision = await writePluginFile(env, entry, file);
    }
    return revision ? `<script src="${pluginFileUrl(env, entry.title, revision)}"></script>` : "";
  }));
  return tags.filter(Boolean).join("\n");
}

// Inserts markup right after <head ...>. Works on the bytes of index.html (a few MB): decoding,
// editing and re-encoding the whole page as a string costs about ten times more CPU.
const pageDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });   // keeps a BOM, so offsets stay right
function insertAfterHead(html, markup) {
  for (const length of [16384, html.length]) {
    const start = pageDecoder.decode(html.subarray(0, length));
    const match = /<head[^>]*>/i.exec(start);
    if (match) {
      const at = encoder.encode(start.slice(0, match.index + match[0].length)).length;
      return concatBytes([html.subarray(0, at), encoder.encode(markup), html.subarray(at)]);
    }
    if (length >= html.length) break;
  }
  return html;
}

// A byte offset moved back to the start of a character, so a window never cuts one in two
function charStart(bytes, at) {
  while (at > 0 && at < bytes.length && (bytes[at] & 0xC0) === 0x80) at--;
  return at;
}

// Inserts markup right before the last occurrence of marker, looked for in the page's last 64 KB
// (all of it if it isn't there). Returns the new bytes, or null if the page doesn't have it.
function insertBeforeLast(html, marker, markup) {
  for (const length of [65536, html.length]) {
    const from = charStart(html, Math.max(0, html.length - length));
    const tail = pageDecoder.decode(html.subarray(from));
    const index = tail.lastIndexOf(marker);
    if (index >= 0) {
      const at = from + encoder.encode(tail.slice(0, index)).length;
      return concatBytes([html.subarray(0, at), encoder.encode(markup), html.subarray(at)]);
    }
    if (from === 0) break;
  }
  return null;
}

// Saves baked.html, unless an overlapping build has already saved a newer one for the same worker
// and index.html: from a newer tiddler list or a newer shell, and no older one of the other.
// "Newer" compares when R2 stored each (listVersion, shellVersion), so a list replaced by hand
// counts as newer too. If each page has the newer one of the two (a rare three-way overlap), this
// one is stored as outdated, so the next page load builds it from both. Each page gets its date
// (pageTime, see serveWiki). Returns the stored page (its R2 object), or null if it kept the other
// page. The last try writes unconditionally, like the create-only fallback in the PUT handler: best
// effort.
async function storePage(env, html, meta) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await env.WIKI_BUCKET.head("baked.html");
    const theirs = current?.customMetadata || {};
    let stored = meta;
    if (current && theirs.bakeVersion === meta.bakeVersion && theirs.sourceEtag === meta.sourceEtag) {
      const newerList = Number(theirs.listVersion) - Number(meta.listVersion),
        newerShell = Number(theirs.shellVersion || 0) - Number(meta.shellVersion);
      if (newerList >= 0 && newerShell >= 0 && (newerList > 0 || newerShell > 0)) return null;
      if (newerList > 0 || newerShell > 0) stored = { ...meta, bakeVersion: "outdated" };
    }
    const pageTime = Math.max(Math.floor(Date.now() / 1000), Number(theirs.pageTime || 0) + 1);
    const written = await env.WIKI_BUCKET.put("baked.html", html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { ...stored, pageTime: String(pageTime) },
      ...(current && attempt < 3 ? { onlyIf: { etagMatches: current.etag } } : {})
    });
    if (written) return written;
  }
  return null;
}

// Builds baked.html = the page source (the published shell, or index.html, see readPageSource) +
// startup tiddlers + browser modules + plugin <script> tags, then purges the public copy. source:
// the page source, if the caller has it. Returns { html (bytes), page: the stored page's R2 object,
// or null if an overlapping build's page was kept }, or null.
async function rebakeHtml(env, ctx, list = null, source = null) {
  try {
    const pageSource = source || await readPageSource(env);
    if (!pageSource) return null;
    let html = pageSource.html;

    // list: the list a save or delete has just written. Otherwise it's read, and a missing or
    // damaged one rebuilt first (a page built without it would have no plugins); while that takes
    // more requests, this throws and the page stays as it is.
    const { object: manifestObj, entries: manifest } = list || await readableList(env, ctx, { pageBuild: true });
    // Every stored tiddler is listed, so only listed startup tiddlers are read
    const startupTitles = manifest.filter(t => t.title && isStartupTiddler(t)).map(t => t.title);

    const store = [];
    const [, pluginTags] = await Promise.all([
      Promise.all(startupTitles.map(async (title) => {
        const obj = await env.WIKI_BUCKET.get(tiddlerKey(title));
        if (!obj) return;
        try {
          const tiddler = await obj.json();
          if (hasNestedFields(tiddler)) tiddler.fields = tiddler.fields.fields;
          store.push(tiddler);
        } catch (e) {}
      })),
      pluginScriptTags(env, manifest.filter(t => t.title && needsPluginFile(t)))
    ]);

    if (conflictGuardEnabled(env)) {
      store.push({
        title: CONFLICT_GUARD_TITLE,
        type: "application/javascript",
        "module-type": "startup",
        text: CONFLICT_GUARD_SOURCE
      });
      store.push({ title: PUBLIC_URL_TITLE, text: publicUrl(env, "/") });
      store.push({ title: PAGE_PUBLISHER_TITLE, type: "application/javascript", "module-type": "startup", text: PAGE_PUBLISHER_SOURCE });
      store.push({ title: PAGE_SOURCE_TITLE, type: "application/json", text: JSON.stringify({ index: pageSource.index, fingerprint: pageSource.fingerprint, core: pageSource.core }) });
    }

    // In a shell, plugins load right before the core (they must run before TiddlyWiki starts, which
    // the core does), so they don't hold up the top of the page (a splash screen). In a full
    // index.html, where TiddlyWiki starts from code inside the page, from <head>.
    // (Only a shell is searched: in index.html, the marker is only in TiddlyWiki's templates, so
    // the search would decode the whole page for nothing, and one in raw markup isn't the place.)
    let pluginsPlaced = false;
    if (pluginTags && pageSource.fingerprint) {
      const placed = insertBeforeLast(html, EXTERNAL_SCRIPTS_MARKER, `${pluginTags}\n`);
      if (placed) {
        html = placed;
        pluginsPlaced = true;
      }
    }

    let injected = "";
    if (store.length > 0) {
      const safeJson = JSON.stringify(store).replace(/</g, '\\u003c');
      injected = `
        <script>
          window.$tw = window.$tw || {};
          window.$tw.preloadTiddlers = window.$tw.preloadTiddlers || [];
          window.$tw.preloadTiddlers = window.$tw.preloadTiddlers.concat(${safeJson});
        </script>
      `;
    }
    if (pluginTags && !pluginsPlaced) injected += `\n${pluginTags}\n`;
    if (injected) html = insertAfterHead(html, `\n${injected}\n`);

    const stored = await storePage(env, html, {
      bakeVersion: bakeVersion(env),
      sourceEtag: pageSource.index,
      shell: pageSource.fingerprint,
      shellVersion: String(pageSource.shellVersion || 0),
      listVersion: String(manifestObj ? manifestObj.uploaded.getTime() : 0)
    });
    if (stored) ctx.waitUntil(purgePublicCache(env, PUBLIC_PAGE_PATHS.map(path => publicUrl(env, path))));
    return { html, page: stored };
  } catch (err) {
    console.error("Failed to rebake HTML:", err);
    return null;
  }
}

// --- The page -----------------------------------------------------------------------------------
// The admin wiki renders the page itself, with TiddlyWiki's own $:/core/templates/tiddlywiki5-external-js.html
// (src/page-publisher.js): the shell, which is everything TiddlyWiki writes in its file (title,
// language, raw markup...) but the core, and the core file, loaded at the end of the shell. The shell
// is kept in _page/shell.html, with the index.html it was rendered for; the page is built from it
// while that's the current index.html, and from index.html itself otherwise (a new upload, until
// the admin wiki publishes a shell for it). index.html is never changed. The core file is
// _plugins/tiddlywikicore.js, served by the public site as ?v=<TiddlyWiki version>-<format> and
// cached for a year, like plugin files.

const SHELL_KEY = "_page/shell.html";
const SHELL_LIMIT = 2 * 1024 * 1024;
const CORE_KEY = "_plugins/tiddlywikicore.js";
const CORE_LIMIT = 20 * 1024 * 1024;
const EXTERNAL_SCRIPTS_MARKER = "<!--~~ Load external JavaScripts ~~-->";

// An unescaped "$:/config/SaveWikiButton/Template": TiddlyWiki's own line in the core file, not a
// mention inside the core plugin's JSON
const SAVE_TEMPLATE_SETTING = /[^\\]"\$:\/config\/SaveWikiButton\/Template"/;

function coreFileUrl(env, version) {
  return publicUrl(env, `/${CORE_KEY}?v=${encodeURIComponent(version)}`);
}

// What a page is built from: { html (bytes), index: index.html's ETag, fingerprint: the shell's
// ("" for index.html itself), core: the stored core file's version ("" if none) }, or null if
// there's no index.html
async function readPageSource(env) {
  const [index, shell, coreFile] = await Promise.all([
    env.WIKI_BUCKET.head("index.html"), env.WIKI_BUCKET.get(SHELL_KEY), env.WIKI_BUCKET.head(CORE_KEY)
  ]);
  const core = coreFile?.customMetadata?.v || "";
  if (shell && index && shell.customMetadata?.index === index.etag) {
    return { html: new Uint8Array(await shell.arrayBuffer()), index: index.etag, fingerprint: shell.customMetadata.fingerprint || "", core, shellVersion: shell.uploaded.getTime() };
  }
  if (shell) await shell.body.cancel();
  const full = await env.WIKI_BUCKET.get("index.html");
  return full && { html: new Uint8Array(await full.arrayBuffer()), index: full.etag, fingerprint: "", core };
}

function refusal(message, corsHeaders, status = 400) {
  return new Response(message, { status, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

// PUT /page/core?v=<TiddlyWiki version>-<format>: TiddlyWiki's core file, rendered by the admin wiki
// (once per version). The same version again isn't rewritten.
async function publishCoreFile(request, env, url, corsHeaders) {
  const version = url.searchParams.get("v") || "";
  if (!/^[0-9A-Za-z.+]+(-[0-9A-Za-z.+]+)*-\d+$/.test(version)) {
    return refusal(`"${version}" isn't a core file version (<TiddlyWiki version>-<format>).`, corsHeaders);
  }
  const current = await env.WIKI_BUCKET.head(CORE_KEY);
  if (current?.customMetadata?.v === version) return new Response(null, { status: 204, headers: corsHeaders });
  if (Number(request.headers.get("Content-Length")) > CORE_LIMIT) return refusal("The core file is too big.", corsHeaders);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > CORE_LIMIT) return refusal("The core file is too big.", corsHeaders);
  // It starts like TiddlyWiki's core file and ends with its boot code
  const start = pageDecoder.decode(bytes.subarray(0, charStart(bytes, Math.min(bytes.length, 8192))));
  const end = pageDecoder.decode(bytes.subarray(charStart(bytes, Math.max(0, bytes.length - 524288))));
  if (!start.startsWith("/*") || !start.includes("$tw.preloadTiddlers") || !end.includes('"$:/boot/boot.js"')) {
    return refusal("That isn't TiddlyWiki's core file.", corsHeaders);
  }
  // The admin wiki takes out TiddlyWiki's line switching the save template to the external-core one
  // (just before the boot code; the core plugin's mentions of the setting are escaped JSON). Still
  // there, TiddlyWiki has changed it: refused, so it shows, and the page stays built from index.html
  if (SAVE_TEMPLATE_SETTING.test(end)) {
    return refusal("The core file still switches the save template to the external-core one: this version of TiddlyWiki writes it in a way the page publisher doesn't know. Update the worker. Meanwhile the page is built from index.html.", corsHeaders);
  }
  await env.WIKI_BUCKET.put(CORE_KEY, bytes, {
    httpMetadata: { contentType: "application/javascript; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { v: version }
  });
  return new Response(null, { status: 204, headers: corsHeaders });
}

// PUT /page/shell: the page rendered by the admin wiki, without the core. X-Page-Fingerprint: its
// fingerprint (computed by the admin wiki); X-Page-Index: the index.html the admin page was built
// for. Refused unless it's a page that works: TiddlyWiki's tiddler store with the TiddlyWeb plugin,
// and the stored core file loaded at the end. The same shell again only makes sure the page is
// built from it.
async function publishShell(request, env, ctx, corsHeaders) {
  const fingerprint = request.headers.get("X-Page-Fingerprint") || "";
  if (!fingerprint || fingerprint.length > 100) return refusal("The shell has no fingerprint (X-Page-Fingerprint).", corsHeaders);
  if (Number(request.headers.get("Content-Length")) > SHELL_LIMIT) return refusal("The shell is too big.", corsHeaders);
  const [index, core, kept] = await Promise.all([
    env.WIKI_BUCKET.head("index.html"), env.WIKI_BUCKET.head(CORE_KEY), env.WIKI_BUCKET.head(SHELL_KEY)
  ]);
  if (!index || request.headers.get("X-Page-Index") !== index.etag) {
    return refusal("index.html has changed since this page was loaded: reload the admin wiki.", corsHeaders, 409);
  }
  if (kept?.customMetadata?.index === index.etag && kept.customMetadata.fingerprint === fingerprint) {
    const page = await env.WIKI_BUCKET.head("baked.html");
    if (page?.customMetadata?.sourceEtag === index.etag && page.customMetadata.shell === fingerprint) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > SHELL_LIMIT) return refusal("The shell is too big.", corsHeaders);
  const text = pageDecoder.decode(bytes);
  if (!text.includes("<!--~~ Ordinary tiddlers ~~-->") || !text.includes('<script class="tiddlywiki-tiddler-store"')) {
    return refusal("The shell has no tiddler store.", corsHeaders);
  }
  if (!/"title":"\$:\/plugins\/tiddlywiki\/tiddlyweb"/.test(text)) {
    // Usually TiddlyWeb installed or updated from the wiki: the publisher then leaves it to its file
    return refusal("The page doesn't contain the TiddlyWeb plugin, so it couldn't sync. If TiddlyWeb was installed or updated from the wiki, delete it there and reload to go back to the one in index.html, or upload an index.html with that version.", corsHeaders);
  }
  if (!text.includes(EXTERNAL_SCRIPTS_MARKER)) return refusal("The shell has no place for the external scripts (TiddlyWiki's marker).", corsHeaders);
  const version = core?.customMetadata?.v;
  if (!version) return refusal("There's no core file yet: publish it first.", corsHeaders);
  if (!text.includes(`<script src="${coreFileUrl(env, version)}"`)) {
    return refusal(`The shell doesn't load the stored core file (${coreFileUrl(env, version)}).`, corsHeaders);
  }
  const storedShell = await env.WIKI_BUCKET.put(SHELL_KEY, bytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { index: index.etag, fingerprint }
  });
  const rebuilt = await untilDone(ctx, rebakeHtml(env, ctx, null, { html: bytes, index: index.etag, fingerprint, core: version, shellVersion: storedShell.uploaded.getTime() }));
  if (rebuilt) return new Response(null, { status: 204, headers: corsHeaders });
  // Kept, but the page couldn't be built now (see the logs): the next admin page load builds it
  ctx.waitUntil(markPageOutdated(env));
  return refusal("The shell is kept, but the page couldn't be rebuilt now: it will be at the next admin page load.", corsHeaders, 503);
}

const MANIFEST_KEY = "recipes/default/tiddlers.json";

// Drops anything that should never have been listed (drafts, story list, state...)
function scrubManifest(manifest) {
  return manifest.filter(t => !isEphemeralTitle(t.title || "") && !isDraft(t));
}

// The list's entries, or null if it isn't a JSON array of tiddlers
function parseList(text) {
  try {
    const entries = JSON.parse(text);
    return Array.isArray(entries) && entries.every(e => e !== null && typeof e === "object" && typeof e.title === "string") ? entries : null;
  } catch (e) {
    return null;
  }
}

// The list as stored: entries is null if it's missing (object null) or damaged
async function getList(env) {
  const object = await env.WIKI_BUCKET.get(MANIFEST_KEY);
  if (!object) return { object: null, text: null, entries: null };
  const text = await object.text();
  return { object, text, entries: parseList(text) };
}

// The list, readable: { object, text, entries }. A missing or damaged list is rebuilt from the
// stored tiddlers first; throws ListRebuilding while that takes more requests.
async function readableList(env, ctx, options) {
  const list = await getList(env);
  if (list.entries) return list;
  const rebuilt = await rebuildList(env, ctx, list, options);
  const entries = rebuilt?.entries;   // parsed once
  if (!entries) throw new ListRebuilding();
  return { object: rebuilt.object, text: rebuilt.text, entries };
}

// mutator returns the new manifest, or null when nothing needs to change. list: the list already
// read (readableList), used for the first attempt. Returns the list as now stored,
// { object, text, entries }, so a page build right after needn't read it again.
async function mutateManifest(env, ctx, mutator, list = null, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { object: existing, text: existingText, entries } = list || await readableList(env, ctx);
    list = null;
    const etag = existing.etag || existing.httpEtag.replace(/"/g, "");

    const current = scrubManifest(entries);
    const manifest = mutator(current);
    if (manifest === null) return { object: existing, text: existingText, entries: current };

    // Only if the list is still the one we read
    const text = JSON.stringify(manifest);   // compact: a third smaller than indented, cheaper to write and read
    const written = await env.WIKI_BUCKET.put(MANIFEST_KEY, text, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: etag }
    });

    if (written !== null) return { object: written, text, entries: manifest };

    console.warn(`[Manifest] Write conflict detected, retrying (${attempt}/${attempts})...`);
    // A short, growing, slightly random pause, so saves that collided don't collide again
    await new Promise(resolve => setTimeout(resolve, 25 * attempt + Math.random() * 25));
  }

  throw new Error("Manifest update failed: too many concurrent write conflicts");
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
// list keeps that one }
async function updateManifest(env, ctx, title, fields, revision, list = null) {
  const entry = listEntry(title, fields, revision);
  let previous = null, superseded = false;
  const stored = await mutateManifest(env, ctx, (manifest) => {
    const idx = manifest.findIndex(t => t.title === title);
    previous = idx >= 0 ? manifest[idx] : null;
    superseded = !!previous && isNewerRevision(String(previous.revision), revision);
    if (superseded) return null;
    if (idx < 0) {
      manifest.push(entry);
      return manifest;
    }
    manifest[idx] = entry;
    // Listed twice (a hand edit, say): listed once from now on
    return manifest.some((t, i) => i > idx && t.title === title) ? manifest.filter((t, i) => i <= idx || t.title !== title) : manifest;
  }, list);
  return { previous, list: stored, superseded };
}

// Returns { removed: the entry it removed, or null if the title wasn't listed; list: the list as now
// stored; recreated: the title was saved again since the deleted revision (this delete's list write
// was retried after that save), so its entry stays }
async function removeFromManifest(env, ctx, title, list = null, deletedRevision = null) {
  let removed = null, recreated = false;
  const stored = await mutateManifest(env, ctx, (manifest) => {
    removed = manifest.find(t => t.title === title) || null;
    recreated = !!removed && !!deletedRevision && isNewerRevision(String(removed.revision), deletedRevision);
    if (recreated) removed = null;
    return removed ? manifest.filter(t => t.title !== title) : null;
  }, list);
  return { removed, list: stored, recreated };
}

// --- Rebuilding the tiddler list -----------------------------------------------------------------
// The list is an index: every tiddler is also stored on its own, with all its fields. If the list
// is missing or damaged (a bad upload or hand edit), the worker rebuilds it from the stored
// tiddlers wherever it needs it (serving it, a save, a delete, a page build) and carries on. The
// damaged copy is kept in _repair/. Nothing runs in the background: the requests do the work.
//
// A request may make 1,000 R2 calls and use about 10 ms of CPU (Free plan), so a big wiki is
// rebuilt a step per request, its progress kept in _repair/. Until the last step the damaged list
// stays as it is, and the list, saves and deletes answer 503 without changing anything, so the
// browser simply asks again: the conflict guard at once, TiddlyWiki itself every 5 seconds.

const REPAIR_PROGRESS_KEY = "_repair/tiddler-list-progress.json";
const REPAIR_STEP_TIDDLERS = 100;         // read per request
const REPAIR_STALE_MS = 2 * 60 * 1000;    // progress untouched for this long is from an abandoned rebuild
const HEAD_BYTES = 16384;                 // flat tiddlers: how much is read to get the fields before "text"
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
function rebuildingResponse(corsHeaders) {
  return new Response(LIST_REBUILDING, {
    status: 503,
    headers: {
      ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
      "Retry-After": "1", "X-Tiddler-List": "rebuilding"
    }
  });
}

function failureResponse(what, error, corsHeaders) {
  if (error instanceof ListRebuilding) return rebuildingResponse(corsHeaders);
  return new Response(`${what}: ${error.message}`, { status: error instanceof BadSave ? 400 : 500, headers: corsHeaders });
}

// Calls fn on each item, at most `limit` at a time (a request has 6 connections)
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// A create-only write, with the same fallback as the save handler: if it's refused but nothing is
// there, it's written anyway. Returns the object written, or null if one was already there.
async function putIfAbsent(env, key, value, options) {
  const written = await env.WIKI_BUCKET.put(key, value, { ...options, onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (written || await env.WIKI_BUCKET.head(key)) return written;
  return env.WIKI_BUCKET.put(key, value, options);
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
  const partial = item.size > HEAD_BYTES;
  let obj = await env.WIKI_BUCKET.get(item.key, partial ? { range: { offset: 0, length: HEAD_BYTES } } : undefined);
  if (!obj) return null;   // deleted meanwhile
  let bytes = new Uint8Array(await obj.arrayBuffer());
  let cut = textKeyOffset(bytes);
  if (partial && cut === -1) {   // fields over HEAD_BYTES, or no text: read whole
    obj = await env.WIKI_BUCKET.get(item.key);
    if (!obj) return null;
    bytes = new Uint8Array(await obj.arrayBuffer());
    cut = textKeyOffset(bytes);
  }
  let fields = null;
  try { fields = JSON.parse(cut === -1 ? decoder.decode(bytes) : decoder.decode(bytes.subarray(0, cut)) + "}"); } catch (e) {}
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
async function rebuildList(env, ctx, damaged, { pageBuild = false } = {}) {
  let list = damaged.object;
  if (!list) {
    // Missing: a stand-in takes its place, so this rebuild has a list of its own to replace
    list = await putIfAbsent(env, MANIFEST_KEY, listStandIn(), { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
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
      const current = await env.WIKI_BUCKET.head(MANIFEST_KEY);
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
  const written = await env.WIKI_BUCKET.put(MANIFEST_KEY, text, {
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
  ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 5000)).then(() => purgePublicCache(env, urls)));
  if (!pageBuild) ctx.waitUntil(markPageOutdated(env));
  // Served as is; parsed only by callers that need the entries (a save, a page build)
  return { object: written, text, fresh: true, get entries() { return parseList(text); } };
}

// The page is built again on the next page load, rather than in this request: it may have been built
// from a list that missed a plugin (a save whose list update failed and was never retried), or a
// build after a change failed
async function markPageOutdated(env) {
  const page = await env.WIKI_BUCKET.get("baked.html");
  if (!page) return;
  await env.WIKI_BUCKET.put("baked.html", await page.arrayBuffer(), {
    httpMetadata: page.httpMetadata,
    customMetadata: { ...page.customMetadata, bakeVersion: "outdated" },
    onlyIf: { etagMatches: page.etag }
  });
}

// --- GitHub backup through a Cloudflare Queue -------------------------------------------------
// Every save or delete becomes one message. The queue consumer (the queue() handler, configured
// with max_concurrency 1) commits them one at a time, in order, one commit per save, so commits
// never collide, and GitHub rate limits or outages only delay backups: failed messages are put
// back with a growing delay until they go through. A rate limit or a token GitHub refuses pauses
// every backup; any other failure holds up only that tiddler's versions, so a file GitHub refuses
// can't hold up the others. Nothing runs while the queue is empty.
// Without a BACKUP_QUEUE binding (or if the queue is unavailable) the same backup runs directly.

// Writes bytes as base64 into out (ASCII bytes) from position at; returns where it ends. GitHub takes
// a file's content in base64, in a request body sent as bytes: written there directly, it's never a
// string. (Through a string, with String.fromCharCode, btoa, then the body encoded to be sent, a 1.5
// MB plugin took about 7 ms of CPU, this about 2: a run gets about 10 on the free plan.)
const BASE64_DIGITS = encoder.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
function writeBase64(bytes, out, at) {
  const end = bytes.length - bytes.length % 3;
  let i = 0;
  for (; i < end; i += 3) {
    const v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out[at] = BASE64_DIGITS[v >>> 18];
    out[at + 1] = BASE64_DIGITS[v >>> 12 & 63];
    out[at + 2] = BASE64_DIGITS[v >>> 6 & 63];
    out[at + 3] = BASE64_DIGITS[v & 63];
    at += 4;
  }
  if (i < bytes.length) {
    // One or two bytes left: padded with "="
    const two = i + 1 < bytes.length;
    const v = bytes[i] << 16 | (two ? bytes[i + 1] << 8 : 0);
    out[at] = BASE64_DIGITS[v >>> 18];
    out[at + 1] = BASE64_DIGITS[v >>> 12 & 63];
    out[at + 2] = two ? BASE64_DIGITS[v >>> 6 & 63] : 61;
    out[at + 3] = 61;
    at += 4;
  }
  return at;
}

const QUEUE_MESSAGE_LIMIT = 128000;   // a queue message, as sent; a version that would make it bigger waits in R2
const BACKUP_PER_RUN = 10;            // keeps one run within Cloudflare's 50-subrequest limit (free plan)
// After this many bytes of versions, the rest of a run goes on to the next one: a megabyte takes a
// few milliseconds of CPU (its base64 above all), and a run gets about 10 on the free plan. A run
// always backs up one version, whatever its size.
const BACKUP_BYTES_PER_RUN = 512 * 1024;
const BACKUP_MAX_DELAY = 6 * 3600;    // longest wait between retries (seconds)

// About the size of a message as the queue measures it: V8-serialized, where a string takes one
// byte a character if they're all Latin-1, two otherwise (so a text under 100 KB can be over 128 KB),
// with room for the other fields
function queueMessageSize(message) {
  let size = 200;
  for (const value of [message.title, message.content]) {
    if (typeof value === "string") size += value.length * (/[^\x00-\xff]/.test(value) ? 2 : 1);
  }
  return size;
}

// Called after a save or delete has been stored; job.content is the stored bytes
async function queueBackup(env, job) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return;
  const message = { action: job.action, title: job.title, revision: job.revision ?? null, time: Date.now(), tries: 0 };
  if (env.BACKUP_QUEUE) {
    try {
      if (job.action === "save") {
        // (Decoded only if it may fit: a character is at least one byte of UTF-8)
        const content = job.content.length < QUEUE_MESSAGE_LIMIT ? decoder.decode(job.content) : null;
        if (content !== null && queueMessageSize({ ...message, content }) <= QUEUE_MESSAGE_LIMIT) {
          message.content = content;
        } else {
          // Keep this exact version until it is committed (R2 itself only holds the latest one).
          // Not named after the title, which can be too long for a key (or guessed: the copy is public)
          message.contentKey = `_backup/versions/${message.time}-${crypto.randomUUID()}.json`;
          await env.WIKI_BUCKET.put(message.contentKey, job.content, { httpMetadata: { contentType: "application/json" } });
        }
      }
      await env.BACKUP_QUEUE.send(message);
      return;
    } catch (e) {
      console.error(`[Backup] Could not queue '${job.title}', backing up directly:`, e.message);
      if (message.contentKey) await env.WIKI_BUCKET.delete(message.contentKey).catch(() => {});
    }
  }
  // No queue: run the same backup right away, with a couple of quick retries
  const direct = { ...message, content: job.content, contentKey: undefined };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await backupJob(env, direct);
      return await recordBackupResults(env, [], [job.title]);
    } catch (e) {
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      console.error(`[Backup] '${job.title}' could not be backed up:`, e.message);
      await recordBackupResults(env, [backupFailure(direct, e)], []);
    }
  }
}

// --- How backups go, for the admin wiki ----------------------------------------------------------
// Backups GitHub keeps refusing (not a rate limit: that only delays them) are recorded in
// _backup/status.json, one entry per tiddler: since (when its oldest waiting version was saved),
// last (its latest attempt), error (GitHub's answer) and status (its HTTP status, 0 without one).
// The entry goes when that tiddler's backup gets through. The file also keeps a pause of every
// backup, { until, count }, while there's one (processBackupBatch). Written only when something
// changes, read only by a batch with a failure or a version that failed or waited before. The admin
// wiki asks with its tiddler list request (X-Backup-Status: ask) when it loads, then hourly, and
// shows an alert.

const BACKUP_STATUS_KEY = "_backup/status.json";
// An entry not retried for a day belongs to a backup no longer waiting (one still waiting is retried
// at least every 6 hours: BACKUP_MAX_DELAY), and is dropped
const BACKUP_STATUS_STALE = 24 * 3600 * 1000;

function backupFailure(job, e) {
  return { title: job.title, since: job.time || Date.now(), error: String(e.detail || e.message || e).slice(0, 200), status: e.status || 0 };
}

// { failing: title -> entry, pause }. strict: an R2 error throws, rather than reading as no file (a
// file that isn't JSON still reads as none)
async function readBackupStatus(env, strict) {
  let data = null;
  try {
    const obj = await env.WIKI_BUCKET.get(BACKUP_STATUS_KEY);
    try {
      data = obj ? await obj.json() : null;
    } catch {}
  } catch (e) {
    if (strict) throw e;
  }
  const failing = data && typeof data.failing === "object" && data.failing ? Object.entries(data.failing) : [];
  const pause = data && data.pause && data.pause.until > 0 ? { until: data.pause.until, count: data.pause.count || 0 } : null;
  return { failing: new Map(failing), pause };
}

// failures: from backupFailure; cleared: titles whose backup got through; pause: { until, count } of
// a pause that starts, null when one is over, undefined when that's not known; stored: the status
// file, if this run has read it already. Never throws: an R2 error here mustn't count as a failed
// backup
async function recordBackupResults(env, failures, cleared, pause, stored) {
  try {
    await updateBackupStatus(env, failures, cleared, pause, stored);
  } catch (e) {
    console.error("[Backup] Could not record how backups go:", e.message);
  }
}

async function updateBackupStatus(env, failures, cleared, pause, stored) {
  const { failing, pause: storedPause } = stored || await readBackupStatus(env, true), now = Date.now();
  let changed = false;
  let keptPause = pause === undefined ? storedPause : pause;
  // (A pause over for a while no longer counts: gone)
  if (keptPause && now - keptPause.until >= PAUSE_CONTINUES) keptPause = null;
  if (JSON.stringify(keptPause) !== JSON.stringify(storedPause)) changed = true;
  for (const title of cleared) changed = failing.delete(title) || changed;
  for (const { title, since, error, status } of failures) {
    const entry = failing.get(title);
    failing.set(title, { since: entry ? Math.min(entry.since, since) : since, last: now, error, status });
    changed = true;
  }
  for (const [title, entry] of failing) {
    // (Also an entry that isn't one: no time to go by)
    if (!(now - entry.last <= BACKUP_STATUS_STALE)) changed = failing.delete(title) || changed;
  }
  if (!changed) return;
  if (failing.size || keptPause) {
    const status = { failing: Object.fromEntries(failing), ...(keptPause ? { pause: keptPause } : {}) };
    await env.WIKI_BUCKET.put(BACKUP_STATUS_KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
  } else {
    await env.WIKI_BUCKET.delete(BACKUP_STATUS_KEY);
  }
}

// What the admin wiki is told: "ok", or the backups failing for at least BACKUP_ALERT_MINUTES (60
// by default), as encoded JSON: { count, title, since, error, status } of the oldest
function backupReport(env, failing) {
  const minutes = parseFloat(env.BACKUP_ALERT_MINUTES);
  const after = (minutes >= 0 ? minutes : 60) * 60000;
  const now = Date.now();
  const due = [...failing].filter(([, e]) => now - e.last <= BACKUP_STATUS_STALE && now - e.since >= after).sort((a, b) => a[1].since - b[1].since);
  if (!due.length) return "ok";
  const [title, e] = due[0];
  return encodeURIComponent(JSON.stringify({ count: due.length, title: title.slice(0, 200), since: e.since, error: e.error, status: e.status }));
}

// A pause of every backup: GitHub asked to slow down, or refuses every backup (a token it no longer
// accepts, say), so trying them one by one would only make more calls (each answered the same way)
// and more queue operations. While it lasts, the backups delivered are sent again to wait for its
// end, without calling GitHub; then the first one tries. If GitHub still refuses, the next pause is
// twice as long (up to BACKUP_MAX_DELAY, or as long as GitHub asks).
// { until (ms), count (pauses in a row, from 0), error (GitHub's, from the call that started it),
// all (GitHub refuses every backup, not just asking to wait: the ones waiting are recorded as
// failing, for the alert) }. Known to the later runs in this isolate; until and count are also kept
// in the status file, for a run in a new one.
let backupPause = null;
// A failure within this time after a pause ended: the next pause is twice as long
const PAUSE_CONTINUES = 3600 * 1000;

function nextPause(env, last, e) {
  const now = Date.now();
  // Still paused (a run that only knew from the status file): the same pause, for at least as long
  // as GitHub asks; just after one: twice as long; otherwise a first one
  const still = last && now < last.until;
  const count = !last ? 0 : still ? last.count : now - last.until < PAUSE_CONTINUES ? last.count + 1 : 0;
  const until = Math.max(now + backupRetryDelay(env, count, e.retryAfter) * 1000, still ? last.until : 0);
  return { until, count, error: e, all: !isRateLimit(e) };
}

// Queue consumer
async function processBackupBatch(batch, env) {
  const messages = [...batch.messages].sort((a, b) =>
    (a.body.time - b.body.time) || String(a.body.revision).localeCompare(String(b.body.revision)));
  const held = new Map();   // title -> delay: a version of it failed, its later versions wait with it
  const failures = [], cleared = [];   // for the backup status (backupFailure)
  let pause;                // for the status file: a pause that starts in this run, or null if one is over
  let stored;               // the status file, if read in this run
  let denied;               // a tiddler GitHub answered 403 or 404 in this run (see isAccountWide)
  let attempts = 0;
  const work = { bytes: 0 };   // the size of the versions handled so far (BACKUP_BYTES_PER_RUN)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (backupPause && Date.now() < backupPause.until) {
      // Waits for the pause to end. (Marked, so that its backup going through ends the pause in the
      // status file too)
      await requeueBackup(env, msg, Math.ceil((backupPause.until - Date.now()) / 1000), false, { paused: true });
      if (backupPause.all) failures.push(backupFailure(msg.body, backupPause.error));
      continue;
    }
    if (held.has(msg.body.title)) {
      await requeueBackup(env, msg, held.get(msg.body.title), false);
      continue;
    }
    if (attempts >= BACKUP_PER_RUN || work.bytes >= BACKUP_BYTES_PER_RUN) {
      await requeueBackup(env, msg, 0, false);
      continue;
    }
    attempts++;
    try {
      await backupJob(env, msg.body, work);
      msg.ack();
      backupPause = null;   // GitHub takes backups (again)
      // (The backup is done: a copy that can't be removed is only left behind)
      if (msg.body.contentKey) await env.WIKI_BUCKET.delete(msg.body.contentKey).catch(() => {});
      // Only a version that failed or waited before can clear a recorded failure, or a recorded pause
      if (msg.body.tries > 0 || msg.body.paused) {
        cleared.push(msg.body.title);
        pause = null;
      }
    } catch (e) {
      if (isRateLimit(e) || e.status === 401 || (isAccountWide(e) && denied !== undefined && denied !== msg.body.title)) {
        // Every backup waits: this one, the rest of this run (above), and the next runs. (A rate
        // limit isn't a failure to report: a big import waits like this for hours.)
        let last = backupPause;
        if (!last) {
          try {
            stored = await readBackupStatus(env, true);
            last = stored.pause;
          } catch {}
        }
        backupPause = nextPause(env, last, e);
        pause = { until: backupPause.until, count: backupPause.count };
        const delay = Math.ceil((backupPause.until - Date.now()) / 1000);
        console.error(`[Backup] Backups paused for ${delay}s: ${e.message}`);
        await requeueBackup(env, msg, delay, true);
        if (backupPause.all) failures.push(backupFailure(msg.body, e));
        continue;
      }
      if (isAccountWide(e)) denied = msg.body.title;
      const delay = backupRetryDelay(env, msg.body.tries, e.retryAfter);
      console.error(`[Backup] '${msg.body.title}' not backed up yet (${e.message}); retrying in ${delay}s`);
      await requeueBackup(env, msg, delay, true, isRefusal(e) ? { refused: true } : undefined);
      // Anything else may concern this file only, and other tiddlers' backups go ahead. Its later
      // versions wait with it, so they stay in order, unless GitHub refuses this version for good
      // (its path, or a secret in its text): the next one may be fine, and goes ahead (the late
      // versions logic keeps GitHub on the newest)
      if (!isRefusal(e)) held.set(msg.body.title, delay);
      failures.push(backupFailure(msg.body, e));
    }
  }
  if (failures.length || cleared.length || pause !== undefined) await recordBackupResults(env, failures, cleared, pause, stored);
}

// GitHub refusing every backup, not one file: the token (401: expired or revoked; 403 other than a
// rate limit: no access to the repository, or the repository archived), or the repository not
// found (404: only on a write, as the 404 of a read, a file not there yet, isn't an error). A 403 or
// 404 could still concern one file only (a path GitHub can't take): it pauses every backup only once
// a second tiddler gets one in the same run, or one file would hold up all the others (the oldest
// backup tries first after a pause). Until then it's that file's own failure.
function isAccountWide(e) {
  return e.status === 401 || (e.status === 403 && !isRateLimit(e)) || e.status === 404;
}

// GitHub refusing this file for good: its path, or its content (a secret in it, which its push
// protection refuses with a 409; a 409 that's only a race over the file's sha passes on its retry)
function isRefusal(e) {
  return e.status === 409 || e.status === 422;
}

// GitHub asking to slow down: Retry-After or an exhausted rate limit, 429, or its "rate limit"
// messages (a secondary rate limit can come as a 403 without a header)
function isRateLimit(e) {
  return e.retryAfter > 0 || e.status === 429 || /rate limit/i.test(e.message || "");
}

function backupRetryDelay(env, tries, retryAfter) {
  const base = parseInt(env.BACKUP_RETRY_SECONDS, 10) || 60;
  const delay = Math.min(base * 2 ** (tries || 0), BACKUP_MAX_DELAY);
  return Math.ceil(Math.min(Math.max(delay, retryAfter || 0), 24 * 3600));
}

// Sends the message again as a fresh one, so neither the queue's retry limit nor its retention
// period can drop a backup that keeps failing. extra: fields to add to it
async function requeueBackup(env, msg, delaySeconds, countTry, extra) {
  const body = { ...msg.body, ...(countTry ? { tries: (msg.body.tries || 0) + 1 } : {}), ...extra };
  try {
    await env.BACKUP_QUEUE.send(body, delaySeconds > 0 ? { delaySeconds } : undefined);
    msg.ack();
  } catch (e) {
    msg.retry(delaySeconds > 0 ? { delaySeconds } : undefined);
  }
}

// Commits one save or delete. job.content: the version as text (in a queue message) or bytes (a
// direct backup). work.bytes: adds the size of the versions it handles
async function backupJob(env, job, work = { bytes: 0 }) {
  const github = githubContents(env);
  const current = await env.WIKI_BUCKET.head(tiddlerKey(job.title));   // the version in the wiki now

  if (job.action === "delete") {
    if (current) return; // Recreated since then: its own save message updates GitHub
    const existing = await github.get(job.title);
    if (existing) await github.remove(job.title, existing.sha, `🗑️ Delete: ${job.title}`);
    return;
  }

  // (As bytes: what GitHub gets, and what its sha is computed from)
  let content = typeof job.content === "string" ? encoder.encode(job.content) : job.content;
  if (content === undefined && job.contentKey) {
    const stored = await env.WIKI_BUCKET.get(job.contentKey);
    content = stored ? new Uint8Array(await stored.arrayBuffer()) : undefined;
  }
  if (content === undefined) return; // Already handled by an earlier delivery of this message
  work.bytes += content.length;

  // GitHub needs the sha of the file it holds to replace it. Its content isn't needed (decoding a
  // plugin's took more CPU than a run is allowed): whether GitHub already holds a newer version is
  // told by the sha too, compared with the wiki's current version's
  const existing = await github.get(job.title);
  let sha = existing ? existing.sha : null;
  const newer = await newerInWiki(env, job, current, sha, work);
  // A version GitHub refused for good, now replaced there by a newer one, or whose tiddler has been
  // deleted since: dropped, rather than tried forever (it would only have been history)
  if (job.refused && (newer || !current)) return;
  // (A retry after the restore below failed: this version is already in the history, even if a
  // newer one has been committed on top since)
  if (!job.restore && sha !== await gitBlobSha(content)) {
    sha = await github.put(job.title, content, `✏️ Save: ${job.title}`, sha);
  }
  if (newer) {
    // This version arrived after a newer one was committed: it is now in the history, and the
    // newer version goes back on top. (Marked first: if putting it back fails, the retry of this
    // message, which finds this version already committed, still does it.)
    job.restore = true;
    if (sha !== newer.sha) await github.put(job.title, newer.bytes, `✏️ Save: ${job.title} (newer version restored)`, sha);
  } else if (!current) {
    // Deleted since this save: keep this version in the history, then delete it again
    await github.remove(job.title, sha, `🗑️ Delete: ${job.title}`);
  }
}

// The wiki's current version of a tiddler, { bytes, sha }, if it's newer than this job's and GitHub
// already holds it (githubSha), so this job's version arrived late; or if an earlier try of this
// job found that (job.restore). Otherwise null: a newer version still waiting for its own backup
// (quick successive edits) is committed by its own message, in order.
async function newerInWiki(env, job, current, githubSha, work) {
  if (!current || !isNewerRevision(revisionOf(current), job.revision) || (!githubSha && !job.restore)) return null;
  const obj = await env.WIKI_BUCKET.get(tiddlerKey(job.title));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  work.bytes += bytes.length;
  const sha = await gitBlobSha(bytes);
  return job.restore || sha === githubSha ? { bytes, sha } : null;
}

// Revisions written by this worker are millisecond timestamps
function isNewerRevision(a, b) {
  return /^\d+$/.test(a) && /^\d+$/.test(String(b)) && Number(a) > Number(b);
}

// Git's blob id for a file (its bytes), to recognise content GitHub already has
async function gitBlobSha(content) {
  const header = encoder.encode(`blob ${content.length}\0`);
  const data = new Uint8Array(header.length + content.length);
  data.set(header);
  data.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

// A failed GitHub call; retryAfter (seconds) is set when GitHub says how long to wait, status is
// GitHub's HTTP status
class GitHubError extends Error {
  // detail: GitHub's own message ("Bad credentials"), when its answer has one
  constructor(message, retryAfter, status, detail = "") {
    super(message);
    this.name = "GitHubError";
    this.retryAfter = retryAfter;
    this.status = status;
    this.detail = detail;
  }
}

// GitHub Contents API, with the same file paths as the original per-save backup
function githubContents(env) {
  const branch = env.GITHUB_BRANCH || "main";
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "TiddlyWiki-Cloudflare-Worker"
  };
  // body: the request body, as text or bytes
  async function call(method, title, body) {
    const apiBase = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/tiddlers/${encodeURIComponent(title)}.json`;
    // Reads ask for the "object" format: the default one isn't available for files between 1 and
    // 100 MB, so their backups would fail forever and hold up every later one. The object format
    // works for all sizes, with empty content above 1 MB.
    const res = await fetch(method === "GET" ? `${apiBase}?ref=${branch}` : apiBase, {
      method,
      headers: method === "GET" ? { ...headers, Accept: "application/vnd.github.object+json" } : headers,
      body
    });
    if (method === "GET" && res.status === 404) return null;
    if (!res.ok) {
      // How long GitHub asks us to wait, if it says (rate limits)
      let waitSeconds;
      const retryAfter = parseInt(res.headers.get("retry-after"), 10);
      const reset = parseInt(res.headers.get("x-ratelimit-reset"), 10);
      if (retryAfter > 0) waitSeconds = retryAfter;
      else if (res.headers.get("x-ratelimit-remaining") === "0" && reset) waitSeconds = Math.max(reset - Date.now() / 1000, 1);
      const answer = await res.text();
      let detail = "";
      try {
        detail = String(JSON.parse(answer).message || "");
      } catch {}
      throw new GitHubError(`GitHub ${method} ${res.status}: ${answer.slice(0, 200)}`, waitSeconds, res.status, detail);
    }
    return res.json();
  }
  return {
    // { sha } of the file on GitHub, or null. (GitHub sends the content too, up to 1 MB; it isn't used.)
    async get(title) {
      const file = await call("GET", title);
      return file ? { sha: file.sha } : null;
    },
    // content: bytes. Returns the new blob sha. (The body is made as bytes, the content written into
    // it as base64: see writeBase64.)
    async put(title, content, message, sha) {
      const head = encoder.encode(`{"message":${JSON.stringify(message)},"branch":${JSON.stringify(branch)}${sha ? `,"sha":${JSON.stringify(sha)}` : ""},"content":"`);
      const body = new Uint8Array(head.length + Math.ceil(content.length / 3) * 4 + 2);
      body.set(head);
      const end = writeBase64(content, body, head.length);
      body[end] = 34;        // "
      body[end + 1] = 125;   // }
      const result = await call("PUT", title, body);
      return result.content.sha;
    },
    async remove(title, sha, message) {
      await call("DELETE", title, JSON.stringify({ message, sha, branch }));
    }
  };
}
