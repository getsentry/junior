import type { Actor } from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import {
  buildSteeringPiMessage,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import type { CredentialContext } from "@/chat/credentials/context";
import {
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { canSteerParentTurn } from "@/chat/task-execution/attempt-selection";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { isDroppedChildInput } from "./child-input";
import { logDroppedParentMessage, parentMessageText } from "./parent-message";
import { readParentMessage, type ParentMessage } from "./parent-message-input";

/**
 * Drain the parent messages that wait while a Turn that the parent started
 * runs, and give them to that Turn as steering messages at its next model
 * call. A message joins only when it comes from the stored parent with the
 * Turn's author, Actor, and credentials. The first one that cannot join
 * stops the scan, so it and every later message wait for their own Turn in
 * order. A message that the sender check drops is read and gets no
 * authority.
 */
export function createParentSteeringDrain(args: {
  actor: Actor;
  /** Transcript author of the Turn's parent messages. */
  author: ConversationAuthor;
  context: ConversationWorkerContext;
  conversation: ThreadConversationState;
  credentialContext: CredentialContext;
  turnId: string;
}) {
  const { author, context, conversation, turnId } = args;
  const turn = {
    actor: args.actor,
    authorId: author.userId,
    credentialContext: args.credentialContext,
  };
  // The Turn's own input waits in the mailbox until the Turn commits it.
  const turnInputIds = new Set(
    context.attempt.messages.map((message) => message.inboundMessageId),
  );
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(
      async (pending) => {
        const readIds: string[] = [];
        const joining: { message: InboundMessage; parent: ParentMessage }[] =
          [];
        for (const message of pending) {
          const parent = readParentMessage(message);
          if (!parent || turnInputIds.has(message.inboundMessageId)) {
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- Stop at the first message that cannot join, so steering keeps message order.
          if (await isDroppedChildInput(message)) {
            logDroppedParentMessage(message, parent);
            readIds.push(message.inboundMessageId);
            continue;
          }
          if (!canSteerParentTurn(turn, message)) {
            break;
          }
          joining.push({ message, parent });
          readIds.push(message.inboundMessageId);
        }
        if (joining.length === 0) {
          return readIds;
        }

        const rendered = await mapBounded(joining, async (entry) => ({
          message: entry.message,
          text: await parentMessageText(entry.message, entry.parent),
        }));
        // Save the transcript Message first. A failed write leaves the input
        // pending instead of missing from the transcript.
        for (const { message, text } of rendered) {
          const requestText = message.input.text.trim();
          upsertConversationMessage(conversation, {
            id: message.inboundMessageId,
            role: "user",
            text: normalizeConversationText(text),
            createdAtMs: message.createdAtMs,
            author,
            authorIdentityId: message.input.authorIdentityId,
            meta: {
              explicitMention: true,
              ...(requestText ? { requestText } : undefined),
            },
          });
        }
        await persistConversationMessages({
          conversation,
          conversationId: context.conversationId,
        });

        // An earlier drain can save the messages in the Turn and fail before
        // the mailbox ack. Do not give them to the Turn again.
        const saved =
          (await getTurnRecord(context.conversationId, turnId))?.piMessages ??
          [];
        const messages = withoutSavedSteeringMessages(
          saved,
          rendered.map(({ message, text }): AgentSteeringMessage => ({
            kind: "runtime",
            provenance: agentInstructionProvenance,
            text,
            timestampMs: message.createdAtMs,
          })),
          buildSteeringPiMessage,
        );
        if (messages.length > 0) {
          await accept(messages);
          accepted.push(...messages);
        }
        return readIds;
      },
      // Parent messages keep `defer` delivery, so this drain scopes them.
      { deferred: true },
    );
    return accepted;
  };
}
