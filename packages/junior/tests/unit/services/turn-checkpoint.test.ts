import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

let disconnectStateAdapter: typeof import("@/chat/state/adapter").disconnectStateAdapter;
let getAgentTurnSessionCheckpoint: typeof import("@/chat/state/turn-session-store").getAgentTurnSessionCheckpoint;
let upsertAgentTurnSessionCheckpoint: typeof import("@/chat/state/turn-session-store").upsertAgentTurnSessionCheckpoint;
let persistAuthPauseCheckpoint: typeof import("@/chat/services/turn-checkpoint").persistAuthPauseCheckpoint;

describe("persistAuthPauseCheckpoint", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    vi.resetModules();

    const stateAdapterModule = await import("@/chat/state/adapter");
    disconnectStateAdapter = stateAdapterModule.disconnectStateAdapter;
    await disconnectStateAdapter();

    const turnSessionStoreModule =
      await import("@/chat/state/turn-session-store");
    getAgentTurnSessionCheckpoint =
      turnSessionStoreModule.getAgentTurnSessionCheckpoint;
    upsertAgentTurnSessionCheckpoint =
      turnSessionStoreModule.upsertAgentTurnSessionCheckpoint;

    ({ persistAuthPauseCheckpoint } =
      await import("@/chat/services/turn-checkpoint"));
  });

  afterEach(async () => {
    await disconnectStateAdapter?.();
    delete process.env.JUNIOR_STATE_ADAPTER;
    vi.resetModules();
  });

  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const priorMessages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        api: "responses",
        provider: "openai",
        model: "gpt-5.3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        timestamp: 2,
        stopReason: "toolUse",
      },
    ];

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
      errorMessage: "initial auth pause",
    });

    const nextSliceId = await persistAuthPauseCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      loadedSkillNames: ["demo-skill"],
      errorMessage: "plugin auth pause",
      logContext: {
        modelId: "test-model",
      },
    });

    expect(nextSliceId).toBe(2);

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
      errorMessage: "plugin auth pause",
      piMessages: [priorMessages[0]],
    });
  });
});
