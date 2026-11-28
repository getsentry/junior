import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { resolveAgentDispatchId } from "@/chat/agent-dispatch/work";
import { recordChildAgentEnded } from "@/chat/child-agents/markers";
import { withSenderActors } from "@/chat/child-agents/sender-actors";
import {
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";

type RunWork = (
  context: ConversationWorkerContext,
) => Promise<ConversationWorkerResult>;

/** The workers that one queue has for the work of a Conversation. */
type ConversationWorkers = {
  runTurn: (
    context: ConversationWorkerContext,
    work: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>;
  /** Omit when the queue carries no Automation dispatch work. */
  runDispatch?: (
    context: ConversationWorkerContext,
    dispatchId: string,
  ) => Promise<ConversationWorkerResult>;
  /**
   * Workers by Destination platform. Input for any other platform that no
   * Turn or dispatch took throws.
   */
  destinations?: Partial<Record<Destination["platform"], RunWork>>;
  state?: StateAdapter | undefined;
};

/**
 * Run one attempt of any Conversation, root or child: its mailbox Turn,
 * then its dispatch, then its Destination work. An attempt with none of
 * them, such as an empty wake after a stop, completes.
 */
export async function runConversation(
  context: ConversationWorkerContext,
  workers: ConversationWorkers,
): Promise<ConversationWorkerResult> {
  const mailboxTurn = await resolveMailboxTurnWork(context);
  if (mailboxTurn) {
    const work = await withSenderActors(mailboxTurn);
    if (!work) {
      // A stop or parent check dropped every input.
      await context.attempt.ack();
      return { status: "completed" };
    }
    const result = await workers.runTurn(context, work);
    if (result.status === "completed") {
      // A child Turn that sent no result, such as a `noReply` Turn, ends the
      // child's markers here.
      await recordChildAgentEnded(context.conversationId, "success", {
        state: workers.state,
      });
    }
    return result;
  }
  if (workers.runDispatch) {
    const dispatchId = await resolveAgentDispatchId(context);
    if (dispatchId) {
      return await workers.runDispatch(context, dispatchId);
    }
  }
  const destination = context.destination;
  const runDestination =
    destination && workers.destinations?.[destination.platform];
  if (runDestination) {
    return await runDestination(context);
  }
  if (destination && context.attempt.messages.length > 0) {
    throw new Error(
      `Conversation ${context.conversationId} has a ${destination.platform} destination but no matching conversation worker`,
    );
  }
  // No open Turn is left, such as after a late stop request or a retry of a
  // killed Turn. Work with no Conversation record has no Destination, and a
  // Destination with no worker, such as `local`, has no other work.
  await context.attempt.ack();
  return { status: "completed" };
}
