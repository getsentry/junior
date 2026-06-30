import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function setOrDelete(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("getVercelSandboxCredentials decision matrix", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it.each([
    {
      token: "tk",
      teamId: "tm",
      projectId: "pj",
      expected: { token: "tk", teamId: "tm", projectId: "pj" },
    },
    { token: "tk", teamId: "tm", projectId: undefined, expected: undefined },
    { token: "tk", teamId: undefined, projectId: "pj", expected: undefined },
    { token: undefined, teamId: "tm", projectId: "pj", expected: undefined },
    {
      token: undefined,
      teamId: undefined,
      projectId: undefined,
      expected: undefined,
    },
    { token: "", teamId: "tm", projectId: "pj", expected: undefined },
    { token: "tk", teamId: " ", projectId: "pj", expected: undefined },
    { token: "tk", teamId: "tm", projectId: "  ", expected: undefined },
  ])(
    "token=$token teamId=$teamId projectId=$projectId",
    async ({ token, teamId, projectId, expected }) => {
      setOrDelete("VERCEL_TOKEN", token);
      setOrDelete("VERCEL_TEAM_ID", teamId);
      setOrDelete("VERCEL_PROJECT_ID", projectId);
      vi.resetModules();
      const { getVercelSandboxCredentials } =
        await import("@/chat/sandbox/credentials");
      expect(getVercelSandboxCredentials()).toEqual(expected);
    },
  );
});
