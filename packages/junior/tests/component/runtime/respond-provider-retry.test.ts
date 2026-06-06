import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import { createJuniorReporting } from "@/reporting";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  createScriptedReplyAgentFactory,
  type ScriptedReplyAgent,
} from "../../fixtures/respond-agent";
import {
  configureRespondRuntimeEnv,
  restoreRespondRuntimeEnv,
} from "../../fixtures/respond-env";
import { mockTestClock } from "../../fixtures/vitest";

const originalEnv = configureRespondRuntimeEnv();
const { generateAssistantReply } = await import("@/chat/respond");
const { isCooperativeTurnYieldError } = await import("@/chat/runtime/turn");
const { getAwaitingAgentContinueRequest } =
  await import("@/chat/services/agent-continue");
const { disconnectStateAdapter } = await import("@/chat/state/adapter");
const turnSessionState = await import("@/chat/state/turn-session");

type AgentMode =
  | "providerRetry"
  | "cooperativeYield"
  | "steering"
  | "steeringSteerThrows";

const agentMode: { value: AgentMode } = {
  value: "providerRetry",
};
const counters = {
  continueCalls: 0,
  promptCalls: 0,
};
const turnThinkingSelection = {
  thinkingLevel: "medium",
  confidence: 1,
  reason: "test",
} satisfies TurnThinkingSelection;

const agentFactory = createScriptedReplyAgentFactory({
  async continue(agent) {
    counters.continueCalls += 1;
    agent.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Recovered." }],
      stopReason: "stop",
      usage: {
        input: 2,
        output: 2,
      },
    } as PiMessage);
    return {};
  },
  async prompt(agent, message) {
    counters.promptCalls += 1;
    agent.state.messages.push(message as PiMessage);
    if (
      agentMode.value === "cooperativeYield" ||
      agentMode.value === "steering" ||
      agentMode.value === "steeringSteerThrows"
    ) {
      await agent.prepareNextTurn?.();
      agent.state.messages.push(...agent.steeringMessages);
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Steered." }],
        stopReason: "stop",
        usage: {
          input: 2,
          output: 2,
        },
      } as PiMessage);
      return {};
    }
    agent.state.messages.push({
      role: "toolResult",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "ok" }],
    } as PiMessage);
    agent.state.messages.push({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Anthropic stream ended before message_stop",
      usage: {
        input: 10,
        output: 1,
      },
    } as unknown as PiMessage);
    return {};
  },
  steer(agent: ScriptedReplyAgent, message: unknown) {
    if (agentMode.value === "steeringSteerThrows") {
      throw new Error("steer failed");
    }
    agent.steeringMessages.push(message as PiMessage);
  },
});

async function generateReply(
  message: string,
  options: Parameters<typeof generateAssistantReply>[1] = {},
) {
  const { destination, harness, requester, ...restOptions } = options;
  return await generateAssistantReply(message, {
    destination: destination ?? TEST_DESTINATION,
    requester: requester ? { ...TEST_REQUESTER, ...requester } : TEST_REQUESTER,
    ...restOptions,
    harness: {
      agentFactory,
      turnThinkingSelection,
      ...harness,
    },
  });
}

const TEST_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;
const TEST_REQUESTER = {
  platform: "slack",
  teamId: TEST_DESTINATION.teamId,
  userId: "U123",
} as const;

describe("generateAssistantReply provider retry", () => {
  afterAll(() => {
    restoreRespondRuntimeEnv(originalEnv);
  });

  beforeEach(async () => {
    agentMode.value = "providerRetry";
    counters.continueCalls = 0;
    counters.promptCalls = 0;
    await disconnectStateAdapter();
    mockTestClock();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("continues from the last safe boundary after a transient provider stream error", async () => {
    const replyPromise = generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    });

    await vi.waitFor(() => {
      expect(counters.promptCalls).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const reply = await replyPromise;

    expect(reply.text).toBe("Recovered.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.toolResultCount).toBe(1);
    expect(reply.diagnostics.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(counters.promptCalls).toBe(1);
    expect(counters.continueCalls).toBe(1);

    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord?.state).toBe("completed");
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
  });

  it("persists and queues steering messages at the next Pi boundary", async () => {
    agentMode.value = "steering";
    const injectedTexts: string[] = [];
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "previous question" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "previous answer" }],
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
        stopReason: "stop",
        timestamp: 2,
      },
    ] satisfies PiMessage[];

    const reply = await generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "slack:C123:1712345.0001",
        turnId: "turn-steering",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
      piMessages: priorMessages,
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
        ];
        await inject(messages);
        injectedTexts.push(...messages.map((message) => message.text));
        return messages;
      },
    });

    expect(reply.text).toBe("Steered.");
    expect(injectedTexts).toEqual(["actually do the other thing"]);

    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "slack:C123:1712345.0001",
      "turn-steering",
    );
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("previous question");
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");

    const report = await createJuniorReporting().getConversation(
      "slack:C123:1712345.0001",
    );
    const transcript = report.runs[0]?.transcript ?? [];
    expect(JSON.stringify(transcript)).not.toContain("previous question");
    expect(transcript).toHaveLength(3);
    expect(transcript[0]).toMatchObject({
      role: "user",
      timestamp: expect.any(Number),
      parts: expect.arrayContaining([{ type: "text", text: "help me" }]),
    });
    expect(transcript[1]).toEqual({
      role: "user",
      timestamp: 2_000,
      parts: [{ type: "text", text: "actually do the other thing" }],
    });
    expect(transcript[2]).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "Steered." }],
    });
  });

  it("parks the turn when the worker asks to yield at a Pi boundary", async () => {
    agentMode.value = "cooperativeYield";

    const error = await generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-yield",
        turnId: "turn-yield",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
      shouldYield: () => true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isCooperativeTurnYieldError(error)).toBe(true);
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-yield",
      "turn-yield",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "yield",
      errorMessage: expect.stringContaining(
        "Agent turn yielded at a safe boundary",
      ),
      sliceId: 1,
    });
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
    ]);
    await expect(
      getAwaitingAgentContinueRequest({
        conversationId: "conversation-yield",
        sessionId: "turn-yield",
      }),
    ).resolves.toMatchObject({
      conversationId: "conversation-yield",
      destination: TEST_DESTINATION,
      sessionId: "turn-yield",
      expectedVersion: sessionRecord?.version,
    });
  });

  it("keeps steered messages when yielding after steering drain", async () => {
    agentMode.value = "cooperativeYield";

    const error = await generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-yield-steering",
        turnId: "turn-yield-steering",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
      destination: TEST_DESTINATION,
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
        ];
        await inject(messages);
        return messages;
      },
      shouldYield: () => true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isCooperativeTurnYieldError(error)).toBe(true);
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-yield-steering",
      "turn-yield-steering",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "yield",
      errorMessage: expect.stringContaining(
        "Agent turn yielded at a safe boundary",
      ),
      sliceId: 1,
    });
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");
  });

  it("rejects steering injection when Pi steer fails", async () => {
    agentMode.value = "steeringSteerThrows";
    let injectRejected = false;
    let injectCompleted = false;

    await generateReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-steering-failure",
        turnId: "turn-steering-failure",
        channelId: "C123",
        threadTs: "1712345.0002",
      },
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
        ];
        try {
          await inject(messages);
          injectCompleted = true;
          return messages;
        } catch {
          injectRejected = true;
          throw new Error("inject rejected");
        }
      },
    });

    expect(injectRejected).toBe(true);
    expect(injectCompleted).toBe(false);
  });
});
