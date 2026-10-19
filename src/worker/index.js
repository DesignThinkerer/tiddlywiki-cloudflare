// TiddlyWiki on Cloudflare: the admin worker. The entry point: the request router, and the queue
// consumer. See README.md for the whole picture, and design 1.1 for the requests answered here.
//
// Every request goes: Access check → settings check → the route whose method and path match. The
// modules, from the bottom up: docs (where the manual is, for messages), bytes, tiddlers, storage,
// settings, access, http (the small shared helpers); layout (reading and storing a tiddler), cache
// (public site purges), list (the tiddler list and its rebuild), plugins (plugin files), app (the
// app's manifest and icons), build (building the page), page (serving and publishing it); reads and
// saves (the handlers); backup/ (the GitHub backup through the queue); setup (the setup check).
// Each imports only from the ones before it (build.mjs refuses a cycle).
//
// worker.js is built from these by `npm run build` (build.mjs), with the browser modules of
// src/browser/ embedded as text (build.js lists them).

import { ACCESS_REFUSED, withoutAccess } from "./access.js";
import { processBackupBatch } from "./backup/queue.js";
import { backupSyncStatus, startBackupSync } from "./backup/sync.js";
import { decodePath, invalidPath } from "./http.js";
import { APP_ICON_SIZES, MANIFEST_KEY, serveIcon, serveManifest } from "./app.js";
import { serveServiceWorker } from "./build.js";
import { publishCoreFile, publishShell, serveWiki, updateEngine } from "./page.js";
import { serveList, serveObject, serveStatus } from "./reads.js";
import { handleDelete, handleSave } from "./saves.js";
import { publicSiteError } from "./settings.js";
import { setupCheck } from "./setup.js";
import { LIST_KEY } from "./storage.js";

// The admin wiki is served by this worker and talks to it from its own origin (its reads of the
// public site are allowed there, by the zone's CORS rule, setup 2.7); these headers let a page from
// elsewhere talk to it too. "*" gives nothing away: Access answers before the worker, and a browser
// shows a page from another site no response it asked for with credentials when the origin allowed
// is "*" (credentials need a named one), so such a page gets either a refusal or nothing. TiddlyWiki
// reads the ETag of each save, which a browser only shows a page that's told it may (Expose-Headers).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, X-Tiddler-Layout, If-Match, If-None-Match, Accept",
  "Access-Control-Expose-Headers": "ETag, X-Tiddler-List, Retry-After",
};

const PAGE_PATHS = ["/", "/index.html", "/baked.html"];

// The routes, in the order they're tried: { methods, matches(path) → what the handler gets (false:
// not this route; null: a path that isn't valid percent-encoding, 400), handle(...) }
const ROUTES = [
  { methods: ["OPTIONS"], matches: () => true, handle: (request, env, ctx, url, match, headers) => new Response(null, { headers }) },
  { methods: ["GET"], matches: path => path === "/status", handle: (request, env, ctx, url, match, headers) => serveStatus(headers) },
  { methods: ["GET"], matches: path => path === "/sw.js", handle: (request, env, ctx, url, match, headers) => serveServiceWorker(request, headers) },
  { methods: ["GET"], matches: path => path === `/${MANIFEST_KEY}`, handle: (request, env, ctx, url, match, headers) => serveManifest(env, headers) },
  { methods: ["GET"], matches: path => { const m = path.match(/^\/_app\/icon-(\d+)\.png$/); return m && APP_ICON_SIZES.includes(Number(m[1])) ? Number(m[1]) : false; }, handle: (request, env, ctx, url, size, headers) => serveIcon(env, size, headers) },
  { methods: ["GET"], matches: path => PAGE_PATHS.includes(path), handle: (request, env, ctx, url, match, headers) => serveWiki(request, env, ctx, headers) },
  // A full backup (design 1.7): started by the admin wiki, and how the last one went
  { methods: ["POST"], matches: path => path === "/backup/sync", handle: (request, env, ctx, url, match, headers) => startBackupSync(request, env, ctx, headers) },
  { methods: ["GET"], matches: path => path === "/backup/sync", handle: (request, env, ctx, url, match, headers) => backupSyncStatus(env, headers) },
  // The setup check (design 1.13): each piece of the setup looked at, on demand
  { methods: ["GET"], matches: path => path === "/setup/check", handle: (request, env, ctx, url, match, headers) => setupCheck(request, env, ctx, headers) },
  { methods: ["POST"], matches: path => path === "/engine/update", handle: (request, env, ctx, url, match, headers) => updateEngine(request, env, headers) },
  // Any other read is an object of the bucket, by its key: the tiddler list, a tiddler, a file
  { methods: ["GET", "HEAD"], matches: path => decodePath(path.substring(1)), handle: (request, env, ctx, url, key, headers) =>
    key === LIST_KEY ? serveList(request, env, ctx, headers) : serveObject(request, env, key, headers) },
  { methods: ["PUT"], matches: path => path === "/page/core", handle: (request, env, ctx, url, match, headers) => publishCoreFile(request, env, url, headers) },
  { methods: ["PUT"], matches: path => path === "/page/shell", handle: (request, env, ctx, url, match, headers) => publishShell(request, env, ctx, headers) },
  { methods: ["PUT"], matches: () => true, handle: (request, env, ctx, url, match, headers) => handleSave(request, env, ctx, url, headers) },
  { methods: ["DELETE"], matches: () => true, handle: (request, env, ctx, url, match, headers) => handleDelete(request, env, ctx, url, headers) },
];

const plainText = (text, status) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env, ctx) {
    // Before anything else: a request Access didn't authenticate costs nothing but this answer
    if (withoutAccess(request, ctx, env)) return plainText(ACCESS_REFUSED, 403);
    const url = new URL(request.url);
    // Nor anything with a public address that isn't a site's (the page would load its code from
    // nowhere); none at all is a private wiki
    const notSetUp = publicSiteError(env, url.origin);
    if (notSetUp) return plainText(notSetUp, 500);

    for (const route of ROUTES) {
      if (!route.methods.includes(request.method)) continue;
      const match = route.matches(url.pathname);
      if (match === null) return invalidPath(CORS_HEADERS);
      if (match === false) continue;
      return route.handle(request, env, ctx, url, match, CORS_HEADERS);
    }
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  },

  // Queue consumer: commits queued saves and deletes to GitHub, one at a time
  async queue(batch, env) {
    await processBackupBatch(batch, env);
  }
};
