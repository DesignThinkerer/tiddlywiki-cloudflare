// Building the page, baked.html (design 1.3): the page source (the published shell, or index.html)
// with, right after <head>, a script that preloads what the page needs at boot (the startup
// tiddlers, the browser modules and their settings), and the plugin files and the core file loaded
// before TiddlyWiki boots. Rebuilt when the page source, the browser modules or a page tiddler
// change. Two builds can overlap: each page records what it was built from, and an older build
// doesn't replace a newer page (storePage).

import { APP_HEAD, ensureAppFiles } from "./app.js";
import { concatBytes, encoder } from "./bytes.js";
import { PUBLIC_PAGE_PATHS, purgePublicCache } from "./cache.js";
import { hasNestedFields } from "./layout.js";
import { readableList } from "./list.js";
import { pluginScriptTags } from "./plugins.js";
import { conflictGuardEnabled, publicSite, publicUrl } from "./settings.js";
import { CORE_KEY, INDEX_KEY, PAGE_KEY, SHELL_KEY } from "./storage.js";
import { isStartupTiddler, needsPluginFile, tiddlerKey } from "./tiddlers.js";

// The browser modules (src/browser/, operating 3), baked into the page as TiddlyWiki modules: the
// library the others require, the conflict guard, the list sync, the backup alert, the page
// publisher (see "The page" below), the restore import (the backup's files dropped onto the wiki),
// the control panel's Cloudflare tab, the outbox (changes kept on the device until the worker has
// them), the cold start (the service worker registered) and the device tab (what this browser
// keeps). Each source is a placeholder here, which build.mjs replaces with the file's text (the
// first with src/browser/lib.js, and so on).
const BROWSER_MODULES = [
  { title: "$:/cfworker/lib.js", type: "library", source: "__LIB_SOURCE__" },
  { title: "$:/cfworker/conflict-guard.js", type: "startup", source: "__CONFLICT_GUARD_SOURCE__" },
  { title: "$:/cfworker/list-sync.js", type: "startup", source: "__LIST_SYNC_SOURCE__" },
  { title: "$:/cfworker/backup-alert.js", type: "startup", source: "__BACKUP_ALERT_SOURCE__" },
  { title: "$:/cfworker/page-publisher.js", type: "startup", source: "__PAGE_PUBLISHER_SOURCE__" },
  { title: "$:/cfworker/restore-import.js", type: "startup", source: "__RESTORE_IMPORT_SOURCE__" },
  { title: "$:/cfworker/control-panel.js", type: "startup", source: "__CONTROL_PANEL_SOURCE__" },
  { title: "$:/cfworker/outbox.js", type: "startup", source: "__OUTBOX_SOURCE__" },
  { title: "$:/cfworker/cold-start.js", type: "startup", source: "__COLD_START_SOURCE__" },
  { title: "$:/cfworker/device.js", type: "startup", source: "__DEVICE_SOURCE__" }
];

// The admin wiki's service worker (src/browser/service-worker.js, design 1.11): not a module of the
// page but a script the worker serves at /sw.js, registered by the cold-start module at the address
// the page carries ($:/cfworker/sw-url), which changes with the script, so a new one takes over at
// the next load
const SERVICE_WORKER_SOURCE = "__SERVICE_WORKER_SOURCE__";
const SW_URL_TITLE = "$:/cfworker/sw-url";
let serviceWorkerVersion = "";

export function swVersion() {
  if (!serviceWorkerVersion) serviceWorkerVersion = "1-" + hashText(SERVICE_WORKER_SOURCE).toString(36);
  return serviceWorkerVersion;
}

