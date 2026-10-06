// TiddlyWiki on Cloudflare: the admin worker
//
// Serves the editable wiki (TiddlyWeb protocol) from an R2 bucket, protects against edit
// conflicts between tabs, keeps the public R2-served copy's cache fresh, writes plugins as files
// the page loads before TiddlyWiki boots, and backs every save up to GitHub through a Cloudflare
// Queue. See README.md for the full picture.
//
// worker.js is generated from src/worker.src.js by `npm run build`, which embeds the browser
// module src/conflict-guard.js as CONFLICT_GUARD_SOURCE.

// Helper to safely encode UTF-8 strings to Base64 for the GitHub API
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function getTwTimestamp(date = new Date()) {
  return date.toISOString().replace(/\D/g, '').slice(0, 17);
}

// Security check for mutations
function isAuthorized(request, env) {
  if (!env.API_KEY) return true;
  const authHeader = request.headers.get("Authorization");
  return authHeader === `Bearer ${env.API_KEY}` || authHeader === env.API_KEY;
}

// --- Edit-conflict protection ---------------------------------------------------------------
//
// How it works:
//  * Every tiddler has a revision: customMetadata.revision (a millisecond timestamp set on each
//    save), else the revision stored in the tiddler JSON, else one derived from the R2 etag.
//    GET returns it in the body and in the ETag "default/<title>/<revision>:auto".
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

// TiddlyWeb JSON puts non-standard fields such as draft.of under "fields"
function isDraft(tiddler) {
  return tiddler["draft.of"] !== undefined ||
         (tiddler.fields !== null && typeof tiddler.fields === "object" && tiddler.fields["draft.of"] !== undefined);
}

// --- What the page needs at boot ---------------------------------------------------------------
// TiddlyWiki only runs startup actions, plugins and JavaScript modules that are present when it
// boots; anything that arrives later through sync is too late. Small startup tiddlers are baked
// into baked.html. Plugins and JavaScript modules each get a file in R2 (_plugins/<title>.js),
// which baked.html loads from the public site with a <script> tag before TiddlyWiki boots.

const STARTUP_TITLES = ["$:/DefaultTiddlers", "$:/SiteTitle", "$:/SiteSubtitle",
  // read at boot to choose the theme, language and palette
  "$:/theme", "$:/language", "$:/palette"];
const DISABLED_PLUGIN_PREFIX = "$:/config/Plugins/Disabled/";   // read at boot, when plugins are registered
const PLUGIN_FILE_TYPES = ["plugin", "theme", "language"];
const MODULE_TYPES = ["application/javascript", "application/json", "application/x-tiddler-dictionary"];   // TiddlyWiki defines modules from these at boot

// A field of a tiddler in either layout: TiddlyWeb's (custom fields under "fields") or flat
function fieldOf(tiddler, name) {
  if (tiddler[name] !== undefined) return tiddler[name];
  return tiddler.fields !== null && typeof tiddler.fields === "object" ? tiddler.fields[name] : undefined;
}

// These take a saved tiddler or an entry of the tiddler list
function isStartupTiddler(tiddler) {
  const title = tiddler.title || "", tags = tiddler.tags;
  return STARTUP_TITLES.includes(title) || title.startsWith(DISABLED_PLUGIN_PREFIX) || (Array.isArray(tags)
    ? tags.some(tag => tag.includes("$:/tags/StartupAction"))
    : typeof tags === "string" && tags.includes("$:/tags/StartupAction"));
}

// Plugins (but not the core: it comes with index.html and is never synced) and JavaScript modules
function needsPluginFile(tiddler) {
  const pluginType = fieldOf(tiddler, "plugin-type");
  if (pluginType) {
    return PLUGIN_FILE_TYPES.includes(pluginType) && tiddler.title !== "$:/core" && fieldOf(tiddler, "platform") !== "server";
  }
  return MODULE_TYPES.includes(tiddler.type) && Boolean(fieldOf(tiddler, "module-type"));
}

function isPageTiddler(tiddler) {
  return isStartupTiddler(tiddler) || needsPluginFile(tiddler);
}

function tiddlerKeys(title) {
  const raw = `recipes/default/tiddlers/${title}`;
  const encoded = `recipes/default/tiddlers/${encodeURIComponent(title)}`;
  return raw === encoded ? [raw] : [raw, encoded];
}

// Finds the stored object for a title (older objects may live under the URL-encoded key)
async function findTiddler(env, title) {
  for (const key of tiddlerKeys(title)) {
    const obj = await env.WIKI_BUCKET.head(key);
    if (obj) return { key, obj };
  }
  return null;
}

// The revision the wiki sees for a stored object. GET, PUT and DELETE must all agree on it:
// the worker's own metadata, else the revision stored in the tiddler itself (objects written by
// other tools), else one derived from the R2 etag.
function revisionOf(obj, body) {
  if (obj.customMetadata?.revision) return obj.customMetadata.revision;
  if (body && body.revision !== undefined && body.revision !== null && body.revision !== "") return String(body.revision);
  return obj.httpEtag.replace(/[^a-zA-Z0-9]/g, "");
}

