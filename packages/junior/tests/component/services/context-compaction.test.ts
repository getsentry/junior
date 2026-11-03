import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
} from "@/chat/repository-instructions";

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
        return {
          ...assistant("Lookup complete.", 2),
          // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
          responseId: undefined,
          usage: { input: 5, cached: undefined },
        } as PiMessage;
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

  it("keeps earlier user asks before the summary at Turn start", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "conversation-turn-start-retained";
    const alice = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    } as const;
    const history = [
      user("Please remember the deploy blocker.", 1),
      assistant("The blocker is missing migration approval.", 2),
      user("Also track the rollback plan.", 3),
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "oversized",
        content: [{ type: "text", text: "x".repeat(1_600_000) }],
        isError: false,
        timestamp: 4,
      } as PiMessage,
      assistant("Tracking both.", 5),
    ];
    const prompt = user("What is still open?", 6);
    // The Turn commits its instruction before the agent compacts.
    await commitMessages({
      conversationId,
      messages: [...history, prompt],
      newMessageProvenance: { authority: "instruction", actor: alice },
    });
    const askProvenance = (await loadConversationProjection({ conversationId }))
      .provenance[2];

    const result = await compactActiveContextIfNeeded(
      {
        conversationId,
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        pendingMessages: [
          { message: prompt, provenance: { authority: "instruction" } },
        ],
        piMessages: history,
        mode: "blocking",
      },
      async () => "Open: migration approval and rollback plan.",
    );

    expect(result.compacted).toBe(true);
    const texts = result.piMessages!.map(textOf);
    expect(texts.slice(0, 2)).toEqual([
      "Please remember the deploy blocker.",
      "Also track the rollback plan.",
    ]);
    expect(texts[2]).toContain("Open: migration approval and rollback plan.");
    expect(result.piMessages!.at(-1)).toEqual(prompt);
    const projection = await loadConversationProjection({ conversationId });
    expect(projection.messages).toEqual(result.piMessages);
    expect(projection.provenance[1]).toEqual(askProvenance);
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
          mode: "active",
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
        async () => "Short summary.",
      ),
    ).rejects.toBeInstanceOf(ContextInputLimitExceededError);
    await expect(loadProjection({ conversationId })).resolves.toEqual(original);
  });

  it("retains split host context during active compaction", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const { buildTurnContextPrompt } = await import("@/chat/prompt");
    const conversationId = "conversation-active-split-context";
    // An earlier Turn sent session context. A later Turn that no person
    // started got request context. Neither request context applies now.
    const sessionContext = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
      disabledTools: [{ name: "firstTurnTool", reason: "First Turn only." }],
      runtime: { conversationId },
    })!;
    const earlierRequestContext = buildTurnContextPrompt({
      availableSkills: [],
      includeSessionContext: false,
      disabledTools: [
        { name: "createAutomation", reason: "No person started it." },
      ],
      pluginPromptContributions: [
        { pluginName: "memory", id: "userPrompt:0", text: "Earlier memory." },
      ],
    })!;
    const earlierTurns = [
      user(sessionContext, 1),
      user("<current-instruction>\nPlan it.\n</current-instruction>", 1),
      assistant("Planned.", 1),
      {
        role: "user",
        content: [
          { type: "text", text: earlierRequestContext },
          {
            type: "text",
            text: "<current-instruction>\n[task]\n</current-instruction>",
          },
        ],
        timestamp: 2,
      } as PiMessage,
      assistant("Say go.", 2),
    ];
    const timestamp = 3;
    const contextMessage = {
      role: "user",
      content: [
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
        mode: "active",
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        pendingMessages: [
          { message: instruction, provenance: { authority: "instruction" } },
        ],
        piMessages: [
          ...earlierTurns,
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
        runtimeContextMessages: [
          ...earlierTurns,
          contextMessage,
          instruction,
          agents,
        ],
        turnStartMessageIndex: earlierTurns.length,
      },
      async () => "Short summary.",
    );

    expect(result.compacted).toBe(true);
    expect(result.piMessages?.map(textOf)).toEqual([
      expect.stringContaining("<runtime-turn-context>"),
      expect.stringContaining("<current-instruction>"),
      expect.stringContaining("Short summary."),
    ]);
    const context = textOf(result.piMessages![0]!);
    expect(context).toContain(`- gen_ai.conversation.id: ${conversationId}`);
    expect(context).not.toContain("firstTurnTool");
    expect(context).not.toContain("createAutomation");
    expect(context).not.toContain("Earlier memory.");
    expect(context).toContain("Use the repository formatter.");
    expect(context).toContain("Keep the API stable.");
    expect(context).toContain("Use the new formatter.");
    expect(context).not.toContain("Use the old formatter.");
    expect(context).not.toContain(AGENTS_REPLACEMENT_NOTICE);
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
          mode: "active",
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
        async () => {
          throw new Error("summary provider unavailable");
        },
      ),
    ).rejects.toBeInstanceOf(ContextInputLimitExceededError);
    await expect(loadProjection({ conversationId })).resolves.toEqual(original);
  });

  it("handoff binds its named profile", async () => {
    const { compactContextForHandoff } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const { getConversationEventStore } = await import("@/chat/db");
    const { botConfig } = await import("@/chat/config");
    const conversationId = "conversation-handoff";
    const priorMessages = [
      user("Implement the multi-file change.", 1),
      {
        ...assistant("", 2),
        content: [
          {
            type: "toolCall",
            id: "plan-handoff",
            name: "updatePlan",
            arguments: {
              plan: [
                { step: "Edit both modules", status: "in_progress" },
                { step: "Run focused tests", status: "pending" },
              ],
            },
          },
        ],
        stopReason: "toolUse",
      } as PiMessage,
      {
        role: "toolResult",
        toolCallId: "plan-handoff",
        toolName: "updatePlan",
        content: [{ type: "text", text: "Plan updated" }],
        isError: false,
        timestamp: 3,
      } as PiMessage,
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
      "Another language model started to solve this problem",
    );
    expect(textOf(handoffMessages[1]!)).toContain(
      "Continue the multi-file implementation.",
    );
    expect(textOf(handoffMessages[1]!)).toContain(
      '<open-plan>\n[{"step":"Edit both modules","status":"in_progress"},{"step":"Run focused tests","status":"pending"}]\n</open-plan>',
    );
    const durableHandoffMessages = handoffMessages;
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
      replacementHistory: durableHandoffMessages.map((message) => ({
        item: {
          type: "user_message",
          content: (message as { content: unknown[] }).content,
          timestamp: expect.any(Number),
          provenance: { authority: "context" },
        },
      })),
    });

    await expect(
      commitMessages({
        conversationId,
        messages: [user("Replacement safe boundary.", 3)],
      }),
    ).rejects.toThrow("changed before its committed boundary");
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
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
    expect(textOf(messages[1]!)).not.toContain("<current-instruction>");

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
    expect(textOf(agentsOnlyMessages[1]!)).not.toContain(
      "<current-instruction>",
    );

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
});
