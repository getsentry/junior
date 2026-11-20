import type { ReviewItem } from "@/chat/review-items/store";
import type { JuniorSqlDatabase } from "@/db/db";
import { resolveMentions } from "../mentions";
import type { ActorIdentity } from "../schema/conversation";

/**
 * Resolve the people that each Review item's title, body, and question
 * mention, in item order. Agents name people as Slack `<@U123>` mentions.
 */
export async function readReviewItemMentions(
  executor: JuniorSqlDatabase,
  items: readonly ReviewItem[],
): Promise<ActorIdentity[][]> {
  return resolveMentions(
    executor,
    items.map((item) => ({
      tenantId:
        item.tenant?.provider === "slack"
          ? item.tenant.providerTenantId
          : undefined,
      texts: [item.title, item.body, item.request?.question],
    })),
  );
}
