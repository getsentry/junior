import { describe, expect, it } from "vitest";
import {
  compactStatusCommand,
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain,
  truncateStatusText,
} from "@/chat/status-format";

describe("status formatting", () => {
  it("truncates long status text with ellipsis", () => {
    expect(truncateStatusText("  " + "x".repeat(60) + "  ")).toBe(
      "x".repeat(47) + "...",
    );
  });

  it("extracts filename from unix and windows paths", () => {
    expect(compactStatusFilename("/tmp/workspace/src/chat/respond.ts")).toBe(
      "respond.ts",
    );
    expect(
      compactStatusFilename("C:\\tmp\\workspace\\src\\chat\\respond.ts"),
    ).toBe("respond.ts");
  });

  it("extracts the executable name from shell commands", () => {
    expect(compactStatusCommand("pnpm --filter @sentry/junior test")).toBe(
      "pnpm",
    );
    expect(
      compactStatusCommand('CI=1 DEBUG=1 "/usr/local/bin/pnpm" test'),
    ).toBe("pnpm");
  });

  it("compacts long freeform text with ellipsis", () => {
    expect(compactStatusText("x".repeat(90), 12)).toBe("xxxxxxxxx...");
  });

  it("compacts long paths with leading ellipsis", () => {
    const compacted = compactStatusPath(`/tmp/${"a".repeat(120)}`);
    expect(compacted?.startsWith("...")).toBe(true);
    expect(compacted?.length).toBe(80);
  });

  it("extracts domain from url", () => {
    expect(extractStatusUrlDomain("https://docs.example.com/path?q=1")).toBe(
      "docs.example.com",
    );
  });
});
