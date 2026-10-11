// Plugin files (design 1.8): _plugins/<title>.js holds the stored tiddler, untouched, inside the
// same code the external-plugins export template produces: it adds the tiddler to
// $tw.preloadTiddlers before TiddlyWiki boots. The file name never changes; the page loads it as
// <title>.js?v=<revision>, so every version has its own URL and nothing needs purging. Files are
// served by the public site, never by the worker.

import { concatBytes, encoder } from "./bytes.js";
import { hasNestedFields } from "./layout.js";
import { publicUrl } from "./settings.js";
import { PLUGIN_FILE_DIR } from "./storage.js";
import { isNewerRevision, revisionOf, tiddlerKey } from "./tiddlers.js";

const PRELOAD_OPEN = "{\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([";

const PRELOAD_CLOSE = "]);\n}\n";

// A tiddler with a field called "fields" (stored nested: hasNestedFields) is unpacked first
const PRELOAD_NESTED_OPEN = "{\nconst t = ";

const PRELOAD_NESTED_CLOSE = ";\nt.fields = t.fields.fields;\nconst tw = globalThis.$tw ??= Object.create(null);\ntw.preloadTiddlers = (tw.preloadTiddlers ?? []).concat([t]);\n}\n";

export function pluginFileKey(title) {
  return `${PLUGIN_FILE_DIR}${title}.js`;
}

// Encoded the same way as the tiddler URLs the public wiki already loads; on the public site, or
// root-relative (this site, the worker) for a private wiki
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
export async function pluginScriptTags(env, entries) {
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

// After the page has been rebuilt without it, so a page load in between doesn't miss it. If this
// fails, the file is only left behind (nothing loads it): the request isn't failed for it, since its
// retry would find nothing left to do, and wouldn't rebuild the page either
export async function deletePluginFile(env, title) {
  try {
    await env.WIKI_BUCKET.delete(pluginFileKey(title));
  } catch (e) {
    console.error(`Could not delete the plugin file of '${title}' (left behind, unused):`, e.message);
  }
}
