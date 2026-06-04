import { describe, expect, it } from "vitest";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  createSlackBehaviorRuntime,
  postedText,
} from "../../fixtures/slack-behavior";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";

describe("Slack behavior: thread continuity", () => {
  it("keeps same-thread replies in arrival order for rapid follow-up messages", async () => {
    const scriptedReplies = [
      "Rollback complete. Error rates are back to baseline.",
      "Next step: monitor dashboards for 30 minutes.",
    ];
    const prompts: string[] = [];

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "direct mention follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            prompts.push(prompt);
            return successfulAssistantReply(
              scriptedReplies[prompts.length - 1] ?? "Unexpected extra reply",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700003000.000" });
    const firstMessage = createTestMessage({
      id: "m-continuity-1",
      text: "<@U_APP> We rolled back the deploy after a 500 spike. Give me a status update.",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const secondMessage = createTestMessage({
      id: "m-continuity-2",
      text: "<@U_APP> Also give one concrete next step for follow-up.",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, firstMessage, {
      destination: createTestDestination(thread),
    });
    await slackRuntime.handleSubscribedMessage(thread, secondMessage, {
      destination: createTestDestination(thread),
    });

    expect(prompts).toHaveLength(2);
    expect(thread.posts).toHaveLength(2);
    expect(postedText(thread.posts[0])).toContain("Rollback complete");
    expect(postedText(thread.posts[1])).toContain(
      "Next step: monitor dashboards",
    );
  });

  it("omits prior conversation context for a brand-new mention", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return successfulAssistantReply("First reply.");
          },
        },
      },
    });

    const threadId = "slack:C_FIRST_EMPTY:1700000000.000";
    const thread = createTestThread({ id: threadId });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-first-current",
        threadId,
        text: "Can you summarize this?",
        isMention: true,
      }),
    );

    expect(capturedContexts).toEqual([undefined]);
  });

  it("builds first-turn context from the prior thread transcript only", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return successfulAssistantReply("Follow-up reply.");
          },
        },
      },
    });

    const threadId = "slack:C_FIRST_EXISTING:1700000000.000";
    const thread = createTestThread({ id: threadId });
    const priorMessage = createTestMessage({
      id: "msg-first-prior",
      threadId,
      text: "Original production issue summary.",
      author: { userId: "U-prior", userName: "alice", isBot: false },
    });
    priorMessage.metadata.dateSent = new Date(1_700_000_000_000);
    const currentMessage = createTestMessage({
      id: "msg-first-current",
      threadId,
      text: "Can you include the regression window?",
      isMention: true,
      author: { userId: "U-current", userName: "bob", isBot: false },
    });
    currentMessage.metadata.dateSent = new Date(1_700_000_001_000);
    thread.recentMessages = [priorMessage, currentMessage];

    await slackRuntime.handleNewMention(thread, currentMessage);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toContain("<thread-transcript>");
    expect(capturedContexts[0]).toContain("Original production issue summary.");
    expect(capturedContexts[0]).not.toContain(
      "Can you include the regression window?",
    );
  });

  it("does not include newer thread messages in subscribed-message context", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Context thread" }) as never,
        },
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"follow-up"}',
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return successfulAssistantReply(
              "Responding to first message only.",
            );
          },
        },
      },
    });

    const threadId = "slack:D_ORDER:1700000000.000";
    const thread = createTestThread({ id: threadId });
    const firstMessage = createTestMessage({
      id: "1700000000.100",
      threadId,
      text: "you work now?",
      isMention: false,
    });
    const laterMessage = createTestMessage({
      id: "1700000000.200",
      threadId,
      text: "hello",
      isMention: false,
    });

    Object.defineProperty(thread, "messages", {
      configurable: true,
      get() {
        return (async function* () {
          // Chat SDK thread iterators are newest-first.
          yield laterMessage;
          yield firstMessage;
        })();
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, firstMessage);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toBeUndefined();
  });

  it("preserves persisted conversation state across multiple turns", async () => {
    let turnCount = 0;
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            turnCount += 1;
            return successfulAssistantReply(`reply-${turnCount}`);
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_MULTI:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t1",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "first turn",
        isMention: true,
      }),
    );

    const stateAfterFirstTurn = thread.getState();
    const conv1 = (
      stateAfterFirstTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv1).toBeDefined();
    const messageCountAfterFirst = conv1?.messages?.length ?? 0;

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "second turn",
        isMention: true,
      }),
    );

    const stateAfterSecondTurn = thread.getState();
    const conv2 = (
      stateAfterSecondTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv2).toBeDefined();
    expect(conv2?.messages?.length ?? 0).toBeGreaterThan(
      messageCountAfterFirst,
    );
  });
});
