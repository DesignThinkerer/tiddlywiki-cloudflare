// Building the page, baked.html (design 1.3): the page source (the published shell, or index.html)
// with, right after <head>, a script that preloads what the page needs at boot (the startup
// tiddlers, the browser modules and their settings), and the plugin files and the core file loaded
// before TiddlyWiki boots. Rebuilt when the page source, the browser modules or a page tiddler
// change. Two builds can overlap: each page records what it was built from, and an older build
// doesn't replace a newer page (storePage).

import { concatBytes, encoder } from "./bytes.js";
import { PUBLIC_PAGE_PATHS, purgePublicCache } from "./cache.js";
import { hasNestedFields } from "./layout.js";
import { readableList } from "./list.js";
import { pluginScriptTags } from "./plugins.js";
import { conflictGuardEnabled, publicSite, publicUrl } from "./settings.js";
import { CORE_KEY, INDEX_KEY, PAGE_KEY, SHELL_KEY } from "./storage.js";
import { isStartupTiddler, needsPluginFile, tiddlerKey } from "./tiddlers.js";

// The browser modules (src/browser/, README 3), baked into the page as TiddlyWiki modules: the
// library the others require, the conflict guard, the list sync, the backup alert, the page
// publisher (see "The page" below), the restore import (the backup's files dropped onto the wiki)
// and the control panel's Cloudflare tab. Each source is a placeholder here, which build.mjs
// replaces with the file's text (the first with src/browser/lib.js, and so on).
const BROWSER_MODULES = [
  { title: "$:/cfworker/lib.js", type: "library", source: "__LIB_SOURCE__" },
  { title: "$:/cfworker/conflict-guard.js", type: "startup", source: "__CONFLICT_GUARD_SOURCE__" },
  { title: "$:/cfworker/list-sync.js", type: "startup", source: "__LIST_SYNC_SOURCE__" },
  { title: "$:/cfworker/backup-alert.js", type: "startup", source: "__BACKUP_ALERT_SOURCE__" },
  { title: "$:/cfworker/page-publisher.js", type: "startup", source: "__PAGE_PUBLISHER_SOURCE__" },
  { title: "$:/cfworker/restore-import.js", type: "startup", source: "__RESTORE_IMPORT_SOURCE__" },
  { title: "$:/cfworker/control-panel.js", type: "startup", source: "__CONTROL_PANEL_SOURCE__" }
];

// Their settings. The public site's address: the admin wiki loads tiddler contents from there (no
// worker request) and only asks the worker when that copy isn't current. Empty for a private wiki
// (README 2.1): the modules then know this site is the admin site, and read from the worker.
const PUBLIC_URL_TITLE = "$:/cfworker/public-url";

// What the page carries as the public address: the site with a trailing slash, or ""
function publicAddress(env) {
  return publicSite(env) ? publicUrl(env, "/") : "";
}

// What the page was built from, so the page publisher can tell when it needs publishing again
const PAGE_SOURCE_TITLE = "$:/cfworker/page-source";

// Changes whenever the browser modules or the public URL change, so baked.html is rebuilt after a
// deploy (the number in front changes when the way pages are built changes). Asked at every page
// load: worked out once while the worker runs (hashing the modules costs about 0.3 ms), again only
// if its settings change.
let lastBakeVersion = { settings: null, version: "" };

export function bakeVersion(env) {
  const enabled = conflictGuardEnabled(env), settings = enabled + "\n" + publicAddress(env);
  if (lastBakeVersion.settings !== settings) {
    const input = (enabled ? BROWSER_MODULES.map(m => m.source).join("\n") : "off") + "\n" + publicAddress(env);
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
export const PAGE_ETAG_SUFFIX = "-page";

// Inserts markup right after <head ...>. Works on the bytes of index.html (a few MB): decoding,
// editing and re-encoding the whole page as a string costs about ten times more CPU.
export const pageDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

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
// (every stored tiddler is listed, so only listed ones are read), and the browser modules with
// their settings, unless CONFLICT_GUARD is off
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
  if (conflictGuardEnabled(env)) {
    for (const m of BROWSER_MODULES) store.push({ title: m.title, type: "application/javascript", "module-type": m.type, text: m.source });
    store.push({ title: PUBLIC_URL_TITLE, text: publicAddress(env) });
    store.push({ title: PAGE_SOURCE_TITLE, type: "application/json", text: JSON.stringify({ index: pageSource.index, fingerprint: pageSource.fingerprint, core: pageSource.core, shell: pageSource.shell || "" }) });
  }
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
  if (injected) html = insertAfterHead(html, `\n${injected}\n`);
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
    return { html, page: stored };
  } catch (err) {
    console.error("Failed to rebake HTML:", err);
    return null;
  }
}

// What a page is built from: { html (bytes), index: index.html's ETag, fingerprint: the shell's
// ("" for index.html itself), core: the stored core file's version ("" if none), shell: the stored
// shell's ETag ("" for index.html itself), the version a tab sends back with the page it publishes
// (publishShell) }, or null if there's no index.html
async function readPageSource(env) {
  const [index, shell, coreFile] = await Promise.all([
    env.WIKI_BUCKET.head(INDEX_KEY), env.WIKI_BUCKET.get(SHELL_KEY), env.WIKI_BUCKET.head(CORE_KEY)
  ]);
  const core = coreFile?.customMetadata?.v || "";
  if (shell && index && shell.customMetadata?.index === index.etag) {
    return { html: new Uint8Array(await shell.arrayBuffer()), index: index.etag, fingerprint: shell.customMetadata.fingerprint || "", core, shellVersion: shell.uploaded.getTime(), shell: shell.etag };
  }
  if (shell) await shell.body.cancel();
  const full = await env.WIKI_BUCKET.get(INDEX_KEY);
  return full && { html: new Uint8Array(await full.arrayBuffer()), index: full.etag, fingerprint: "", core, shell: "" };
}

// Where the page loads the core file from: the public site, or this site (root-relative) for a
// private wiki. The page publisher writes the same URL into the shell (page.js checks it).
export function coreFileUrl(env, version) {
  return publicUrl(env, `/${CORE_KEY}?v=${encodeURIComponent(version)}`);
}

export const EXTERNAL_SCRIPTS_MARKER = "<!--~~ Load external JavaScripts ~~-->";
