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

  it.each<{
    label: string;
    raw: Record<string, unknown> | undefined;
    allowed: boolean;
  }>([
    { label: "missing event", raw: undefined, allowed: false },
    { label: "missing author team", raw: {}, allowed: false },
    {
      label: "unrelated team fields",
      raw: { team: LOCAL_TEAM, team_id: LOCAL_TEAM },
      allowed: false,
    },
    { label: "local author", raw: { user_team: LOCAL_TEAM }, allowed: true },
    {
      label: "external author",
      raw: { user_team: EXTERNAL_TEAM },
      allowed: false,
    },
    {
      label: "local source fallback",
      raw: { source_team: LOCAL_TEAM },
      allowed: true,
    },
    {
      label: "external source fallback",
      raw: { source_team: EXTERNAL_TEAM },
      allowed: false,
    },
    {
      label: "local author takes precedence",
      raw: { user_team: LOCAL_TEAM, source_team: EXTERNAL_TEAM },
      allowed: true,
    },
    {
      label: "external author takes precedence",
      raw: { user_team: EXTERNAL_TEAM, source_team: LOCAL_TEAM },
      allowed: false,
    },
    {
      label: "empty author team cannot use fallback",
      raw: { user_team: "", source_team: LOCAL_TEAM },
      allowed: false,
    },
    {
      label: "invalid author team cannot use fallback",
      raw: { user_team: 123, source_team: LOCAL_TEAM },
      allowed: false,
    },
    {
      label: "invalid source team",
      raw: { source_team: 123 },
      allowed: false,
    },
  ])("$label", ({ raw, allowed }) => {
    runWithWorkspaceTeamId(LOCAL_TEAM, () => {
      expect(isSlackWorkspaceMember(raw)).toBe(allowed);
    });
  });
});
