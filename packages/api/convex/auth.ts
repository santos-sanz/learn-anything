import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, type AuthProviderConfig } from "@convex-dev/auth/server";

import { redirectCallback } from "./redirects";

/**
 * S06 authentication wiring.
 *
 * Password sign-in is the method that works today without registering an
 * OAuth app or configuring an email provider (see docs/adr/0004). GitHub and
 * Google OAuth are configuration-gated: they are registered only when the
 * deployer supplies both client credentials, which requires separate user
 * authority. Session semantics are pinned here: 1 hour access JWT, 30 day
 * total and inactive session duration.
 */
function readCredentials(idKey: string, secretKey: string): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env[idKey] ?? "").trim();
  const clientSecret = (process.env[secretKey] ?? "").trim();
  if (clientId === "" || clientSecret === "") return null;
  return { clientId, clientSecret };
}

function configuredOAuthProviders(): AuthProviderConfig[] {
  const providers: AuthProviderConfig[] = [];
  const github = readCredentials("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET");
  if (github !== null) providers.push(GitHub(github));
  const google = readCredentials("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  if (google !== null) providers.push(Google(google));
  return providers;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password(), ...configuredOAuthProviders()],
  jwt: { durationMs: HOUR_MS },
  session: { totalDurationMs: 30 * DAY_MS, inactiveDurationMs: 30 * DAY_MS },
  callbacks: { redirect: (params) => redirectCallback(params) },
});
