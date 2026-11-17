import { afterEach, describe, expect, it } from "vitest";
import type { Source } from "@sentry/junior-plugin-api";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  buildTurnThreadContext,
  loadThreadContextTrimFloor,
  startTurnThreadContext,
} from "@/chat/conversations/thread-context";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
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
  conversationId = CONVERSATION_ID,
): Promise<void> {
  conversation.messages.push(...messages);
  await persistConversationMessages({ conversation, conversationId });
  await hydrateConversationMessages({ conversation, conversationId });
}

/** Start a Turn the way the runtime does and build its thread context. */
async function startTurn(
  conversation: ThreadConversationState,
  args: {
    conversationId?: string;
    hasHistory: boolean;
    inputMessageId: string;
    /** The Turn Source. Slack, the person's mention, by default. */
    source?: Source["kind"];
    turnId: string;
  },
): Promise<string | undefined> {
  const conversationId = args.conversationId ?? CONVERSATION_ID;
  const turnContext = {
    conversation,
    conversationId,
    excludeMessageIds: [args.inputMessageId],
    personStarted: isPersonInput(args.source ?? "slack"),
    turnId: args.turnId,
  };
  await getTurnLifecycle().start({
    conversationId,
    createdAtMs: Date.now(),
    inputMessageIds: [args.inputMessageId],
    surface: "slack",
    ...(await startTurnThreadContext(turnContext)),
    turnId: args.turnId,
  });
  return await buildTurnThreadContext({
    ...turnContext,
    hasHistory: args.hasHistory,
  });
}

async function recordConversation(conversationId: string): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "C123" },
    nowMs: Date.now(),
  });
}

async function completeTurn(turnId: string): Promise<void> {
  await getTurnLifecycle().complete({
    conversationId: CONVERSATION_ID,
    createdAtMs: Date.now(),
    outcome: "success",
    turnId,
  });
}

/** Return the stored `turn_started` data of every Turn, in order. */
async function turnStarts(conversationId: string) {
  const history = await getConversationEventStore().loadHistory(conversationId);
  return history.flatMap((event) =>
    event.data.type === "turn_started" ? [event.data] : [],
  );
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
        personStarted: true,
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

    // Trimming keeps the Messages that the next Turn may still show.
    const between = conversation.messages.find(
      (message) => message.id === "m-between",
    );
    const floor = await loadThreadContextTrimFloor(CONVERSATION_ID);
    expect(floor).toBeDefined();
    expect(between?.seq).toBeGreaterThan(floor!);
  });

  it("gives skipped Messages only to Turns that a person opened", async () => {
    await recordConversation(CONVERSATION_ID);
    const conversation = coerceThreadConversationState({});

    await saveMessages(conversation, [
      threadMessage("m-first", "first request", { explicitMention: true }),
    ]);
    await startTurn(conversation, {
      hasHistory: false,
      inputMessageId: "m-first",
      turnId: "turn-first",
    });
    await completeTurn("turn-first");

    await saveMessages(conversation, [
      threadMessage("m-skipped", "none of the versions is pretty", {
        replied: false,
        skippedReason: "passive_disabled:passive-routing",
      }),
      threadMessage("m-event", "Code change checks failed", {
        eventType: "check_suite.completed",
        explicitMention: true,
      }),
    ]);
    // A Watch Event, a child agent result, and an Automation run neither see
    // nor consume the skipped Message.
    for (const [turnId, source] of [
      ["turn-event", "event"],
      ["turn-automation", "scheduled_automation"],
    ] as const) {
      // With and without agent history, as on a resume that lost it.
      for (const hasHistory of [true, false]) {
        const context = await startTurn(conversation, {
          hasHistory,
          inputMessageId: "m-event",
          source,
          turnId,
        });
        expect(context ?? "").not.toContain("none of the versions is pretty");
      }
      await completeTurn(turnId);
    }

    await saveMessages(conversation, [
      threadMessage("m-second", "what did sam say?", {
        explicitMention: true,
      }),
    ]);
    const second = await startTurn(conversation, {
      hasHistory: true,
      inputMessageId: "m-second",
      turnId: "turn-second",
    });
    expect(second).toContain(
      "none of the versions is pretty (not addressed to you)",
    );

    const starts = await turnStarts(CONVERSATION_ID);
    const first = starts.find((start) => start.turnId === "turn-first");
    // A Turn that no person opened keeps the cursor of the previous Turn.
    expect(
      starts
        .filter((start) => start.turnId !== "turn-second")
        .map((start) => start.threadContextThroughSeq),
    ).toEqual([
      first?.threadContextThroughSeq,
      first?.threadContextThroughSeq,
      first?.threadContextThroughSeq,
    ]);
    expect(
      starts.map((start) => [start.turnId, start.threadContextMessageIds]),
    ).toEqual([
      ["turn-first", undefined],
      ["turn-event", undefined],
      ["turn-automation", undefined],
      ["turn-second", ["m-skipped"]],
    ]);
  });

  it("keeps no cursor for a first Turn that no person opened", async () => {
    const conversationId = "agent-dispatch:thread-context";
    await recordConversation(conversationId);
    const conversation = coerceThreadConversationState({});
    await saveMessages(
      conversation,
      [
        threadMessage("m-skipped", "chatter before the run", {
          replied: false,
        }),
        threadMessage("m-run", "Post the digest.", { explicitMention: true }),
      ],
      conversationId,
    );

    await startTurn(conversation, {
      conversationId,
      hasHistory: false,
      inputMessageId: "m-run",
      source: "plugin_dispatch",
      turnId: "turn-run",
    });

    // The next Turn that a person opens then shows every skipped Message.
    expect(await turnStarts(conversationId)).toEqual([
      expect.not.objectContaining({
        threadContextThroughSeq: expect.anything(),
      }),
    ]);
  });
});
