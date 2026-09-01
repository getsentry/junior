import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitAutomatedTurn,
  buildAutomatedTurnLimitResponse,
  chargeAutomatedTurn,
  getAutomatedTurnLimitRecord,
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
    expect(isAutomatedTurnSource({ kind: "resource_event", eventKey: "e", eventType: "x", identifier: "i", namespace: "n" })).toBe(true);
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

  it("explains the pause without internal jargon", () => {
    const response = buildAutomatedTurnLimitResponse(10);
    expect(response).toContain("paused automated updates after 10 consecutive");
    expect(response).toContain("Send a message or @mention");
    expect(response).not.toContain("circuit");
    expect(response).not.toContain("budget");
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
      await chargeAutomatedTurn({ maxTurns: 3, nowMs: 1_000 + i, scope });
    }

    await expect(
      admitAutomatedTurn({ maxTurns: 3, nowMs: 2_000, scope }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 3,
      shouldPostNotice: true,
    });
    await expect(
      admitAutomatedTurn({ maxTurns: 3, nowMs: 2_001, scope }),
    ).resolves.toEqual({
      status: "paused",
      consecutiveAutomatedTurns: 3,
      shouldPostNotice: false,
    });
    await expect(getAutomatedTurnLimitRecord({ scope })).resolves.toMatchObject({
      consecutiveAutomatedTurns: 3,
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

    await chargeAutomatedTurn({
      maxTurns: 2,
      nowMs: 1,
      scope: { kind: "conversation", conversationId },
    });
    await chargeAutomatedTurn({
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

  it("charges conversation and destination scopes for automated finishes", async () => {
    const conversationId = "agent-dispatch:abc";
    const destination = {
      platform: "slack" as const,
      teamId: "T9",
      channelId: "C9",
    };

    await recordFinishedTurnForAutomatedLimit({
      conversationId,
      destination,
      maxTurns: 10,
      nowMs: 10,
      source: { kind: "event_task" },
    });

    await expect(
      getAutomatedTurnLimitRecord({
        scope: { kind: "conversation", conversationId },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
    });
    await expect(
      getAutomatedTurnLimitRecord({
        scope: { kind: "destination", destination },
      }),
    ).resolves.toMatchObject({
      consecutiveAutomatedTurns: 1,
      paused: false,
    });

    await resetAutomatedTurnLimit({
      scope: { kind: "conversation", conversationId },
    });
  });
});
