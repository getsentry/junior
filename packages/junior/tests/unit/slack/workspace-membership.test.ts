import { describe, expect, it } from "vitest";
import {
  isSlackWorkspaceMember,
  runWithWorkspaceTeamId,
} from "@/chat/ingress/workspace-membership";

const LOCAL_TEAM = "T0LOCAL";
const EXTERNAL_TEAM = "T0EXTERNAL";

describe("isSlackWorkspaceMember", () => {
  it("rejects an author when the workspace context is missing", () => {
    expect(isSlackWorkspaceMember({ user_team: LOCAL_TEAM })).toBe(false);
  });

  it.each([
    { user_team: LOCAL_TEAM },
    { source_team: LOCAL_TEAM },
    { user_team: LOCAL_TEAM, source_team: EXTERNAL_TEAM },
  ])("accepts a local author: %j", (raw) => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isSlackWorkspaceMember(raw)).toBe(true);
    });
  });

  it.each([
    undefined,
    {},
    { team: LOCAL_TEAM, team_id: LOCAL_TEAM },
    { user_team: EXTERNAL_TEAM },
    { source_team: EXTERNAL_TEAM },
    { user_team: EXTERNAL_TEAM, source_team: LOCAL_TEAM },
    { user_team: "", source_team: LOCAL_TEAM },
    { user_team: 123, source_team: LOCAL_TEAM },
    { source_team: 123 },
  ])("rejects an external or unknown author: %j", (raw) => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isSlackWorkspaceMember(raw)).toBe(false);
    });
  });
});
