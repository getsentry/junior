import type { InboxItem } from "@/chat/inbox-items/store";
import type { JuniorSqlDatabase } from "@/db/db";
import { resolveMentions } from "../mentions";
import type { ActorIdentity } from "../schema/conversation";
import { inboxItemQuestion } from "@/chat/inbox-items/request";

/**
 * Resolve the people that each Inbox item's title, body, and question
 * mention, in item order. Agents name people as Slack `<@U123>` mentions.
 */
export async function readInboxItemMentions(
  executor: JuniorSqlDatabase,
  items: readonly InboxItem[],
): Promise<ActorIdentity[][]> {
  return resolveMentions(
    executor,
    items.map((item) => ({
      tenantId:
        item.tenant?.provider === "slack"
          ? item.tenant.providerTenantId
          : undefined,
      texts: [item.title, item.body, inboxItemQuestion(item.request)?.question],
    })),
  );
}
