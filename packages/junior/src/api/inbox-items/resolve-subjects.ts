import type { User } from "@sentry/junior-plugin-api";
import {
  resolveObjectCards,
  type ObjectCardView,
} from "@/api/objects/subject-cards";
import { subjectKey } from "@/chat/inbox-items/subject-links";
import type { InboxItem } from "@/chat/inbox-items/store";

/** The link of one item subject, and its card when the viewer can read it. */
export type InboxSubjectView = ObjectCardView;

/**
 * Read the link and card of each item subject that has a link, such as a
 * pull request, for one viewer and one page of items, by `subjectKey`. A
 * subject whose card cannot be read, such as when its provider is down,
 * has only its link: the Inbox then shows the item's own title and the
 * label of its kind.
 */
export async function resolveInboxItemSubjects(
  viewer: User,
  items: readonly Pick<InboxItem, "subject">[],
): Promise<Map<string, InboxSubjectView>> {
  // Pass only the subject: an item's own `owner` is its Conversation.
  const views = await resolveObjectCards(
    viewer,
    items.map(({ subject }) => ({ subject })),
  );
  return new Map(
    items.flatMap((item, index) => {
      const view = views[index];
      return view ? [[subjectKey(item.subject), view] as const] : [];
    }),
  );
}
