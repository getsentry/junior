import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
} from "@/chat/repository-instructions";

function asPiMessage(value: unknown): PiMessage {
  return value as PiMessage;
}

const ORIGINAL_ENV = { ...process.env };

function user(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistant(text: string, timestamp = 1): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content
      ?.map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

describe("context compaction retained messages", () => {
  it("derives automatic trigger size from the model context window", async () => {
    const {
      calculateContextCompactionTargetTokens,
      calculateContextCompactionTriggerTokens,
      calculateContextInputLimitTokens,
    } = await import("@/chat/services/context-budget");

    const miniTrigger = calculateContextCompactionTriggerTokens({
      contextWindow: 400_000,
    });
    expect(miniTrigger).toBe(360_000);
    expect(calculateContextInputLimitTokens({ contextWindow: 400_000 })).toBe(
      380_000,
    );
    expect(calculateContextCompactionTargetTokens(miniTrigger)).toBe(288_000);
    expect(
      calculateContextCompactionTriggerTokens({
        contextWindow: 1_050_000,
      }),
    ).toBe(945_000);
  });

  it("uses configured model context windows for runtime thresholds", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL: "openai/gpt-5.4",
      AI_FAST_MODEL: "openai/gpt-5.4-mini",
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "200000",
    };
    vi.resetModules();
    try {
      const {
        calculateContextCompactionTriggerTokens,
        getAgentContextCompactionTriggerTokens,
        getConversationContextCompactionTriggerTokens,
        getModelContextBudget,
      } = await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(getAgentContextCompactionTriggerTokens("openai/gpt-5.4")).toBe(
        180_000,
      );
      expect(getModelContextBudget("openai/gpt-5.4")).toMatchObject({
        contextWindow: 200_000,
      });
      expect(getConversationContextCompactionTriggerTokens()).toBe(
        calculateContextCompactionTriggerTokens({
          ...resolveGatewayModel("openai/gpt-5.4-mini"),
          contextWindow: 200_000,
        }),
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("never raises an active model's advertised context window", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "900000",
    };
    vi.resetModules();
    try {
      const { getModelContextBudget } =
        await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");
      const model = resolveGatewayModel("anthropic/claude-haiku-4.5");

      expect(getModelContextBudget(model.id).contextWindow).toBe(
        model.contextWindow,
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("keeps newest eligible user messages in chronological order", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages(
      [
        user("older message that should not fit", 1),
        user("middle", 2),
        assistant("assistant reply", 3),
        user("<data_base64>raw-payload</data_base64>", 4),
        user("recent", 5),
      ],
      4,
    );

    expect(retained.map(textOf)).toEqual(["middle", "recent"]);
  });

  it("strips stale runtime context before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
          },
          { type: "text", text: "actual user request" },
        ],
        timestamp: 1,
      } as PiMessage,
    ]);

    expect(retained.map(textOf)).toEqual(["actual user request"]);
  });

  it("unwraps current instruction markers before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        "<current-instruction>\nuse &lt;tag&gt; literally\n</current-instruction>",
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["use <tag> literally"]);
  });

  it("unwraps current instruction markers from composite prompt text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        [
          "<thread-background>",
          "prior context",
          "</thread-background>",
          "",
          "<current-instruction>",
          "actual follow-up",
          "</current-instruction>",
        ].join("\n"),
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["actual follow-up"]);
  });
});

