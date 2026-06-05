import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  configureRespondRuntimeEnv,
  restoreRespondRuntimeEnv,
} from "../../fixtures/respond-env";
import { createScriptedReplyAgentFactory } from "../../fixtures/respond-agent";

const originalEnv = configureRespondRuntimeEnv();
const { generateAssistantReply } = await import("@/chat/respond");
const { isRetryableTurnError, isTurnInputCommitLostError } =
  await import("@/chat/runtime/turn");
const { AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES } =
  await import("@/chat/services/turn-session-record");
const { disconnectStateAdapter } = await import("@/chat/state/adapter");
const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
  await import("@/chat/state/turn-session");

type PromptMode =
  | "settlesAfterAbort"
  | "hangsAfterAbort"
  | "continueSettlesAfterAbort"
  | "providerRetryThenHangs";

const promptAborted = { value: false };
const promptMode: { value: PromptMode } = {
  value: "settlesAfterAbort",
};
let resolveAbort: (() => void) | undefined;
const turnThinkingSelection = {
  thinkingLevel: "medium",
  confidence: 1,
  reason: "test",
} satisfies TurnThinkingSelection;

const agentFactory = createScriptedReplyAgentFactory({
  abort() {
    promptAborted.value = true;
    resolveAbort?.();
  },
  async continue(agent) {
    if (promptMode.value === "continueSettlesAfterAbort") {
      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "continued partial" }],
      } as PiMessage);
      return {};
    }
    if (promptMode.value === "providerRetryThenHangs") {
      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "continued partial" }],
        stopReason: "stop",
      } as PiMessage);
      return {};
    }

    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "continued" }],
      stopReason: "stop",
    } as PiMessage);
    return {};
  },
  async prompt(agent, message) {
    agent.state.messages.push(message as PiMessage);
    if (promptMode.value === "providerRetryThenHangs") {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "provider error" }],
        stopReason: "error",
        errorMessage: "Provider returned error: 503 service unavailable",
      } as PiMessage);
      return {};
    }
    if (promptMode.value === "hangsAfterAbort") {
      await new Promise(() => undefined);
      return {};
    }
    await new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    } as PiMessage);
    return {};
  },
});

async function generateReply(
  message: string,
  options: Parameters<typeof generateAssistantReply>[1] = {},
) {
  return await generateAssistantReply(message, {
    agentFactory,
    turnThinkingSelection,
    ...options,
  });
}

describe("generateAssistantReply timeout resume", () => {
  beforeEach(async () => {
    promptAborted.value = false;
    promptMode.value = "settlesAfterAbort";
    resolveAbort = undefined;
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  afterAll(() => {
    restoreRespondRuntimeEnv(originalEnv);
  });

  it("rejects durable input when no prompt checkpoint can be persisted", async () => {
    const onInputCommitted = vi.fn();

    const error = await generateReply("help me", {
      onInputCommitted,
    }).catch((caught) => caught);

    expect(isTurnInputCommitLostError(error)).toBe(true);
    expect(onInputCommitted).not.toHaveBeenCalled();
  });

  it("stores the last safe boundary and throws a retryable timeout error", async () => {
    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    expect(error.metadata).toMatchObject({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      version: expect.any(Number),
      sliceId: 2,
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("throws terminal timeout failures instead of returning an error reply after the slice cap", async () => {
    promptMode.value = "continueSettlesAfterAbort";
    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      } as PiMessage,
    ];
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-timeout-cap",
      sessionId: "turn-timeout-cap",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      state: "awaiting_resume",
      piMessages,
      resumeReason: "timeout",
    });

    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-timeout-cap",
        turnId: "turn-timeout-cap",
        channelId: "C123",
        threadTs: "1712345.0006",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("text");
    expect(isRetryableTurnError(error, "agent_continue")).toBe(false);
    expect(error.message).toContain("slice limit");

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-timeout-cap",
      "turn-timeout-cap",
    );
    expect(sessionRecord).toMatchObject({
      state: "failed",
      resumeReason: "timeout",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      errorMessage: expect.stringContaining("slice limit"),
    });
  });

  it("records the effective request deadline timeout budget", async () => {
    const startedAtMs = Date.now();
    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      turnDeadlineAtMs: startedAtMs + 2_500,
      correlation: {
        conversationId: "conversation-short-deadline",
        turnId: "turn-short-deadline",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(2_500);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-short-deadline",
      "turn-short-deadline",
    );
    expect(sessionRecord?.errorMessage).toBe(
      "Agent turn timed out after 2500ms",
    );
  });

  it("persists omitted-image context in the session-recorded Pi user message", async () => {
    const replyPromise = generateReply("what is in this image?", {
      requester: { userId: "U123" },
      omittedImageAttachmentCount: 1,
      correlation: {
        conversationId: "conversation-2",
        turnId: "turn-2",
        channelId: "C123",
        threadTs: "1712345.0002",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    await replyPromise;

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-2",
      "turn-2",
    );
    const userMessage = sessionRecord?.piMessages[0] as
      | {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        }
      | undefined;

    expect(userMessage?.role).toBe("user");
    expect(userMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("<omitted-image-attachments>"),
        }),
      ]),
    );
  });

  it("persists agent continuation state when abort does not settle the agent run", async () => {
    promptMode.value = "hangsAfterAbort";
    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-hung",
        turnId: "turn-hung",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(15_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    expect(error.metadata).toMatchObject({
      conversationId: "conversation-hung",
      sessionId: "turn-hung",
      version: expect.any(Number),
      sliceId: 2,
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-hung",
      "turn-hung",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("uses one wall-clock timeout budget across provider retries", async () => {
    promptMode.value = "providerRetryThenHangs";
    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-retry",
        turnId: "turn-retry",
        channelId: "C123",
        threadTs: "1712345.0004",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-retry",
      "turn-retry",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });
});
