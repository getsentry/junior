import { describe, expect, it } from "vitest";
import { resolveHostDataPath } from "@/chat/sandbox/skill-sync";

describe("resolveHostDataPath", () => {
  const referenceFiles = ["/app/runbooks.md", "/app/api-surface.md"];

  it("resolves a sandbox data path to its host file", () => {
    expect(
      resolveHostDataPath(referenceFiles, "/vercel/sandbox/data/runbooks.md"),
    ).toBe("/app/runbooks.md");
  });

  it("resolves another sandbox data path", () => {
    expect(
      resolveHostDataPath(
        referenceFiles,
        "/vercel/sandbox/data/api-surface.md",
      ),
    ).toBe("/app/api-surface.md");
  });

  it("returns null for unknown files", () => {
    expect(
      resolveHostDataPath(referenceFiles, "/vercel/sandbox/data/unknown.md"),
    ).toBeNull();
  });

  it("returns null for paths outside the data root", () => {
    expect(
      resolveHostDataPath(referenceFiles, "/vercel/sandbox/skills/foo/bar.md"),
    ).toBeNull();
  });

  it("returns null for path traversal attempts", () => {
    expect(
      resolveHostDataPath(
        referenceFiles,
        "/vercel/sandbox/data/../skills/foo.md",
      ),
    ).toBeNull();
  });

  it("returns null for nested paths within data root", () => {
    expect(
      resolveHostDataPath(
        referenceFiles,
        "/vercel/sandbox/data/nested/file.md",
      ),
    ).toBeNull();
  });
});
