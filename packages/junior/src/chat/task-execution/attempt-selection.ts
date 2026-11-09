import { isUserActor } from "@/chat/actor";
import type { TurnRecord } from "./checkpoint";
import type { ConversationWorkState, InboundMessage } from "./store";

/** Source and Actor that own Turn input. */
interface TurnOwner {
  authorId?: string;
  identityId?: string;
  source?: string;
}

function inputOwner(message: InboundMessage): TurnOwner {
  return {
    authorId: message.input.authorId,
    identityId: message.input.authorIdentityId,
    source: message.source,
  };
}

function turnOwner(turn: TurnRecord): TurnOwner {
  return {
    authorId: isUserActor(turn.actor) ? turn.actor.userId : undefined,
    identityId: turn.actorIdentityId,
    source: turn.source?.kind,
  };
}

/**
 * One Turn has one Actor and one Source: it runs with that Actor's
 * credentials, so input from anyone else must not join it. Every id that both
 * sides know must match, and they must share at least one. Input with no
 * known author matches nothing.
 */
function hasSameOwner(a: TurnOwner, b: TurnOwner): boolean {
  if (a.source === undefined || a.source !== b.source) return false;
  const sameIdentity =
    a.identityId && b.identityId ? a.identityId === b.identityId : undefined;
  const sameAuthor =
    a.authorId && b.authorId ? a.authorId === b.authorId : undefined;
  return (
    sameIdentity !== false &&
    sameAuthor !== false &&
    (sameIdentity ?? sameAuthor) === true
  );
}

/** True when two Inbound messages may share one Turn. */
export function canShareTurn(a: InboundMessage, b: InboundMessage): boolean {
  return hasSameOwner(inputOwner(a), inputOwner(b));
}

/** True when an Inbound message may join `turn`. */
export function canJoinTurn(
  turn: TurnRecord,
  message: InboundMessage,
): boolean {
  return hasSameOwner(turnOwner(turn), inputOwner(message));
}

function selectContiguousTurnBatch(
  messages: readonly InboundMessage[],
): InboundMessage[] {
  const first = messages[0];
  if (!first) {
    return [];
  }
  const nextTurnIndex = messages.findIndex(
    (message, index) => index > 0 && !canShareTurn(first, message),
  );
  return messages.slice(
    0,
    nextTurnIndex === -1 ? messages.length : nextTurnIndex,
  );
}

/**
 * True when an interrupt can start its own attempt.
 *
 * A steered web message must not start a second Turn while a yielded Turn
 * waits to resume. It stays pending for that Turn's drain or the next attempt.
 */
export function isAttemptInterrupt(
  message: InboundMessage,
  work: ConversationWorkState,
): boolean {
  return (
    message.delivery === "interrupt" &&
    !(work.execution.status === "paused" && message.source === "web")
  );
}

/** Prioritize interrupts while keeping each attempt to one Actor and Source. */
export function selectAttemptMessages(
  work: ConversationWorkState,
): InboundMessage[] {
  const messages = work.messages;
  const interrupts = messages.filter((message) =>
    isAttemptInterrupt(message, work),
  );
  if (interrupts.length > 0) {
    return selectContiguousTurnBatch(interrupts);
  }
  if (work.execution.status === "paused") return [];
  const nonEventMessages = messages.filter(
    (message) => message.source !== "event",
  );
  return selectContiguousTurnBatch(
    nonEventMessages.length > 0 ? nonEventMessages : messages,
  );
}
