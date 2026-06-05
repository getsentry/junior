import { describe, expect, it } from "vitest";
import { getRuntimeMetadata } from "@/chat/config";
import { stubTestEnv } from "../../fixtures/vitest";

describe("getRuntimeMetadata", () => {
  it("returns version from VERCEL_GIT_COMMIT_SHA", () => {
    stubTestEnv({ VERCEL_GIT_COMMIT_SHA: "abc123" });
    expect(getRuntimeMetadata()).toEqual({ version: "abc123" });
  });

  it("omits version when VERCEL_GIT_COMMIT_SHA is missing", () => {
    stubTestEnv({ VERCEL_GIT_COMMIT_SHA: undefined });
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });

  it("treats blank VERCEL_GIT_COMMIT_SHA as missing", () => {
    stubTestEnv({ VERCEL_GIT_COMMIT_SHA: "   " });
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });
});
