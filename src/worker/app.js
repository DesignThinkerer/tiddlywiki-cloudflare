// The wiki as an installable app (design 1.12): the web app manifest the page links, with the
// wiki's title as its name and the icons inside it; the icons at their own addresses for iOS and
// for the public site; and the copies the public site serves from the bucket.
//
// Behind Cloudflare Access a manifest's icons can't be at addresses: a browser fetches them without
// cookies. So the manifest the worker serves embeds them as data URLs, and the page's link to the
// manifest says use-credentials. The public site has no Access, so its copy in the bucket
// (manifest.webmanifest, written with the page) points at /_app/icon-<size>.png there.

import { publicUrl, purges } from "./settings.js";
import { purgePublicCache } from "./cache.js";
import { tiddlerKey } from "./tiddlers.js";

export const MANIFEST_KEY = "manifest.webmanifest";
export const APP_ICON_SIZES = [192, 512];
const APP_DIR = "_app/";
const THEME_COLOR = "#2d6a8f";
const BACKGROUND_COLOR = "#f4f4f4";
const DEFAULT_NAME = "My TiddlyWiki";   // TiddlyWiki's own site title, until the wiki's is set
const SHORT_NAME_LIMIT = 12;

// The default icons (src/app/, embedded by the build as base64)
const DEFAULT_ICONS = { 192: "__ICON_192_PNG_BASE64__", 512: "__ICON_512_PNG_BASE64__" };

// What the page's <head> carries: the manifest, with the site's cookies, the theme colour, the
// iOS icon (Safari reads no manifest icons)
export const APP_HEAD = `<link rel="manifest" href="/${MANIFEST_KEY}" crossorigin="use-credentials">\n<meta name="theme-color" content="${THEME_COLOR}">\n<link rel="apple-touch-icon" href="/${APP_DIR}icon-192.png">`;

export function iconKey(size) {
  return `${APP_DIR}icon-${size}.png`;
}

// The wiki's title: the stored $:/SiteTitle, or TiddlyWiki's own
async function siteTitle(env) {
  try {
    const stored = await env.WIKI_BUCKET.get(tiddlerKey("$:/SiteTitle"));
    if (!stored) return DEFAULT_NAME;
    const fields = await stored.json();
    const text = typeof fields.text === "string" ? fields.text.trim() : "";
    return text || DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME;
  }
}

// An icon's bytes, base64: the owner's from the bucket, else the default
async function iconBase64(env, size) {
  try {
    const own = await env.WIKI_BUCKET.get(iconKey(size));
    if (own) return bytesToBase64(new Uint8Array(await own.arrayBuffer()));
  } catch {}
  return DEFAULT_ICONS[size];
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The manifest, with the icons as data URLs (the worker's, behind Access) or at their addresses
// (the public site's copy)
async function manifestJson(env, { embedIcons }) {
  const name = await siteTitle(env);
  const icons = await Promise.all(APP_ICON_SIZES.map(async size => ({
    src: embedIcons ? `data:image/png;base64,${await iconBase64(env, size)}` : `/${iconKey(size)}`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose: "any maskable"
  })));
  const manifest = { name, start_url: "/", scope: "/", display: "standalone", background_color: BACKGROUND_COLOR, theme_color: THEME_COLOR, icons };
  if (name.length <= SHORT_NAME_LIMIT) manifest.short_name = name;
  return JSON.stringify(manifest);
}

const MANIFEST_TYPE = "application/manifest+json";

// GET /manifest.webmanifest: the worker's, for the admin site; cached a day by the browser, which
// asks for it at installs and launches
export async function serveManifest(env, corsHeaders) {
  const body = await manifestJson(env, { embedIcons: true });
  return new Response(body, { headers: { ...corsHeaders, "Content-Type": `${MANIFEST_TYPE}; charset=utf-8`, "Cache-Control": "private, max-age=86400" } });
}

// GET /_app/icon-<size>.png: the owner's icon from the bucket, else the default
export async function serveIcon(env, size, corsHeaders) {
  const headers = { ...corsHeaders, "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" };
  try {
    const own = await env.WIKI_BUCKET.get(iconKey(size));
    if (own) return new Response(own.body, { headers });
  } catch {}
  return new Response(base64ToBytes(DEFAULT_ICONS[size]), { headers });
}

// With each page build: the public site's copy of the manifest, written when it's missing or the
// page's source changed (the title lives in the published page), one look otherwise; the default
// icons go in with the first manifest ever written, unless the owner has put some. Purged from the
// public cache when written.
export async function ensureAppFiles(env, ctx, pageSource) {
  const source = `${pageSource.index}:${pageSource.fingerprint || ""}`;
  const written = [];
  try {
    const existing = await env.WIKI_BUCKET.head(MANIFEST_KEY);
    if (existing && existing.customMetadata?.source === source) return;
    if (!existing) {
      for (const size of APP_ICON_SIZES) {
        if (!await env.WIKI_BUCKET.head(iconKey(size))) {
          await env.WIKI_BUCKET.put(iconKey(size), base64ToBytes(DEFAULT_ICONS[size]), { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=86400" } });
        }
      }
    }
    await env.WIKI_BUCKET.put(MANIFEST_KEY, await manifestJson(env, { embedIcons: false }), { httpMetadata: { contentType: MANIFEST_TYPE, cacheControl: "public, max-age=86400" }, customMetadata: { source } });
    written.push(`/${MANIFEST_KEY}`);
  } catch (e) {
    console.error("The app's files couldn't be written:", e.message);
  }
  if (written.length && purges(env)) ctx.waitUntil(purgePublicCache(env, written.map(path => publicUrl(env, path))));
}
