import { describe, expect, it } from "vitest";
import {
  isSlackWorkspaceMember,
  runWithWorkspaceTeamId,
} from "@/chat/ingress/workspace-membership";

const LOCAL_TEAM = "T0LOCAL";
const EXTERNAL_TEAM = "T0EXTERNAL";

describe("isSlackWorkspaceMember", () => {
  it("rejects an author when the workspace context is missing", async () => {
    await expect(
      isSlackWorkspaceMember({ user_team: LOCAL_TEAM }),
    ).resolves.toBe(false);
  });

  it.each([
    { user: "U123", user_team: LOCAL_TEAM },
    { user: "U123", type: "message", team: LOCAL_TEAM },
    { user: "U123", user_team: LOCAL_TEAM, source_team: EXTERNAL_TEAM },
  ])("accepts a local author: %j", async (raw) => {
    await runWithWorkspaceTeamId(LOCAL_TEAM, async () => {
      await expect(isSlackWorkspaceMember(raw)).resolves.toBe(true);
    });
  });

  it.each([
    undefined,
    null,
    "not an event",
    [],
    {},
    { team: LOCAL_TEAM, team_id: LOCAL_TEAM },
    { user_team: LOCAL_TEAM },
    { user: "U123", user_team: EXTERNAL_TEAM },
    { user: "U123", type: "message", team: EXTERNAL_TEAM },
    { user: "U123", user_team: EXTERNAL_TEAM, team: LOCAL_TEAM },
    { user: "U123", user_team: "", source_team: LOCAL_TEAM },
    { user: "U123", user_team: 123, source_team: LOCAL_TEAM },
    { user: "U123", user_team: null, source_team: LOCAL_TEAM },
    { user: "U123", source_team: 123 },
  ])("rejects an external or unknown author: %j", async (raw) => {
    await runWithWorkspaceTeamId(LOCAL_TEAM, async () => {
      await expect(isSlackWorkspaceMember(raw)).resolves.toBe(false);
    });
  });
});
