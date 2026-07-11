import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

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
    timestamp,
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

describe("context compaction retained messages", () => {
  it("derives automatic trigger size from the model context window", async () => {
    const {
      calculateContextCompactionTargetTokens,
      calculateContextCompactionTriggerTokens,
    } = await import("@/chat/services/context-budget");

    const miniTrigger = calculateContextCompactionTriggerTokens({
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(miniTrigger).toBe(225_000);
    expect(calculateContextCompactionTargetTokens(miniTrigger)).toBe(180_000);
    expect(
      calculateContextCompactionTriggerTokens({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }),
    ).toBe(691_500);
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
      } = await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(getAgentContextCompactionTriggerTokens()).toBe(112_500);
      expect(getConversationContextCompactionTriggerTokens()).toBe(
        calculateContextCompactionTriggerTokens(
          resolveGatewayModel("openai/gpt-5.4-mini"),
        ),
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
      modelId: "test/model",
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

  it("handoff binds its named profile and later projection replacements inherit it", async () => {
    const { compactContextForHandoff, createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { getAgentStepStore } = await import("@/chat/db");
    const { botConfig } = await import("@/chat/config");
    const conversationId = "conversation-handoff";
    const priorMessages = [
      user("Implement the multi-file change.", 1),
      assistant("I found the affected modules.", 2),
    ];
    await commitMessages({
      modelId: "test/model",
      conversationId,
      messages: priorMessages,
    });

    const handoffMessages = await compactContextForHandoff(
      {
        conversationId,
        piMessages: priorMessages,
        target: {
          modelId: botConfig.modelProfiles.handoff,
          modelProfile: "handoff",
        },
      },
      {
        completeText: async () =>
          ({ text: "Continue the multi-file implementation." }) as never,
      },
    );

    expect(handoffMessages).toHaveLength(1);
    expect(textOf(handoffMessages[0]!)).toContain(
      "Continue the outstanding request now",
    );
    expect(textOf(handoffMessages[0]!)).toContain(
      "Continue the multi-file implementation.",
    );
    await expect(loadProjection({ conversationId })).resolves.toEqual(
      handoffMessages,
    );
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const marker = (await getAgentStepStore().loadHistory(conversationId))
      .map((step) => step.entry)
      .find(
        (entry) =>
          entry.type === "context_epoch_started" && entry.reason === "handoff",
      );
    expect(marker).toEqual({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "handoff",
      modelId: botConfig.modelProfiles.handoff,
    });

    const compactor = createContextCompactor({
      completeText: async () =>
        ({ text: "Continue the handed-off implementation." }) as never,
      autoCompactionTriggerTokens: 0,
    });
    const compacted = await compactor.maybeCompact({
      conversation: coerceThreadConversationState({}),
      conversationId,
      piMessages: handoffMessages,
    });
    expect(compacted.compacted).toBe(true);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");

    await commitMessages({
      modelId: "test/handoff",
      conversationId,
      messages: [user("Replacement safe boundary.", 3)],
    });
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const projectionMarkers = (
      await getAgentStepStore().loadHistory(conversationId)
    )
      .map((step) => step.entry)
      .filter((entry) => entry.type === "context_epoch_started");
    expect(
      projectionMarkers.map(({ reason, modelProfile, modelId }) => ({
        reason,
        modelProfile,
        modelId,
      })),
    ).toEqual([
      {
        reason: "initial",
        modelProfile: "standard",
        modelId: "test/model",
      },
      {
        reason: "handoff",
        modelProfile: "handoff",
        modelId: botConfig.modelProfiles.handoff,
      },
      {
        reason: "compaction",
        modelProfile: "handoff",
        modelId: botConfig.modelProfiles.handoff,
      },
      {
        reason: "rollback",
        modelProfile: "handoff",
        modelId: "test/handoff",
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
      modelId: "test/model",
      conversationId,
      messages: priorMessages,
    });

    await expect(
      compactContextForHandoff(
        {
          conversationId,
          piMessages: priorMessages,
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

  it("does not start handoff persistence when abort is observed after summarization", async () => {
    const { compactContextForHandoff } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-aborted-handoff";
    const priorMessages = [user("Implement the change.", 1)];
    const controller = new AbortController();
    await commitMessages({
      modelId: "test/model",
      conversationId,
      messages: priorMessages,
    });

    await expect(
      compactContextForHandoff(
        {
          conversationId,
          piMessages: priorMessages,
          signal: controller.signal,
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
      modelId: "test/model",
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
      modelId: "test/model",
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
      modelId: "test/model",
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
        piMessages: [],
      }),
    ).resolves.toEqual({ compacted: false, reason: "missing_context" });
    expect(completeText).not.toHaveBeenCalled();
  });
});
