// TiddlyWiki on Cloudflare: the admin worker
//
// Serves the editable wiki (TiddlyWeb protocol) from an R2 bucket, protects against edit
// conflicts between tabs, keeps the public R2-served copy's cache fresh, and backs every save
// up to GitHub through a Cloudflare Queue. See README.md for the full picture.
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

function getTwTimestamp() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 17);
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

// Titles the wiki keeps only in the browser: never stored, never backed up
function isEphemeralTitle(title) {
  return title.startsWith("$:/StoryList") ||
         title.startsWith("$:/HistoryList") ||
         title.startsWith("$:/state/") ||
         title.startsWith("$:/temp/") ||
         title.startsWith("$:/status/") ||
         /^Draft( \d+)? of '/.test(title);
}

// TiddlyWeb JSON puts non-standard fields such as draft.of under "fields"
function isDraft(tiddler) {
  return tiddler["draft.of"] !== undefined ||
         (tiddler.fields !== null && typeof tiddler.fields === "object" && tiddler.fields["draft.of"] !== undefined);
}

// Tiddlers that must be in the page when it boots, so they are baked into baked.html
const STARTUP_TITLES = ["$:/DefaultTiddlers", "$:/SiteTitle", "$:/SiteSubtitle"];
function isStartupTiddler(title, tags) {
  return STARTUP_TITLES.includes(title) || (Array.isArray(tags)
    ? tags.some(tag => tag.includes("$:/tags/StartupAction"))
    : typeof tags === "string" && tags.includes("$:/tags/StartupAction"));
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // FIX: Bulletproof CORS exposure for ETag capitalization
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, If-Match, If-None-Match, Authorization, Accept",
      "Access-Control-Expose-Headers": "ETag, Etag, etag",
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

      if (decodedKey === MANIFEST_KEY) return serveManifest(request, env, corsHeaders);

      let object = await env.WIKI_BUCKET.get(decodedKey);
      if (!object && rawKey !== decodedKey) {
        object = await env.WIKI_BUCKET.get(rawKey);
      }

      if (!object) return new Response("Not found", { status: 404, headers: corsHeaders });

      const headers = objectHeaders(object, corsHeaders);

      if (decodedKey.startsWith("recipes/default/tiddlers/") || decodedKey.startsWith("bags/default/tiddlers/")) {
        const title = decodedKey.replace(/^(recipes|bags)\/default\/tiddlers\//, "");
        const text = await object.text();
        let tiddlerData = null;
        try { tiddlerData = JSON.parse(text); } catch (e) {}
        // Always report the same revision that PUT/DELETE check against
        const revision = revisionOf(object, tiddlerData);

        headers.set("Cache-Control", "no-cache");
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
        const tiddler = JSON.parse(await request.text());

        if (isEphemeralTitle(title) || isDraft(tiddler)) {
          const etag = tiddlerEtag(title, Date.now().toString());
          return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: etag } });
        }

        const tiddlerKey = `recipes/default/tiddlers/${title}`;
        const found = await findTiddler(env, title);
        const currentRevision = found ? await storedRevision(env, found) : null;

        const { conditional, reason } = checkPreconditions(request, currentRevision);
        if (reason) return conflictResponse(title, reason, currentRevision, corsHeaders);

        const newRevision = Date.now().toString();
        tiddler.revision = newRevision;
        tiddler.bag = "default";
        tiddler.recipe = "default";

        const modifiedBody = JSON.stringify(tiddler);
        const putOptions = {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { revision: newRevision }
        };

        if (conditional) {
          // Only write if the object is still exactly the one we checked (or still absent)
          const replacesCurrent = found !== null && found.key === tiddlerKey;
          let written = await env.WIKI_BUCKET.put(tiddlerKey, modifiedBody, {
            ...putOptions,
            onlyIf: replacesCurrent ? { etagMatches: found.obj.etag } : new Headers({ "If-None-Match": "*" })
          });
          if (written === null && !replacesCurrent && !(await env.WIKI_BUCKET.head(tiddlerKey))) {
            // A create-only write was refused but nothing is there: write it normally
            written = await env.WIKI_BUCKET.put(tiddlerKey, modifiedBody, putOptions);
          }
          if (written === null) {
            const latest = await findTiddler(env, title);
            return conflictResponse(title, "it was changed in another tab or browser", latest ? await storedRevision(env, latest) : null, corsHeaders);
          }
        } else {
          await env.WIKI_BUCKET.put(tiddlerKey, modifiedBody, putOptions);
        }

        await updateManifest(env, title, tiddler, newRevision);
        ctx.waitUntil(queueBackup(env, { action: "save", title, revision: newRevision, content: modifiedBody }));
        ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title)));

        if (isStartupTiddler(title, tiddler.tags)) {
          ctx.waitUntil(rebakeHtml(env, ctx));
        }

        return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: tiddlerEtag(title, newRevision) } });
      } catch (error) {
        return new Response("Save failed: " + error.message, { status: 500, headers: corsHeaders });
      }
    }

    // 5. DELETES
    if (request.method === "DELETE") {
      try {
        const match = url.pathname.match(/^\/(?:bags|recipes)\/[^\/]+\/tiddlers\/(.+)$/);
        if (!match) return new Response("Invalid DELETE path", { status: 400, headers: corsHeaders });

        const title = decodeURIComponent(match[1]);
        // Drafts, the story list etc. are never stored, so there is nothing to delete or back up
        if (isEphemeralTitle(title)) return new Response(null, { status: 204, headers: corsHeaders });

        const found = await findTiddler(env, title);
        let currentRevision;
        if (found) {
          currentRevision = await storedRevision(env, found);
          const { reason } = checkPreconditions(request, currentRevision);
          if (reason) return conflictResponse(title, reason, currentRevision, corsHeaders);
          for (const key of tiddlerKeys(title)) {
            await env.WIKI_BUCKET.delete(key);
          }
        }
        // If it was neither stored nor listed, there is nothing to back up or purge
        const listed = await removeFromManifest(env, title);
        if (found || listed) {
          ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
          ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title)));
        }
        if (found && title.startsWith("$:/")) {
          ctx.waitUntil(rebakeHtml(env, ctx));
        }

        return new Response(null, { status: 204, headers: corsHeaders });
      } catch (error) {
        return new Response("Delete failed: " + error.message, { status: 500, headers: corsHeaders });
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
  return [
    publicUrl(env, `/recipes/default/tiddlers/${encodeURIComponent(title)}`),
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
async function serveManifest(request, env, corsHeaders) {
  // Our ETag is "<R2 etag>-patched"; Cloudflare's compression may hand it back weakened as W/"..."
  const known = parseEtagList(request.headers.get("If-None-Match")).find(token => token.endsWith("-patched"));
  const object = await env.WIKI_BUCKET.get(MANIFEST_KEY,
    known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -"-patched".length) } } : undefined);
  if (!object) return new Response("Not found", { status: 404, headers: corsHeaders });

  const headers = objectHeaders(object, corsHeaders);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", `"${object.etag}-patched"`);
  // A conditional get that fails its precondition returns the object without a body
  if (!("body" in object)) return new Response(null, { status: 304, headers });

  try {
    const manifest = JSON.parse(await object.text())
      .map(t => ({ ...t, bag: t.bag || "default", recipe: t.recipe || "default" }));
    return new Response(JSON.stringify(manifest), { headers });
  } catch (e) {
    return new Response("[]", { headers });
  }
}

