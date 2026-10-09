// Cloudflare Access: the worker has no login of its own; Access, in front of it, has (README 3.3).

// The worker has no login of its own: Cloudflare Access, in front of it, has (README 3.3). Cloudflare
// gives a request that came through Access a ctx.access; a request without one didn't, and is refused
// before anything is read or built. So an Access application missing, or set up on another hostname
// than the one the request came to, leaves the wiki closed rather than open. ACCESS = "off" lets
// requests through without it: for the tests and local runs, where there is no Access.
export function withoutAccess(ctx, env) {
  return !ctx.access && env.ACCESS !== "off";
}

export const ACCESS_REFUSED = "Refused: this request didn't come through Cloudflare Access, which must protect the admin site (README 3.3). " +
  "If you're setting the worker up, add the Access application for this hostname first. Only for tests and local runs, " +
  "where there is no Access, the variable ACCESS = off lets requests through.";
