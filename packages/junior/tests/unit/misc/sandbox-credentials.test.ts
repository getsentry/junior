import { describe, expect, it } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/vercel/credentials";
import { useConfig } from "../../fixtures/config";

describe("getVercelSandboxCredentials", () => {
  it("returns explicit sandbox credentials when the full token triple is set", () => {
    useConfig({
      sandbox: {
        vercel: {
          token: "sandbox-token",
          teamId: "team_123",
          projectId: "prj_123",
        },
      },
    });

    expect(getVercelSandboxCredentials()).toEqual({
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("ignores incomplete explicit credentials and lets the SDK resolve auth", () => {
    useConfig(
      { sandbox: { vercel: { teamId: "team_123", projectId: "prj_123" } } },
      { VERCEL_TOKEN: undefined },
    );

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });
});
