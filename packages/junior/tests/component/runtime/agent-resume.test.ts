import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import { loadTurnSessionRecord } from "@/chat/services/turn-session-record";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

describe("agent resume", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("keeps auth parking failures terminal", async () => {
    const conversationId = "local:test:auth-park-failure";
    const turnId = "turn-auth-park-failure";
    const destination = { platform: "local" as const, conversationId };
    const resume = createResumeState({
      destination,
      durability: {},
      recordActiveMcpProviders: async () => {
        throw new Error("provider metadata unavailable");
      },
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      sessionRecordState: await loadTurnSessionRecord({
        conversationId,
        sessionId: turnId,
      }),
      startedAtMs: Date.now(),
      surface: "internal",
    });

    await expect(
      resume.parkForAuth(
        new AuthorizationPauseError("mcp", "example", "Example", "link_sent"),
      ),
    ).rejects.toEqual(expect.any(Error));
    await expect(
      getAgentTurnSessionRecord(conversationId, turnId),
    ).resolves.toBeUndefined();
  });
});
