import type { WebActor } from "@/chat/actor";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import { readMessageAttachments } from "@/chat/attachments/input";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import {
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { createSteeringDrain } from "@/chat/task-execution/core-turn";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

function steeringMessageFromWeb(
  message: InboundMessage,
  actor: WebActor,
): AgentSteeringMessage {
  const storedAttachments = readMessageAttachments(message.input.attachments);
  return {
    actor: {
      authorId: actor.userId,
      ...(actor.fullName ? { authorName: actor.fullName } : undefined),
    },
    provenance: instructionProvenanceFor(actor),
    text: message.input.text.trim(),
    timestampMs: message.createdAtMs,
    ...(storedAttachments.length ? { storedAttachments } : undefined),
  };
}

/**
 * Drain steered web messages into the active web Turn.
 *
 * Only messages from the Turn Actor join. Steered messages from another
 * participant stay pending and start their own Turn next, so they never act
 * with this Actor's credentials.
 */
export function createWebSteeringDrain(args: {
  actor: WebActor;
  /** Transcript author of the Turn Actor. */
  author: ConversationAuthor;
  context: ConversationWorkerContext;
  conversation: ThreadConversationState;
  turnId: string;
}) {
  const { actor, author, context, conversation, turnId } = args;
  return createSteeringDrain<InboundMessage>({
    context,
    turnId,
    select: async (pending) => {
      const joining = pending.filter(
        (message) =>
          message.source === "web" &&
          message.input.authorId === actor.userId &&
          legacyWebMailboxMetadataSchema.safeParse(message.input.metadata)
            .success,
      );
      return {
        joining,
        readIds: joining.map((message) => message.inboundMessageId),
      };
    },
    // Save the transcript Message first. A failed write leaves the input
    // pending instead of missing from the transcript.
    beforeAccept: async (joining) => {
      for (const message of joining) {
        const attachments = readMessageAttachments(message.input.attachments);
        upsertConversationMessage(conversation, {
          id: message.inboundMessageId,
          role: "user",
          text: normalizeConversationText(message.input.text),
          createdAtMs: message.createdAtMs,
          author,
          ...(message.input.authorIdentityId
            ? { authorIdentityId: message.input.authorIdentityId }
            : undefined),
          meta: {
            ...(attachments.length ? { attachments } : undefined),
            explicitMention: true,
            source: "web",
          },
        });
      }
      await persistConversationMessages({
        conversation,
        conversationId: context.conversationId,
      });
    },
    toSteeringMessage: (message) => steeringMessageFromWeb(message, actor),
  });
}