// GET /sw.js: the service worker script. The browser checks the script of a registration at
// navigations, from its cache while the script is fresh (a day here), past it afterwards: so a
// page load costs no request for it, and a new version has a new address anyway (the page's).
export function serveServiceWorker(request, corsHeaders) {
  const etag = `"sw-${swVersion()}"`;
  const headers = { ...corsHeaders, "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, max-age=86400", ETag: etag };
  if ((request.headers.get("If-None-Match") || "").includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(SERVICE_WORKER_SOURCE, { headers });
}

function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Their settings. The public site's address: the admin wiki loads tiddler contents from there (no
// worker request) and only asks the worker when that copy isn't current. Empty for a private wiki
// (setup 2.1): the modules then know this site is the admin site, and read from the worker.
const PUBLIC_URL_TITLE = "$:/cfworker/public-url";

// What the page carries as the public address: the site with a trailing slash, or ""
function publicAddress(env) {
  return publicSite(env) ? publicUrl(env, "/") : "";
}

// What the page was built from, so the page publisher can tell when it needs publishing again
const PAGE_SOURCE_TITLE = "$:/cfworker/page-source";

// The modules and their settings travel as one plugin (design 2.21), $:/plugins/cfworker/admin:
// its parts are shadow tiddlers (out of search, out of syncing, overridden only on purpose), and
// Control Panel → Plugins lists it with the worker's version (package.json's, plus the hash of
// everything else in it: pluginVersion) and three tabs, a readme, the settings and the device
// (src/browser/*.txt).
// Preloaded like the modules were: never stored, never a plugin file (tiddlers.js, page-publisher.js).
export const ADMIN_PLUGIN_TITLE = "$:/plugins/cfworker/admin";
const PACKAGE_VERSION = "__PACKAGE_VERSION__";   // filled by build.mjs from package.json
export const SHIPPED_VERSION = "__TIDDLYWIKI_VERSION__";   // the TiddlyWiki version of the empty wiki the worker ships (build.mjs)
const PLUGIN_README_SOURCE = "__PLUGIN_README_SOURCE__";
const PLUGIN_SETTINGS_SOURCE = "__PLUGIN_SETTINGS_SOURCE__";
const PLUGIN_DEVICE_SOURCE = "__PLUGIN_DEVICE_SOURCE__";
const PLUGIN_FIELDS = {
  name: "TiddlyWiki on Cloudflare", description: "The admin wiki's side of the worker: conflicts, the tiddler list and the device copy, backups, the published page, editing and opening offline",
  author: "https://github.com/DesignThinkerer/tiddlywiki-cloudflare", "core-version": ">=5.3.0", list: "readme settings device"
};
let adminPluginVersion = "";

// package.json's version, plus the hash of everything else in the plugin that doesn't depend on
// the wiki: the modules, the service worker's address, the three tabs and the fields above. So the
// version changes whenever any of them does, and the page, which carries the plugin, is rebuilt
// (bakeVersion). Worked out once while the worker runs.
export function pluginVersion() {
  if (!adminPluginVersion) {
    // (The shipped TiddlyWiki version is in the page too, for the Cloudflare tab: a new one, a new page)
    const parts = [...BROWSER_MODULES.map(m => m.source), swVersion(), PLUGIN_README_SOURCE, PLUGIN_SETTINGS_SOURCE, PLUGIN_DEVICE_SOURCE, JSON.stringify(PLUGIN_FIELDS), SHIPPED_VERSION];
    adminPluginVersion = PACKAGE_VERSION + "+" + hashText(parts.join("\n")).toString(36);
  }
  return adminPluginVersion;
}

function adminPlugin(env, pageSource) {
  const tiddlers = {};
  for (const m of BROWSER_MODULES) tiddlers[m.title] = { title: m.title, type: "application/javascript", "module-type": m.type, text: m.source };
  tiddlers[PUBLIC_URL_TITLE] = { title: PUBLIC_URL_TITLE, text: publicAddress(env) };
  tiddlers[SW_URL_TITLE] = { title: SW_URL_TITLE, text: `/sw.js?v=${swVersion()}` };
  tiddlers[PAGE_SOURCE_TITLE] = { title: PAGE_SOURCE_TITLE, type: "application/json", text: JSON.stringify({ index: pageSource.index, fingerprint: pageSource.fingerprint, core: pageSource.core, shell: pageSource.shell || "", engine: engineVersion(pageSource.html), shipped: SHIPPED_VERSION }) };
  tiddlers[`${ADMIN_PLUGIN_TITLE}/readme`] = { title: `${ADMIN_PLUGIN_TITLE}/readme`, text: PLUGIN_README_SOURCE };
  tiddlers[`${ADMIN_PLUGIN_TITLE}/settings`] = { title: `${ADMIN_PLUGIN_TITLE}/settings`, text: PLUGIN_SETTINGS_SOURCE };
  tiddlers[`${ADMIN_PLUGIN_TITLE}/device`] = { title: `${ADMIN_PLUGIN_TITLE}/device`, text: PLUGIN_DEVICE_SOURCE };
  return {
    title: ADMIN_PLUGIN_TITLE, "plugin-type": "plugin", type: "application/json", ...PLUGIN_FIELDS, version: pluginVersion(),
    text: JSON.stringify({ tiddlers })
  };
}

// Changes whenever the plugin (pluginVersion: the modules, the service worker, the tabs, the fields,
// the package version) or the public URL changes, so baked.html is rebuilt after a deploy that
// changes what the page carries, and not after one that doesn't (the number in front changes when
// the way pages are built changes). Asked at every page load: worked out once while the worker
// runs (hashing the modules costs about 0.3 ms), again only if its settings change.
let lastBakeVersion = { settings: null, version: "" };

export function bakeVersion(env) {
  const enabled = conflictGuardEnabled(env), settings = enabled + "\n" + publicAddress(env);
  if (lastBakeVersion.settings !== settings) {
    const input = (enabled ? pluginVersion() : "off") + "\n" + publicAddress(env);
    lastBakeVersion = { settings, version: "9-" + hashText(input).toString(36) };
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
export const PAGE_ETAG_SUFFIX = "-page";

// Inserts markup right after <head ...>. Works on the bytes of index.html (a few MB): decoding,
// editing and re-encoding the whole page as a string costs about ten times more CPU.
export const pageDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

// The TiddlyWiki version a page (index.html, or the shell rendered from it) was made by: its
// <meta name="tiddlywiki-version"> tag, in the head; "" when there's none. Looked for in the first
// 64 KB (bytes or a string).
export function engineVersion(html) {
  const head = typeof html === "string" ? html.slice(0, 65536) : pageDecoder.decode(html.subarray(0, Math.min(html.length, 65536)));
  const match = /<meta\s+name="tiddlywiki-version"\s+content="([^"]*)"/i.exec(head);
  return match ? match[1] : "";
}

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
export function charStart(bytes, at) {
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
    const current = await env.WIKI_BUCKET.head(PAGE_KEY);
    const theirs = current?.customMetadata || {};
    let stored = meta;
    if (current && theirs.bakeVersion === meta.bakeVersion && theirs.sourceEtag === meta.sourceEtag) {
      const newerList = Number(theirs.listVersion) - Number(meta.listVersion),
        newerShell = Number(theirs.shellVersion || 0) - Number(meta.shellVersion);
      if (newerList >= 0 && newerShell >= 0 && (newerList > 0 || newerShell > 0)) return null;
      if (newerList > 0 || newerShell > 0) stored = { ...meta, bakeVersion: "outdated" };
    }
    const pageTime = Math.max(Math.floor(Date.now() / 1000), Number(theirs.pageTime || 0) + 1);
    const written = await env.WIKI_BUCKET.put(PAGE_KEY, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { ...stored, pageTime: String(pageTime) },
      ...(current && attempt < 3 ? { onlyIf: { etagMatches: current.etag } } : {})
    });
    if (written) return written;
  }
  return null;
}