// revisionOf() for an object found with head(); reads the body only if the metadata is missing
async function storedRevision(env, found) {
  if (found.obj.customMetadata?.revision) return found.obj.customMetadata.revision;
  const full = await env.WIKI_BUCKET.get(found.key);
  let body = null;
  if (full) {
    try { body = JSON.parse(await full.text()); } catch (e) {}
  }
  return revisionOf(found.obj, body);
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
// The browser module sends tiddlers "flat" (header X-Tiddler-Layout: flat): every field at the top
// level, compact JSON, "text" last, without revision, bag or recipe. The worker parses only the
// fields before "text" and appends its revision, bag and recipe, working on the raw bytes: the
// text itself (a whole plugin, an image...) is never decoded, parsed or re-encoded.
// Other clients send TiddlyWeb JSON (custom fields under "fields"), parsed and re-serialized.

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

// A save in TiddlyWeb's layout, or any other JSON: parsed, stamped and re-serialized
function parsedSave(tiddler) {
  // A title that isn't text would make the tiddler list unreadable (and no browser sends one)
  if (!isTiddlerObject(tiddler)) throw new BadSave("the body is not a tiddler (a JSON object with a text title)");
  const fields = { ...tiddler };
  delete fields.text;
  return {
    fields, layout: "tiddlyweb",
    stored: revision => encoder.encode(JSON.stringify({ ...tiddler, revision, bag: "default", recipe: "default" }))
  };
}

// Returns { fields, layout, stored(revision) }: fields = the tiddler without its text,
// stored(revision) = the bytes to store, with the worker's revision, bag and recipe
async function readSave(request) {
  if (request.headers.get("X-Tiddler-Layout") !== FLAT_LAYOUT) {
    return parsedSave(parseJsonBody(await request.text()));
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] <= 0x20) end--;
  let cut = textKeyOffset(bytes);
  if (cut === -1) cut = end - 1;   // no text: the fields run up to the closing brace
  const fields = bytes[0] === 0x7b && bytes[end - 1] === 0x7d && cut > 0
    ? parseJsonBody(decoder.decode(bytes.subarray(0, cut)) + "}") : null;
  if (!isTiddlerObject(fields)) throw new BadSave("the body is not a tiddler in the flat layout");
  // Not what the browser module sends (pretty-printed, or with these fields before "text"):
  // handled like any other save
  if (["text", "revision", "bag", "recipe"].some(name => name in fields)) {
    return parsedSave(parseJsonBody(decoder.decode(bytes)));
  }
  return {
    fields, layout: FLAT_LAYOUT,
    stored: revision => concatBytes([
      bytes.subarray(0, end - 1),
      encoder.encode(`,"revision":"${revision}","bag":"default","recipe":"default"}`)
    ])
  };
}

// The rest of a save once the tiddler is stored: the tiddler list, the public cache and the page.
// list: the list as read before the tiddler was stored (readableList), or null to read it here.
async function finishSave(env, ctx, title, fields, revision, list = null) {
  const { previous, list: stored } = await updateManifest(env, ctx, title, fields, revision, list);
  // Only once the new list is in R2: a public request between the purge and the list update
  // would put the old list back in Cloudflare's cache
  ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title)));
  const saved = { ...fields, title };
  if (previous && needsPluginFile(previous) && !needsPluginFile(saved)) {
    await env.WIKI_BUCKET.delete(pluginFileKey(title));
  }
  // Something the page needs at boot was added, changed or is no longer needed: rebuild the
  // page (which writes the plugin file) before confirming, so a reload right after has it
  if (isPageTiddler(saved) || (previous && isPageTiddler(previous))) {
    await rebakeHtml(env, ctx, stored);
  }
}

