import type { Actor } from "@sentry/junior-plugin-api";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import {
  buildSteeringPiMessage,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { contextProvenance } from "@/chat/conversations/provenance";
import {
  credentialContextForActor,
  type CredentialContext,
} from "@/chat/credentials/context";
import { EVENT_MESSAGE_AUTHOR } from "@/chat/events/actor";
import { eventBatchMessageMeta } from "@/chat/events/notification";
import { readSpaceLead } from "@/chat/lead/conversation";
import {
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { canSteerForSender } from "@/chat/task-execution/attempt-selection";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import {
  isTopLevelAgentMessage,
  readTeamMessageSender,
} from "./top-level-message";

/**
 * Drain the messages that a Space's Lead sends to a root in its Space while
 * a Turn of that root runs, and give them to that Turn at its next model
 * call. A message joins only when the Lead Turn that sent it acts for the
 * running Turn's Actor with the same credentials. The first top-level
 * message that cannot join stops the scan, so it and every later one wait
 * for their own Turn in order. A message keeps its data rendering and
 * context provenance, so it gives no approval.
 */
export function createTeamSteeringDrain(args: {
  actor: Actor;
  context: ConversationWorkerContext;
  conversation: ThreadConversationState;
  credentialContext: CredentialContext;
  spaceId: string;
  turnId: string;
}) {
  const { context, conversation, spaceId, turnId } = args;
  const turn = { actor: args.actor, credentialContext: args.credentialContext };
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(
      async (pending) => {
        const candidates = pending.filter(isTopLevelAgentMessage);
        if (candidates.length === 0) return [];
        const leadId = (await readSpaceLead(spaceId))?.conversationId;
        const joining: InboundMessage[] = [];
        for (const message of candidates) {
          const sender = readTeamMessageSender(message);
          if (
            !sender ||
            sender.senderConversationId !== leadId ||
            !canSteerForSender(turn, {
              actor: sender.actor,
              credentialContext: credentialContextForActor(sender.actor),
            })
          ) {
            break;
          }
          joining.push(message);
        }
        if (joining.length === 0) return [];

        // Save the transcript Message first. A failed write leaves the input
        // pending instead of missing from the transcript.
        for (const message of joining) {
          upsertConversationMessage(conversation, {
            id: message.inboundMessageId,
            role: "user",
            text: normalizeConversationText(message.input.text),
            createdAtMs: message.createdAtMs,
            author: EVENT_MESSAGE_AUTHOR,
            authorIdentityId: message.input.authorIdentityId,
            meta: {
              explicitMention: true,
              ...eventBatchMessageMeta([message]),
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
          joining.map((message): AgentSteeringMessage => ({
            kind: "runtime",
            provenance: contextProvenance,
            text: message.input.text.trim(),
            timestampMs: message.createdAtMs,
          })),
          buildSteeringPiMessage,
        );
        if (messages.length > 0) {
          await accept(messages);
          accepted.push(...messages);
        }
        return joining.map((message) => message.inboundMessageId);
      },
      // Top-level messages keep `defer` delivery, so this drain scopes them.
      { deferred: true },
    );
    return accepted;
  };
}
