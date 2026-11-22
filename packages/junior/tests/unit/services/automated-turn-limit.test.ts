import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAutomatedTurnLimitResponse,
  countAutomatedTurn,
  getAutomatedTurnLimitState,
  isAutomatedTurnSource,
  recordFinishedTurnForAutomatedLimit,
  resetAutomatedTurnLimit,
} from "@/chat/services/automated-turn-limit";
import { disconnectStateAdapter } from "@/chat/state/adapter";

describe("automated turn limit", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("classifies automated sources", () => {
    expect(
      isAutomatedTurnSource({
        kind: "event",
        eventKey: "e",
        eventType: "x",
        identifier: "i",
        namespace: "n",
      }),
    ).toBe(true);
    expect(isAutomatedTurnSource({ kind: "event_automation" })).toBe(true);
    expect(
      isAutomatedTurnSource({
        kind: "slack",
        teamId: "T1",
        channelId: "C1",
        visibility: "public",
      }),
    ).toBe(false);
    expect(isAutomatedTurnSource(undefined)).toBe(false);
  });

  it("explains the stop in plain language", () => {
    const response = buildAutomatedTurnLimitResponse({
      maxTurns: 10,
    });
    expect(response).toContain(
      "stopped automatic updates after 10 automated turns without a new message from you",
    );
    expect(response).toContain("Turns with no reply also count.");
    expect(response).toContain("Send a message or @mention me in this thread");
    expect(response).not.toContain("event-driven");
    expect(response).not.toContain("event");
    expect(response).not.toContain("budget");
    expect(response).not.toContain("circuit");
    expect(response).not.toContain("channel");
  });

  it("reports the limit from the Turn that reaches it", async () => {
    const conversationId = "slack:C1:1.0";

    for (let i = 0; i < 4; i += 1) {
      await expect(
        countAutomatedTurn({
          conversationId,
          maxTurns: 3,
          nowMs: 1_000 + i,
        }),
      ).resolves.toEqual({
        consecutiveAutomatedTurns: i + 1,
        reached: i + 1 >= 3,
      });
    }
  });

  it("keeps the count of a stored pause from before the stop rule", async () => {
    const conversationId = "slack:C1:old-pause";
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const state = getStateAdapter();
    await state.connect();
    await state.set(
      `junior:automated_turn_limit:v1:conversation:${conversationId}`,
      {
        consecutiveAutomatedTurns: 3,
        noticePostedAtMs: 1_000,
        paused: true,
        updatedAtMs: 1_000,
      },
    );

    await expect(
      countAutomatedTurn({ conversationId, maxTurns: 3, nowMs: 2_000 }),
    ).resolves.toEqual({ consecutiveAutomatedTurns: 4, reached: true });
  });

  it("resets after a user turn", async () => {
    const conversationId = "slack:C2:2.0";

    await countAutomatedTurn({
      conversationId,
      maxTurns: 2,
      nowMs: 1,
    });

    await recordFinishedTurnForAutomatedLimit({
      conversationId,
      maxTurns: 2,
      nowMs: 3,
      source: {
        kind: "slack",
        teamId: "T1",
        channelId: "C2",
        visibility: "public",
      },
    });

    await expect(
      getAutomatedTurnLimitState({ conversationId, nowMs: 4 }),
    ).resolves.toEqual({ consecutiveAutomatedTurns: 0, updatedAtMs: 4 });
  });

  it("counts automated finishes on the conversation", async () => {
    const conversationId = "agent-dispatch:abc";

    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        maxTurns: 10,
        nowMs: 10,
        source: { kind: "event_automation" },
      }),
    ).resolves.toEqual({ consecutiveAutomatedTurns: 1, reached: false });

    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });

    await resetAutomatedTurnLimit({ conversationId });
  });

  it("counts event finishes on the conversation", async () => {
    const conversationId = "slack:C3:3.0";
    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        maxTurns: 10,
        nowMs: 1,
        source: {
          kind: "event",
          eventKey: "e",
          eventType: "pull_request.opened",
          identifier: "getsentry/junior#1",
          namespace: "github",
        },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
    });
    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });
  });

  it("keeps separate conversations independent", async () => {
    const first = "agent-dispatch:one";
    const second = "agent-dispatch:two";

    for (let i = 0; i < 3; i += 1) {
      await countAutomatedTurn({
        conversationId: first,
        maxTurns: 3,
        nowMs: 1_000 + i,
      });
    }

    await expect(
      getAutomatedTurnLimitState({ conversationId: first }),
    ).resolves.toMatchObject({ consecutiveAutomatedTurns: 3 });
    await expect(
      getAutomatedTurnLimitState({ conversationId: second, nowMs: 2_001 }),
    ).resolves.toEqual({ consecutiveAutomatedTurns: 0, updatedAtMs: 2_001 });
  });
});