// Whether the stored object holds exactly what this save would store with that revision
async function storesSameContent(env, found, save, revision) {
  const wouldStore = save.stored(revision);
  // Different sizes, different content: no need to read it (a real conflict, nearly always)
  if (found.obj.size !== wouldStore.length) return false;
  const obj = await env.WIKI_BUCKET.get(found.key);
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
    // FIX: Bulletproof CORS exposure for ETag capitalization
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, X-Tiddler-Layout, If-Match, If-None-Match, Authorization, Accept",
      "Access-Control-Expose-Headers": "ETag, Etag, etag, X-Tiddler-List, Retry-After",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 1. STATUS ENDPOINT
    if (request.method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify({
        username: "admin", read_only: false, anonymous: false,
        logout_is_available: true, space: { recipe: "default" }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // 2. SERVE WIKI UI (baked.html is rebuilt automatically when index.html or the conflict guard changes)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/baked.html")) {
      return serveWiki(env, ctx, corsHeaders);
    }

    // 3. READS
    if (request.method === "GET" || request.method === "HEAD") {
      const rawKey = url.pathname.substring(1);
      const decodedKey = decodeURIComponent(rawKey);

      if (decodedKey === MANIFEST_KEY) return serveManifest(request, env, ctx, corsHeaders);

      let object = await env.WIKI_BUCKET.get(decodedKey);
      if (!object && rawKey !== decodedKey) {
        object = await env.WIKI_BUCKET.get(rawKey);
      }

      if (!object) return new Response("Not found", { status: 404, headers: corsHeaders });

      const headers = objectHeaders(object, corsHeaders);

      if (decodedKey.startsWith("recipes/default/tiddlers/") || decodedKey.startsWith("bags/default/tiddlers/")) {
        const title = decodedKey.replace(/^(recipes|bags)\/default\/tiddlers\//, "");
        headers.set("Cache-Control", "no-cache");
        if (object.customMetadata?.layout === FLAT_LAYOUT) {
          // Stored with its revision, bag and recipe already in place: served as is
          headers.set("ETag", tiddlerEtag(title, object.customMetadata.revision));
          return new Response(request.method === "GET" ? object.body : null, { headers });
        }
        const text = await object.text();
        let tiddlerData = null;
        try { tiddlerData = JSON.parse(text); } catch (e) {}
        // Always report the same revision that PUT/DELETE check against
        const revision = revisionOf(object, tiddlerData);

        headers.set("ETag", tiddlerEtag(title, revision));

        if (request.method !== "GET") return new Response(null, { headers });
        if (!tiddlerData) return new Response(text, { headers });
        tiddlerData.bag = "default";
        tiddlerData.recipe = "default";
        tiddlerData.revision = revision;
        return new Response(JSON.stringify(tiddlerData), { headers });
      }
      
      headers.set("ETag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    // MUTATIONS
    if ((request.method === "PUT" || request.method === "DELETE") && !isAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    // 4. WRITES
    if (request.method === "PUT") {
      try {
        const match = url.pathname.match(/^\/recipes\/default\/tiddlers\/(.+)$/);
        if (!match) return new Response("Invalid PUT path", { status: 400, headers: corsHeaders });

        const title = decodeURIComponent(match[1]);
        const save = await readSave(request);
        // Stored and listed under the title in the URL: a different one in the body would make the
        // list disagree with the stored tiddlers (the browser always sends the same one)
        if (save.fields.title !== title) throw new BadSave("the title in the body isn't the one in the URL");

        if (isEphemeralTitle(title) || isDraft(save.fields)) {
          const etag = tiddlerEtag(title, Date.now().toString());
          return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: etag } });
        }

        const tiddlerKey = `recipes/default/tiddlers/${title}`;
        const found = await findTiddler(env, title);
        const currentRevision = found ? await storedRevision(env, found) : null;

        const { conditional, reason } = checkPreconditions(request, currentRevision);
        if (reason) {
          // A retry of a save that was stored but whose list update then failed: the stored tiddler
          // is exactly what this save would store, so finish that save instead of refusing it.
          // (Otherwise the browser sees the identical copy, adopts it, and the list is never fixed.)
          if (found && await storesSameContent(env, found, save, currentRevision)) {
            await untilDone(ctx, finishSave(env, ctx, title, save.fields, currentRevision));
            return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: tiddlerEtag(title, currentRevision) } });
          }
          return conflictResponse(title, reason, currentRevision, corsHeaders);
        }

        // Read before the tiddler is written: while a damaged list is being rebuilt, the save is
        // refused (503) without changing anything, so the browser's retry can't conflict with it
        const list = await readableList(env, ctx);

        const newRevision = Date.now().toString();
        const body = save.stored(newRevision);
        const putOptions = {
          httpMetadata: { contentType: "application/json" },
          // "layout" tells readers the revision, bag and recipe are already in the stored JSON
          customMetadata: save.layout === FLAT_LAYOUT ? { revision: newRevision, layout: FLAT_LAYOUT } : { revision: newRevision }
        };

        if (conditional) {
          // Only write if the object is still exactly the one we checked (or still absent)
          const replacesCurrent = found !== null && found.key === tiddlerKey;
          let written = await env.WIKI_BUCKET.put(tiddlerKey, body, {
            ...putOptions,
            onlyIf: replacesCurrent ? { etagMatches: found.obj.etag } : new Headers({ "If-None-Match": "*" })
          });
          if (written === null && !replacesCurrent && !(await env.WIKI_BUCKET.head(tiddlerKey))) {
            // A create-only write was refused but nothing is there: write it normally
            written = await env.WIKI_BUCKET.put(tiddlerKey, body, putOptions);
          }
          if (written === null) {
            const latest = await findTiddler(env, title);
            return conflictResponse(title, "it was changed in another tab or browser", latest ? await storedRevision(env, latest) : null, corsHeaders);
          }
        } else {
          await env.WIKI_BUCKET.put(tiddlerKey, body, putOptions);
        }

        ctx.waitUntil(queueBackup(env, { action: "save", title, revision: newRevision, content: body }));
        await untilDone(ctx, finishSave(env, ctx, title, save.fields, newRevision, list));

        return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: tiddlerEtag(title, newRevision) } });
      } catch (error) {
        return failureResponse("Save failed", error, corsHeaders);
      }
    }

    // 5. DELETES
    if (request.method === "DELETE") {
      try {
        const match = url.pathname.match(/^\/(?:bags|recipes)\/[^\/]+\/tiddlers\/(.+)$/);
        if (!match) return new Response("Invalid DELETE path", { status: 400, headers: corsHeaders });

        const title = decodeURIComponent(match[1]);
        // The story list, state and temp tiddlers are never stored, so there is nothing to delete or back up
        if (isEphemeralTitle(title)) return new Response(null, { status: 204, headers: corsHeaders });

        // Read first, like a save (see there). The check below is then followed at once by the
        // delete, which can't be made conditional.
        const list = await readableList(env, ctx);
        const found = await findTiddler(env, title);
        let currentRevision;
        if (found) {
          currentRevision = await storedRevision(env, found);
          const { reason } = checkPreconditions(request, currentRevision);
          if (reason) return conflictResponse(title, reason, currentRevision, corsHeaders);
        }
        if (found) {
          for (const key of tiddlerKeys(title)) {
            await env.WIKI_BUCKET.delete(key);
          }
        }
        // Queued before the list update, which may fail (the retry then finds nothing to delete)
        if (found) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
        await untilDone(ctx, (async () => {
          // If it was neither stored nor listed, there is nothing to back up or purge
          const { removed, list: stored } = await removeFromManifest(env, ctx, title, list);
          if (!found && removed) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
          if (found || removed) ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title)));
          // The list entry says what it was; if it wasn't listed, delete any plugin file anyway
          // (deleting a missing object is free) and rebuild the page for system tiddlers
          if (removed ? needsPluginFile(removed) : found) {
            await env.WIKI_BUCKET.delete(pluginFileKey(title));
          }
          if (removed ? isPageTiddler(removed) : found && title.startsWith("$:/")) {
            await rebakeHtml(env, ctx, stored);
          }
        })());

        return new Response(null, { status: 204, headers: corsHeaders });
      } catch (error) {
        return failureResponse("Delete failed", error, corsHeaders);
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  },

  // Queue consumer: commits queued saves and deletes to GitHub, one at a time
  async queue(batch, env, ctx) {
    await processBackupBatch(batch, env);
  }
};

