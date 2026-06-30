import { afterEach, describe, expect, it } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";

const TEST_ENV_KEYS = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("getVercelSandboxCredentials", () => {
  afterEach(() => {
    clearTestEnv();
  });

  it("returns explicit sandbox credentials when the full token triple is set", () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(getVercelSandboxCredentials()).toEqual({
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("ignores incomplete explicit credentials and lets the SDK resolve auth", () => {
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });
});
