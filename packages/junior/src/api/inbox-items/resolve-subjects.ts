import type { OwnedObjectAnnotation, User } from "@sentry/junior-plugin-api";
import { resolveObjectLinks } from "@/api/objects/resolve";
import { subjectLink } from "@/chat/inbox-items/subjects";
import type { InboxItem } from "@/chat/inbox-items/store";

/**
 * Read the card of each item subject that is a web link, such as a pull
 * request, for one viewer and one page of items. A link type that can read
 * many objects at once reads the page with one call, such as one GitHub
 * GraphQL query. A subject without a card, such as when its provider is
 * down, has no entry: the Inbox then shows the item's own title and the
 * label of its kind.
 */
export async function resolveInboxItemSubjects(
  viewer: User,
  items: readonly Pick<InboxItem, "subject">[],
): Promise<Map<string, OwnedObjectAnnotation>> {
  const urls = items.flatMap((item) => subjectLink(item.subject) ?? []);
  if (urls.length === 0) return new Map();
  const cards = await resolveObjectLinks(viewer, urls);
  return new Map(cards.map(({ object, url }) => [url, object]));
}