// --- Helper Functions ---

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

// Encoded the same way TiddlyWiki encodes them when it requests them
function tiddlerPurgeUrls(env, title) {
  return [publicUrl(env, `/recipes/default/tiddlers/${encodeURIComponent(title)}`), ...listPurgeUrls(env)];
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
  let object = await env.WIKI_BUCKET.get(MANIFEST_KEY,
    known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -"-patched".length) } } : undefined);
  // A conditional get that fails its precondition returns the object without a body
  if (object && !("body" in object)) return new Response(null, { status: 304, headers: listHeaders(object, corsHeaders) });

  let text = object ? await object.text() : null;
  let manifest = text === null ? null : parseList(text);
  if (!manifest) {
    // Missing or damaged: rebuilt from the stored tiddlers. (Answering [] would make every open tab
    // remove all its tiddlers as "missing from the server".)
    const rebuilt = await untilDone(ctx, rebuildList(env, ctx, { object, text }));
    // Just rebuilt: served as written (every entry already has its bag and recipe)
    if (rebuilt?.fresh) return new Response(rebuilt.text, { headers: listHeaders(rebuilt.object, corsHeaders) });
    manifest = rebuilt?.entries;
    if (!manifest) return rebuildingResponse(corsHeaders);
    object = rebuilt.object;
  }
  manifest = manifest.map(t => ({ ...t, bag: t.bag || "default", recipe: t.recipe || "default" }));
  return new Response(JSON.stringify(manifest), { headers: listHeaders(object, corsHeaders) });
}

