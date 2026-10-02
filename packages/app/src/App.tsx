import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "@learn-anything/api/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { deriveAuthView, mapAuthError } from "./authView.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { SignInForm, type SignInSubmission } from "./SignInForm.js";
import { TurnCapture } from "./TurnCapture.js";

export function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const revokeConnectionTokens = useMutation(api.agentSessions.revokeAllConnectionTokens);
  const projects = useQuery(api.projects.listProjects, {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const view = deriveAuthView({ isLoading, isAuthenticated });

  if (view === "loading") return <main role="status">Checking your session…</main>;

  if (view === "sign-in") {
    const handleSubmit = async (submission: SignInSubmission) => {
      setBusy(true);
      setError(null);
      try {
        await signIn("password", { flow: submission.flow, email: submission.email, password: submission.password });
      } catch (caught) {
        setError(mapAuthError(caught));
      } finally {
        setBusy(false);
      }
    };
    return <SignInForm busy={busy} error={error} onSubmit={handleSubmit} />;
  }

  const handleSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      // Still authenticated here: kill scoped agent tokens before the Convex
      // Auth session so a reconnecting agent cannot outlive sign-out.
      await revokeConnectionTokens({});
      await signOut();
    } catch (caught) {
      setError(mapAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  const projectList = projects ?? [];
  const activeProjectId =
    selectedProjectId !== null && projectList.some((project) => project._id === selectedProjectId)
      ? selectedProjectId
      : projectList[0]?._id ?? null;

  return (
    <main>
      <h1>Learn Anything</h1>
      <p>You are signed in.</p>
      <button type="button" onClick={() => void handleSignOut()} disabled={busy}>
        Sign out
      </button>
      {error !== null && <p role="alert">{error}</p>}
      <ProjectPicker selectedProjectId={activeProjectId} onSelect={setSelectedProjectId} />
      {projects !== undefined &&
        (activeProjectId === null ? (
          <p>Create a project to record a microphone turn.</p>
        ) : (
          <TurnCapture
            key={activeProjectId}
            projectId={activeProjectId}
            siteUrl={import.meta.env.VITE_CONVEX_SITE_URL}
          />
        ))}
    </main>
  );
}
