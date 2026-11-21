/**
 * The transcripts of the mock question Conversations, whose items come from
 * `inbox-items.ts`.
 */
import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import {
  AVERY_MENTION,
  MOCK_QUESTION_CONVERSATION_ID,
  MOCK_QUESTIONS_CONVERSATION_ID,
  type MockItemSeed,
  seeds,
  viewer,
} from "./inbox-items";

function addItemCall(seq: number, createdAt: string, item: MockItemSeed) {
  return {
    seq,
    createdAt,
    data: {
      type: "tool_calls",
      calls: [
        {
          input: { kind: "action", title: item.title },
          name: "addInboxItem",
          output: JSON.stringify({ item: { id: item.id } }),
          status: "completed",
          toolCallId: `add-${item.id}`,
        },
      ],
    },
  } satisfies ConversationReportEvent;
}

function message(
  seq: number,
  createdAt: string,
  role: "assistant" | "user",
  text: string,
): ConversationReportEvent {
  return {
    seq,
    createdAt,
    data: { type: "message", messageId: `qa-message-${seq}`, role, text },
  };
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
    conversation(MOCK_QUESTION_CONVERSATION_ID, "Roll out payments-v42", [
      message(0, at(60), "user", "Ship payments-v42 when the canary is clean."),
      addItemCall(1, at(58), region!),
      message(
        2,
        at(58),
        "assistant",
        "The build is ready. I need a region for the canary first.",
      ),
      message(3, at(50), "user", region!.answer!.other!),
      {
        ...message(
          4,
          at(49),
          "assistant",
          "The canary is running in us-east-1. I will check it in 20 minutes, and <@U789> can roll it back.",
        ),
        mentions: [AVERY_MENTION],
      },
      addItemCall(5, at(26), rollout!),
      message(
        6,
        at(26),
        "assistant",
        "The canary error rate is flat for 30 minutes, and p95 latency did not move. I need your go-ahead before I roll out to every region.",
      ),
    ]),
    conversation(MOCK_QUESTIONS_CONVERSATION_ID, "Plan the billing migration", [
      message(0, at(45), "user", "Plan the billing migration for next week."),
      addItemCall(1, at(42), window!),
      addItemCall(2, at(41), tables!),
      addItemCall(3, at(40), negative!),
      message(
        4,
        at(40),
        "assistant",
        "The dry run passed. Three decisions are left before I schedule it.",
      ),
    ]),
  ];
}
