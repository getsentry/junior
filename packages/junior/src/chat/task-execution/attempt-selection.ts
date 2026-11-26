import { isDeepStrictEqual } from "node:util";
import type { Actor } from "@sentry/junior-plugin-api";
import { isUserActor } from "@/chat/actor";
import { readParentMessage } from "@/chat/child-agents/parent-message-input";
import { sameActorIdentity } from "@/chat/conversations/provenance";
import type { CredentialContext } from "@/chat/credentials/context";
import type { TurnRecord } from "./checkpoint";
import type { ConversationWorkState, InboundMessage } from "./store";

/** Source and Actor that own Turn input. */
interface TurnOwner {
  authorId?: string | undefined;
  /**
   * The Actor and credentials that a parent message gives its Turn. Every
   * parent message from one parent has the same author, so these decide
   * which of them share a Turn.
   */
  credentials?: {
    actor: Actor;
    credentialContext?: CredentialContext | undefined;
  };
  identityId?: string | undefined;
  source?: string | undefined;
}

function inputOwner(message: InboundMessage): TurnOwner {
  const parentMessage = readParentMessage(message);
  return {
    authorId: message.input.authorId,
    ...(parentMessage
      ? {
          credentials: {
            actor: parentMessage.actor,
            credentialContext: parentMessage.credentialContext,
          },
        }
      : undefined),
    identityId: message.input.authorIdentityId,
    source: message.source,
  };
}

type TurnOwnerFacts = Pick<TurnRecord, "actor" | "actorIdentityId" | "source">;

function turnOwner(turn: TurnOwnerFacts): TurnOwner {
  return {
    authorId: isUserActor(turn.actor) ? turn.actor.userId : undefined,
    identityId: turn.actorIdentityId,
    source: turn.source?.kind,
  };
}

/**
 * One Turn has one Actor and one Source: it runs with that Actor's
 * credentials, so input from anyone else must not join it. Every value that
 * both sides know must match, and they must share an Identity id or an author
 * id. Input with no known author matches nothing.
 */
function hasSameOwner(a: TurnOwner, b: TurnOwner): boolean {
  if (a.source && b.source && a.source !== b.source) return false;
  if (
    a.credentials &&
    b.credentials &&
    !hasSameCredentials(a.credentials, b.credentials)
  ) {
    return false;
  }
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

function hasSameCredentials(
  a: NonNullable<TurnOwner["credentials"]>,
  b: NonNullable<TurnOwner["credentials"]>,
): boolean {
  return (
    sameActorIdentity(a.actor, b.actor) &&
    isDeepStrictEqual(a.credentialContext, b.credentialContext)
  );
}

/** True when two Inbound messages may share one Turn. */
export function canShareTurn(a: InboundMessage, b: InboundMessage): boolean {
  return hasSameOwner(inputOwner(a), inputOwner(b));
}

/** True when an Inbound message may join `turn`. */
export function canJoinTurn(
  turn: TurnOwnerFacts,
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
  work: Pick<ConversationWorkState, "execution">,
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
