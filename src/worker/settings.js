// The worker's settings: every variable it reads from its environment, in one place (setup 2.5 has
// the table). The bindings (WIKI_BUCKET, BACKUP_QUEUE) are used where they're needed.
//
// | variable             | read by                 |
// |----------------------|-------------------------|
// | PUBLIC_WIKI_URL      | publicSiteError, publicSite, publicUrl (optional: none is a private wiki) |
// | ACCESS               | accessCheckOff (tests and local runs only) |
// | CONFLICT_GUARD       | conflictGuardEnabled    |
// | GITHUB_REPO, GITHUB_TOKEN, GITHUB_BRANCH | github |
// | CF_ZONE_ID, CF_API_TOKEN | purges              |
// | BACKUP_RETRY_SECONDS | backupRetrySeconds      |
// | BACKUP_ALERT_MINUTES | backupAlertMinutes      |
// | TEST_WAIT_SCALE      | waitMs (the tests only) |

import { guideText } from "./docs.js";

// PUBLIC_WIKI_URL, the public site's address (the bucket's custom domain, setup 2.2): the page
// loads its plugin files and TiddlyWiki's core file from it, the list sync reads tiddlers from
// it, and purges name its URLs. Optional: without it the wiki is private (setup 2.1), the worker
// serves all of that itself (publicUrl gives root-relative URLs), the page carries no public
// address, and there is nothing to purge. Set, it has to be a site's address, with no default: a
// wiki must never load its code from a site that isn't its own. Checked at every request
// (index.js), so a worker with a wrong one does nothing but say so.
//
// Why the setting can't be used, or null. requestOrigin: where the request came to, which the
// public site can't be: the worker isn't the public site, and the browser modules take a page at
// the public address for the public site's (read-only, publishing nothing).
export function publicSiteError(env, requestOrigin) {
  const value = publicSite(env);
  const expected = `the public site's address, https://<its hostname> (${guideText("setup", "2.5")})`;
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return `PUBLIC_WIKI_URL is "${value}", not ${expected}.`;
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || url.username || url.password) {
    return `PUBLIC_WIKI_URL is "${value}": it must be ${expected}, nothing after the hostname.`;
  }
  if (requestOrigin && url.origin === new URL(requestOrigin).origin) {
    return `PUBLIC_WIKI_URL is "${value}", this worker's own address: it must be the public site's, the bucket's custom domain (${guideText("setup", "2.2")}).`;
  }
  return null;
}

// The public site's address as set, trimmed, or "" for a private wiki
export function publicSite(env) {
  return String(env.PUBLIC_WIKI_URL || "").trim();
}

// A URL on the public site (PUBLIC_WIKI_URL, checked before any request is handled): the path
// itself, root-relative, for a private wiki, where the worker serves it
export function publicUrl(env, path) {
  return publicSite(env).replace(/\/+$/, "") + path;
}

// ACCESS = "off" lets requests through without Cloudflare Access (access.js), for the tests and
// local runs, where there is no Access: only requests to a local address, so it changes nothing on a
// deployed worker.
export function accessCheckOff(env) {
  return env.ACCESS === "off";
}

// CONFLICT_GUARD = "off" builds the page without the browser modules (operating 3)
export function conflictGuardEnabled(env) {
  return String(env.CONFLICT_GUARD || "").toLowerCase() !== "off";
}

// The GitHub backup's repository (owner/repo), token and branch, or null when backups are off
// (no repository or no token: setup 2.5)
export function github(env) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return null;
  return { repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN, branch: env.GITHUB_BRANCH || "main" };
}

// The zone and token public-site purges use, or null when purges are off (setup 2.5)
export function purges(env) {
  if (!env.CF_ZONE_ID || !env.CF_API_TOKEN) return null;
  return { zoneId: env.CF_ZONE_ID, token: env.CF_API_TOKEN };
}

// The first wait before a failed backup is tried again (BACKUP_RETRY_SECONDS, 60 by default)
export function backupRetrySeconds(env) {
  return parseInt(env.BACKUP_RETRY_SECONDS, 10) || 60;
}

// How long backups have to keep failing before the admin wiki shows it (BACKUP_ALERT_MINUTES, 60
// by default)
export function backupAlertMinutes(env) {
  const minutes = parseFloat(env.BACKUP_ALERT_MINUTES);
  return minutes >= 0 ? minutes : 60;
}

// The worker's own waits — a direct backup's retries, the second purge after a list rebuild, the
// outdated mark tried again — in ms, scaled by TEST_WAIT_SCALE, a fraction the test setups bind
// (design 2.25): the same things happen sooner. Never set in a deployed worker: unset, 1. The
// queue's delays are whole seconds (Cloudflare's API) and aren't scaled: BACKUP_RETRY_SECONDS is
// their setting, and the tests run it at 1.
export function waitMs(env, ms) {
  const scale = parseFloat(env.TEST_WAIT_SCALE);
  return Math.max(1, Math.round(ms * (scale > 0 && scale < 1 ? scale : 1)));
}