// What the page preloads ($tw.preloadTiddlers): the listed startup tiddlers, read from the bucket
// (every stored tiddler is listed, so only listed ones are read), and the admin plugin (the browser
// modules with their settings), unless CONFLICT_GUARD is off
async function preloadedTiddlers(env, entries, pageSource) {
  const store = [];
  const startupTitles = entries.filter(t => t.title && isStartupTiddler(t)).map(t => t.title);
  await Promise.all(startupTitles.map(async (title) => {
    const obj = await env.WIKI_BUCKET.get(tiddlerKey(title));
    if (!obj) return;
    try {
      const tiddler = await obj.json();
      if (hasNestedFields(tiddler)) tiddler.fields = tiddler.fields.fields;
      store.push(tiddler);
    } catch (e) {}
  }));
  if (conflictGuardEnabled(env)) store.push(adminPlugin(env, pageSource));
  return store;
}

// The page source with the preloaded tiddlers (as a script right after <head>) and the plugin
// script tags in it. In a shell, plugins load right before the core (they must run before
// TiddlyWiki starts, which the core does), so they don't hold up the top of the page (a splash
// screen). In a full index.html, where TiddlyWiki starts from code inside the page, from <head>.
// (Only a shell is searched: in index.html, the marker is only in TiddlyWiki's templates, so the
// search would decode the whole page for nothing, and one in raw markup isn't the place.)
function pageWithPreloads(pageSource, store, pluginTags) {
  let html = pageSource.html;
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
  // The app's manifest and icon, for the browser to install the wiki (app.js)
  injected += `\n${APP_HEAD}\n`;
  html = insertAfterHead(html, `\n${injected}\n`);
  return html;
}

