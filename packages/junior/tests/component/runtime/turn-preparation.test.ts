import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "chat";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { createPrepareTurnState } from "@/chat/runtime/turn-preparation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
  type TestThread,
} from "../../fixtures/slack-harness";

// Compaction, image summaries, and Slack profile lookups have their own
// tests. These cases need only the thread and the stored transcript.
const prepareTurnState = createPrepareTurnState({
  compactConversationIfNeeded: async () => {},
  hydrateConversationVisionContext: async () => {},
  resolveBackfillMessageActors: async () => {},
});

async function prepare(thread: TestThread, message: Message) {
  return await prepareTurnState({
    context: { threadId: thread.id },
    destination: createTestDestination(thread),
    explicitMention: true,
    message,
    text: { rawText: message.text, userText: message.text },
    thread,
  });
}

describe("turn state preparation", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("reports a redelivered message that already has a delivered reply", async () => {
    const conversationId = "slack:C0PREPREPLAY:1700000000.000";
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(
      {
        id: "msg-replayed",
        role: "user",
        text: "please answer once",
        createdAtMs: 1,
        author: { userId: "U-test" },
        meta: { replied: true, slackTs: "1700000000.000" },
      },
      {
        id: "assistant-reply",
        role: "assistant",
        text: "Already answered.",
        createdAtMs: 2,
        author: { isBot: true, userName: "Junior" },
        meta: { replied: true },
      },
    );
    await persistConversationMessages({ conversation, conversationId });
    const thread = await createTestThread({ id: conversationId });

    const prepared = await prepare(
      thread,
      createTestMessage({
        id: "msg-replayed",
        threadId: conversationId,
        text: "please answer once",
        isMention: true,
      }),
    );

    expect(prepared.userMessageAlreadyReplied).toBe(true);
  });

  it("gives the first turn no thread context when the thread has no earlier message", async () => {
    const conversationId = "slack:C0PREPEMPTY:1700000000.000";
    const thread = await createTestThread({ id: conversationId });

    const prepared = await prepare(
      thread,
      createTestMessage({
        id: "msg-first-current",
        threadId: conversationId,
        text: "Can you summarize this?",
        isMention: true,
      }),
    );

    expect(prepared.userMessageAlreadyReplied).toBe(false);
    expect(prepared.conversationContext).toBeUndefined();
  });

  it("gives the first turn the earlier thread messages without the current message", async () => {
    const conversationId = "slack:C0PREPEXISTING:1700000000.000";
    const thread = await createTestThread({ id: conversationId });
    const earlier = createTestMessage({
      id: "msg-first-prior",
      threadId: conversationId,
      text: "Original production issue summary.",
      dateSent: new Date(1_700_000_000_000),
    });
    const fromApp = createTestMessage({
      id: "msg-first-app",
      threadId: conversationId,
      text: "Automated deployment context.",
      author: { isBot: true, userId: "B-deploys", userName: "deploys" },
      dateSent: new Date(1_700_000_000_500),
    });
    const current = createTestMessage({
      id: "msg-first-current",
      threadId: conversationId,
      text: "Can you include the regression window?",
      isMention: true,
      dateSent: new Date(1_700_000_001_000),
    });
    thread.recentMessages = [earlier, fromApp, current];

    const prepared = await prepare(thread, current);

    expect(prepared.conversationContext).toContain(
      "Original production issue summary.",
    );
    expect(prepared.conversationContext).toContain(
      "Automated deployment context.",
    );
    expect(prepared.conversationContext).not.toContain(
      "Can you include the regression window?",
    );
  });

  it("leaves thread messages that are newer than the current message out of the context", async () => {
    const conversationId = "slack:C0PREPORDER:1700000000.000";
    const thread = await createTestThread({ id: conversationId });
    const current = createTestMessage({
      id: "1700000000.100",
      threadId: conversationId,
      text: "you work now?",
      dateSent: new Date(1_700_000_000_100),
    });
    const newer = createTestMessage({
      id: "1700000000.200",
      threadId: conversationId,
      text: "hello",
      dateSent: new Date(1_700_000_000_200),
    });
    // The Chat SDK lists thread messages from newest to oldest.
    Object.defineProperty(thread, "messages", {
      configurable: true,
      get() {
        return (async function* () {
          yield newer;
          yield current;
        })();
      },
    });

    const prepared = await prepare(thread, current);

    expect(prepared.conversationContext).toBeUndefined();
  });
});
