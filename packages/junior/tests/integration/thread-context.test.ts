import { afterEach, describe, expect, it } from "vitest";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import { buildTurnThreadContext } from "@/chat/conversations/thread-context";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { closeDb, getConversationStore } from "@/chat/db";
import { latestConversationMessageSeq } from "@/chat/services/conversation-memory";
import {
  coerceThreadConversationState,
  type ConversationMessage,
  type ThreadConversationState,
} from "@/chat/state/conversation";

const CONVERSATION_ID = "slack:C123:1700000000.200000";

function threadMessage(
  id: string,
  text: string,
  meta: ConversationMessage["meta"] = {},
): ConversationMessage {
  return {
    id,
    role: "user",
    text,
    createdAtMs: Date.now(),
    author: { userId: "U0SAM", userName: "sam" },
    meta,
  };
}

/** Save Messages as Slack ingress does, then reload them with their seqs. */
async function saveMessages(
  conversation: ThreadConversationState,
  messages: ConversationMessage[],
): Promise<void> {
  conversation.messages.push(...messages);
  await persistConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
  await hydrateConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
}

/** Start a Turn the way the runtime does and build its thread context. */
async function startTurn(
  conversation: ThreadConversationState,
  args: { hasHistory: boolean; inputMessageId: string; turnId: string },
): Promise<string | undefined> {
  await getTurnLifecycle().start({
    conversationId: CONVERSATION_ID,
    createdAtMs: Date.now(),
    inputMessageIds: [args.inputMessageId],
    surface: "slack",
    threadContextThroughSeq: latestConversationMessageSeq(conversation),
    turnId: args.turnId,
  });
  return await buildTurnThreadContext({
    conversation,
    conversationId: CONVERSATION_ID,
    excludeMessageIds: [args.inputMessageId],
    hasHistory: args.hasHistory,
    turnId: args.turnId,
  });
}

describe("Turn thread context", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("shows only untagged thread Messages saved since the previous Turn", async () => {
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      nowMs: Date.now(),
    });
    const conversation = coerceThreadConversationState({});

    await saveMessages(conversation, [
      threadMessage("m-before", "chatter before the first mention"),
      threadMessage("m-first", "first request", { explicitMention: true }),
    ]);
    const first = await startTurn(conversation, {
      hasHistory: false,
      inputMessageId: "m-first",
      turnId: "turn-first",
    });
    expect(first).toContain("chatter before the first mention");
    expect(first).not.toContain("first request");
    await getTurnLifecycle().complete({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      outcome: "success",
      turnId: "turn-first",
    });

    await saveMessages(conversation, [
      {
        id: "m-reply",
        role: "assistant",
        text: "first reply",
        createdAtMs: Date.now(),
      },
      threadMessage("m-between", "chatter between mentions"),
      threadMessage("m-second", "second request", { explicitMention: true }),
    ]);
    const second = await startTurn(conversation, {
      hasHistory: true,
      inputMessageId: "m-second",
      turnId: "turn-second",
    });
    expect(second).toContain("chatter between mentions");
    expect(second).not.toContain("chatter before the first mention");
    expect(second).not.toContain("first reply");
    expect(second).not.toContain("request");

    // A retried Turn reads the cursor of the previous Turn, not its own.
    await expect(
      buildTurnThreadContext({
        conversation,
        conversationId: CONVERSATION_ID,
        excludeMessageIds: ["m-second"],
        hasHistory: true,
        turnId: "turn-second",
      }),
    ).resolves.toBe(second);

    // A failed Turn may not have its prompt in agent history, so the next
    // Turn still shows the Messages that the failed Turn covered.
    await getTurnLifecycle().fail({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      turnId: "turn-second",
    });
    await saveMessages(conversation, [
      threadMessage("m-third", "third request", { explicitMention: true }),
    ]);
    const third = await startTurn(conversation, {
      hasHistory: true,
      inputMessageId: "m-third",
      turnId: "turn-third",
    });
    expect(third).toContain("chatter between mentions");
    expect(third).not.toContain("chatter before the first mention");
  });
});
