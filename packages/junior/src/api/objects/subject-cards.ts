/**
 * Live cards of the objects that Junior names by subject, such as the
 * subject of an Inbox item or the object of an Annotation. Junior reads
 * each object for one viewer and stores no card.
 */
import type {
  ObjectType,
  OwnedObjectAnnotation,
  User,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { readSubjectLinks, subjectKey } from "@/chat/inbox-items/subject-links";
import type { InboxItemSubject } from "@/chat/inbox-items/subjects";
import { findObjectLinkType } from "./link-types";
import { readObjectLinkTypes, resolveObjectLinks } from "./resolve";

/** One object to show: its subject, its stored link, and its owner. */
export interface ObjectCardSource {
  /**
   * The plugin that owns the object and the type of the object. When set,
   * only a link type of that plugin that opens that type reads the card.
   * A card from another link type, such as the web page card of a link
   * that the viewer cannot open, does not count.
   */
  owner?: { objectType: ObjectType; plugin: string } | undefined;
  subject?: InboxItemSubject | undefined;
  /** The stored link, for a subject that names no link of its own. */
  url?: string | null | undefined;
}

/** The link of one object, and its card when the viewer can read it. */
export interface ObjectCardView {
  object?: OwnedObjectAnnotation;
  url: string;
}

/**
 * Read the link and live card of each source for one viewer, in source
 * order. A source's link is its subject link, such as a pull request that
 * follows a renamed repository, else its stored link. A source without a
 * link, or whose owner has no link type for it, gets nothing. A viewer who
 * cannot read the object, or a failed read, gets only the link. Without a
 * viewer, nothing is read. One call reads the whole page: a link type that
 * can read many objects at once, such as GitHub, makes one query.
 */
export async function resolveObjectCards(
  viewer: User | undefined,
  sources: readonly ObjectCardSource[],
): Promise<Array<ObjectCardView | undefined>> {
  const subjects = sources.flatMap(({ subject }) =>
    subject ? [{ subject }] : [],
  );
  const links =
    subjects.length > 0
      ? await readSubjectLinks(getDb(), subjects)
      : new Map<string, string>();
  const linkTypes = readObjectLinkTypes();
  const urls = sources.map((source) => {
    const url =
      (source.subject && links.get(subjectKey(source.subject))) ??
      source.url ??
      undefined;
    if (!url || !source.owner) return url;
    const { objectType, plugin } = source.owner;
    const linkType = URL.canParse(url)
      ? findObjectLinkType(linkTypes, new URL(url))
      : undefined;
    return linkType?.owner === plugin &&
      linkType.objectTypes.includes(objectType)
      ? url
      : undefined;
  });
  const read = [...new Set(urls.filter((url) => url !== undefined))];
  const cards = new Map(
    viewer && read.length > 0
      ? (await resolveObjectLinks(viewer, read)).map(({ object, url }) => [
          url,
          object,
        ])
      : [],
  );
  return urls.map((url, index) => {
    if (!url) return undefined;
    const object = cards.get(url);
    const owner = sources[index]?.owner;
    return object && (!owner || object.plugin === owner.plugin)
      ? { object, url }
      : { url };
  });
}
