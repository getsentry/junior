import type { OwnedObjectAnnotation, User } from "@sentry/junior-plugin-api";
import { resolveObjectLinks } from "@/api/objects/resolve";
import { getDb } from "@/chat/db";
import { readSubjectLinks } from "@/chat/inbox-items/subject-links";
import type { InboxItem } from "@/chat/inbox-items/store";

/** The link of one item subject, and its card when the viewer can read it. */
export interface InboxSubjectView {
  object?: OwnedObjectAnnotation;
  url: string;
}

/**
 * Read the link and card of each item subject that has a link, such as a
 * pull request, for one viewer and one page of items, by `subjectKey`. A
 * link type that can read many objects at once reads the page with one
 * call, such as one GitHub GraphQL query. A subject whose card cannot be
 * read, such as when its provider is down, has only its link: the Inbox
 * then shows the item's own title and the label of its kind.
 */
export async function resolveInboxItemSubjects(
  viewer: User,
  items: readonly Pick<InboxItem, "request" | "subject">[],
): Promise<Map<string, InboxSubjectView>> {
  const links = await readSubjectLinks(getDb(), items);
  if (links.size === 0) return new Map();
  const cards = new Map(
    (await resolveObjectLinks(viewer, [...new Set(links.values())])).map(
      ({ object, url }) => [url, object],
    ),
  );
  return new Map(
    [...links].map(([key, url]) => {
      const object = cards.get(url);
      return [key, { url, ...(object ? { object } : undefined) }];
    }),
  );
}
