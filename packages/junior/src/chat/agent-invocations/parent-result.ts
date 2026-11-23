import type { Actor } from "@sentry/junior-plugin-api";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import type { ConversationKind } from "@/chat/conversations/store";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import { listWatches } from "@/chat/events/store";
import { selectAttemptMessages } from "@/chat/task-execution/attempt-selection";
import {
  getConversationWorkState,
  type ConversationWorkState,
} from "@/chat/task-execution/store";
import type { TurnRecord } from "@/chat/task-execution/turn-cursor";
import type { Reply } from "@/chat/turn-answer";
import { readChildConversationSender } from "./child-input";
import { listChildMessages } from "./child-message";
import { hasWaitingParentWork } from "./list";
import { childAgentStillWorks } from "./store";

/**
 * What one child agent Turn sends its parent agent: its `reply`, a result
 * with no `reply` when its work ended quietly, or a blocked, failed, or
 * stopped result.
 */
export type ParentResult =
  | { kind: "reply"; reply: Reply }
  | { kind: "blocked" | "completed" | "failed" | "stopped"; text: string };

/**
 * Send one child agent Turn's result to the parent agent. `actor` is the
 * Actor of the Turn. Repeat calls for one result are safe.
 */
export type DeliverToParent = (args: {
  actor: Actor;
  result: ParentResult;
  conversationId: string;
  turnId: string;
}) => Promise<void>;

/**
 * Return whether a child's work ended with its Turn `turnId`, which ended
 * with no answer: none of its own child agents still works, it has no active
 * Watch or Timer, no input waits to run a later Turn that answers, and the
 * Turn sent its parent nothing. A Turn can send its `reply` and then lose
 * its worker, so its retry already reported.
 */
export async function childWorkEnded(
  conversationId: string,
  kind: ConversationKind,
  turnId: string,
): Promise<boolean> {
  const [stillWorks, watches, waiting, sender] = await Promise.all([
    childAgentStillWorks(conversationId),
    listWatches({ conversationId }),
    hasWaitingParentWork(conversationId, kind),
    readChildConversationSender(conversationId),
  ]);
  if (stillWorks || watches.length > 0 || waiting || !sender) {
    return false;
  }
  const parent = await getConversationWorkState({
    conversationId: sender.parentConversationId,
  });
  return !listChildMessages(
    parent?.execution.inboundMessageIds ?? [],
    parent?.execution.messageSenders ?? {},
  ).some(
    (message) =>
      message.sender.conversationId === conversationId &&
      message.sender.turnId === turnId,
  );
}

/**
 * Return whether a child's open Turn runs a person's input, such as a
 * person's Message in a Thread. Its parent did not give that work, so the
 * parent hears nothing when it fails or a person stops it. Before its first
 * save, a Turn has no record, and its input is still in the mailbox: the
 * input that its attempt took, or the input that the next attempt takes.
 * Other input can wait beside it.
 */
export function runsPersonInput(
  turn: TurnRecord | undefined,
  work: ConversationWorkState | undefined,
): boolean {
  if (turn) {
    return isPersonInput(turn.source?.kind);
  }
  if (!work) {
    return false;
  }
  const taken = new Set(work.execution.lease?.attemptInboundMessageIds);
  const input =
    taken.size > 0
      ? work.messages.filter((message) => taken.has(message.inboundMessageId))
      : selectAttemptMessages(work);
  return (
    input.length > 0 &&
    input.every(
      (message) =>
        legacyWebMailboxMetadataSchema.safeParse(message.input.metadata)
          .success,
    )
  );
}