// --- Browser-side conflict guard -------------------------------------------------------------
// A TiddlyWiki startup module baked into the page by rebakeHtml(). Set the worker variable
// CONFLICT_GUARD to "off" to stop including it.

const CONFLICT_GUARD_TITLE = "$:/cfworker/conflict-guard.js";

// Tells the browser module where the public copy is, so the admin wiki can load tiddler contents
// from there (no worker request) and only ask the worker when that copy isn't current
const PUBLIC_URL_TITLE = "$:/cfworker/public-url";

const CONFLICT_GUARD_SOURCE = String.raw`__CONFLICT_GUARD_SOURCE__`;

function conflictGuardEnabled(env) {
  return String(env.CONFLICT_GUARD || "").toLowerCase() !== "off";
}

// Changes whenever the guard code or the public URL changes, so baked.html is rebuilt after a deploy
function bakeVersion(env) {
  if (!conflictGuardEnabled(env)) return "3-off";
  const input = CONFLICT_GUARD_SOURCE + "\n" + publicUrl(env, "/");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return "3-" + hash.toString(36);
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
  const fallback = await env.WIKI_BUCKET.get("index.html");
  if (!fallback) return new Response("Wiki not found", { status: 404 });
  return new Response(fallback.body, { headers: htmlHeaders });
}

// Stored tiddlers use TiddlyWeb JSON (custom fields nested under "fields"); preloadTiddlers wants them flat
function toPreloadFields(tiddler) {
  const flat = {};
  if (tiddler.fields !== null && typeof tiddler.fields === "object") Object.assign(flat, tiddler.fields);
  for (const [name, value] of Object.entries(tiddler)) {
    if (name !== "fields") flat[name] = value;
  }
  if (typeof flat.revision === "number") flat.revision = String(flat.revision);
  return flat;
}

