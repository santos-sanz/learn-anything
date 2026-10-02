import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) files.push(full);
  }
  return files;
}

const sourceFiles = walk(join(appRoot, "src"), [".ts", ".tsx", ".css"]);
const read = (file: string) => readFileSync(file, "utf8");

test("the browser bundle source never reads provider or deployer configuration", () => {
  const forbidden = ["NAN_API_KEY", "CONVEX_DEPLOYMENT", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "JWT_PRIVATE_KEY", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "process.env", "localStorage.getItem", "sessionStorage.getItem"];
  for (const file of sourceFiles) {
    const content = read(file);
    for (const needle of forbidden) {
      expect(content.includes(needle), `${file} must not reference ${needle}`).toBe(false);
    }
  }
});

test("only public VITE_* values (plus Vite's own DEV flag) are read from import.meta.env", () => {
  const publicFlags = new Set(["DEV"]);
  const reads = sourceFiles.flatMap((file) => [...read(file).matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => [file, match[1]] as const));
  expect(reads.length).toBeGreaterThan(0);
  for (const [, key] of reads) {
    expect(key.startsWith("VITE_") || publicFlags.has(key), `unexpected env key ${key}`).toBe(true);
  }
});

test("committed example configuration stays empty", () => {
  for (const example of [join(appRoot, "..", "..", ".env.example"), join(appRoot, "..", "api", ".env.example")]) {
    for (const line of readFileSync(example, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      expect(trimmed, `${example} must only contain empty values`).toMatch(/^[A-Z0-9_]+=$/);
    }
  }
});

test("the page declares a mobile viewport and ships responsive CSS", () => {
  const html = readFileSync(join(appRoot, "index.html"), "utf8");
  expect(html).toContain('name="viewport"');
  expect(html).toContain("width=device-width");
  const css = read(join(appRoot, "src", "styles.css"));
  expect(css).toContain("@media (min-width: 40rem)");
  expect(css).toContain(":focus-visible");
});
