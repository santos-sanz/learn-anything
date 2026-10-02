import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * Free-plan configuration review (S07 acceptance evidence). This test reads
 * the committed Wrangler configuration, the package pins, the lockfile and
 * the operator documentation, so a change that silently enables a paid plan,
 * Workers AI, frontend hosting or unpinned SDK versions fails CI.
 */
const readText = (relativePath: string): string => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const wrangler = JSON.parse(readText("../wrangler.json")) as Record<string, unknown>;
const packageJson = JSON.parse(readText("../package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const workspaceRoot = "../../../";

test("pins the agent runtime to exact versions", () => {
  const exact = /^[0-9]+\.[0-9]+\.[0-9]+$/;
  const workspace = /^workspace:\*$/;
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    if (name.startsWith("@learn-anything/")) {
      expect(version, `${name} must use the workspace protocol`).toMatch(workspace);
    } else {
      expect(version, `${name} must be pinned exactly`).toMatch(exact);
    }
  }
  expect(packageJson.dependencies).toMatchObject({ agents: "0.26.0" });
  expect(packageJson.devDependencies).toMatchObject({
    wrangler: "4.147.0",
    "@cloudflare/workers-types": "5.20261002.1",
    "@cloudflare/vitest-plugin": "1.3.6",
    msw: "3.0.1",
    "@msw/cloudflare": "0.2.0",
  });

  const lockfile = readText(`${workspaceRoot}pnpm-lock.yaml`);
  expect(lockfile).toContain("agents@0.26.0");
  expect(lockfile).toContain("wrangler@4.147.0");
  expect(lockfile).toContain("workerd@1.20261001.1");
});

test("keeps the Wrangler configuration inside the Workers Free agent-only shape", () => {
  expect(wrangler.compatibility_date).toBe("2026-08-01");
  expect(wrangler.compatibility_flags).toEqual(["nodejs_compat"]);

  // SQLite-backed Durable Object only (the sole backend available on Free).
  expect(wrangler.exports).toEqual({ LearnerAgent: { type: "durable-object", storage: "sqlite" } });
  expect(wrangler.durable_objects).toEqual({ bindings: [{ name: "LearnerAgent", class_name: "LearnerAgent" }] });

  // Forbidden: Workers AI, general frontend hosting, routes/custom domains,
  // account/plan selection (nothing may opt into paid spend).
  for (const forbidden of ["ai", "assets", "routes", "zone_id", "account_id", "plan", "workers_dev", "kv_namespaces", "d1_databases", "r2_buckets", "queues"]) {
    expect(wrangler, `wrangler.json must not configure "${forbidden}"`).not.toHaveProperty(forbidden);
  }

  // Committed vars are empty placeholders only; secrets never appear here.
  expect(wrangler.vars).toEqual({ CONVEX_URL: "", NAN_DEPLOYER_ID: "" });
  for (const secretName of ["AGENT_BRIDGE_SECRET", "NAN_API_KEY"]) {
    expect(wrangler.vars, `${secretName} must not live in wrangler.json`).not.toHaveProperty(secretName);
  }

  // Local secret template stays empty.
  const devVars = readText("../.dev.vars.example");
  const lines = devVars.split("\n").filter((line) => line.includes("=") && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const value = line.slice(line.indexOf("=") + 1).trim();
    expect(value, `${line.split("=")[0]} must be empty in the example`).toBe("");
  }
});

test("never references Workers AI or another model provider in the agent sources", () => {
  const files = readdirSync(fileURLToPath(new URL("../src", import.meta.url)));
  expect(files.length).toBeGreaterThan(0);
  const forbidden = [/workers-ai/i, /@cloudflare\/ai\b/, /\benv\.AI\b/, /\.AI\.run\(/, /@\w+\/[\w-]*-\d+\.\d+/];
  for (const file of files) {
    const source = readText(`../src/${file}`);
    for (const pattern of forbidden) {
      expect(pattern.test(source), `${file} must not match ${pattern}`).toBe(false);
    }
  }
  // The only model/provider entry point is the S11 NaN adapter bridge.
  const bridge = readText("../src/nanBridge.ts");
  expect(bridge).toContain("from \"@learn-anything/worker\"");
});

test("documents the official Free-plan limits and the no-upgrade policy", () => {
  const docs = readText(`${workspaceRoot}docs/cloudflare-agent-runtime.md`);
  for (const marker of [
    "Workers Free and Durable Objects Free limits",
    "100,000/day",
    "10 ms",
    "128 MB",
    "13,000 GB-s",
    "5,000,000/day",
    "100,000/day",
    "5 GB",
    "00:00 UTC",
    "never upgrades to a paid plan",
    "0.26.0",
    "4.147.0",
    "2026-08-01",
  ]) {
    expect(docs, `docs must document "${marker}"`).toContain(marker);
  }
});
