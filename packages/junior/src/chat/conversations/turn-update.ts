/**
 * The agent update of one ended Turn, read from the events that the Turn
 * stored. A Watch on the Conversation gets the same update that a parent
 * gets from a child agent: the reply, the `noReply` note, or what blocks
 * it. Every Turn stores these events, whatever surface ran it.
 */
import type { AgentUpdate } from "@/chat/agent-invocations/agent-update";
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import { readTurnAnswer } from "@/chat/turn-answer";
import type {
  ConversationEvent,
  ConversationEventStore,
  ConversationTurnFailureCode,
} from "./history";

// The answer of a Turn is among its newest events, so a short page of the
// newest events of one type finds it.
const TURN_ANSWER_PAGE_SIZE = 20;

/** Where one ended Turn sits in the event log, and how it ended. */
export interface EndedTurn {
  conversationId: string;
  outcome: "success" | "no_reply" | "cancelled" | "blocked";
  /** Seq of the Turn's `turn_started` event. */
  startSeq: number;
  /** Seq of the Turn's terminal event. */
  terminalSeq: number;
  turnId: string;
  /** The answer that the worker that ended the Turn saw, when it has one. */
  answerText?: string | undefined;
}

async function readTurnEvents(
  events: ConversationEventStore,
  turn: EndedTurn,
  types: ["message", "message_updated"] | ["tool_result"],
): Promise<ConversationEvent[]> {
  const page = await events.query(turn.conversationId, {
    beforeSeq: turn.terminalSeq,
    limit: TURN_ANSWER_PAGE_SIZE,
    types,
  });
  return page.events.filter((event) => event.seq > turn.startSeq);
}

/** Return the text of the last reply that the Turn delivered. */
async function readReplyText(
  events: ConversationEventStore,
  turn: EndedTurn,
): Promise<string> {
  const prefix = `${turn.turnId}:assistant:`;
  const replies = (
    await readTurnEvents(events, turn, ["message", "message_updated"])
  ).flatMap((event) =>
    (event.data.type === "message" || event.data.type === "message_updated") &&
    event.data.role === "assistant" &&
    event.data.messageId.startsWith(prefix)
      ? [event.data.text]
      : [],
  );
  return replies.at(-1) ?? "";
}

/** Return the `noReply` note or the blocked report that ended the Turn. */
async function readAnswerText(
  events: ConversationEventStore,
  turn: EndedTurn,
): Promise<string> {
  const results = (await readTurnEvents(events, turn, ["tool_result"])).flatMap(
    (event) =>
      event.data.type === "tool_result"
        ? [piMessageFromHistoryItem(event.data)]
        : [],
  );
  const answer = readTurnAnswer(results);
  if (!answer) return "";
  if ("noReply" in answer) return answer.noReply.note ?? "";
  if ("blocked" in answer) return answer.blocked.missing;
  return answer.reply.text;
}

/**
 * Return the agent update of a Turn that ended without a failure. A
 * cancelled Turn reports nothing: new input or a stop replaced it, and each
 * of them reports.
 */
export async function readTurnUpdate(
  events: ConversationEventStore,
  turn: EndedTurn,
): Promise<AgentUpdate | undefined> {
  switch (turn.outcome) {
    case "success":
      return { status: "done", text: await readReplyText(events, turn) };
    case "no_reply":
      return {
        status: "done",
        text: turn.answerText ?? (await readAnswerText(events, turn)),
      };
    case "blocked":
      return {
        status: "blocked",
        text: turn.answerText ?? (await readAnswerText(events, turn)),
      };
    case "cancelled":
      return undefined;
  }
}

/**
 * Return the agent update of a failed Turn. Raw error text is not stored, so
 * only the worker that saw the failure has `failureText`.
 */
export function failedTurnUpdate(
  failureCode: ConversationTurnFailureCode,
  failureText?: string,
): AgentUpdate {
  return {
    status: "failed",
    text: failureText?.trim() || `The Turn failed: ${failureCode}.`,
  };
}
