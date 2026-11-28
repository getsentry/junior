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
import {
  findObjectLinkType,
  type ObjectLinkRead,
  type ObjectLinkType,
} from "./link-types";
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

/**
 * The link of one object, and its card when the viewer can read it. A
 * source with an owner also gets the label that its link type makes from
 * the link, for a card that cannot read the object.
 */
export interface ObjectCardView {
  label?: string;
  object?: OwnedObjectAnnotation;
  url: string;
}

/**
 * Return the label that a plugin makes from the link of its object, for a
 * card that cannot read the object: the label of the plugin's link type for
 * the link, else the host of the link. Undefined without a link.
 */
export function ownerLinkLabel(
  plugin: string,
  url: string | null | undefined,
  linkTypes: readonly ObjectLinkType[] = readObjectLinkTypes(),
): string | undefined {
  const parsed = url ? URL.parse(url) : null;
  if (!parsed) return undefined;
  const linkType = findObjectLinkType(linkTypes, parsed);
  return (
    (linkType?.owner === plugin ? linkType.label?.(parsed) : undefined) ??
    parsed.host
  );
}

/**
 * Read the link and live card of each source for one viewer, in source
 * order, in one call for the page. The link is the subject link, else the
 * stored one. A source with no link or link type gets nothing. A viewer who
 * cannot read the object, or a failed read, gets only the link. A
 * `cacheOnly` read makes no provider call.
 */
export async function resolveObjectCards(
  viewer: User | undefined,
  sources: readonly ObjectCardSource[],
  mode: Pick<ObjectLinkRead, "cacheOnly"> = {},
): Promise<Array<ObjectCardView | undefined>> {
  const subjects = sources.flatMap(({ subject }) =>
    subject ? [{ subject }] : [],
  );
  const links =
    subjects.length > 0
      ? await readSubjectLinks(getDb(), subjects)
      : new Map<string, string>();
  const linkTypes = readObjectLinkTypes();
  const labels: Array<string | undefined> = [];
  const urls = sources.map((source, index) => {
    const url =
      (source.subject && links.get(subjectKey(source.subject))) ??
      source.url ??
      undefined;
    if (!url || !source.owner) return url;
    const { objectType, plugin } = source.owner;
    const parsed = URL.parse(url);
    const linkType = parsed && findObjectLinkType(linkTypes, parsed);
    if (
      !parsed ||
      linkType?.owner !== plugin ||
      !linkType.objectTypes.includes(objectType)
    ) {
      return undefined;
    }
    labels[index] = ownerLinkLabel(plugin, url, [linkType]);
    return url;
  });
  const read = [...new Set(urls.filter((url) => url !== undefined))];
  const cards = new Map(
    viewer && read.length > 0
      ? (await resolveObjectLinks(viewer, read, mode)).map(
          ({ object, url }) => [url, object],
        )
      : [],
  );
  return urls.map((url, index) => {
    if (!url) return undefined;
    const object = cards.get(url);
    const owner = sources[index]?.owner;
    const label = labels[index];
    return {
      ...(label ? { label } : undefined),
      ...(object && (!owner || object.plugin === owner.plugin)
        ? { object }
        : undefined),
      url,
    };
  });
}