// Builds baked.html = index.html + startup tiddlers + conflict guard, then purges the public copy.
// Returns the HTML, or null.
async function rebakeHtml(env, ctx) {
  try {
    const htmlObj = await env.WIKI_BUCKET.get("index.html");
    if (!htmlObj) return null;

    let htmlText = await htmlObj.text();
    const startupTitles = new Set(STARTUP_TITLES);

    const manifestObj = await env.WIKI_BUCKET.get(MANIFEST_KEY);
    if (manifestObj) {
      try {
        for (const t of JSON.parse(await manifestObj.text())) {
          if (isStartupTiddler(t.title, t.tags)) startupTitles.add(t.title);
        }
      } catch (e) {
        console.error("Manifest parse error:", e);
      }
    }

    const store = [];
    await Promise.all(
      Array.from(startupTitles).map(async (title) => {
        for (const key of tiddlerKeys(title)) {
          const obj = await env.WIKI_BUCKET.get(key);
          if (obj) {
            try { store.push(toPreloadFields(await obj.json())); } catch (e) {}
            return;
          }
        }
      })
    );

    if (conflictGuardEnabled(env)) {
      store.push({
        title: CONFLICT_GUARD_TITLE,
        type: "application/javascript",
        "module-type": "startup",
        text: CONFLICT_GUARD_SOURCE
      });
      store.push({ title: PUBLIC_URL_TITLE, text: publicUrl(env, "/") });
    }

    if (store.length > 0) {
      const safeJson = JSON.stringify(store).replace(/</g, '\\u003c');
      const injectedScript = `
        <script>
          window.$tw = window.$tw || {};
          window.$tw.preloadTiddlers = window.$tw.preloadTiddlers || [];
          window.$tw.preloadTiddlers = window.$tw.preloadTiddlers.concat(${safeJson});
        </script>
      `;
      // A replacer function, so "$&", "$1" etc. inside tiddler text are not treated as patterns
      htmlText = htmlText.replace(/<head[^>]*>/i, (headTag) => `${headTag}\n${injectedScript}\n`);
    }

    await env.WIKI_BUCKET.put("baked.html", htmlText, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { bakeVersion: bakeVersion(env), sourceEtag: htmlObj.etag }
    });
    ctx.waitUntil(purgePublicCache(env, PUBLIC_PAGE_PATHS.map(path => publicUrl(env, path))));
    return htmlText;
  } catch (err) {
    console.error("Failed to rebake HTML:", err);
    return null;
  }
}

const MANIFEST_KEY = "recipes/default/tiddlers.json";

// Drops anything that should never have been listed (drafts, story list, state...)
function scrubManifest(manifest) {
  return manifest.filter(t => !isEphemeralTitle(t.title || ""));
}

// mutator returns the new manifest, or null when nothing needs to change
async function mutateManifest(env, mutator, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const existing = await env.WIKI_BUCKET.get(MANIFEST_KEY);

    let manifest = [];
    let etag = null;

    if (existing) {
      try {
        manifest = JSON.parse(await existing.text());
      } catch (e) {
        manifest = [];
      }
      if (!Array.isArray(manifest)) manifest = [];
      etag = existing.etag || existing.httpEtag.replace(/"/g, "");
    }

    manifest = mutator(scrubManifest(manifest));
    if (manifest === null) return false;

    const putOptions = {
      httpMetadata: { contentType: "application/json" }
    };

    if (etag) {
      putOptions.onlyIf = { etagMatches: etag };
    }

    const written = await env.WIKI_BUCKET.put(
      MANIFEST_KEY,
      JSON.stringify(manifest, null, 2),
      putOptions
    );

    if (written !== null) return true;

    console.warn(`[Manifest] Write conflict detected, retrying (${attempt}/${attempts})...`);
  }

  throw new Error("Manifest update failed: too many concurrent write conflicts");
}

async function updateManifest(env, title, tiddler, revisionStr) {
  const skinny = {
    title: tiddler.title ?? title,
    bag: "default",
    recipe: "default",
    modified: tiddler.modified || getTwTimestamp(),
    created: tiddler.created || getTwTimestamp(),
    tags: tiddler.tags || [],
    type: tiddler.type || "text/vnd.tiddlywiki",
    revision: revisionStr,
    _is_skinny: ""
  };

  if (tiddler.fields) skinny.fields = tiddler.fields;

  await mutateManifest(env, (manifest) => {
    const idx = manifest.findIndex(t => t.title === title);
    if (idx >= 0) manifest[idx] = skinny;
    else manifest.push(skinny);
    return manifest;
  });
}

// Returns true if the title was listed
async function removeFromManifest(env, title) {
  return mutateManifest(env, (manifest) =>
    manifest.some(t => t.title === title) ? manifest.filter(t => t.title !== title) : null
  );
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

// Called after a save or delete has been stored
async function queueBackup(env, job) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return;
  const message = { action: job.action, title: job.title, revision: job.revision ?? null, time: Date.now(), tries: 0 };
  if (env.BACKUP_QUEUE) {
    try {
      if (job.action === "save") {
        if (new TextEncoder().encode(job.content).length <= BACKUP_INLINE_LIMIT) {
          message.content = job.content;
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
  const direct = { ...message, content: job.content, contentKey: undefined };
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
    const res = await fetch(method === "GET" ? `${apiBase}?ref=${branch}` : apiBase, {
      method, headers, body: body ? JSON.stringify(body) : undefined
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
