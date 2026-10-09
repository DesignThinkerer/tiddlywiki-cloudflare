// The worker's settings: every variable it reads from its environment, in one place (README 3.2 has
// the table). The bindings (WIKI_BUCKET, BACKUP_QUEUE, ASSETS) are used where they're needed.
//
// | variable             | read by                 |
// |----------------------|-------------------------|
// | PUBLIC_WIKI_URL      | publicSiteError, publicUrl (required) |
// | ACCESS               | accessCheckOff (tests and local runs only) |
// | CONFLICT_GUARD       | conflictGuardEnabled    |
// | GITHUB_REPO, GITHUB_TOKEN, GITHUB_BRANCH | github |
// | CF_ZONE_ID, CF_API_TOKEN | purges              |
// | BACKUP_RETRY_SECONDS | backupRetrySeconds      |
// | BACKUP_ALERT_MINUTES | backupAlertMinutes      |

// Why the setting can't be used, or null. requestOrigin: where the request came to, which the
// public site can't be: the worker isn't the public site, and the browser modules take a page at
// the public address for the public site's (read-only, publishing nothing).
export function publicSiteError(env, requestOrigin) {
  const value = env.PUBLIC_WIKI_URL;
  const expected = "the public site's address, https://<its hostname> (README 3.2)";
  if (!value) return `PUBLIC_WIKI_URL isn't set: the worker needs ${expected}.`;
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return `PUBLIC_WIKI_URL is "${value}", not ${expected}.`;
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || url.username || url.password) {
    return `PUBLIC_WIKI_URL is "${value}": it must be ${expected}, nothing after the hostname.`;
  }
  if (requestOrigin && url.origin === new URL(requestOrigin).origin) {
    return `PUBLIC_WIKI_URL is "${value}", this worker's own address: it must be the public site's, the bucket's custom domain (README 3.1).`;
  }
  return null;
}

// A URL on the public site (PUBLIC_WIKI_URL, checked before any request is handled)
export function publicUrl(env, path) {
  return env.PUBLIC_WIKI_URL.replace(/\/+$/, "") + path;
}

export function conflictGuardEnabled(env) {
  return String(env.CONFLICT_GUARD || "").toLowerCase() !== "off";
}
