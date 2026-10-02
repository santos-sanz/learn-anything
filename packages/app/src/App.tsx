import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "@learn-anything/api/convex/_generated/api";
import { useConvex, useMutation } from "convex/react";
import { useMemo } from "react";

import { makeConvexProjectsBackend } from "./data/projects.js";
import { Root, type AuthSession } from "./Root.js";
import type { SignInSubmission } from "./SignInForm.js";

/**
 * Production root: binds Convex Auth (S06) and the authorized project backend
 * (S05 functions) to the shared `Root` gate/shell. Nothing here reads provider
 * configuration; only the public `VITE_CONVEX_URL` reaches the browser.
 */
export function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const revokeConnectionTokens = useMutation(api.agentSessions.revokeAllConnectionTokens);
  const convex = useConvex();
  const backend = useMemo(() => makeConvexProjectsBackend(convex), [convex]);

  const session = useMemo<AuthSession>(
    () => ({
      isLoading,
      isAuthenticated,
      async signIn(submission: SignInSubmission) {
        await signIn("password", { flow: submission.flow, email: submission.email, password: submission.password });
      },
      async signOut() {
        // Still authenticated here: kill scoped agent tokens before the Convex
        // Auth session so a reconnecting agent cannot outlive sign-out.
        await revokeConnectionTokens({});
        await signOut();
      },
    }),
    [isLoading, isAuthenticated, signIn, signOut, revokeConnectionTokens],
  );

  return <Root session={session} backend={backend} />;
}
