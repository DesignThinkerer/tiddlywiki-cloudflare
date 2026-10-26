// Cloudflare Access: the worker has no login of its own; Access, in front of it, has (setup 2.6,
// design 1.18).

import { guideText } from "./docs.js";
import { accessCheckOff, isLocalHost } from "./settings.js";

// Cloudflare gives a request that came through Access a ctx.access; a request without one didn't,
// and is refused before anything is read or built. So an Access application missing, or set up on
// another hostname than the one the request came to, leaves the wiki closed rather than open.
// ACCESS = "off" lets requests through without it, for the tests and local runs, where there is no
// Access: it counts only for a request to a local address (localhost, 127.0.0.1, ::1), which is all
// those make. A deployed worker is reached by a real hostname, so the switch left on by mistake
// opens nothing. One thing would break this: static assets. "Workers with Static Assets execute
// behind an internal router Worker. Access still protects the application and its assets. However,
// the router does not pass ctx.access to the user Worker"
// (developers.cloudflare.com/workers/configuration/cloudflare-access). So the worker has none: the
// empty wiki it needs travels as a text module (page.js, wrangler.toml).
export function withoutAccess(request, ctx, env) {
  return !ctx.access && !(accessCheckOff(env) && isLocal(request));
}

// A request to a local address: what the tests (Miniflare) and wrangler dev answer
function isLocal(request) {
  return isLocalHost(new URL(request.url).hostname);
}

// The refusal, in the setup check's order (design 2.20): what was found, the host the request came
// to; the one thing to do, in setup 2.6's words (the dashboard's, October 2026); the link; and the
// local-only switch last
export function accessRefused(request) {
  const host = new URL(request.url).host;
  return `Refused: this request to ${host} didn't come through Cloudflare Access, which must protect the admin site. ` +
    `If you're setting the worker up: in the Cloudflare dashboard, Workers & Pages → the worker → the Access tab → Protect this Worker behind Access → All traffic, with a policy that allows you alone (${guideText("setup", "2.6")}). ` +
    "Only for tests and local runs, where there is no Access, the variable ACCESS = off lets requests through, and only to a local address (localhost): on a deployed worker it changes nothing.";
}

// Whom Access let in, for the setup check's line (setup.js): the e-mail Access attaches to each
// request it passes (Cf-Access-Authenticated-User-Email), else Cloudflare's own identity read
// (ctx.access.getIdentity, whose cost its documentation doesn't say: once per check, after the
// header), else null. Said, not acted on: Access decides who gets in, the worker only reports it
export async function accessIdentity(request, ctx) {
  const header = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (header) return header;
  if (ctx && ctx.access && typeof ctx.access.getIdentity === "function") {
    try {
      const identity = await ctx.access.getIdentity();
      return identity && identity.email ? String(identity.email) : null;
    } catch {
      return null;
    }
  }
  return null;
}
