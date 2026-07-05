import { describe, expect, it } from "vitest";
import {
  isExternalSlackUser,
  runWithWorkspaceTeamId,
} from "@/chat/ingress/workspace-membership";

const LOCAL_TEAM = "T0LOCAL";
const EXTERNAL_TEAM = "T0EXTERNAL";

describe("isExternalSlackUser", () => {
  it("returns false when no workspace context is set", () => {
    expect(isExternalSlackUser({ user_team: EXTERNAL_TEAM })).toBe(false);
  });

  it("returns false for undefined raw", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isExternalSlackUser(undefined)).toBe(false);
    });
  });

  it("returns false when user_team matches workspace", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isExternalSlackUser({ user_team: LOCAL_TEAM })).toBe(false);
    });
  });

  it("returns true when user_team differs from workspace", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isExternalSlackUser({ user_team: EXTERNAL_TEAM })).toBe(true);
    });
  });

  it("falls back to source_team when user_team is absent", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isExternalSlackUser({ source_team: EXTERNAL_TEAM })).toBe(true);
      expect(isExternalSlackUser({ source_team: LOCAL_TEAM })).toBe(false);
    });
  });

  it("prefers user_team over source_team", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(
        isExternalSlackUser({
          user_team: LOCAL_TEAM,
          source_team: EXTERNAL_TEAM,
        }),
      ).toBe(false);
    });
  });

  it("returns false for non-shared channel messages (no team fields)", () => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isExternalSlackUser({ channel: "C123", ts: "1.0" })).toBe(false);
    });
  });
});
