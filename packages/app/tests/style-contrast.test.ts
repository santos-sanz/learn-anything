import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"), "utf8");

function variable(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (match === null) throw new Error(`styles.css is missing --${name}`);
  return match[1].trim();
}

function toRgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex === null) throw new Error(`expected one opaque 6-digit colour, got "${value}" (alpha would silently weaken contrast)`);
  const packed = Number.parseInt(hex[1], 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

function luminance(rgb: [number, number, number]): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a: string, b: string): number {
  const la = luminance(toRgb(a));
  const lb = luminance(toRgb(b));
  const [high, low] = la > lb ? [la, lb] : [lb, la];
  return (high + 0.05) / (low + 0.05);
}

test("hint text meets WCAG AA (>= 4.5:1) on every surface it sits on", () => {
  const hint = variable("ink-soft");
  for (const surface of ["surface", "surface-sunken"]) {
    expect(contrast(hint, variable(surface)), `--ink-soft on --${surface}`).toBeGreaterThanOrEqual(4.5);
  }
});
