import { getDb } from "@/chat/db";
import { identityLinkRequestDedupeKey } from "@/chat/identities/link-request";
import { runPluginIdentityLinked } from "@/chat/plugins/credential-hooks";
import { readIdentityById } from "@/chat/plugins/viewer";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { closeOpenReviewItemsByDedupeKey } from "@/chat/review-items/store";

/**
 * Finish the Identity link requests of a person who linked a provider
 * account: close their open notices, then let the plugin update its work.
 * It runs for every link, so the plugin also updates work from before a
 * request existed.
 */
export async function completeIdentityLink(args: {
  identityId: string;
  provider: string;
  show: ShowReviewItem;
}): Promise<void> {
  const linked = await readIdentityById(args.identityId);
  const user = linked?.user;
  if (!linked || !user) return;
  const closedIds = await closeOpenReviewItemsByDedupeKey(getDb(), {
    dedupeKey: identityLinkRequestDedupeKey(args.provider, user.id),
    nowMs: Date.now(),
    reason: "Linked the account.",
    status: "done",
  });
  for (const id of closedIds) {
    await args.show(id);
  }
  await runPluginIdentityLinked({
    identity: linked.identity,
    provider: args.provider,
    user,
  });
}
