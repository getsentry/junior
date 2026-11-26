import { mapBounded } from "@/chat/fan-out";
import type { WebActor } from "@/chat/actor";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import {
  buildSteeringPiMessage,
  instructionActorFor,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import { readMessageAttachments } from "@/chat/attachments/input";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { queueSteeredLinks } from "@/chat/conversations/sent-links";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import { upsertConversationMessage } from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import { loadInboxItemInput } from "@/chat/inbox-items/prompt-input";
import { webConversationMessage } from "@/chat/task-execution/mailbox-input";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { SendPluginTask } from "@/chat/plugins/task-runner";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

async function steeringMessageFromWeb(
  message: InboundMessage,
  actor: WebActor,
): Promise<AgentSteeringMessage> {
  const storedAttachments = readMessageAttachments(message.input.attachments);
  // An answer steers in as its Inbox item tag.
  const inboxItemInput = await loadInboxItemInput(
    message.input.reviewItemChange,
  );
  return {
    actor: instructionActorFor(actor),
    ...(inboxItemInput ? { kind: "runtime" as const } : undefined),
    provenance: instructionProvenanceFor(actor),
    text: inboxItemInput?.text ?? message.input.text.trim(),
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
  /** Starts the attach of the steered Messages' links. */
  sendPluginTask?: SendPluginTask | undefined;
  turnId: string;
}) {
  const { actor, author, context, conversation, sendPluginTask, turnId } = args;
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(async (pending) => {
      const joining = pending.filter(
        (message) =>
          message.source === "web" &&
          message.input.authorId === actor.userId &&
          legacyWebMailboxMetadataSchema.safeParse(message.input.metadata)
            .success,
      );
      if (joining.length === 0) return [];

      // Save the transcript Message first. A failed write leaves the input
      // pending instead of missing from the transcript.
      for (const message of joining) {
        upsertConversationMessage(
          conversation,
          webConversationMessage(message, author),
        );
      }
      await persistConversationMessages({
        conversation,
        conversationId: context.conversationId,
      });
      await queueSteeredLinks(
        sendPluginTask,
        context.conversationId,
        joining.map((message) => message.inboundMessageId),
      );

      // An earlier drain can save the messages in the Turn and fail before
      // the mailbox ack. Do not give them to the Turn again.
      const saved =
        (await getTurnRecord(context.conversationId, turnId))?.piMessages ?? [];
      const messages = withoutSavedSteeringMessages(
        saved,
        await mapBounded(joining, (message) =>
          steeringMessageFromWeb(message, actor),
        ),
        buildSteeringPiMessage,
      );
      if (messages.length > 0) {
        await accept(messages);
        accepted.push(...messages);
      }
      return joining.map((message) => message.inboundMessageId);
    });
    return accepted;
  };
}
