// Serving the page, and the page the admin wiki publishes (design 1.3, 1.9).
//
// The admin wiki renders the page itself, with TiddlyWiki's own template
// $:/core/templates/tiddlywiki5-external-js.html (src/browser/page-publisher.js): the shell, which is
// everything TiddlyWiki writes in its file (title, language, raw markup...) but the core, and the
// core file, loaded at the end of the shell. The shell is kept in _page/shell.html, with the
// index.html it was rendered for; the page is built from it while that's the current index.html,
// and from index.html itself otherwise (a new upload, until the admin wiki publishes a shell for
// it). index.html is never changed. The core file is _plugins/tiddlywikicore.js, served by the
// public site as ?v=<TiddlyWiki version>-<format> and cached for a year, like plugin files.

import { guideText } from "./docs.js";
import { EXTERNAL_SCRIPTS_MARKER, PAGE_ETAG_SUFFIX, bakeVersion, charStart, coreFileUrl, engineVersion, pageDecoder, rebakeHtml } from "./build.js";
import { parseEtagList, refusal, untilDone } from "./http.js";
import { waitMs } from "./settings.js";
import { CORE_KEY, INDEX_KEY, PAGE_KEY, SHELL_KEY, STATUS_KEY, markPageOutdated, putIfAbsent } from "./storage.js";

function pageHeaders(htmlHeaders, page) {
  const headers = { ...htmlHeaders, ETag: `"${page.etag}${PAGE_ETAG_SUFFIX}"` };
  const time = Number(page.customMetadata?.pageTime);
  if (time) headers["Last-Modified"] = new Date(time * 1000).toUTCString();
  return headers;
}

// X-Wiki-Page marks the page as the worker's own: the service worker (design 1.11) keeps only an
// answer that carries it, never Cloudflare's login page or a refusal
export async function serveWiki(request, env, ctx, corsHeaders) {
  const htmlHeaders = { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Wiki-Page": bakeVersion(env) };
  const ifNoneMatch = request.headers.get("If-None-Match");
  const known = parseEtagList(ifNoneMatch).find(token => token.endsWith(PAGE_ETAG_SUFFIX));
  // Only without an ETag, as HTTP says
  const since = ifNoneMatch ? NaN : Math.floor(Date.parse(request.headers.get("If-Modified-Since") || "") / 1000);
  let [baked, source] = await Promise.all([
    env.WIKI_BUCKET.get(PAGE_KEY, known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -PAGE_ETAG_SUFFIX.length) } } : undefined),
    env.WIKI_BUCKET.head(INDEX_KEY)
  ]);
  // A new bucket, or an engine deleted by hand: the empty wiki the build made goes there first
  if (!source && await seedWiki(env)) source = await env.WIKI_BUCKET.head(INDEX_KEY);
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
  const lastPage = baked && await env.WIKI_BUCKET.get(PAGE_KEY);
  if (lastPage) return new Response(lastPage.body, { headers: htmlHeaders });
  const fallback = await env.WIKI_BUCKET.get(INDEX_KEY);
  if (!fallback) return new Response(NO_WIKI, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(fallback.body, { headers: htmlHeaders });
}

// A new bucket is empty. The build makes seed/empty.html, an empty TiddlyWiki with the TiddlyWeb
// plugin, which a deploy through Wrangler or Workers Builds uploads with the worker as a text module
// (wrangler.toml): the first page request puts it in the bucket as index.html, with the public
// site's status file, and the wiki starts from there. Nothing already in the bucket is replaced, so
// an engine deleted by hand gets a fresh one and the stored tiddlers stay. The empty tiddler list
// isn't written: the first list request makes it from the stored tiddlers (none, or the ones that
// stayed). A worker pasted into the dashboard has no such module: the page then says what to upload.
// (A module, not a static asset: a worker with static assets runs behind a router that doesn't pass
// Cloudflare Access's mark on to it, see access.js.) Loaded only here, when a bucket needs it.

const PUBLIC_STATUS = { username: "GUEST", read_only: true, anonymous: true, logout_is_available: false, space: { recipe: "default" } };

const NO_WIKI = "There's no wiki yet: the bucket has no index.html, and this worker was deployed without the empty wiki that would " +
  "go there by itself (a deploy through Wrangler or Workers Builds ships it, " + guideText("setup", "2.8") + "). Upload an index.html, a TiddlyWiki " +
  "with the TiddlyWeb plugin, and the status file (setup 2.8), then open this page again.";

