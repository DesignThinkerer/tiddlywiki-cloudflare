// TiddlyWiki on Cloudflare: the admin worker. The entry point: the request router, and the queue
// consumer. See README.md for the whole picture, and 4.1 for the requests answered here.
//
// Every request goes: Access check → settings check → the route whose method and path match. The
// modules, from the bottom up: bytes, tiddlers, storage, settings, access, http (the small shared
// helpers); layout (reading and storing a tiddler), cache (public site purges), list (the tiddler
// list and its rebuild), plugins (plugin files), build (building the page), page (serving and
// publishing it); reads and saves (the handlers); backup/ (the GitHub backup through the queue).
// Each imports only from the ones before it (build.mjs refuses a cycle).
//
// worker.js is built from these by `npm run build` (build.mjs), with the browser modules
// src/conflict-guard.js and src/page-publisher.js embedded as text.

import { ACCESS_REFUSED, withoutAccess } from "./access.js";
import { processBackupBatch } from "./backup/queue.js";
import { decodePath, invalidPath, objectHeaders, tiddlerEtag } from "./http.js";
import { publishCoreFile, publishShell, serveWiki } from "./page.js";
import { ADMIN_STATUS, STATUS_CACHE, serveManifest } from "./reads.js";
import { handleDelete, handleSave } from "./saves.js";
import { publicSiteError } from "./settings.js";
import { MANIFEST_KEY, TIDDLER_PREFIX } from "./storage.js";
import { keyTooLong, revisionOf } from "./tiddlers.js";

export default {
  async fetch(request, env, ctx) {
    // Before anything else: a request Access didn't authenticate costs nothing but this answer
    if (withoutAccess(ctx, env)) {
      return new Response(ACCESS_REFUSED, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const url = new URL(request.url);
    // Nor anything without the public site's address (the page would load its code from nowhere)
    const notSetUp = publicSiteError(env, url.origin);
    if (notSetUp) return new Response(notSetUp, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
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
