import { describe, expect, it } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/vercel/credentials";
import { useConfig } from "../../fixtures/config";

describe("getVercelSandboxCredentials decision matrix", () => {
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
    ({ token, teamId, projectId, expected }) => {
      useConfig(
        {},
        {
          VERCEL_TOKEN: token,
          VERCEL_TEAM_ID: teamId,
          VERCEL_PROJECT_ID: projectId,
        },
      );
      expect(getVercelSandboxCredentials()).toEqual(expected);
    },
  );
});