function listHeaders(object, corsHeaders) {
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

const CONFLICT_GUARD_SOURCE = "__CONFLICT_GUARD_SOURCE__";   // replaced by the build

function conflictGuardEnabled(env) {
  return String(env.CONFLICT_GUARD || "").toLowerCase() !== "off";
}

// Changes whenever the guard code or the public URL changes, so baked.html is rebuilt after a deploy
// (the number in front changes when the way pages are built changes)
function bakeVersion(env) {
  const input = (conflictGuardEnabled(env) ? CONFLICT_GUARD_SOURCE : "off") + "\n" + publicUrl(env, "/");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return "4-" + hash.toString(36);
}

async function serveWiki(env, ctx, corsHeaders) {
  const htmlHeaders = { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
  const [baked, source] = await Promise.all([
    env.WIKI_BUCKET.get("baked.html"),
    env.WIKI_BUCKET.head("index.html")
  ]);
  if (baked) {
    const meta = baked.customMetadata || {};
    if (!source || (meta.bakeVersion === bakeVersion(env) && meta.sourceEtag === source.etag)) {
      return new Response(baked.body, { headers: htmlHeaders });
    }
    await baked.body.cancel();
  }
  const html = await rebakeHtml(env, ctx);
  if (html !== null) return new Response(html, { headers: htmlHeaders });
  // The rebuild failed (see the logs): the last page built is better than the bare engine
  const lastPage = baked && await env.WIKI_BUCKET.get("baked.html");
  if (lastPage) return new Response(lastPage.body, { headers: htmlHeaders });
  const fallback = await env.WIKI_BUCKET.get("index.html");
  if (!fallback) return new Response("Wiki not found", { status: 404 });
  return new Response(fallback.body, { headers: htmlHeaders });
}

// Stored tiddlers may use TiddlyWeb's layout (custom fields nested under "fields"); preloadTiddlers wants them flat
function toPreloadFields(tiddler) {
  const flat = {};
  if (tiddler.fields !== null && typeof tiddler.fields === "object") Object.assign(flat, tiddler.fields);
  for (const [name, value] of Object.entries(tiddler)) {
    if (name !== "fields") flat[name] = value;
  }
  if (typeof flat.revision === "number") flat.revision = String(flat.revision);
  return flat;
}

// --- Plugin files -------------------------------------------------------------------------------
// _plugins/<title>.js holds the stored tiddler, untouched, inside the same code the external-plugins
// export template produces: it adds the tiddler to $tw.preloadTiddlers before TiddlyWiki boots.
// The file name never changes; the page loads it as <title>.js?v=<revision>, so every version has
// its own URL and nothing needs purging. Files are served by the public site, never by the worker.

const PLUGIN_FILE_DIR = "_plugins/";
const PRELOAD_OPEN = "{\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([";
const PRELOAD_CLOSE = "]);\n}\n";
// Tiddlers stored in TiddlyWeb's layout (before the flat layout, or by other clients) keep their
// custom fields under "fields": the browser moves them up first, and sets the revision as a string
const PRELOAD_NESTED_OPEN = "{\nconst t = ";
const preloadNestedClose = revision => ";\nconst f = t.fields || {}; delete t.fields;\nfor (const k in f) if (!(k in t)) t[k] = f[k];\n" +
  `t.revision = ${JSON.stringify(String(revision))};\n` +
  "const tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([t]);\n}\n";

function pluginFileKey(title) {
  return `${PLUGIN_FILE_DIR}${title}.js`;
}

// Encoded the same way as the tiddler URLs the public wiki already loads
function pluginFileUrl(env, title, revision) {
  return publicUrl(env, `/${PLUGIN_FILE_DIR}${encodeURIComponent(title)}.js?v=${encodeURIComponent(revision)}`);
}

// Writes the plugin file from the stored tiddler. file: what head() returned for it (or null).
// Two page builds can overlap, so it doesn't replace a file holding a newer version, and writes
// only if the file is still the one it looked at. After two lost races, a missing file is written
// unconditionally (like the PUT handler's create-only fallback): best effort, not a guarantee.
// Returns the revision the file holds, or null.
async function writePluginFile(env, title, file) {
  let obj = null;
  for (const key of tiddlerKeys(title)) {
    if ((obj = await env.WIKI_BUCKET.get(key))) break;
  }
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let revision = obj.customMetadata?.revision;
  if (!revision) {
    let body = null;
    try { body = JSON.parse(decoder.decode(bytes)); } catch (e) {}
    revision = revisionOf(obj, body);
  }
  const flat = obj.customMetadata?.layout === FLAT_LAYOUT;
  const content = concatBytes([
    encoder.encode(flat ? PRELOAD_OPEN : PRELOAD_NESTED_OPEN), bytes, encoder.encode(flat ? PRELOAD_CLOSE : preloadNestedClose(revision))
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
      revision = await writePluginFile(env, entry.title, file);
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

// Saves baked.html, unless an overlapping build from a newer tiddler list has already saved one
// for the same worker and index.html. "Newer" compares when R2 stored each list (listVersion), so
// a list replaced by hand counts as newer too. Returns false if it kept the other page. The last
// try writes unconditionally, like the create-only fallback in the PUT handler: best effort.
async function storePage(env, html, meta) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await env.WIKI_BUCKET.head("baked.html");
    const theirs = current?.customMetadata || {};
    if (current && theirs.bakeVersion === meta.bakeVersion && theirs.sourceEtag === meta.sourceEtag &&
        Number(theirs.listVersion) > Number(meta.listVersion)) {
      return false;
    }
    const written = await env.WIKI_BUCKET.put("baked.html", html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: meta,
      ...(current && attempt < 3 ? { onlyIf: { etagMatches: current.etag } } : {})
    });
    if (written) return true;
  }
  return false;
}

// Builds baked.html = index.html + startup tiddlers + conflict guard + plugin <script> tags, then
// purges the public copy. Returns the page (bytes), or null.
async function rebakeHtml(env, ctx, list = null) {
  try {
    const htmlObj = await env.WIKI_BUCKET.get("index.html");
    if (!htmlObj) return null;
    let html = new Uint8Array(await htmlObj.arrayBuffer());

    // list: the list a save or delete has just written. Otherwise it's read, and a missing or
    // damaged one rebuilt first (a page built without it would have no plugins); while that takes
    // more requests, this throws and the page stays as it is.
    const { object: manifestObj, entries: manifest } = list || await readableList(env, ctx, { pageBuild: true });
    // Every stored tiddler is listed, so only listed startup tiddlers are read
    const startupTitles = manifest.filter(t => t.title && isStartupTiddler(t)).map(t => t.title);

    const store = [];
    const [, pluginTags] = await Promise.all([
      Promise.all(startupTitles.map(async (title) => {
        for (const key of tiddlerKeys(title)) {
          const obj = await env.WIKI_BUCKET.get(key);
          if (obj) {
            try { store.push(toPreloadFields(await obj.json())); } catch (e) {}
            return;
          }
        }
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
    if (pluginTags) injected += `\n${pluginTags}\n`;
    if (injected) html = insertAfterHead(html, `\n${injected}\n`);

    const stored = await storePage(env, html, {
      bakeVersion: bakeVersion(env),
      sourceEtag: htmlObj.etag,
      listVersion: String(manifestObj ? manifestObj.uploaded.getTime() : 0)
    });
    if (stored) ctx.waitUntil(purgePublicCache(env, PUBLIC_PAGE_PATHS.map(path => publicUrl(env, path))));
    return html;
  } catch (err) {
    console.error("Failed to rebake HTML:", err);
    return null;
  }
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
    const text = JSON.stringify(manifest, null, 2);
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
// (always text, whatever the body says); fields: the tiddler without its text, in either layout.
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

// Returns { previous: the entry it replaced, or null; list: the list as now stored }
async function updateManifest(env, ctx, title, fields, revision, list = null) {
  const entry = listEntry(title, fields, revision);
  let previous = null;
  const stored = await mutateManifest(env, ctx, (manifest) => {
    const idx = manifest.findIndex(t => t.title === title);
    previous = idx >= 0 ? manifest[idx] : null;
    if (idx < 0) {
      manifest.push(entry);
      return manifest;
    }
    manifest[idx] = entry;
    // Listed twice (a hand edit, say): listed once from now on
    return manifest.some((t, i) => i > idx && t.title === title) ? manifest.filter((t, i) => i <= idx || t.title !== title) : manifest;
  }, list);
  return { previous, list: stored };
}

// Returns { removed: the entry it removed, or null if the title wasn't listed; list: the list as now stored }
async function removeFromManifest(env, ctx, title, list = null) {
  let removed = null;
  const stored = await mutateManifest(env, ctx, (manifest) => {
    removed = manifest.find(t => t.title === title) || null;
    return removed ? manifest.filter(t => t.title !== title) : null;
  }, list);
  return { removed, list: stored };
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

const TIDDLER_PREFIX = "recipes/default/tiddlers/";
const REPAIR_PROGRESS_KEY = "_repair/tiddler-list-progress.json";
const REPAIR_STEP_TIDDLERS = 100;         // read per request
const REPAIR_STEP_READ_BYTES = 2000000;   // tiddlers not in the flat layout are read whole (text skipped, about 1 ms per MB): at most this much per request
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

// Where the closing quote of the JSON string starting at `start` is, or -1: the next quote that
// isn't escaped (preceded by an even number of backslashes). Inside a string every quote is escaped.
function stringEnd(bytes, start) {
  for (let quote = bytes.indexOf(0x22, start + 1); quote !== -1; quote = bytes.indexOf(0x22, quote + 1)) {
    let slashes = 0;
    while (bytes[quote - 1 - slashes] === 0x5c) slashes++;
    if (slashes % 2 === 0) return quote;
  }
  return -1;
}

// Where a stored tiddler's text is, to skip it: { start, end } covers the top-level '"text":"…"' and
// the comma that separates it, or null if there's none. Strings are jumped over with indexOf, so a
// big text costs one hop per quote in it; only the bytes between strings are looked at one by one.
const TEXT_VALUE = encoder.encode('"text":"');
function textValueRange(bytes) {
  let depth = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x7b || byte === 0x5b) depth++;
    else if (byte === 0x7d || byte === 0x5d) depth--;
    else if (byte === 0x22) {
      const end = stringEnd(bytes, i);
      if (end === -1) return null;
      if (depth === 1 && TEXT_VALUE.every((b, j) => bytes[i + j] === b)) {
        const valueEnd = stringEnd(bytes, i + TEXT_VALUE.length - 1);
        if (valueEnd === -1) return null;
        let before = i - 1;
        while (before >= 0 && bytes[before] <= 0x20) before--;
        // ',"text":"…"' goes with the comma before it; the first key with the comma after it
        if (bytes[before] === 0x2c) return { start: before, end: valueEnd + 1 };
        let after = valueEnd + 1;
        while (after < bytes.length && bytes[after] <= 0x20) after++;
        return { start: i, end: bytes[after] === 0x2c ? after + 1 : valueEnd + 1 };
      }
      i = end;
    }
  }
  return null;
}

// A stored tiddler's fields without its text, in either layout, or null if it isn't a JSON object.
// The text, often most of the object (a plugin's is), is skipped as bytes, never decoded or parsed;
// if what's left doesn't parse, the whole object is parsed.
function storedFields(bytes) {
  const text = textValueRange(bytes);
  let fields = null;
  if (text) {
    try { fields = JSON.parse(decoder.decode(bytes.subarray(0, text.start)) + decoder.decode(bytes.subarray(text.end))); } catch (e) {}
  }
  if (fields === null) {
    try { fields = JSON.parse(decoder.decode(bytes)); } catch (e) { return null; }
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return null;
  delete fields.text;
  return fields;
}

// The list entry for a stored tiddler (item: from list()), or null if it isn't listed. Flat
// tiddlers have their fields before "text": usually only the start of the object is read.
async function storedEntry(env, item) {
  const partial = item.customMetadata?.layout === FLAT_LAYOUT && item.size > HEAD_BYTES;
  let obj = await env.WIKI_BUCKET.get(item.key, partial ? { range: { offset: 0, length: HEAD_BYTES } } : undefined);
  if (!obj) return null;   // deleted meanwhile
  let bytes = new Uint8Array(await obj.arrayBuffer());
  let fields = null;
  if (partial) {
    const cut = obj.customMetadata?.layout === FLAT_LAYOUT ? textKeyOffset(bytes) : -1;   // as stored now
    if (cut !== -1) {
      try { fields = JSON.parse(decoder.decode(bytes.subarray(0, cut)) + "}"); } catch (e) {}
    } else {
      // Re-saved in another layout meanwhile, or fields over HEAD_BYTES: read whole
      obj = await env.WIKI_BUCKET.get(item.key);
      if (!obj) return null;
      bytes = new Uint8Array(await obj.arrayBuffer());
    }
  }
  if (!fields) fields = storedFields(bytes);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    console.error(`Rebuilding the tiddler list: ${item.key} is not a readable tiddler, left out`);
    return null;
  }
  // A tiddler is stored under its title: the one in the save's URL, which must match the body's.
  // An older version stored some under their URL-encoded title.
  const keyTitle = item.key.slice(TIDDLER_PREFIX.length);
  const title = typeof fields.title === "string" && (fields.title === keyTitle || encodeURIComponent(fields.title) === keyTitle) ? fields.title : keyTitle;
  if (isEphemeralTitle(title) || isDraft(fields)) return null;
  // If both keys exist, the wiki uses the plain one (findTiddler)
  if (item.key !== TIDDLER_PREFIX + title && await env.WIKI_BUCKET.head(TIDDLER_PREFIX + title)) return null;
  return listEntry(title, fields, revisionOf(obj, fields), getTwTimestamp(obj.uploaded));
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
  const items = [];
  let readBytes = 0;
  for (const item of listing.objects) {
    const whole = item.customMetadata?.layout === FLAT_LAYOUT ? 0 : item.size;
    if (items.length > 0 && readBytes + whole > REPAIR_STEP_READ_BYTES) break;
    readBytes += whole;
    items.push(item);
  }
  const results = await mapLimit(items, 6, item => storedEntry(env, item));
  const entries = results.filter(Boolean);
  // Listed from an older version's URL-encoded key: if its plain key appears later in the rebuild
  // (a hand upload), it's listed twice, so the last step then removes duplicates
  const dedupe = (resume && meta.dedupe === "yes") || results.some((entry, i) => entry && items[i].key !== TIDDLER_PREFIX + entry.title);
  const added = encoder.encode(entries.map(entry => JSON.stringify(entry)).join(","));
  const all = concatBytes(done.length > 0 && added.length > 0 ? [done, encoder.encode(","), added] : [done, added]);
  let count = (resume ? Number(meta.count) || 0 : 0) + entries.length;

  if (listing.truncated || items.length < listing.objects.length) {
    // Only if the damaged list is still there (a request that read it just before another one
    // finished the rebuild would otherwise start a new one)
    if (!resume) {
      const current = await env.WIKI_BUCKET.head(MANIFEST_KEY);
      if (!current || `${current.etag}/${current.uploaded.getTime()}` !== rebuildId) return getList(env);
    }
    // Where the next step starts (list() may return an empty page that isn't the last); the key is
    // encoded, as metadata may be sent as HTTP headers
    const position = items.length > 0 ? { after: encodeURIComponent(items[items.length - 1].key) } : { cursor: listing.cursor };
    const options = { customMetadata: { rebuild: rebuildId, count: String(count), ...(dedupe ? { dedupe: "yes" } : {}), ...position } };
    // Saved only if no other request took this step meanwhile (otherwise its progress stands)
    if (progress) await env.WIKI_BUCKET.put(REPAIR_PROGRESS_KEY, all, { ...options, onlyIf: { etagMatches: progress.etag } });
    else await putIfAbsent(env, REPAIR_PROGRESS_KEY, all, options);
    return null;
  }

  // Every tiddler read: the new list replaces the damaged one, unless it was replaced meanwhile.
  // It's normally written as is, without parsing it, so the last step costs no more than the others:
  // each key is read once (each step adds to the progress it read, and only if no other request did
  // meanwhile), and a title has one key, except as above.
  let text = `[${decoder.decode(all)}]`;
  if (dedupe) {
    const byTitle = new Map(JSON.parse(text).map(entry => [entry.title, entry]));   // the last one read wins
    text = JSON.stringify([...byTitle.values()]);
    count = byTitle.size;
  }
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

// The page may have been built from a list that missed a plugin (a save whose list update failed
// and was never retried): it's built again on the next page load, rather than in this request
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
// back with a growing delay until they go through. Nothing runs while the queue is empty.
// Without a BACKUP_QUEUE binding (or if the queue is unavailable) the same backup runs directly.

const BACKUP_INLINE_LIMIT = 100000;   // queue messages are limited to 128 KB; bigger versions wait in R2
const BACKUP_PER_RUN = 10;            // keeps one run within Cloudflare's 50-subrequest limit (free plan)
const BACKUP_MAX_DELAY = 6 * 3600;    // longest wait between retries (seconds)

// Called after a save or delete has been stored; job.content is the stored bytes
async function queueBackup(env, job) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return;
  const message = { action: job.action, title: job.title, revision: job.revision ?? null, time: Date.now(), tries: 0 };
  if (env.BACKUP_QUEUE) {
    try {
      if (job.action === "save") {
        if (job.content.length <= BACKUP_INLINE_LIMIT) {
          message.content = decoder.decode(job.content);
        } else {
          // Keep this exact version until it is committed (R2 itself only holds the latest one)
          message.contentKey = `_backup/versions/${message.time}-${encodeURIComponent(job.title)}.json`;
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
  const direct = { ...message, content: job.content && decoder.decode(job.content), contentKey: undefined };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await backupJob(env, direct);
    } catch (e) {
      if (attempt === 3) console.error(`[Backup] '${job.title}' could not be backed up:`, e.message);
      else await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Queue consumer
async function processBackupBatch(batch, env) {
  const messages = [...batch.messages].sort((a, b) =>
    (a.body.time - b.body.time) || String(a.body.revision).localeCompare(String(b.body.revision)));
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i >= BACKUP_PER_RUN) {
      await requeueBackup(env, msg, 0, false);
      continue;
    }
    try {
      await backupJob(env, msg.body);
      msg.ack();
      if (msg.body.contentKey) await env.WIKI_BUCKET.delete(msg.body.contentKey);
    } catch (e) {
      const delay = backupRetryDelay(env, msg.body.tries, e.retryAfter);
      console.error(`[Backup] '${msg.body.title}' not backed up yet (${e.message}); retrying in ${delay}s`);
      // Keep the order: this message and all later ones wait and retry together
      for (let j = i; j < messages.length; j++) {
        await requeueBackup(env, messages[j], delay, j === i);
      }
      return;
    }
  }
}

function backupRetryDelay(env, tries, retryAfter) {
  const base = parseInt(env.BACKUP_RETRY_SECONDS, 10) || 60;
  const delay = Math.min(base * 2 ** (tries || 0), BACKUP_MAX_DELAY);
  return Math.ceil(Math.min(Math.max(delay, retryAfter || 0), 24 * 3600));
}

// Sends the message again as a fresh one, so neither the queue's retry limit nor its retention
// period can drop a backup that keeps failing
async function requeueBackup(env, msg, delaySeconds, countTry) {
  const body = countTry ? { ...msg.body, tries: (msg.body.tries || 0) + 1 } : msg.body;
  try {
    await env.BACKUP_QUEUE.send(body, delaySeconds > 0 ? { delaySeconds } : undefined);
    msg.ack();
  } catch (e) {
    msg.retry(delaySeconds > 0 ? { delaySeconds } : undefined);
  }
}

// Commits one save or delete
async function backupJob(env, job) {
  const github = githubContents(env);
  const inWiki = (await findTiddler(env, job.title)) !== null;

  if (job.action === "delete") {
    if (inWiki) return; // Recreated since then: its own save message updates GitHub
    const existing = await github.get(job.title);
    if (existing) await github.remove(job.title, existing.sha, `🗑️ Delete: ${job.title}`);
    return;
  }

  let content = job.content;
  if (content === undefined && job.contentKey) {
    const stored = await env.WIKI_BUCKET.get(job.contentKey);
    content = stored ? await stored.text() : undefined;
  }
  if (content === undefined) return; // Already handled by an earlier delivery of this message

  const existing = await github.get(job.title);
  let sha = existing ? existing.sha : null;
  if (sha !== await gitBlobSha(content)) {
    sha = await github.put(job.title, content, `✏️ Save: ${job.title}`, sha);
  }
  if (existing && existing.text !== null && isNewerRevision(revisionIn(existing.text), job.revision)) {
    // This version arrived after a newer one was committed: it is now in the history,
    // and the newer version goes back on top
    await github.put(job.title, existing.text, `✏️ Save: ${job.title} (newer version restored)`, sha);
  } else if (!inWiki) {
    // Deleted since this save: keep this version in the history, then delete it again
    await github.remove(job.title, sha, `🗑️ Delete: ${job.title}`);
  }
}

function revisionIn(text) {
  try { return String(JSON.parse(text).revision ?? ""); } catch (e) { return ""; }
}

// Revisions written by this worker are millisecond timestamps
function isNewerRevision(a, b) {
  return /^\d+$/.test(a) && /^\d+$/.test(String(b)) && Number(a) > Number(b);
}

// Git's blob id for a file, to recognise content GitHub already has
async function gitBlobSha(text) {
  const content = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const data = new Uint8Array(header.length + content.length);
  data.set(header);
  data.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

// A failed GitHub call; retryAfter (seconds) is set when GitHub says how long to wait
class GitHubError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.name = "GitHubError";
    this.retryAfter = retryAfter;
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
  async function call(method, title, body) {
    const apiBase = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/tiddlers/${encodeURIComponent(title)}.json`;
    // Reads ask for the "object" format: the default one isn't available for files between 1 and
    // 100 MB, so their backups would fail forever and hold up every later one. The object format
    // works for all sizes, with empty content above 1 MB.
    const res = await fetch(method === "GET" ? `${apiBase}?ref=${branch}` : apiBase, {
      method,
      headers: method === "GET" ? { ...headers, Accept: "application/vnd.github.object+json" } : headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if (method === "GET" && res.status === 404) return null;
    if (!res.ok) {
      // How long GitHub asks us to wait, if it says (rate limits)
      let waitSeconds;
      const retryAfter = parseInt(res.headers.get("retry-after"), 10);
      const reset = parseInt(res.headers.get("x-ratelimit-reset"), 10);
      if (retryAfter > 0) waitSeconds = retryAfter;
      else if (res.headers.get("x-ratelimit-remaining") === "0" && reset) waitSeconds = Math.max(reset - Date.now() / 1000, 1);
      throw new GitHubError(`GitHub ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`, waitSeconds);
    }
    return res.json();
  }
  return {
    // { sha, text } of the file on GitHub (text is null for files over 1 MB), or null
    async get(title) {
      const file = await call("GET", title);
      if (!file) return null;
      let text = null;
      if (file.encoding === "base64" && typeof file.content === "string") {
        const binary = atob(file.content.replace(/\n/g, ""));
        text = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
      }
      return { sha: file.sha, text };
    },
    // Returns the new blob sha
    async put(title, content, message, sha) {
      const result = await call("PUT", title, { message, content: toBase64(content), branch, ...(sha ? { sha } : {}) });
      return result.content.sha;
    },
    async remove(title, sha, message) {
      await call("DELETE", title, { message, sha, branch });
    }
  };
}
