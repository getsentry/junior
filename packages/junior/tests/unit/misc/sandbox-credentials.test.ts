import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/vercel/credentials";

describe("getVercelSandboxCredentials", () => {
  // Start without the host's Vercel credentials, and restore them after.
  beforeEach(() => {
    vi.stubEnv("VERCEL_TOKEN", undefined);
    vi.stubEnv("VERCEL_TEAM_ID", undefined);
    vi.stubEnv("VERCEL_PROJECT_ID", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns explicit sandbox credentials when the full token triple is set", () => {
    vi.stubEnv("VERCEL_TOKEN", "sandbox-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_123");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");

    expect(getVercelSandboxCredentials()).toEqual({
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("ignores incomplete explicit credentials and lets the SDK resolve auth", () => {
    vi.stubEnv("VERCEL_TEAM_ID", "team_123");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });
});
