import type { SlackAdapter } from "@chat-adapter/slack";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { syncInboxItemSlackCards } from "@/chat/slack/inbox-item-card-sync";
import { syncInboxItemPush } from "./inbox-item-push";

/**
 * Return the `ShowInboxItem` for app setup: the item's Slack cards, then
 * its push. The push reads the cards, so an item that Slack shows does not
 * push. Pass `getSlackAdapter` outside Slack work so each card uses the
 * token of its workspace.
 */
export function createInboxItemShow(
  getSlackAdapter?: () => SlackAdapter,
): ShowInboxItem {
  return async (itemId) => {
    await syncInboxItemSlackCards({ getSlackAdapter, itemId });
    await syncInboxItemPush(itemId);
  };
}
