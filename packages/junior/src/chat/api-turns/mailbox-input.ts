/** Shared mailbox helpers for conversation-only turns. */
import type { LocalActor } from "@/chat/actor";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";
import type { InboundMessage } from "@/chat/task-execution/store";

/** Join non-empty mailbox texts for one conversation-only turn. */
export function joinMailboxText(messages: readonly InboundMessage[]): string {
  return messages
    .map((message) => message.input.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Local actor stamped on resource-event conversation-only turns. */
export function localResourceEventActor(): LocalActor {
  return {
    platform: "local",
    userId: RESOURCE_EVENT_AUTHOR_ID,
    userName: "junior-event",
    fullName: "Junior event",
  };
}