describe("context compaction projection reset", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("compares repeated commits in their durable JSON form", async () => {
    const { commitMessages, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-json-normalization";
    const priorMessages = [
      user("Run the lookup.", 1),
      (() => {
                return asPiMessage({
          ...assistant("Lookup complete.", 2),
          responseId: undefined,
          usage: { input: 5, cached: undefined },
        });
      })(),
    ];

    const firstCommit = await commitMessages({
      conversationId,
      messages: priorMessages,
    });
    await expect(
      commitMessages({
        conversationId,
        messages: [...priorMessages, user("What did it find?", 3)],
      }),
    ).resolves.toMatchObject({ committedSeq: 2 });

    expect(firstCommit.messages[1]).toEqual({
      ...assistant("Lookup complete.", 2),
      usage: { input: 5 },
    });
    await expect(loadProjection({ conversationId })).resolves.toHaveLength(3);
  });

  it("automatic compaction replaces the conversation projection without a synthetic session", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");

    const priorMessages = [
      user("Please remember the deploy blocker.", 1),
      assistant("The blocker is missing migration approval.", 2),
    ];
    await commitMessages({
      conversationId: "conversation-1",
      messages: priorMessages,
      newMessageProvenance: {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
          userName: "alice",
          fullName: "Alice Example",
          email: "alice@sentry.io",
        },
      },
    });
    const conversation = coerceThreadConversationState({});

    const compactor = createContextCompactor({
      completeText: async () =>
        ({
          text: "Outstanding ask: continue tracking migration approval.",
        }) as never,
      autoCompactionTriggerTokens: 0,
    });

    const result = await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-1",
      modelId: "openai/gpt-5.4",
      piMessages: priorMessages,
    });

    expect(result.compacted).toBe(true);
    expect(result).not.toHaveProperty("sessionId");
    const compactedMessages = result.piMessages ?? [];
    expect(compactedMessages.map(textOf).join("\n")).toContain(
      "Context compaction summary",
    );
    expect(compactedMessages.map(textOf).join("\n")).toContain(
      "migration approval",
    );
    await expect(
      loadProjection({ conversationId: "conversation-1" }),
    ).resolves.toEqual(compactedMessages);
    const projection = await loadConversationProjection({
      conversationId: "conversation-1",
    });
    expect(projection.messages).toEqual(compactedMessages);
    const instructionActor = projection.provenance
      .filter((entry) => entry.authority === "instruction" && entry.actor)
      .at(-1)?.actor;
    expect(instructionActor).toMatchObject({
      platform: "slack",
      teamId: "T123",
      userId: "U123",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
  });

  it("counts retained runtime context in the replacement hard limit", async () => {
    const { compactActiveContextIfNeeded, ContextInputLimitExceededError } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-active-pending-hard-limit";
    const original = [user("Keep this committed history.", 1)];
    await commitMessages({ conversationId, messages: original });

    await expect(
      compactActiveContextIfNeeded(
        {
          conversationId,
          modelId: "openai/gpt-5.4",
          modelProfile: "standard",
          pendingMessages: [
            {
              message: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<runtime-turn-context>\n${"y".repeat(1_600_000)}\n</runtime-turn-context>`,
                  },
                  {
                    type: "text",
                    text: "<current-instruction>\nRetain exactly.\n</current-instruction>",
                  },
                ],
                timestamp: 3,
              } as PiMessage,
              provenance: { authority: "instruction" },
            },
          ],
          piMessages: [
            ...original,
            {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "oversized",
              content: [{ type: "text", text: "x".repeat(1_600_000) }],
              isError: false,
              timestamp: 2,
            } as PiMessage,
          ],
        },
        {
          completeText: async () => ({ text: "Short summary." }) as never,
        },
      ),
    ).rejects.toBeInstanceOf(ContextInputLimitExceededError);
    await expect(loadProjection({ conversationId })).resolves.toEqual(original);
  });

  it("retains split host context during active compaction", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const conversationId = "conversation-active-split-context";
    const timestamp = 3;
    const contextMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<runtime-turn-context>\nRuntime facts\n</runtime-turn-context>",
        },
        {
          type: "text",
          text: "<skill>\nUse the repository formatter.\n</skill>",
        },
        {
          type: "text",
          text: "<thread-background>\nKeep the API stable.\n</thread-background>",
        },
        {
          type: "text",
          text: "# AGENTS.md instructions for /vercel/sandbox/repo\n\n<INSTRUCTIONS>\nUse the old formatter.\n</INSTRUCTIONS>",
        },
      ],
      timestamp,
    } as PiMessage;
    const instruction = user(
      "<current-instruction>\nImplement the change.\n</current-instruction>",
      timestamp,
    );
    const agents = buildAgentsInstructionsMessage({
      directory: "/vercel/sandbox/repo",
      text: `${AGENTS_REPLACEMENT_NOTICE}\n\nUse the new formatter.`,
      timestamp: 4,
    });

    const result = await compactActiveContextIfNeeded(
      {
        conversationId,
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        pendingMessages: [
          { message: instruction, provenance: { authority: "instruction" } },
        ],
        piMessages: [
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "oversized",
            content: [{ type: "text", text: "x".repeat(1_600_000) }],
            isError: false,
            timestamp: 2,
          } as PiMessage,
          contextMessage,
        ],
        runtimeContextMessages: [contextMessage, instruction, agents],
      },
      {
        completeText: async () => ({ text: "Short summary." }) as never,
      },
    );

    expect(result.compacted).toBe(true);
    expect(result.piMessages?.map(textOf)).toEqual([
      expect.stringContaining("<runtime-turn-context>"),
      expect.stringContaining("<current-instruction>"),
      expect.stringContaining("Short summary."),
    ]);
    expect(textOf(result.piMessages![0]!)).toContain(
      "Use the repository formatter.",
    );
    expect(textOf(result.piMessages![0]!)).toContain("Keep the API stable.");
    expect(textOf(result.piMessages![0]!)).toContain("Use the new formatter.");
    expect(textOf(result.piMessages![0]!)).not.toContain(
      "Use the old formatter.",
    );
    expect(textOf(result.piMessages![0]!)).not.toContain(
      AGENTS_REPLACEMENT_NOTICE,
    );
  });

  it("blocks the next provider request when hard-limit compaction fails", async () => {
    const { compactActiveContextIfNeeded, ContextInputLimitExceededError } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-active-hard-limit";
    const original = [user("Keep this committed history.", 1)];
    await commitMessages({ conversationId, messages: original });

    await expect(
      compactActiveContextIfNeeded(
        {
          conversationId,
          modelId: "openai/gpt-5.4",
          modelProfile: "standard",
          piMessages: [
            ...original,
            {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "oversized",
              content: [{ type: "text", text: "x".repeat(1_600_000) }],
              isError: false,
              timestamp: 2,
            } as PiMessage,
          ],
        },
        {
          completeText: async () => {
            throw new Error("summary provider unavailable");
          },
        },
      ),
    ).rejects.toBeInstanceOf(ContextInputLimitExceededError);
    await expect(loadProjection({ conversationId })).resolves.toEqual(original);
  });

  it("handoff binds its named profile and later projection replacements inherit it", async () => {
    const { compactContextForHandoff, createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { getConversationEventStore } = await import("@/chat/db");
    const { botConfig } = await import("@/chat/config");
    const conversationId = "conversation-handoff";
    const priorMessages = [
      user("Implement the multi-file change.", 1),
      assistant("I found the affected modules.", 2),
    ];
    await commitMessages({
      conversationId,
      messages: priorMessages,
    });

    const runtimeContext = [
      user(
        "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
        3,
      ),
    ];
    const handoffMessages = await compactContextForHandoff(
      {
        conversationId,
        piMessages: priorMessages,
        runtimeContext,
        triggeringToolCallId: "handoff-call-1",
        target: {
          modelId: botConfig.profiles.handoff!.modelId,
          modelProfile: "handoff",
        },
      },
      {
        completeText: async () =>
          ({ text: "Continue the multi-file implementation." }) as never,
      },
    );

    expect(handoffMessages).toHaveLength(2);
    expect(textOf(handoffMessages[0]!)).toContain(
      "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
    );
    expect(textOf(handoffMessages[0]!)).not.toContain("<current-instruction>");
    expect(textOf(handoffMessages[1]!)).toContain(
      "<current-instruction>\nModel handoff checkpoint.",
    );
    expect(textOf(handoffMessages[1]!)).toContain(
      "Continue the outstanding request now",
    );
    expect(textOf(handoffMessages[1]!)).toContain(
      "Continue the multi-file implementation.",
    );
    const durableHandoffMessages = [
      user(
        "<current-instruction>\nModel handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\nContinue the multi-file implementation.\n</current-instruction>",
        3,
      ),
    ];
    await expect(loadProjection({ conversationId })).resolves.toEqual(
      durableHandoffMessages,
    );
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const marker = (
      await getConversationEventStore().loadHistory(conversationId)
    )
      .map((event) => event.data)
      .find((entry) => entry.type === "handoff");
    expect(marker).toEqual({
      type: "handoff",
      modelProfile: "handoff",
      modelId: botConfig.profiles.handoff!.modelId,
      triggeringToolCallId: "handoff-call-1",
      summary: "Continue the multi-file implementation.",
      replacementHistory: [
        {
          item: {
            type: "user_message",
            content: (
              durableHandoffMessages[0] as {
                content: unknown[];
              }
            ).content,
            timestamp: 3,
            provenance: { authority: "context" },
          },
        },
      ],
    });

    const compactor = createContextCompactor({
      completeText: async () =>
        ({ text: "Continue the handed-off implementation." }) as never,
      autoCompactionTriggerTokens: 0,
    });
    const compacted = await compactor.maybeCompact({
      conversation: coerceThreadConversationState({}),
      conversationId,
      modelId: botConfig.profiles.handoff!.modelId,
      piMessages: handoffMessages,
    });
    expect(compacted.compacted).toBe(true);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");

    await expect(
      commitMessages({
        conversationId,
        messages: [user("Replacement safe boundary.", 3)],
      }),
    ).rejects.toThrow("changed before its committed boundary");
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const replacements = (
      await getConversationEventStore().loadHistory(conversationId)
    )
      .map((event) => event.data)
      .filter(
        (entry) => entry.type === "handoff" || entry.type === "compaction",
      );
    expect(
      replacements.map(({ type, modelProfile, modelId, summary }) => ({
        type,
        modelProfile,
        modelId,
        summary,
      })),
    ).toEqual([
      {
        type: "handoff",
        modelProfile: "handoff",
        modelId: botConfig.profiles.handoff!.modelId,
        summary: "Continue the multi-file implementation.",
      },
      {
        type: "compaction",
        modelProfile: "handoff",
        modelId: botConfig.profiles.handoff!.modelId,
        summary: "Continue the handed-off implementation.",
      },
    ]);
  });

  it("leaves the standard projection untouched when handoff summarization fails", async () => {
    const { compactContextForHandoff } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-failed-handoff";
    const priorMessages = [user("Implement the change.", 1)];
    await commitMessages({
      conversationId,
      messages: priorMessages,
    });

    await expect(
      compactContextForHandoff(
        {
          conversationId,
          piMessages: priorMessages,
          runtimeContext: [
            user(
              "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
            ),
          ],
          triggeringToolCallId: "failed-handoff-call",
          target: {
            modelId: "test/handoff",
            modelProfile: "handoff",
          },
        },
        {
          completeText: async () => {
            throw new Error("summary unavailable");
          },
        },
      ),
    ).rejects.toThrow("summary unavailable");
    await expect(loadProjection({ conversationId })).resolves.toEqual(
      priorMessages,
    );
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("standard");
  });

  it("uses the latest runtime context and supports AGENTS-only context", async () => {
    const { compactContextForHandoff } =
      await import("@/chat/services/context-compaction");
    const completeText = async () => ({ text: "Continue safely." }) as never;
    const target = {
      modelId: "test/handoff",
      modelProfile: "handoff" as const,
    };

    const agents = buildAgentsInstructionsMessage({
      directory: "/vercel/sandbox/repo",
      text: "Use pnpm.",
      timestamp: 3,
    });
    const messages = await compactContextForHandoff(
      {
        conversationId: "conversation-latest-runtime-context",
        piMessages: [user("Implement the change.")],
        runtimeContext: [
          user(
            "<runtime-turn-context>\nStale runtime context\n</runtime-turn-context>",
          ),
          user(
            "<runtime-turn-context>\nCurrent runtime context\n</runtime-turn-context>",
          ),
          agents,
        ],
        triggeringToolCallId: "latest-context-handoff-call",
        target,
      },
      { completeText },
    );

    expect(messages).toHaveLength(2);
    expect(textOf(messages[0]!)).toContain("Current runtime context");
    expect(textOf(messages[0]!)).toContain("Use pnpm.");
    expect(textOf(messages[0]!)).not.toContain("Stale runtime context");
    expect(textOf(messages[1]!)).toContain("<current-instruction>");

    const agentsOnlyMessages = await compactContextForHandoff(
      {
        conversationId: "conversation-agents-only-runtime-context",
        piMessages: [user("Implement the change.")],
        runtimeContext: [agents],
        triggeringToolCallId: "agents-only-context-handoff-call",
        target,
      },
      { completeText },
    );
    expect(agentsOnlyMessages).toHaveLength(2);
    expect(textOf(agentsOnlyMessages[0]!)).toContain("Use pnpm.");
    expect(textOf(agentsOnlyMessages[1]!)).toContain("<current-instruction>");

    await expect(
      compactContextForHandoff(
        {
          conversationId: "conversation-missing-runtime-context",
          piMessages: [user("Implement the change.")],
          runtimeContext: [],
          triggeringToolCallId: "missing-context-handoff-call",
          target,
        },
        { completeText },
      ),
    ).rejects.toThrow("Handoff requires the current runtime turn context");
  });

  it("does not start handoff persistence when abort is observed after summarization", async () => {
    const { compactContextForHandoff } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-aborted-handoff";
    const priorMessages = [user("Implement the change.", 1)];
    const controller = new AbortController();
    await commitMessages({
      conversationId,
      messages: priorMessages,
    });

    await expect(
      compactContextForHandoff(
        {
          conversationId,
          piMessages: priorMessages,
          runtimeContext: [
            user(
              "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
            ),
          ],
          signal: controller.signal,
          triggeringToolCallId: "aborted-handoff-call",
          target: {
            modelId: "test/handoff",
            modelProfile: "handoff",
          },
        },
        {
          completeText: async (params) => {
            expect(params.signal).toBe(controller.signal);
            controller.abort(new Error("turn aborted"));
            return { text: "This summary must not commit." } as never;
          },
        },
      ),
    ).rejects.toThrow("turn aborted");
    await expect(loadProjection({ conversationId })).resolves.toEqual(
      priorMessages,
    );
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("standard");
  });

  it("preserves retained user provenance positionally when authors send identical text", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages, loadConversationProjection } =
      await import("@/chat/conversations/projection");

    const alice = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U_ALICE",
      userName: "alice",
    };
    const bob = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U_BOB",
      userName: "bob",
    };
    const priorMessages = [user("same request", 1), user("same request", 2)];

    await commitMessages({
      conversationId: "conversation-identical-retained-text",
      messages: priorMessages,
      provenance: [
        { authority: "instruction", actor: alice },
        { authority: "instruction", actor: bob },
      ],
    });

    const compactor = createContextCompactor({
      completeText: async () =>
        ({ text: "Both matching requests remain distinct." }) as never,
      autoCompactionTriggerTokens: 0,
    });

    const result = await compactor.maybeCompact({
      conversation: coerceThreadConversationState({}),
      conversationId: "conversation-identical-retained-text",
      modelId: "openai/gpt-5.4",
      piMessages: priorMessages,
    });

    expect(result.compacted).toBe(true);
    const projection = await loadConversationProjection({
      conversationId: "conversation-identical-retained-text",
    });
    expect(projection.messages.slice(0, 2).map(textOf)).toEqual([
      "same request",
      "same request",
    ]);
    expect(projection.provenance.slice(0, 2)).toEqual([
      { authority: "instruction", actor: alice },
      { authority: "instruction", actor: bob },
    ]);
  });

  it("summarizes recent history when compaction input is oversized", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages } = await import("@/chat/conversations/projection");

    const priorMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nbootstrap instructions that must not be summarized\n</runtime-turn-context>",
          },
          { type: "text", text: "first actual request" },
        ],
        timestamp: 1,
      } as PiMessage,
      ...Array.from({ length: 35 }, (_, index) =>
        user(`old-${index.toString().padStart(2, "0")} ${"x".repeat(5_000)}`),
      ),
      user("recent-critical-marker keep the rollback plan"),
    ];
    await commitMessages({
      conversationId: "conversation-large",
      messages: priorMessages,
    });
    const conversation = coerceThreadConversationState({});
    let capturedPrompt = "";
    let capturedMessageAttributeMode: unknown;
    const compactor = createContextCompactor({
      completeText: async (params) => {
        capturedPrompt = String(params.messages[0]?.content ?? "");
        capturedMessageAttributeMode = params.messageAttributeMode;
        return { text: "Summary keeps the rollback plan." } as never;
      },
      autoCompactionTriggerTokens: 0,
    });

    await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-large",
      modelId: "openai/gpt-5.4",
      piMessages: priorMessages,
    });

    expect(capturedMessageAttributeMode).toBe("metadata");
    expect(capturedPrompt).toContain("[older context omitted]");
    expect(capturedPrompt).not.toContain("old-00");
    expect(capturedPrompt).not.toContain("bootstrap instructions");
    expect(capturedPrompt).not.toContain("<runtime-turn-context>");
    expect(capturedPrompt).toContain("recent-critical-marker");
  });

  it("counts structured tool context when deciding whether to compact", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages } = await import("@/chat/conversations/projection");

    const priorMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-call-1",
            name: "readFile",
            arguments: { path: "src/large-file.ts", limit: 10_000 },
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    ] as PiMessage[];
    await commitMessages({
      conversationId: "conversation-tool-context",
      messages: priorMessages,
    });
    const conversation = coerceThreadConversationState({});
    let summarized = false;
    const compactor = createContextCompactor({
      completeText: async () => {
        summarized = true;
        return { text: "Tool context was compacted." } as never;
      },
      autoCompactionTriggerTokens: 1,
    });

    const result = await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-tool-context",
      modelId: "openai/gpt-5.4",
      piMessages: priorMessages,
    });

    expect(result.compacted).toBe(true);
    expect(summarized).toBe(true);
  });

  it("does not compact when there is no reusable conversation projection", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");

    const completeText = vi.fn(async () => ({ text: "should not run" }));
    const conversation = coerceThreadConversationState({});
    const compactor = createContextCompactor({
      completeText: completeText as never,
    });

    await expect(
      compactor.maybeCompact({
        conversation,
        conversationId: "conversation-missing",
        modelId: "openai/gpt-5.4",
        piMessages: [],
      }),
    ).resolves.toEqual({ compacted: false, reason: "missing_context" });
    expect(completeText).not.toHaveBeenCalled();
  });
});
