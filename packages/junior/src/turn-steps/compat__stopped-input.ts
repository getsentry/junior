// Compat: exists only so main's readers keep working; delete it once they
// read `junior_turns`. Main's stop result lists the person messages that the
// stop dropped as mailbox messages, and the dashboard puts the viewer's own
// text back in the composer from them. This builds that shape from the core
// inputs that a stop dropped.
import type { LegacyWebMailboxMetadata } from "@/chat/conversations/web-mailbox";
import type { InboundMessage } from "@/chat/task-execution/state";
import type { SourcedUnreadInput } from "@/core/turn/inbox";
import { turnInputPayloadSchema } from "./input-payload";

/**
 * Compat: maps the person inputs that a core stop dropped to main's mailbox
 * messages. A web message gets main's web metadata. A Slack message gets
 * none, because core does not keep the Slack event, so main's receipt
 * cleanup skips it. Other inputs are not person input and drop out.
 */
export function compat__stoppedMessages(
  conversationId: string,
  inputs: readonly SourcedUnreadInput[],
): InboundMessage[] {
  return inputs.flatMap((input) => {
    const kind = input.source.kind;
    if (kind !== "web" && kind !== "slack") {
      return [];
    }
    const { text, actor } = turnInputPayloadSchema.parse(input.payload);
    const message: InboundMessage = {
      conversationId,
      createdAtMs: input.sentAt.getTime(),
      // Core does not keep the delivery, and no reader of a stop needs it.
      delivery: "defer",
      inboundMessageId: input.idempotencyKey,
      input: { authorIdentityId: input.actorIdentityId, text },
      receivedAtMs: input.receivedAt.getTime(),
      source: kind,
    };
    if (actor.platform !== "web" && actor.platform !== "slack") {
      return [message];
    }
    message.input.authorId = actor.userId;
    if (actor.platform === "web" && actor.email) {
      const metadata: LegacyWebMailboxMetadata = {
        authorEmail: actor.email,
        authorUserId: actor.userId,
        kind: "api_turn",
        messageId: input.idempotencyKey,
      };
      if (actor.fullName) metadata.authorFullName = actor.fullName;
      if (actor.userName) metadata.authorUserName = actor.userName;
      message.input.metadata = metadata;
    }
    return [message];
  });
}
