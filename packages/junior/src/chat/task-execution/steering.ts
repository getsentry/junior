/**
 * Steering: input that arrives while a Turn runs joins that Turn at its next
 * model call. Each kind of input has a source that picks which pending
 * messages join. The mechanics are the same for every source and every
 * Conversation: messages that arrive during one model call join the next
 * one together, their transcript Messages are saved before the Turn takes
 * them, and a retried drain gives the Turn no message twice.
 */
import type { AgentSteeringMessage } from "@/chat/agent/types";
import {
  buildSteeringPiMessage,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { upsertConversationMessage } from "@/chat/services/conversation-memory";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

/** One pending message that joins the running Turn. */
export type SteeringInput = {
  /** The message's own transcript Message. */
  message: ConversationMessage;
  steering: AgentSteeringMessage;
};

/** Which kind of pending input a source reads, and how it renders it. */
export type SteeringSource = {
  /**
   * The source reads `defer` messages. Without it, the drain offers only
   * the `interrupt` messages that this attempt may take.
   */
  deferred?: boolean;
  /**
   * Pick the messages that join, in order. `readIds` are every message that
   * the source reads, also one that it drops. Messages that it does not
   * read stay pending.
   */
  select: (
    pending: InboundMessage[],
  ) => Promise<{ inputs: SteeringInput[]; readIds: string[] }>;
};

/**
 * Return a Turn's steering drain over its sources, which run in order. It
 * returns nothing when the Turn has no source.
 */
export function createSteeringDrain(args: {
  context: ConversationWorkerContext;
  conversation: ThreadConversationState;
  sources: readonly SteeringSource[];
  turnId: string;
}) {
  const { context, conversation, sources, turnId } = args;
  if (sources.length === 0) return undefined;
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    for (const source of sources) {
      // oxlint-disable-next-line no-await-in-loop -- Each source commits its messages to the Turn in turn.
      await context.attempt.drain(
        async (pending) => {
          const { inputs, readIds } = await source.select(pending);
          if (inputs.length === 0) return readIds;

          // Save the transcript Messages first. A failed write leaves the
          // input pending instead of missing from the transcript.
          for (const input of inputs) {
            upsertConversationMessage(conversation, input.message);
          }
          await persistConversationMessages({
            conversation,
            conversationId: context.conversationId,
          });

          // An earlier drain can save the messages in the Turn and fail
          // before the mailbox ack. Do not give them to the Turn again.
          const saved =
            (await getTurnRecord(context.conversationId, turnId))?.piMessages ??
            [];
          const messages = withoutSavedSteeringMessages(
            saved,
            inputs.map((input) => input.steering),
            buildSteeringPiMessage,
          );
          if (messages.length > 0) {
            await accept(messages);
            accepted.push(...messages);
          }
          return readIds;
        },
        source.deferred ? { deferred: true } : undefined,
      );
    }
    return accepted;
  };
}
