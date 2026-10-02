import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
const convexUrl = import.meta.env.VITE_CONVEX_URL;

// Dev-only screenshot/preview fixtures (#/preview/...). `import.meta.env.DEV`
// is replaced with `false` at build time, so production bundles drop both the
// branch and the preview module; no fixture data or mock path ships to users.
if (root !== null && import.meta.env.DEV && window.location.hash.startsWith("#/preview")) {
  void import("./preview.js").then(({ mountPreview }) => mountPreview(root));
} else if (root !== null) {
  if (convexUrl === undefined || convexUrl === "") {
    createRoot(root).render(
      <StrictMode>
        <main>
          <h1>Learn Anything</h1>
          <p role="alert">VITE_CONVEX_URL is not configured, so no sign-in is possible.</p>
        </main>
      </StrictMode>,
    );
  } else {
    createRoot(root).render(
      <StrictMode>
        <ConvexAuthProvider client={new ConvexReactClient(convexUrl)}>
          <App />
        </ConvexAuthProvider>
      </StrictMode>,
    );
  }
}
