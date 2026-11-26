import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeMetadata } from "@/chat/config";
import { useConfig } from "../../fixtures/config";

describe("getRuntimeMetadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns version from VERCEL_GIT_COMMIT_SHA", () => {
    useConfig({ deployment: { commitSha: "abc123" } });
    expect(getRuntimeMetadata()).toEqual({ version: "abc123" });
  });

  it("omits version when VERCEL_GIT_COMMIT_SHA is missing", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined);
    useConfig();
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });

  it("treats blank VERCEL_GIT_COMMIT_SHA as missing", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "   ");
    useConfig();
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });
});
