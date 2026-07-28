import * as fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dashboardInteractiveTextClass } from "../src/client/styles";

const packageRoot = path.resolve(import.meta.dirname, "..");
const clientRoot = path.join(packageRoot, "src", "client");
const tailwindPath = path.join(packageRoot, "src", "tailwind.css");
const legacyWhiteTextPattern = /text-white(?:\/\d+)?\b/;
const legacySecondaryTextPattern = /text-dashboard-text-secondary/;
const arbitraryTextColorPattern = /text-\[#([\da-f]{3}|[\da-f]{6})\]/gi;

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function hasArbitraryNeutralTextColor(line: string): boolean {
  return [...line.matchAll(arbitraryTextColorPattern)].some((match) => {
    const value = match[1];
    const channels =
      value.length === 3
        ? [...value].map((channel) => `${channel}${channel}`)
        : value.match(/.{2}/g);
    return channels?.every((channel) => channel === channels[0]) ?? false;
  });
}

function usesNonstandardNeutralTextColor(line: string): boolean {
  return (
    legacyWhiteTextPattern.test(line) ||
    legacySecondaryTextPattern.test(line) ||
    hasArbitraryNeutralTextColor(line)
  );
}

describe("dashboard neutral text colors", () => {
  it("uses only the shared normal and muted colors", () => {
    const violations = sourceFiles(clientRoot).flatMap((file) => {
      const relativePath = path.relative(packageRoot, file);
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          usesNonstandardNeutralTextColor(line)
            ? [`${relativePath}:${index + 1}: ${line.trim()}`]
            : [],
        );
    });

    expect(violations).toEqual([]);
  });

  it("defines the shared normal and muted colors", () => {
    const css = fs.readFileSync(tailwindPath, "utf8");

    expect(css).toContain("--color-dashboard-text: #f4f4f5;");
    expect(css).toContain("--color-dashboard-text-muted: #a1a1aa;");
  });

  it("brightens muted interactive text on hover", () => {
    expect(dashboardInteractiveTextClass).toBe(
      "text-dashboard-text-muted hover:text-dashboard-text",
    );
  });
});