// The empty wiki module, or null without it (logged)
async function loadSeed() {
  let html;
  try {
    ({ default: html } = await import("./seed/empty.html"));   // (a literal: Miniflare resolves the module from it)
  } catch (e) {
    console.error("The empty wiki isn't among the worker's modules (a pasted worker.js?):", e.message);
    return null;
  }
  if (typeof html !== "string" || !html) {
    console.error("The empty wiki module is empty: the build didn't make seed/empty.html?");
    return null;
  }
  return html;
}

async function seedWiki(env) {
  const html = await loadSeed();
  if (!html) return false;
  const index = await putIfAbsent(env, INDEX_KEY, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  const status = await putIfAbsent(env, STATUS_KEY, JSON.stringify(PUBLIC_STATUS), { httpMetadata: { contentType: "application/json" } });
  // (Either may have been there: the status file kept when the engine was deleted, or both put by
  // a request that got there first)
  const put = [index && "index.html", status && "the status file"].filter(Boolean);
  if (put.length > 0) console.log(`New wiki: ${put.join(" and ")} put in the bucket`);
  return true;
}

// POST /engine/update, from the Cloudflare tab (design 1.15): index.html replaced with the empty
// wiki the worker ships, so the next page load builds the page from it, publishes the core file and
// the page for the new version and purges the public copy, as after a deletion of index.html by
// hand. The tiddlers, the plugins installed from the wiki and the published page are untouched; a
// plugin that came only with the old engine goes with it (the tab says so before). Two R2 calls:
// the engine's head, for the version it replaces, and the write. Asked for with the header every
// request of the browser modules carries, so a form on another site can't send it.
export async function updateEngine(request, env, corsHeaders) {
  if (request.headers.get("X-Requested-With") !== "TiddlyWiki") return refusal("The engine is updated from the admin wiki's Cloudflare tab (" + guideText("operating", "3.3") + ").", corsHeaders);
  const html = await loadSeed();
  if (!html) return refusal(NO_SEED, corsHeaders, 404);
  const current = await env.WIKI_BUCKET.get(INDEX_KEY, { range: { offset: 0, length: 65536 } });
  const from = current ? engineVersion(await current.text()) : "";
  const to = engineVersion(html);
  await env.WIKI_BUCKET.put(INDEX_KEY, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  console.log(`Engine replaced: TiddlyWiki ${from || "(no version tag)"} → ${to}`);
  return new Response(JSON.stringify({ from, to }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const NO_SEED = "This worker was deployed without the empty wiki that would replace the engine (a deploy through Wrangler or " +
  "Workers Builds ships it, " + guideText("setup", "2.8") + "): nothing to put in place of index.html.";

// Rebuilds the page after a save or delete. If that fails (an R2 error), the change itself is
// stored: the page is marked outdated instead, so the next page load builds it (and writes any
// missing plugin file) rather than keep serving it without the change. The mark writes the same
// key the build just failed on, and R2 takes one write a second to a key: if it fails too, it's
// tried once more a second later. If that fails as well, the request fails (500), the change
// stored: the browser's retry finds what's left to do (finishSave, handleDelete).
export async function rebuildPage(env, ctx, list) {
  if (await rebakeHtml(env, ctx, list)) return;
  try {
    await markPageOutdated(env);
  } catch (e) {
    console.error("Could not mark the page outdated, trying again in a second:", e.message);
    await new Promise(resolve => setTimeout(resolve, waitMs(env, 1100)));
    await markPageOutdated(env);
  }
}

const SHELL_LIMIT = 2 * 1024 * 1024;

const CORE_LIMIT = 20 * 1024 * 1024;

// An unescaped "$:/config/SaveWikiButton/Template": TiddlyWiki's own line in the core file, not a
// mention inside the core plugin's JSON
const SAVE_TEMPLATE_SETTING = /[^\\]"\$:\/config\/SaveWikiButton\/Template"/;

// PUT /page/core?v=<TiddlyWiki version>-<format>: TiddlyWiki's core file, rendered by the admin wiki
// (once per version). The same version again isn't rewritten.
export async function publishCoreFile(request, env, url, corsHeaders) {
  const version = url.searchParams.get("v") || "";
  if (!/^[0-9A-Za-z.+]+(-[0-9A-Za-z.+]+)*-\d+$/.test(version)) {
    return refusal(`"${version}" isn't a core file version (<TiddlyWiki version>-<format>).`, corsHeaders);
  }
  // For the index.html the admin page was built for (X-Page-Index), as a shell: a tab opened before
  // a new one (an upgrade) would otherwise replace the core file with its older version, which the
  // public site would then serve under the new version's URL, cached for a year
  const [index, current] = await Promise.all([env.WIKI_BUCKET.head(INDEX_KEY), env.WIKI_BUCKET.head(CORE_KEY)]);
  if (!index || request.headers.get("X-Page-Index") !== index.etag) {
    return refusal("index.html has changed since this page was loaded: reload the admin wiki.", corsHeaders, 409);
  }
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
  // The page says which core file is stored (the admin wiki sends it only if it isn't): built again
  // at the next load, so it says this one even if the shell that follows is refused (otherwise every
  // load would send the core file again). Before answering, so that a shell published right after
  // builds over it. (A failure here only means the core file may be sent once more.)
  await markPageOutdated(env).catch(e => console.error("Could not mark the page outdated after a new core file:", e.message));
  return new Response(null, { status: 204, headers: corsHeaders });
}

// PUT /page/shell: the page rendered by the admin wiki, without the core. X-Page-Fingerprint: its
// fingerprint (computed by the admin wiki); X-Page-Index: the index.html the admin page was built
// for; X-Page-Shell: the stored shell the page was built from, or last published over (its ETag, ""
// when built from index.html), so a page older than the shell stored (another tab published since)
// is refused rather than replacing it, 409 with the current version in X-Page-Shell: the tab syncs
// and sends its page again, with that tab's change in it. (A tab that sends no version is from before
// this check: reload.) Refused unless it's a page that works: TiddlyWiki's tiddler store with the
// TiddlyWeb plugin, and the stored core file loaded at the end. The same shell again only makes sure
// the page is built from it. Every answer that kept or keeps a shell gives its version.
export async function publishShell(request, env, ctx, corsHeaders) {
  const fingerprint = request.headers.get("X-Page-Fingerprint") || "";
  if (!fingerprint || fingerprint.length > 100) return refusal("The shell has no fingerprint (X-Page-Fingerprint).", corsHeaders);
  if (Number(request.headers.get("Content-Length")) > SHELL_LIMIT) return refusal("The shell is too big.", corsHeaders);
  const [index, core, kept] = await Promise.all([
    env.WIKI_BUCKET.head(INDEX_KEY), env.WIKI_BUCKET.head(CORE_KEY), env.WIKI_BUCKET.head(SHELL_KEY)
  ]);
  if (!index || request.headers.get("X-Page-Index") !== index.etag) {
    return refusal("index.html has changed since this page was loaded: reload the admin wiki.", corsHeaders, 409);
  }
  const withShell = (headers, shell) => ({ ...headers, "X-Page-Shell": shell });
  if (kept?.customMetadata?.index === index.etag && kept.customMetadata.fingerprint === fingerprint) {
    const page = await env.WIKI_BUCKET.head(PAGE_KEY);
    if (page?.customMetadata?.sourceEtag === index.etag && page.customMetadata.shell === fingerprint) {
      return new Response(null, { status: 204, headers: withShell(corsHeaders, kept.etag) });
    }
  }
  // The shell stored for this index.html, if any, is the one the page must have been built from
  const base = kept?.customMetadata?.index === index.etag ? kept : null;
  const sent = request.headers.get("X-Page-Shell");
  if (base && sent !== base.etag) {
    const why = sent === null ? "This page is from before the worker checked that: reload the admin wiki." : "It's sent again by itself, with that change.";
    return new Response(`Another tab published the page since this one was loaded. ${why}`, { status: 409, headers: withShell({ ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }, base.etag) });
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
  // Over the shell checked above, or none: two tabs sending at once can't both win
  const storedShell = await env.WIKI_BUCKET.put(SHELL_KEY, bytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { index: index.etag, fingerprint },
    onlyIf: kept ? { etagMatches: kept.etag } : new Headers({ "If-None-Match": "*" })
  });
  if (!storedShell) {
    const now = await env.WIKI_BUCKET.head(SHELL_KEY);
    return new Response("Another tab published the page at the same moment. It's sent again by itself, with that change.", { status: 409, headers: withShell({ ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }, now?.etag || "") });
  }
  const rebuilt = await untilDone(ctx, rebakeHtml(env, ctx, null, { html: bytes, index: index.etag, fingerprint, core: version, shellVersion: storedShell.uploaded.getTime(), shell: storedShell.etag }));
  if (rebuilt) return new Response(null, { status: 204, headers: withShell(corsHeaders, storedShell.etag) });
  // Kept, but the page couldn't be built now (see the logs): the next admin page load builds it
  ctx.waitUntil(markPageOutdated(env));
  return new Response("The shell is kept, but the page couldn't be rebuilt now: it will be at the next admin page load.", { status: 503, headers: withShell({ ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }, storedShell.etag) });
}
