import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitAutomatedTurn,
  buildAutomatedTurnLimitResponse,
  clearAutomatedTurnLimitNoticeClaim,
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
        kind: "resource_event",
        eventKey: "e",
        eventType: "x",
        identifier: "i",
        namespace: "n",
      }),
    ).toBe(true);
    expect(isAutomatedTurnSource({ kind: "event_task" })).toBe(true);
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

  it("explains the pause in plain language", () => {
    const response = buildAutomatedTurnLimitResponse({
      maxTurns: 10,
    });
    expect(response).toContain(
      "stopped automatic updates after 10 replies without a new message from you",
    );
    expect(response).toContain("Send a message or @mention me in this thread");
    expect(response).not.toContain("event-driven");
    expect(response).not.toContain("resource event");
    expect(response).not.toContain("budget");
    expect(response).not.toContain("circuit");
    expect(response).not.toContain("channel");
  });

  it("admits turns until the consecutive limit, then pauses with one notice", async () => {
    const conversationId = "slack:C1:1.0";

    for (let i = 0; i < 3; i += 1) {
      await expect(
        admitAutomatedTurn({
          conversationId,
          maxTurns: 3,
          nowMs: 1_000 + i,
        }),
      ).resolves.toEqual({
        status: "allow",
        consecutiveAutomatedTurns: i,
      });
      await expect(
        countAutomatedTurn({
          conversationId,
          maxTurns: 3,
          nowMs: 1_000 + i,
        }),
      ).resolves.toMatchObject({
        consecutiveAutomatedTurns: i + 1,
        paused: i + 1 >= 3,
        shouldPostNotice: i + 1 >= 3,
      });
    }

    await expect(
      admitAutomatedTurn({ conversationId, maxTurns: 3, nowMs: 2_000 }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 3,
      shouldPostNotice: false,
    });
    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 3,
      paused: true,
      noticePostedAtMs: 1_002,
    });
  });

  it("clears a failed notice claim so a later paused wake can post again", async () => {
    const conversationId = "slack:C1:notice-claim";

    for (let i = 0; i < 2; i += 1) {
      await countAutomatedTurn({
        conversationId,
        maxTurns: 2,
        nowMs: 1_000 + i,
      });
    }

    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 2,
      paused: true,
      noticePostedAtMs: 1_001,
    });

    await clearAutomatedTurnLimitNoticeClaim({
      conversationId,
      nowMs: 1_500,
    });

    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toEqual({
      consecutiveAutomatedTurns: 2,
      paused: true,
      updatedAtMs: 1_500,
    });

    await expect(
      admitAutomatedTurn({ conversationId, maxTurns: 2, nowMs: 2_000 }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 2,
      shouldPostNotice: true,
    });
    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 2,
      paused: true,
      noticePostedAtMs: 2_000,
    });
  });

  it("resets after a user turn so later automated wakes can run", async () => {
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
      admitAutomatedTurn({ conversationId, maxTurns: 2, nowMs: 4 }),
    ).resolves.toEqual({
      status: "allow",
      consecutiveAutomatedTurns: 0,
    });
  });

  it("counts automated finishes on the conversation", async () => {
    const conversationId = "agent-dispatch:abc";

    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        maxTurns: 10,
        nowMs: 10,
        source: { kind: "event_task" },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
      shouldPostNotice: false,
    });

    await expect(
      getAutomatedTurnLimitState({ conversationId }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
    });

    await resetAutomatedTurnLimit({ conversationId });
  });

  it("counts resource-event finishes on the conversation", async () => {
    const conversationId = "slack:C3:3.0";
    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        maxTurns: 10,
        nowMs: 1,
        source: {
          kind: "resource_event",
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
      admitAutomatedTurn({ conversationId: first, maxTurns: 3, nowMs: 2_000 }),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      admitAutomatedTurn({
        conversationId: second,
        maxTurns: 3,
        nowMs: 2_001,
      }),
    ).resolves.toEqual({
      status: "allow",
      consecutiveAutomatedTurns: 0,
    });
  });
});
