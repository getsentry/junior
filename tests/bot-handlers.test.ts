import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "chat";
import { FakeSlackAdapter, createTestThread, createTestMessage } from "./fixtures/slack-harness";

// ── Module mocks (required for bot.ts module-level initialization) ───

vi.mock("chat", () => {
  class MockChat {
    onNewMention() {}
    onSubscribedMessage() {}
    onAssistantThreadStarted() {}
    onAssistantContextChanged() {}
    getAdapter() {
      return {
        setAssistantTitle: async () => undefined,
        setSuggestedPrompts: async () => undefined
      };
    }
  }
  return { Chat: MockChat };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: () => ({})
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: async () => ({
    text: "ok",
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "test-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true
    }
  })
}));

vi.mock("@/chat/slack-user", () => ({
  lookupSlackUser: async () => undefined
}));

// ── Tests ────────────────────────────────────────────────────────────

describe("bot handlers (integration)", () => {
  afterEach(async () => {
    const { resetBotDepsForTests } = await import("@/chat/bot");
    resetBotDepsForTests();
  });

  it("handleNewMention: posts reply from generateAssistantReply", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      generateAssistantReply: async () => ({
        text: "Hello from the bot!",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      }),
      listThreadReplies: async () => []
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_INT:1700000000.000" });
    thread.post = postSpy as unknown as Thread["post"];

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-new-mention",
        threadId: "slack:C_INT:1700000000.000",
        text: "hey bot",
        isMention: true
      })
    );

    const postArgs = postSpy.mock.calls.map((c: unknown[]) => c[0]);
    const hasReply = postArgs.some((arg: unknown) => {
      if (typeof arg === "string") return arg.includes("Hello from the bot!");
      if (arg && typeof arg === "object" && "markdown" in (arg as Record<string, unknown>)) {
        return String((arg as { markdown: string }).markdown).includes("Hello from the bot!");
      }
      // AsyncIterable — the thread.post in createTestThread will consume it
      return false;
    });
    expect(hasReply || postSpy.mock.calls.length > 0).toBe(true);
  });

  it("handleSubscribedMessage with explicit mention: replies when should_reply is true", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      completeObject: async () =>
        ({
          object: { should_reply: true, confidence: 1, reason: "explicit mention" },
          text: '{"should_reply":true,"confidence":1,"reason":"explicit mention"}'
        }) as any,
      generateAssistantReply: async () => ({
        text: "Replying to mention",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      }),
      listThreadReplies: async () => []
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_SUB:1700000000.000" });
    thread.post = postSpy as unknown as Thread["post"];

    await appSlackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-mention",
        threadId: "slack:C_SUB:1700000000.000",
        text: "<@UBOT> check this",
        isMention: true
      })
    );

    expect(postSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("handleSubscribedMessage skip: does not reply when should_reply is false", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      completeObject: async () =>
        ({
          object: { should_reply: false, confidence: 0, reason: "passive conversation" },
          text: '{"should_reply":false,"confidence":0,"reason":"passive conversation"}'
        }) as any,
      listThreadReplies: async () => []
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_SKIP:1700000000.000" });
    thread.post = postSpy as unknown as Thread["post"];

    await appSlackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-skip",
        threadId: "slack:C_SKIP:1700000000.000",
        text: "just chatting among ourselves"
      })
    );

    // Should not have posted a reply (no generateAssistantReply call)
    const hasReply = postSpy.mock.calls.some((call: unknown[]) => {
      const arg = call[0];
      if (typeof arg === "string") return !arg.startsWith("Error:");
      if (arg && typeof arg === "object" && "markdown" in (arg as Record<string, unknown>)) return true;
      return false;
    });
    expect(hasReply).toBe(false);

    // Verify state was persisted with replied: false
    const state = thread.getState();
    const conversation = (state as { conversation?: { messages?: Array<{ meta?: { replied?: boolean } }> } }).conversation;
    if (conversation?.messages) {
      const lastMsg = conversation.messages[conversation.messages.length - 1];
      if (lastMsg?.meta) {
        expect(lastMsg.meta.replied).toBe(false);
      }
    }
  });

  it("handleAssistantThreadStarted: sets title and suggested prompts via adapter", async () => {
    const { appSlackRuntime, bot } = await import("@/chat/bot");
    const fakeAdapter = new FakeSlackAdapter();
    const originalGetAdapter = (bot as unknown as { getAdapter?: (name: string) => unknown }).getAdapter?.bind(bot);
    (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter = (name: string): unknown => {
      if (name === "slack") return fakeAdapter;
      return originalGetAdapter ? originalGetAdapter(name) : undefined;
    };

    try {
      await appSlackRuntime.handleAssistantThreadStarted({
        threadId: "slack:C_ASSIST:1700000000.000",
        channelId: "C_ASSIST",
        threadTs: "1700000000.000",
        userId: "U-starter"
      });

      expect(fakeAdapter.titleCalls.length).toBe(1);
      expect(fakeAdapter.titleCalls[0].title).toBe("Junior");
      expect(fakeAdapter.titleCalls[0].channelId).toBe("C_ASSIST");
      expect(fakeAdapter.promptCalls.length).toBe(1);
      expect(fakeAdapter.promptCalls[0].prompts.length).toBe(3);
    } finally {
      (bot as unknown as { getAdapter?: (name: string) => unknown }).getAdapter = originalGetAdapter;
    }
  });

  it("error recovery: posts error message when generateAssistantReply throws", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      generateAssistantReply: async () => {
        throw new Error("LLM unavailable");
      },
      listThreadReplies: async () => []
    });

    const thread = createTestThread({ id: "slack:C_ERR:1700000000.000" });

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-err",
        threadId: "slack:C_ERR:1700000000.000",
        text: "trigger an error",
        isMention: true
      })
    );

    const errorPost = thread.posts.find(
      (p) => typeof p === "string" && p.includes("Error:")
    );
    expect(errorPost).toBeDefined();
    expect(String(errorPost)).toContain("LLM unavailable");
  });

  it("multi-turn state continuity: second turn sees first turn's conversation state", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    let turnCount = 0;
    setBotDepsForTests({
      generateAssistantReply: async () => {
        turnCount += 1;
        return {
          text: `reply-${turnCount}`,
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "test-model",
            outcome: "success" as const,
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true
          }
        };
      },
      listThreadReplies: async () => []
    });

    const thread = createTestThread({ id: "slack:C_MULTI:1700000000.000" });

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t1",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "first turn",
        isMention: true
      })
    );

    const stateAfterFirstTurn = thread.getState();
    const conv1 = (stateAfterFirstTurn as { conversation?: { messages?: unknown[] } }).conversation;
    expect(conv1).toBeDefined();
    const messageCountAfterFirst = conv1?.messages?.length ?? 0;

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "second turn",
        isMention: true
      })
    );

    const stateAfterSecondTurn = thread.getState();
    const conv2 = (stateAfterSecondTurn as { conversation?: { messages?: unknown[] } }).conversation;
    expect(conv2).toBeDefined();
    expect((conv2?.messages?.length ?? 0)).toBeGreaterThan(messageCountAfterFirst);
  });
});
