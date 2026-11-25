import { mapBounded } from "@/chat/fan-out";
import type { WebActor } from "@/chat/actor";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import { instructionActorFor } from "@/chat/agent/prompt";
import { readMessageAttachments } from "@/chat/attachments/input";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import type { ConversationAuthor } from "@/chat/state/conversation";
import { loadInboxItemInput } from "@/chat/inbox-items/prompt-input";
import { webConversationMessage } from "@/chat/task-execution/mailbox-input";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { SteeringSource } from "@/chat/task-execution/steering";

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
 * The steering source of web messages. Only messages from the Turn Actor
 * join. Steered messages from another participant stay pending and start
 * their own Turn next, so they never act with this Actor's credentials.
 */
export function webSteeringSource(args: {
  actor: WebActor;
  /** Transcript author of the Turn Actor. */
  author: ConversationAuthor;
}): SteeringSource {
  const { actor, author } = args;
  return {
    select: async (pending) => {
      const joining = pending.filter(
        (message) =>
          message.source === "web" &&
          message.input.authorId === actor.userId &&
          legacyWebMailboxMetadataSchema.safeParse(message.input.metadata)
            .success,
      );
      return {
        inputs: await mapBounded(joining, async (message) => ({
          message: webConversationMessage(message, author),
          steering: await steeringMessageFromWeb(message, actor),
        })),
        readIds: joining.map((message) => message.inboundMessageId),
      };
    },
  };
}
