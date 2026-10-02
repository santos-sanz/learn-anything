import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convexUrl === undefined || convexUrl === "" ? (
      <main>
        <h1>Learn Anything</h1>
        <p role="alert">VITE_CONVEX_URL is not configured, so no sign-in is possible.</p>
      </main>
    ) : (
      <ConvexAuthProvider client={new ConvexReactClient(convexUrl)}>
        <App />
      </ConvexAuthProvider>
    )}
  </StrictMode>,
);
