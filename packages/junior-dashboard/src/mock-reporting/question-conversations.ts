/**
 * The transcripts of the mock question Conversations, whose items come from
 * `review-items.ts`.
 */
import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import {
  AVERY_MENTION,
  MOCK_QUESTION_CONVERSATION_ID,
  MOCK_QUESTIONS_CONVERSATION_ID,
  type MockItemSeed,
  seeds,
  viewer,
} from "./review-items";

// Each Turn of a mock Conversation, as events without their seqs.
type MockEvent = Omit<ConversationReportEvent, "seq">;

function addItemCall(createdAt: string, item: MockItemSeed): MockEvent {
  return {
    createdAt,
    data: {
      type: "tool_calls",
      calls: [
        {
          input: { kind: "action", title: item.title },
          name: "addReviewItem",
          output: JSON.stringify({ item: { id: item.id } }),
          status: "completed",
          toolCallId: `add-${item.id}`,
        },
      ],
    },
  };
}

function message(
  createdAt: string,
  role: "assistant" | "user",
  text: string,
): MockEvent {
  // `numbered` gives each message its id.
  return { createdAt, data: { type: "message", messageId: "", role, text } };
}

// A Turn starts after the message that it answers and ends with no reply,
// as a Turn that asks a question does.
function turn(turnId: string, events: MockEvent[]): MockEvent[] {
  const lifecycle = (state: "no_reply" | "started", at: string) => ({
    createdAt: at,
    data: { type: "turn_lifecycle" as const, state, turnId },
  });
  return [
    lifecycle("started", events[0]!.createdAt),
    ...events,
    lifecycle("no_reply", events.at(-1)!.createdAt),
  ];
}

// Number the events in order. A message's id names its seq.
function numbered(events: MockEvent[]): ConversationReportEvent[] {
  return events.map((event, seq) => ({
    ...event,
    data:
      event.data.type === "message"
        ? { ...event.data, messageId: `qa-message-${seq}` }
        : event.data,
    seq,
  }));
}

/**
 * Build the two question Conversations. Junior adds each item with a tool
 * call before its final message, as a live Turn does.
 */
export function mockQuestionConversations(nowMs: number) {
  const [region, rollout, window, tables, negative] = seeds(nowMs);
  const at = (minutes: number) =>
    new Date(nowMs - minutes * 60_000).toISOString();
  const conversation = (
    conversationId: string,
    displayTitle: string,
    events: ConversationReportEvent[],
  ) => ({
    actorIdentity: { email: viewer.email, fullName: viewer.displayName },
    conversationId,
    cumulativeDurationMs: 95_000,
    displayTitle,
    events,
    isParticipant: true,
    lastProgressAt: events.at(-1)!.createdAt,
    lastSeenAt: events.at(-1)!.createdAt,
    startedAt: events[0]!.createdAt,
    surface: "internal" as const,
  });
  return [
    conversation(
      MOCK_QUESTION_CONVERSATION_ID,
      "Roll out payments-v42",
      numbered([
        message(at(60), "user", "Ship payments-v42 when the canary is clean."),
        ...turn(region!.addedByTurnId!, [
          addItemCall(at(58), region!),
          message(
            at(58),
            "assistant",
            "The build is ready. I need a region for the canary first.",
          ),
        ]),
        message(at(50), "user", region!.answer!.other!),
        {
          ...message(
            at(49),
            "assistant",
            "The canary is running in us-east-1. I will check it in 20 minutes, and <@U789> can roll it back.",
          ),
          mentions: [AVERY_MENTION],
        },
        ...turn(rollout!.addedByTurnId!, [
          addItemCall(at(26), rollout!),
          message(
            at(26),
            "assistant",
            "The canary error rate is flat for 30 minutes, and p95 latency did not move. I need your go-ahead before I roll out to every region.",
          ),
        ]),
      ]),
    ),
    conversation(
      MOCK_QUESTIONS_CONVERSATION_ID,
      "Plan the billing migration",
      numbered([
        message(at(45), "user", "Plan the billing migration for next week."),
        ...turn(window!.addedByTurnId!, [
          addItemCall(at(42), window!),
          addItemCall(at(41), tables!),
          addItemCall(at(40), negative!),
          message(
            at(40),
            "assistant",
            "The dry run passed. Three decisions are left before I schedule it.",
          ),
        ]),
      ]),
    ),
  ];
}
