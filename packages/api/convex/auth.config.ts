/**
 * Convex platform auth configuration: every request's `ctx.auth` identity is
 * verified against this deployment's `/.well-known/jwks.json`, which serves the
 * public half of `JWT_PRIVATE_KEY`. Deployment variables are documented in
 * `.env.example`; values are never committed.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
