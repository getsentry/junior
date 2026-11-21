import { withSpan } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { sendInboxItemMessages, type InboxItemChange } from "./messages";
import type { InboxItem } from "./store";

/**
 * Show the latest state of an Inbox item on a surface outside Junior, such
 * as cards in its linked Slack threads. App setup supplies it. It is
 * optional UI, so it logs its own failures and does not throw.
 */
export type ShowInboxItem = (itemId: string) => Promise<void>;

/** Where an Inbox item change goes after it is saved. */
export interface InboxItemDelivery {
  queue: ConversationWorkQueue;
  show: ShowInboxItem;
}

/**
 * Deliver one saved Inbox item change. Every surface shows the new state.
 * A person action or an agent close (`change`) also goes to every other open
 * linked Conversation. A content change from an agent has no `change`, so
 * only the surfaces change. `exceptConversationId` is the Conversation that
 * made the change: it already knows. A retry of the same change is safe,
 * because each message has an idempotency key.
 */
export async function deliverInboxItemChange(args: {
  change?: InboxItemChange;
  delivery: InboxItemDelivery;
  exceptConversationId?: string | undefined;
  item: InboxItem;
  nowMs: number;
}): Promise<void> {
  const { change, delivery, item } = args;
  await withSpan(
    "inbox_item.deliver",
    "inbox_item.deliver",
    {},
    async () => {
      await delivery.show(item.id);
      if (!change) return;
      await sendInboxItemMessages({
        change,
        exceptConversationId: args.exceptConversationId,
        item,
        nowMs: args.nowMs,
        queue: delivery.queue,
      });
    },
    {
      "app.inbox_item.id": item.id,
      "app.inbox_item.change": change?.kind ?? "content",
      "app.inbox_item.kind": item.kind,
      "app.inbox_item.status": item.status,
      "app.inbox_item.visibility": item.visibility,
      "app.inbox_item.conversation_count": item.conversationIds.length,
    },
  );
}
