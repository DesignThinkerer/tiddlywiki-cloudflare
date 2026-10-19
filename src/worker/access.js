// Cloudflare Access: the worker has no login of its own; Access, in front of it, has (setup 2.6).

import { guideText } from "./docs.js";
import { accessCheckOff } from "./settings.js";

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
  const host = new URL(request.url).hostname;
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

export const ACCESS_REFUSED = "Refused: this request didn't come through Cloudflare Access, which must protect the admin site (" + guideText("setup", "2.6") + "). " +
  "If you're setting the worker up, add the Access application for this hostname first. Only for tests and local runs, " +
  "where there is no Access, the variable ACCESS = off lets requests through, and only to a local address (localhost): " +
  "on a deployed worker it changes nothing.";
