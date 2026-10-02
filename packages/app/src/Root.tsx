import { useEffect, useRef, useState } from "react";

import { deriveAuthView, mapAuthError } from "./authView.js";
import { ProjectsProvider } from "./data/ProjectsProvider.js";
import type { ProjectsBackend } from "./data/projects.js";
import { Dashboard } from "./screens/Dashboard.js";
import { NewProject } from "./screens/NewProject.js";
import { ProjectDetail } from "./screens/ProjectDetail.js";
import { serializeRoute, useHashRoute } from "./router.js";
import { SignInForm, type SignInSubmission } from "./SignInForm.js";

/**
 * The authenticated session as the view sees it. The real implementation is
 * built in `App` from Convex Auth hooks; tests inject a deterministic one so
 * the sign-in redirect, deep links and sign-out are all observable.
 */
export type AuthSession = {
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (submission: SignInSubmission) => Promise<void>;
  signOut: () => Promise<void>;
};

function Shell({ busy, error, onSignOut }: { busy: boolean; error: string | null; onSignOut: () => void | Promise<void> }) {
  const route = useHashRoute();
  const routeKey = serializeRoute(route);
  const mainRef = useRef<HTMLElement>(null);
  const isFirstRender = useRef(true);

  // Move focus into the main region on navigation so keyboard and screen
  // reader users land on the new view instead of staying in the header. The
  // dependency is the stable route identity, not a fresh route object, so the
  // effect only re-runs when the location actually changes.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [routeKey]);

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#/projects">
          Learn Anything
        </a>
        <button type="button" className="button" onClick={() => void onSignOut()} disabled={busy}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </header>
      {error !== null && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <main className="app-main" id="main" ref={mainRef} tabIndex={-1}>
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "new-project" && <NewProject />}
        {route.name === "project" && <ProjectDetail id={route.id} key={route.id} />}
      </main>
    </div>
  );
}

/**
 * S06 gate + S21 shell: anonymous and still-loading visitors never reach the
 * dashboard (they get the sign-in view, with any deep link left intact for
 * after sign-in), and sign-out revokes before the session state flips.
 */
export function Root({ session, backend }: { session: AuthSession; backend: ProjectsBackend }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const view = deriveAuthView(session);

  if (view === "loading") {
    return (
      <main role="status">
        <h1>Learn Anything</h1>
        <p>Checking your session…</p>
      </main>
    );
  }

  if (view === "sign-in") {
    const handleSubmit = async (submission: SignInSubmission) => {
      setBusy(true);
      setError(null);
      try {
        await session.signIn(submission);
      } catch (caught) {
        setError(mapAuthError(caught));
      } finally {
        setBusy(false);
      }
    };
    return <SignInForm busy={busy} error={error} onSubmit={(submission) => void handleSubmit(submission)} />;
  }

  const handleSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.signOut();
    } catch (caught) {
      setError(mapAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProjectsProvider backend={backend}>
      <Shell busy={busy} error={error} onSignOut={handleSignOut} />
    </ProjectsProvider>
  );
}
