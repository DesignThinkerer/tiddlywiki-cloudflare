// What a tiddler is to the worker: the titles never stored, drafts, what the page needs at boot,
// keys and revisions.
//
// TiddlyWiki only runs startup actions, plugins and JavaScript modules that are present when it
// boots; anything that arrives later through sync is too late. Small startup tiddlers are baked
// into the page (build.js). Plugins and JavaScript modules each get a file in R2 (plugins.js),
// which the page loads from the public site with a <script> tag before TiddlyWiki boots.

import { encoder } from "./bytes.js";
import { TIDDLER_PREFIX } from "./storage.js";

// A date as TiddlyWiki writes one (YYYYMMDDhhmmssSSS, in UTC, like its own created and modified
// fields: $tw.utils.stringifyDate)
export function getTwTimestamp(date = new Date()) {
  return date.toISOString().replace(/\D/g, '').slice(0, 17);
}

// Titles the wiki keeps only in the browser: never stored, never backed up. Drafts are recognised by
// their draft.of field (isDraft), not their title: a tiddler can be called "Draft of 'Chapter 1'".
// (TiddlyWiki doesn't sync $:/HistoryList…, $:/state/, $:/temp/ or $:/status/ anyway. Only
// $:/StoryList itself is a tab's own: the list sync (src/browser/list-sync.js) doesn't send it,
// while $:/StoryList/2 or $:/StoryListBackup are sent, and stored like any tiddler.)
export function isEphemeralTitle(title) {
  return title === "$:/StoryList" ||
         title.startsWith("$:/HistoryList") ||
         title.startsWith("$:/state/") ||
         title.startsWith("$:/temp/") ||
         title.startsWith("$:/status/");
}

// TiddlyWiki's own test (a draft.of field, even empty), which the list sync uses too
export function isDraft(tiddler) {
  return tiddler["draft.of"] !== undefined;
}

const STARTUP_TITLES = ["$:/DefaultTiddlers", "$:/SiteTitle", "$:/SiteSubtitle",
  // read by TiddlyWiki's link-preview tags when the admin wiki renders the page (design 1.9), in a
  // way that loads nothing: every tab has to have them
  "$:/SiteUrl", "$:/SiteDomain", "$:/SitePreviewUrl",
  // read at boot to choose the theme, language and palette
  "$:/theme", "$:/language", "$:/palette",
  // read once by TiddlyWiki's syncer, when it starts
  "$:/config/SyncPollingInterval", "$:/config/SyncThrottleInterval", "$:/config/SyncFilter", "$:/config/SyncDisableLazyLoading"];

const DISABLED_PLUGIN_PREFIX = "$:/config/Plugins/Disabled/";

// The browser modules' own settings ($:/config/cfworker/LoadAll, operating 3), read when the page boots
const MODULE_SETTINGS_PREFIX = "$:/config/cfworker/";

const PLUGIN_FILE_TYPES = ["plugin", "theme", "language"];

const MODULE_TYPES = ["application/javascript", "application/json", "application/x-tiddler-dictionary"];

// These take a saved tiddler or an entry of the tiddler list
export function isStartupTiddler(tiddler) {
  const title = tiddler.title || "", tags = tiddler.tags;
  // (A list entry stored before field values had to be text, or by hand, may hold a tag that isn't)
  return STARTUP_TITLES.includes(title) || title.startsWith(DISABLED_PLUGIN_PREFIX) || title.startsWith(MODULE_SETTINGS_PREFIX) || (Array.isArray(tags)
    ? tags.some(tag => String(tag).includes("$:/tags/StartupAction"))
    : typeof tags === "string" && tags.includes("$:/tags/StartupAction"));
}

// The admin plugin, the worker's own (build.js): preloaded by every page build, never a file
const ADMIN_PLUGIN = "$:/plugins/cfworker/admin";

// Plugins (but not the core: it comes with index.html and is never synced; nor the admin plugin,
// which the worker puts in the page itself) and JavaScript modules
export function needsPluginFile(tiddler) {
  const pluginType = tiddler["plugin-type"];
  if (pluginType) {
    return PLUGIN_FILE_TYPES.includes(pluginType) && tiddler.title !== "$:/core" && tiddler.title !== ADMIN_PLUGIN && tiddler.platform !== "server";
  }
  return MODULE_TYPES.includes(tiddler.type) && Boolean(tiddler["module-type"]);
}

export function isPageTiddler(tiddler) {
  return isStartupTiddler(tiddler) || needsPluginFile(tiddler);
}

export function tiddlerKey(title) {
  return TIDDLER_PREFIX + title;
}

// R2 keys are at most 1024 bytes of UTF-8: a longer one can't be stored, so it isn't there either
export const MAX_KEY_BYTES = 1024;

export function keyTooLong(key) {
  // (A character is at most 3 bytes: most keys are cleared without encoding them)
  return key.length * 3 > MAX_KEY_BYTES && encoder.encode(key).length > MAX_KEY_BYTES;
}

// The revision of a stored tiddler, from the object's metadata. (An object without it isn't one
// the worker stored: its R2 etag stands in, so GET, PUT and DELETE still agree.)
export function revisionOf(obj) {
  return obj.customMetadata?.revision || obj.etag;
}

// Revisions written by this worker are millisecond timestamps (13 digits: compared as numbers,
// which are exact up to 2^53, so for another 285,000 years)
export function isNewerRevision(a, b) {
  return /^\d+$/.test(a) && /^\d+$/.test(String(b)) && Number(a) > Number(b);
}
