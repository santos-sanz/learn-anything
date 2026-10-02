// @vitest-environment jsdom
import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { makeConvexProjectsBackend, type ProjectsBackend } from "../src/data/projects.js";
import { Root, type AuthSession } from "../src/Root.js";
import { asConvexClient } from "./fixtures.js";

/**
 * Two-user end-to-end: the real S21 screens drive the real authorized Convex
 * functions in-process (convex-test), covering the S05/S06 owner boundary.
 * No deployment, credentials or network are involved.
 */
const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
};

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

function backendFor(t: ReturnType<typeof convexTest>, subject?: string): ProjectsBackend {
  const client = subject === undefined ? t : t.withIdentity(identity(subject));
  return makeConvexProjectsBackend(asConvexClient(client));
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined, ...overrides };
}

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

test("user A's projects stay invisible to user B through the full UI flow", async () => {
  const t = convexTest({ schema, modules });
  const user = userEvent.setup();

  // Learner A: onboarding -> create -> dashboard, entirely through the UI.
  render(<Root session={session()} backend={backendFor(t, "learner-a")} />);
  await user.click(await screen.findByRole("link", { name: "Start your first project" }));
  expect(window.location.hash).toBe("#/projects/new");
  await screen.findByRole("heading", { name: "Set up your first project" });
  await user.type(screen.getByLabelText("Project name"), "A private notes");
  await user.type(screen.getByLabelText("Learning goal"), "Pass the driving theory test");
  await user.click(screen.getByLabelText("Language practice"));
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { level: 1, name: "A private notes" });
  await user.click(screen.getByRole("link", { name: "Back to projects" }));
  await screen.findByRole("heading", { name: "A private notes" });
  expect(screen.getByText("Pass the driving theory test")).toBeTruthy();
  cleanup();

  // Learner B on the same deployment sees an empty dashboard, not A's data.
  render(<Root session={session()} backend={backendFor(t, "learner-b")} />);
  await screen.findByRole("heading", { name: "Create your first project" });
  expect(screen.queryByText("A private notes")).toBeNull();
  await user.click(screen.getByRole("link", { name: "Start your first project" }));
  await screen.findByRole("heading", { name: "Set up your first project" });
  await user.type(screen.getByLabelText("Project name"), "B lab notes");
  await user.click(screen.getByLabelText("Concept learning"));
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { level: 1, name: "B lab notes" });
  cleanup();

  // Back as learner A: B's project is absent; A's is still there.
  window.location.hash = "#/projects";
  render(<Root session={session()} backend={backendFor(t, "learner-a")} />);
  await screen.findByRole("heading", { name: "A private notes" });
  expect(screen.queryByText("B lab notes")).toBeNull();

  // Server truth: each owner's list holds only their own row.
  const aProjects = await t.withIdentity(identity("learner-a")).query(api.projects.listProjects, {});
  const bProjects = await t.withIdentity(identity("learner-b")).query(api.projects.listProjects, {});
  expect(aProjects.map((project) => project.name)).toEqual(["A private notes"]);
  expect(bProjects.map((project) => project.name)).toEqual(["B lab notes"]);

  // A cannot delete B's project even with its exact id.
  await expect(t.withIdentity(identity("learner-a")).mutation(api.projects.requestProjectDeletion, { projectId: bProjects[0]._id })).rejects.toThrow("NOT_FOUND");

  // A deletes their own project through the confirmed UI flow; row is gone.
  await user.click(screen.getByRole("button", { name: "Delete A private notes" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "Create your first project" });

  const remaining = await t.run(async (ctx) => ctx.db.query("projects").collect());
  expect(remaining.filter((row) => row.ownerId === "learner-a")).toHaveLength(0);
  expect(remaining.filter((row) => row.ownerId === "learner-b")).toHaveLength(1);
});

test("an anonymous visitor is sent to sign-in and the backend denies every project call", async () => {
  const t = convexTest({ schema, modules });
  const ownedId = await t.withIdentity(identity("learner-a")).mutation(api.projects.createProject, { name: "A secret project" });
  const anonBackend = backendFor(t);

  window.location.hash = "#/projects";
  render(<Root session={session({ isAuthenticated: false })} backend={anonBackend} />);

  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(screen.queryByText("Your projects")).toBeNull();
  expect(screen.queryByText("A secret project")).toBeNull();
  expect(window.location.hash).toBe("#/projects");

  await expect(anonBackend.list()).rejects.toThrow("UNAUTHENTICATED");
  await expect(anonBackend.get(ownedId)).rejects.toThrow("UNAUTHENTICATED");
  await expect(anonBackend.create({ name: "sneaky" })).rejects.toThrow("UNAUTHENTICATED");
  await expect(anonBackend.update(ownedId, { name: "sneaky", goal: "" })).rejects.toThrow("UNAUTHENTICATED");
  await expect(anonBackend.remove(ownedId)).rejects.toThrow("UNAUTHENTICATED");

  const untouched = await t.run(async (ctx) => ctx.db.query("projects").collect());
  expect(untouched).toHaveLength(1);
});

test("sign-in reveals the dashboard and sign-out returns to the sign-in view", async () => {
  const t = convexTest({ schema, modules });
  await t.withIdentity(identity("learner-a")).mutation(api.projects.createProject, { name: "A project" });
  const user = userEvent.setup();

  let authenticated = false;
  const dynamicSession: AuthSession = {
    isLoading: false,
    get isAuthenticated() {
      return authenticated;
    },
    signIn: async () => {
      authenticated = true;
    },
    signOut: async () => {
      authenticated = false;
    },
  };

  render(<Root session={dynamicSession} backend={backendFor(t, "learner-a")} />);
  await screen.findByRole("heading", { name: "Learn Anything" });
  expect(screen.queryByText("Your projects")).toBeNull();

  await user.type(screen.getByLabelText("Email"), "learner-a@example.com");
  await user.type(screen.getByLabelText("Password"), "synthetic-pass-1");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  await screen.findByRole("heading", { name: "Your projects" });
  expect(await screen.findByRole("heading", { name: "A project" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(screen.queryByText("A project")).toBeNull();
});

test("a still-loading session announces progress instead of showing the dashboard", async () => {
  render(<Root session={session({ isLoading: true, isAuthenticated: false })} backend={backendFor(convexTest({ schema, modules }))} />);
  const status = await screen.findByRole("status");
  expect(status.textContent).toContain("Checking your session…");
  await waitFor(() => expect(screen.queryByLabelText("Email")).toBeNull());
});
