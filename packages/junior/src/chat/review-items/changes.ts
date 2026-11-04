import { withSpan } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { sendReviewItemMessages, type ReviewItemChange } from "./messages";
import type { ReviewItem } from "./store";

/**
 * Show the latest state of a Review item on a surface outside Junior, such
 * as cards in its linked Slack threads. App setup supplies it. It is
 * optional UI, so it logs its own failures and does not throw.
 */
export type ShowReviewItem = (itemId: string) => Promise<void>;

/** Where a Review item change goes after it is saved. */
export interface ReviewItemDelivery {
  queue: ConversationWorkQueue;
  show: ShowReviewItem;
}

/**
 * Deliver one saved Review item change. Every surface shows the new state.
 * A person action or an agent close (`change`) also goes to every other open
 * linked Conversation. A content change from an agent has no `change`, so
 * only the surfaces change. `exceptConversationId` is the Conversation that
 * made the change: it already knows. A retry of the same change is safe,
 * because each message has an idempotency key.
 */
export async function deliverReviewItemChange(args: {
  change?: ReviewItemChange;
  delivery: ReviewItemDelivery;
  exceptConversationId?: string;
  item: ReviewItem;
  nowMs: number;
}): Promise<void> {
  const { change, delivery, item } = args;
  await withSpan(
    "review_item.deliver",
    "review_item.deliver",
    {},
    async () => {
      await delivery.show(item.id);
      if (!change) return;
      await sendReviewItemMessages({
        change,
        exceptConversationId: args.exceptConversationId,
        item,
        nowMs: args.nowMs,
        queue: delivery.queue,
      });
    },
    {
      "app.review_item.id": item.id,
      "app.review_item.change": change?.kind ?? "content",
      "app.review_item.kind": item.kind,
      "app.review_item.status": item.status,
      "app.review_item.visibility": item.visibility,
      "app.review_item.conversation_count": item.conversationIds.length,
    },
  );
}
