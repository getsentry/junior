import { describe, expect, it } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { stubTestEnv } from "../../fixtures/vitest";

describe("getVercelSandboxCredentials", () => {
  it("returns explicit sandbox credentials when the full token triple is set", () => {
    stubTestEnv({
      VERCEL_TOKEN: "sandbox-token",
      VERCEL_TEAM_ID: "team_123",
      VERCEL_PROJECT_ID: "prj_123",
    });

    expect(getVercelSandboxCredentials()).toEqual({
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("ignores incomplete explicit credentials and lets the SDK resolve auth", () => {
    stubTestEnv({
      VERCEL_TEAM_ID: "team_123",
      VERCEL_PROJECT_ID: "prj_123",
    });

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });
});
