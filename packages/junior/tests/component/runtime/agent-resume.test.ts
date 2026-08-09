import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import { RetryableDeliveryError } from "@/chat/agent/request";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import {
  loadTurnCheckpoint,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getAgentTurnSessionRecord } from "@/chat/task-execution/turn-cursor";
import type { PiMessage } from "@/chat/pi/messages";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

function userMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

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
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => {
        throw new Error("provider metadata unavailable");
      },
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      checkpoint: await loadTurnCheckpoint({
        conversationId,
        turnId,
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

  it("fails closed when timeout parks again at the resumed boundary", async () => {
    const conversationId = "local:test:no-progress-timeout";
    const turnId = "turn-no-progress-timeout";
    const destination = { platform: "local" as const, conversationId };

    await saveTurnCheckpoint({
      mode: "paused",
      reason: "timeout",
      conversationId,
      turnId,
      sliceId: 2,
      modelId: "test/model",
      messages: [userMessage("keep going", 1)],
      surface: "internal",
      errorMessage: "timed out",
    });

    const checkpoint = await loadTurnCheckpoint({ conversationId, turnId });
    const boundary = checkpoint.record?.piMessages ?? [];
    expect(boundary.length).toBeGreaterThan(0);

    const resume = createResumeState({
      destination,
      durability: {},
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => undefined,
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      checkpoint,
      startedAtMs: Date.now(),
      surface: "internal",
    });

    // Same parked boundary the continue slice resumed from.
    resume.captureResumeSnapshot(boundary);
    resume.markTimedOut();

    await expect(
      resume.translateSuspension({
        error: new Error("slice timed out"),
      }),
    ).rejects.toThrow(/Turn made no progress/);

    await expect(
      getAgentTurnSessionRecord(conversationId, turnId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Turn made no progress: continue parked at the same boundary",
    });
  });

  it("still fails closed after a same-boundary running write", async () => {
    const conversationId = "local:test:no-progress-same-running";
    const turnId = "turn-no-progress-same-running";
    const destination = { platform: "local" as const, conversationId };

    await saveTurnCheckpoint({
      mode: "paused",
      reason: "retry",
      conversationId,
      turnId,
      sliceId: 3,
      modelId: "test/model",
      messages: [userMessage("retry me", 2)],
      surface: "internal",
      errorMessage: "delivery retry",
    });

    const checkpoint = await loadTurnCheckpoint({ conversationId, turnId });
    const boundary = checkpoint.record?.piMessages ?? [];
    expect(boundary.length).toBeGreaterThan(0);

    const resume = createResumeState({
      destination,
      durability: {},
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => undefined,
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      checkpoint,
      startedAtMs: Date.now(),
      surface: "internal",
    });

    // Persist the exact resumed boundary again. That is not progress.
    await expect(resume.persistSafeBoundary(boundary)).resolves.toBe(true);

    await expect(
      resume.translateSuspension({
        error: new RetryableDeliveryError("still stuck"),
      }),
    ).rejects.toThrow(/Turn made no progress/);

    await expect(
      getAgentTurnSessionRecord(conversationId, turnId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Turn made no progress: continue parked at the same boundary",
    });
  });
});
