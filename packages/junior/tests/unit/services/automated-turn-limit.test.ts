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
      resumeIn: "thread",
    });
    expect(response).toContain(
      "stopped automatic updates after 10 replies without a new message from you",
    );
    expect(response).toContain("Send a message or @mention me in this thread");
    expect(response).not.toContain("event-driven");
    expect(response).not.toContain("resource event");
    expect(response).not.toContain("budget");
    expect(response).not.toContain("circuit");
  });

  it("admits turns until the consecutive limit, then pauses with one notice", async () => {
    const scope = {
      kind: "conversation" as const,
      conversationId: "slack:C1:1.0",
    };

    for (let i = 0; i < 3; i += 1) {
      await expect(
        admitAutomatedTurn({ maxTurns: 3, nowMs: 1_000 + i, scope }),
      ).resolves.toEqual({
        status: "allow",
        consecutiveAutomatedTurns: i,
      });
      await expect(
        countAutomatedTurn({ maxTurns: 3, nowMs: 1_000 + i, scope }),
      ).resolves.toMatchObject({
        consecutiveAutomatedTurns: i + 1,
        paused: i + 1 >= 3,
        shouldPostNotice: i + 1 >= 3,
        resumeIn: "thread",
      });
    }

    await expect(
      admitAutomatedTurn({ maxTurns: 3, nowMs: 2_000, scope }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 3,
      shouldPostNotice: false,
    });
    await expect(getAutomatedTurnLimitState({ scope })).resolves.toMatchObject({
      consecutiveAutomatedTurns: 3,
      paused: true,
      noticePostedAtMs: 1_002,
    });
  });

  it("clears a failed notice claim so a later paused wake can post again", async () => {
    const scope = {
      kind: "conversation" as const,
      conversationId: "slack:C1:notice-claim",
    };

    for (let i = 0; i < 2; i += 1) {
      await countAutomatedTurn({ maxTurns: 2, nowMs: 1_000 + i, scope });
    }

    await expect(getAutomatedTurnLimitState({ scope })).resolves.toMatchObject({
      consecutiveAutomatedTurns: 2,
      paused: true,
      noticePostedAtMs: 1_001,
    });

    await clearAutomatedTurnLimitNoticeClaim({ nowMs: 1_500, scope });

    await expect(getAutomatedTurnLimitState({ scope })).resolves.toEqual({
      consecutiveAutomatedTurns: 2,
      paused: true,
      updatedAtMs: 1_500,
    });

    await expect(
      admitAutomatedTurn({ maxTurns: 2, nowMs: 2_000, scope }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 2,
      shouldPostNotice: true,
    });
    await expect(getAutomatedTurnLimitState({ scope })).resolves.toMatchObject({
      consecutiveAutomatedTurns: 2,
      paused: true,
      noticePostedAtMs: 2_000,
    });
  });

  it("resets after a user turn so later automated wakes can run", async () => {
    const conversationId = "slack:C2:2.0";
    const destination = {
      platform: "slack" as const,
      teamId: "T1",
      channelId: "C2",
    };

    await countAutomatedTurn({
      maxTurns: 2,
      nowMs: 1,
      scope: { kind: "conversation", conversationId },
    });
    await countAutomatedTurn({
      maxTurns: 2,
      nowMs: 2,
      scope: { kind: "destination", destination },
    });

    await recordFinishedTurnForAutomatedLimit({
      conversationId,
      destination,
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
      admitAutomatedTurn({
        maxTurns: 2,
        nowMs: 4,
        scope: { kind: "conversation", conversationId },
      }),
    ).resolves.toEqual({
      status: "allow",
      consecutiveAutomatedTurns: 0,
    });
    await expect(
      admitAutomatedTurn({
        maxTurns: 2,
        nowMs: 5,
        scope: { kind: "destination", destination },
      }),
    ).resolves.toEqual({
      status: "allow",
      consecutiveAutomatedTurns: 0,
    });
  });

  it("counts one matching scope for automated finishes", async () => {
    const conversationId = "agent-dispatch:abc";
    const destination = {
      platform: "slack" as const,
      teamId: "T9",
      channelId: "C9",
    };

    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        destination,
        maxTurns: 10,
        nowMs: 10,
        source: { kind: "event_task" },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
      shouldPostNotice: false,
      resumeIn: "channel",
    });

    await expect(
      getAutomatedTurnLimitState({
        scope: { kind: "conversation", conversationId },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 0,
      paused: false,
    });
    await expect(
      getAutomatedTurnLimitState({
        scope: { kind: "destination", destination },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
    });

    await resetAutomatedTurnLimit({
      scope: { kind: "destination", destination },
    });
  });

  it("counts resource-event finishes on the conversation", async () => {
    const conversationId = "slack:C3:3.0";
    await expect(
      recordFinishedTurnForAutomatedLimit({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T3",
          channelId: "C3",
        },
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
      resumeIn: "thread",
    });
    await expect(
      getAutomatedTurnLimitState({
        scope: { kind: "conversation", conversationId },
      }),
    ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });
  });
});