// Builds baked.html = the page source (the published shell, or index.html, see readPageSource) +
// startup tiddlers + browser modules + plugin <script> tags, then purges the public copy. source:
// the page source, if the caller has it. Returns { html (bytes), page: the stored page's R2 object,
// or null if an overlapping build's page was kept }, or null.
export async function rebakeHtml(env, ctx, list = null, source = null) {
  try {
    const pageSource = source || await readPageSource(env);
    if (!pageSource) return null;
    // list: the list a save or delete has just written. Otherwise it's read, and a missing or
    // damaged one rebuilt first (a page built without it would have no plugins); while that takes
    // more requests, this throws and the page stays as it is.
    const { object: listObject, entries } = list || await readableList(env, ctx, { pageBuild: true });
    const [store, pluginTags] = await Promise.all([
      preloadedTiddlers(env, entries, pageSource),
      pluginScriptTags(env, entries.filter(t => t.title && needsPluginFile(t)))
    ]);
    const html = pageWithPreloads(pageSource, store, pluginTags);
    const stored = await storePage(env, html, {
      bakeVersion: bakeVersion(env),
      sourceEtag: pageSource.index,
      shell: pageSource.fingerprint,
      shellVersion: String(pageSource.shellVersion || 0),
      listVersion: String(listObject ? listObject.uploaded.getTime() : 0)
    });
    if (stored) ctx.waitUntil(purgePublicCache(env, PUBLIC_PAGE_PATHS.map(path => publicUrl(env, path))));
    // The public site's manifest and icons, beside the page (finished even if the request ends first)
    ctx.waitUntil(ensureAppFiles(env, ctx, pageSource));
    return { html, page: stored };
  } catch (err) {
    console.error("Failed to rebake HTML:", err);
    return null;
  }
}

// What a page is built from: { html (bytes), index: index.html's ETag, fingerprint: the shell's
// ("" for index.html itself), core: the stored core file's version ("" if none), shell: the stored
// shell's ETag ("" for index.html itself, unless a stored shell was passed over: then its ETag, the
// version the next one replaces), the version a tab sends back with the page it publishes
// (publishShell) }, or null if there's no index.html.
// The shell is used while it's the one published for this index.html and loads the core file from
// where the page would (coreFileUrl: the public site, or this site for a private wiki). After a
// change of the public address, the shell published for the old one names it in the core's script
// tag: built from, both sites would load the core from a site that may be gone, and the admin wiki,
// unable to start, would never publish another. It's passed over, and the page built from index.html
// until the admin wiki publishes a shell for the new address, at its next load (design 1.9).
async function readPageSource(env) {
  const [index, shell, coreFile] = await Promise.all([
    env.WIKI_BUCKET.head(INDEX_KEY), env.WIKI_BUCKET.get(SHELL_KEY), env.WIKI_BUCKET.head(CORE_KEY)
  ]);
  const core = coreFile?.customMetadata?.v || "";
  const kept = shell && index && shell.customMetadata?.index === index.etag ? shell : null;
  if (kept) {
    const html = new Uint8Array(await kept.arrayBuffer());
    if (loadsCoreFile(html, env, core)) {
      return { html, index: index.etag, fingerprint: kept.customMetadata.fingerprint || "", core, shellVersion: kept.uploaded.getTime(), shell: kept.etag };
    }
    console.log("The published page loads the core file from elsewhere than the public site (or this site, for a private wiki): the page is built from index.html until the admin wiki publishes it again");
  } else if (shell) await shell.body.cancel();
  const full = await env.WIKI_BUCKET.get(INDEX_KEY);
  return full && { html: new Uint8Array(await full.arrayBuffer()), index: full.etag, fingerprint: "", core, shell: kept ? kept.etag : "" };
}

// Whether a shell loads the stored core file from where the page would: its script tag is at the end
// of the page, so the last 64 KB are looked at (what publishShell checked on the whole shell)
function loadsCoreFile(html, env, version) {
  if (!version) return false;
  const from = charStart(html, Math.max(0, html.length - 65536));
  return pageDecoder.decode(html.subarray(from)).includes(`<script src="${coreFileUrl(env, version)}"`);
}

// Where the page loads the core file from: the public site, or this site (root-relative) for a
// private wiki. The page publisher writes the same URL into the shell (page.js checks it).
export function coreFileUrl(env, version) {
  return publicUrl(env, `/${CORE_KEY}?v=${encodeURIComponent(version)}`);
}

export const EXTERNAL_SCRIPTS_MARKER = "<!--~~ Load external JavaScripts ~~-->";
