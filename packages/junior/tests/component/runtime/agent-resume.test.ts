import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import { RetryableDeliveryError } from "@/chat/agent/request";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import {
  loadTurnCheckpoint,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { CooperativeTurnYieldError } from "@/chat/runtime/turn";
import { botConfig } from "@/chat/config";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import type { PiMessage } from "@/chat/pi/messages";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

function message(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

async function resumeState(conversationId: string, turnId: string) {
  const checkpoint = await loadTurnCheckpoint({ conversationId, turnId });
  return {
    boundary: checkpoint.record?.piMessages ?? [],
    resume: createResumeState({
      destination: { platform: "local", conversationId },
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
    }),
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
    const resume = createResumeState({
      destination: { platform: "local", conversationId },
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
      checkpoint: await loadTurnCheckpoint({ conversationId, turnId }),
      startedAtMs: Date.now(),
      surface: "internal",
    });

    await expect(
      resume.parkForAuth(
        new AuthorizationPauseError("mcp", "example", "Example", "link_sent"),
      ),
    ).rejects.toEqual(expect.any(Error));
    await expect(
      getTurnRecord(conversationId, turnId),
    ).resolves.toBeUndefined();
  });

  it("preserves the execution-limit error while parking for auth", async () => {
    const conversationId = "local:test:auth-slice-limit";
    const turnId = "turn-auth-slice-limit";
    await saveTurnCheckpoint({
      mode: "paused",
      reason: "auth",
      conversationId,
      turnId,
      sliceId: botConfig.maxSlicesPerTurn - 1,
      modelId: "test/model",
      messages: [message("authorize")],
      surface: "internal",
    });
    const { resume } = await resumeState(conversationId, turnId);

    await expect(
      resume.parkForAuth(
        new AuthorizationPauseError("mcp", "example", "Example", "link_sent"),
      ),
    ).rejects.toBeInstanceOf(TurnSliceLimitExceededError);
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "failed",
      errorMessage: expect.stringContaining("execution limit"),
    });
  });

  it.each([
    ["timeout", new Error("slice timed out"), false],
    ["yield", new CooperativeTurnYieldError(), false],
    ["retry", new RetryableDeliveryError("still stuck"), true],
  ] as const)(
    "fails closed when %s repeats a boundary",
    async (reason, error, writeRunning) => {
      const conversationId = `local:test:no-progress-${reason}`;
      const turnId = `turn-no-progress-${reason}`;
      const boundary = [message(`stuck ${reason}`)];
      await saveTurnCheckpoint({
        mode: "paused",
        reason,
        conversationId,
        turnId,
        sliceId: 2,
        modelId: "test/model",
        messages: boundary,
        surface: "internal",
        errorMessage: String(error),
      });

      const { boundary: storedBoundary, resume } = await resumeState(
        conversationId,
        turnId,
      );
      resume.captureResumeSnapshot(storedBoundary);
      const runningWrite = writeRunning
        ? await resume.persistSafeBoundary(storedBoundary)
        : undefined;
      expect(runningWrite).toBe(writeRunning ? true : undefined);
      if (reason === "timeout") resume.markTimedOut();

      await expect(resume.translateSuspension({ error })).rejects.toThrow(
        /Turn made no progress/,
      );
      await expect(
        getTurnRecord(conversationId, turnId),
      ).resolves.toMatchObject({
        state: "failed",
        errorMessage: expect.stringContaining("made no progress"),
      });
    },
  );
});
