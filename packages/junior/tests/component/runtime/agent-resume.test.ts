import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import {
  loadTurnCheckpoint,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
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
      recordActiveMcpProviders: async () => undefined,
      replyDelivery: "destination",
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
      recordActiveMcpProviders: async () => {
        throw new Error("provider metadata unavailable");
      },
      replyDelivery: "destination",
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
});
