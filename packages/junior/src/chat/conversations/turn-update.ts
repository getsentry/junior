/**
 * The agent update of one ended Turn, read from the events that the Turn
 * stored. A Watch on the Conversation gets the same update that a parent
 * gets from a child agent: the reply, the `noReply` note, or what blocks
 * it. Every Turn stores these events, whatever surface ran it.
 */
import type {
  AgentUpdate,
  AgentUpdateStatus,
} from "@/chat/child-agents/agent-update";
import { piMessageFromHistoryItem } from "@/core/history/items";
import { readTurnAnswer } from "@/chat/turn-answer";
import { isTurnReply } from "@/chat/state/turn-id";
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
  const replies = (
    await readTurnEvents(events, turn, ["message", "message_updated"])
  ).flatMap((event) =>
    (event.data.type === "message" || event.data.type === "message_updated") &&
    isTurnReply(
      {
        id: event.data.messageId,
        meta: event.data.meta,
        role: event.data.role,
      },
      turn.turnId,
    )
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
 * The agent update status of a Turn that ended without a failure. A
 * cancelled Turn reports nothing: new input or a stop replaced it, and each
 * of them reports.
 */
export const TURN_OUTCOME_STATUSES = {
  blocked: "blocked",
  cancelled: undefined,
  no_reply: "done",
  success: "done",
} as const satisfies Record<
  EndedTurn["outcome"],
  Extract<AgentUpdateStatus, "blocked" | "done"> | undefined
>;

/** Return the agent update of a Turn that ended without a failure. */
export async function readTurnUpdate(
  events: ConversationEventStore,
  turn: EndedTurn,
): Promise<AgentUpdate | undefined> {
  const status = TURN_OUTCOME_STATUSES[turn.outcome];
  if (!status) return undefined;
  return {
    status,
    text:
      turn.outcome === "success"
        ? await readReplyText(events, turn)
        : (turn.answerText ?? (await readAnswerText(events, turn))),
  };
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
