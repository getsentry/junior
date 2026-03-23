import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeMetadata } from "@/chat/config";

describe("getRuntimeMetadata", () => {
  afterEach(() => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  });

  it("returns version from VERCEL_GIT_COMMIT_SHA", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    expect(getRuntimeMetadata()).toEqual({ version: "abc123" });
  });

  it("omits version when VERCEL_GIT_COMMIT_SHA is missing", () => {
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });

  it("treats blank VERCEL_GIT_COMMIT_SHA as missing", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "   ";
    expect(getRuntimeMetadata()).toEqual({ version: undefined });
  });
});
