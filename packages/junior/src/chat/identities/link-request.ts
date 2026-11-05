/**
 * Identity link requests ask a person to link a provider account so a plugin
 * can improve work that it already did without the account. They never block
 * a Turn. The open Review notice is the durable request. A link closes it.
 */
import type { Identity, User } from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getDashboardConnectionsLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { PLUGIN_REVIEW_ITEM_KEY_PREFIX } from "@/chat/review-items/access";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { createPluginReviewItems } from "@/chat/review-items/plugin";
import { getOpenReviewItemByDedupeKey } from "@/chat/review-items/store";

/** Plugin dedupe key of the one Identity link request of a User. */
function linkRequestKey(userId: string): string {
  return `identity-link:${userId}`;
}

/** Full dedupe key of a User's Identity link request for one provider. */
export function identityLinkRequestDedupeKey(
  provider: string,
  userId: string,
): string {
  return `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}${provider}:${linkRequestKey(userId)}`;
}

/**
 * Ask the person of one Turn to link their account of `provider`. Junior
 * keeps one open notice per User and provider. A request from another
 * Conversation links that Conversation to the open notice, so its thread
 * shows the card too. A private notice stays with the Conversation that added
 * it, so a later request from another Conversation leaves it as it is.
 */
export async function requestIdentityLink(args: {
  conversationId: string;
  provider: string;
  reason: string;
  requester: { identity: Identity; user?: User } | undefined;
  show: ShowReviewItem;
}): Promise<{ status: "requested" | "skipped" }> {
  const { provider, requester } = args;
  const user = requester?.user;
  const plugin = pluginCatalogRuntime.getDefinition(provider);
  const connectUrl = getDashboardConnectionsLink();
  if (
    !requester ||
    !user ||
    user.identities.some((identity) => identity.provider === provider) ||
    !plugin?.manifest.oauth ||
    plugin.manifest.accounts?.userOAuth === false ||
    !connectUrl
  ) {
    return { status: "skipped" };
  }
  const db = getDb();
  const access = (
    await readConversationAccessFromSql(db, [args.conversationId])
  ).get(args.conversationId);
  const existing = await getOpenReviewItemByDedupeKey(
    db,
    identityLinkRequestDedupeKey(provider, user.id),
    access?.tenant,
  );
  if (
    existing &&
    (existing.visibility === "private" || access?.visibility !== "public") &&
    existing.addedByConversationId !== args.conversationId
  ) {
    return { status: "requested" };
  }
  const name = plugin.manifest.displayName;
  await createPluginReviewItems({
    conversationId: args.conversationId,
    plugin: provider,
    show: args.show,
  }).upsert({
    assigneeIdentityIds: [requester.identity.id],
    body: `${args.reason.trim()}\n\n[Connect your ${name} account](${connectUrl})`,
    dedupeKey: linkRequestKey(user.id),
    title: `Link your ${name} account`,
  });
  return { status: "requested" };
}
