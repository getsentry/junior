import { createMemoryState } from "@chat-adapter/state-memory";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  isSlackWorkspaceMember,
  runWithWorkspaceTeamId,
} from "@/chat/ingress/workspace-membership";

const LOCAL_TEAM = "T0LOCAL";
const EXTERNAL_TEAM = "T0EXTERNAL";

describe("isSlackWorkspaceMember", () => {
  let state: ReturnType<typeof createMemoryState>;
  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
  });
  afterEach(async () => {
    await state.disconnect();
  });
  it("rejects an author when the workspace context is missing", async () => {
    await expect(
      isSlackWorkspaceMember({ user_team: LOCAL_TEAM }, state),
    ).resolves.toBe(false);
  });

  it.each([
    { user: "U123", user_team: LOCAL_TEAM },
    { user: "U123", user_team: LOCAL_TEAM, source_team: EXTERNAL_TEAM },
  ])("accepts a local author: %j", async (raw) => {
    await runWithWorkspaceTeamId(LOCAL_TEAM, async () => {
      await expect(isSlackWorkspaceMember(raw, state)).resolves.toBe(true);
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
    { user: "U123", user_team: EXTERNAL_TEAM, team: LOCAL_TEAM },
    { user: "U123", user_team: "", source_team: LOCAL_TEAM },
    { user: "U123", user_team: 123, source_team: LOCAL_TEAM },
    { user: "U123", user_team: null, source_team: LOCAL_TEAM },
    { user: "U123", source_team: 123 },
  ])("rejects an external or unknown author: %j", async (raw) => {
    await runWithWorkspaceTeamId(LOCAL_TEAM, async () => {
      await expect(isSlackWorkspaceMember(raw, state)).resolves.toBe(false);
    });
  });
});
