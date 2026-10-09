// GitHub's Contents API (one file per tiddler, tiddlers/<title>.json, one commit per version), what
// its answers mean, and how long to wait after a failure.

import { encoder } from "../bytes.js";

// Writes bytes as base64 into out (ASCII bytes) from position at; returns where it ends. GitHub takes
// a file's content in base64, in a request body sent as bytes: written there directly, it's never a
// string. (Through a string, with String.fromCharCode, btoa, then the body encoded to be sent, a 1.5
// MB plugin took about 7 ms of CPU, this about 2: a run gets about 10 on the free plan.)
const BASE64_DIGITS = encoder.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

function writeBase64(bytes, out, at) {
  const end = bytes.length - bytes.length % 3;
  let i = 0;
  for (; i < end; i += 3) {
    const v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out[at] = BASE64_DIGITS[v >>> 18];
    out[at + 1] = BASE64_DIGITS[v >>> 12 & 63];
    out[at + 2] = BASE64_DIGITS[v >>> 6 & 63];
    out[at + 3] = BASE64_DIGITS[v & 63];
    at += 4;
  }
  if (i < bytes.length) {
    // One or two bytes left: padded with "="
    const two = i + 1 < bytes.length;
    const v = bytes[i] << 16 | (two ? bytes[i + 1] << 8 : 0);
    out[at] = BASE64_DIGITS[v >>> 18];
    out[at + 1] = BASE64_DIGITS[v >>> 12 & 63];
    out[at + 2] = two ? BASE64_DIGITS[v >>> 6 & 63] : 61;
    out[at + 3] = 61;
    at += 4;
  }
  return at;
}

// Git's blob id for a file (its bytes), to recognise content GitHub already has
export async function gitBlobSha(content) {
  const header = encoder.encode(`blob ${content.length}\0`);
  const data = new Uint8Array(header.length + content.length);
  data.set(header);
  data.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

// A failed GitHub call; retryAfter (seconds) is set when GitHub says how long to wait, status is
// GitHub's HTTP status
class GitHubError extends Error {
  // detail: GitHub's own message ("Bad credentials"), when its answer has one
  constructor(message, retryAfter, status, detail = "") {
    super(message);
    this.name = "GitHubError";
    this.retryAfter = retryAfter;
    this.status = status;
    this.detail = detail;
  }
}

// GitHub Contents API, with the same file paths as the original per-save backup
export function githubContents(env) {
  const branch = env.GITHUB_BRANCH || "main";
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "TiddlyWiki-Cloudflare-Worker"
  };
  // body: the request body, as text or bytes
  async function call(method, title, body) {
    const apiBase = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/tiddlers/${encodeURIComponent(title)}.json`;
    // Reads ask for the "object" format: the default one isn't available for files between 1 and
    // 100 MB, so their backups would fail forever and hold up every later one. The object format
    // works for all sizes, with empty content above 1 MB.
    const res = await fetch(method === "GET" ? `${apiBase}?ref=${branch}` : apiBase, {
      method,
      headers: method === "GET" ? { ...headers, Accept: "application/vnd.github.object+json" } : headers,
      body
    });
    if (method === "GET" && res.status === 404) return null;
    if (!res.ok) {
      // How long GitHub asks us to wait, if it says (rate limits)
      let waitSeconds;
      const retryAfter = parseInt(res.headers.get("retry-after"), 10);
      const reset = parseInt(res.headers.get("x-ratelimit-reset"), 10);
      if (retryAfter > 0) waitSeconds = retryAfter;
      else if (res.headers.get("x-ratelimit-remaining") === "0" && reset) waitSeconds = Math.max(reset - Date.now() / 1000, 1);
      const answer = await res.text();
      let detail = "";
      try {
        detail = String(JSON.parse(answer).message || "");
      } catch {}
      throw new GitHubError(`GitHub ${method} ${res.status}: ${answer.slice(0, 200)}`, waitSeconds, res.status, detail);
    }
    return res.json();
  }
  return {
    // { sha } of the file on GitHub, or null. (GitHub sends the content too, up to 1 MB; it isn't used.)
    async get(title) {
      const file = await call("GET", title);
      return file ? { sha: file.sha } : null;
    },
    // content: bytes. Returns the new blob sha. (The body is made as bytes, the content written into
    // it as base64: see writeBase64.)
    async put(title, content, message, sha) {
      const head = encoder.encode(`{"message":${JSON.stringify(message)},"branch":${JSON.stringify(branch)}${sha ? `,"sha":${JSON.stringify(sha)}` : ""},"content":"`);
      const body = new Uint8Array(head.length + Math.ceil(content.length / 3) * 4 + 2);
      body.set(head);
      const end = writeBase64(content, body, head.length);
      body[end] = 34;        // "
      body[end + 1] = 125;   // }
      const result = await call("PUT", title, body);
      return result.content.sha;
    },
    async remove(title, sha, message) {
      await call("DELETE", title, JSON.stringify({ message, sha, branch }));
    }
  };
}

const BACKUP_MAX_DELAY = 6 * 3600;

// GitHub refusing every backup, not one file: the token (401: expired or revoked; 403 other than a
// rate limit: no access to the repository, or the repository archived), or the repository not
// found (404: only on a write, as the 404 of a read, a file not there yet, isn't an error). A 403 or
// 404 could still concern one file only (a path GitHub can't take): it pauses every backup only once
// a second tiddler gets one in the same run, or one file would hold up all the others (the oldest
// backup tries first after a pause). Until then it's that file's own failure.
export function isAccountWide(e) {
  return e.status === 401 || (e.status === 403 && !isRateLimit(e)) || e.status === 404;
}

// GitHub refusing this file for good: its path, or its content (a secret in it, which its push
// protection refuses with a 409; a 409 that's only a race over the file's sha passes on its retry)
export function isRefusal(e) {
  return e.status === 409 || e.status === 422;
}

// GitHub asking to slow down: Retry-After or an exhausted rate limit, 429, or its "rate limit"
// messages (a secondary rate limit can come as a 403 without a header)
export function isRateLimit(e) {
  return e.retryAfter > 0 || e.status === 429 || /rate limit/i.test(e.message || "");
}

export function backupRetryDelay(env, tries, retryAfter) {
  const base = parseInt(env.BACKUP_RETRY_SECONDS, 10) || 60;
  const delay = Math.min(base * 2 ** (tries || 0), BACKUP_MAX_DELAY);
  return Math.ceil(Math.min(Math.max(delay, retryAfter || 0), 24 * 3600));
}
