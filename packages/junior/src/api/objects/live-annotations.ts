/**
 * Annotations as people see them: each object reads its title and state
 * live, with the same resolver as the Inbox. An Annotation stores only its
 * object's subject, title, and link, so a card that cannot read the object
 * shows only the label that the plugin makes from the link.
 */
import {
  objectPresentation,
  type ConversationAnnotation,
  type LiveAnnotation,
  type User,
} from "@sentry/junior-plugin-api";
import { annotationSubject } from "@/chat/plugins/annotations";
import { readObjectLinkTypes } from "./resolve";
import {
  ownerLinkLabel,
  resolveObjectCards,
  type ObjectCardView,
} from "./subject-cards";

/**
 * What an Annotation shows when its object cannot be read live:
 * - `label`: only the label and the link, for a viewer who cannot read the
 *   object or when its provider is down.
 * - `title`: the stored title with the label and the link, for a card that
 *   Junior posts once.
 */
export type AnnotationFallback = "label" | "title";

/**
 * Return the short label of an Annotation's object that Junior did not
 * read: the label that its plugin makes from the link, else the name of its
 * type, else its key.
 */
export function annotationLabel(
  annotation: Pick<ConversationAnnotation, "key" | "objectType" | "plugin"> & {
    url: string | null;
  },
  linkTypes = readObjectLinkTypes(),
): string {
  return (
    ownerLinkLabel(annotation.plugin, annotation.url, linkTypes) ??
    (annotation.objectType
      ? objectPresentation({ objectType: annotation.objectType }).label
      : annotation.key)
  );
}

function liveAnnotation(
  annotation: ConversationAnnotation,
  view: ObjectCardView | undefined,
  fallback: AnnotationFallback,
): LiveAnnotation {
  const { createdAt, key, objectType, plugin, updatedAt } = annotation;
  if (view?.object) {
    // The Annotation keeps its own identity. A renamed repository gives
    // the card a new key, but Message refs name the Annotation's key.
    const {
      plugin: _plugin,
      key: _key,
      subject: _subject,
      ...card
    } = view.object;
    return {
      ...card,
      key,
      ...(annotation.kind === "object" && annotation.subject
        ? { subject: annotation.subject }
        : undefined),
      plugin,
      createdAt,
      updatedAt,
    };
  }
  // A subject link follows a renamed repository; the stored link does not.
  const url = view?.url ?? annotation.url;
  const label = view?.label ?? annotationLabel({ ...annotation, url });
  if (fallback === "title" && annotation.kind === "object") {
    return {
      kind: "object",
      key,
      label,
      objectType: annotation.objectType,
      plugin,
      title: annotation.title,
      url,
      createdAt,
      updatedAt,
    };
  }
  return {
    kind: "resource_link",
    key,
    label,
    ...(objectType ? { objectType } : undefined),
    plugin,
    url,
    createdAt,
    updatedAt,
  };
}

/**
 * Return the Annotations with the live card of each object for one viewer,
 * in the same order. Reads every Annotation in one call, so pass a whole
 * page at once.
 */
export async function readLiveAnnotations(
  viewer: User | undefined,
  annotations: readonly ConversationAnnotation[],
  fallback: AnnotationFallback = "label",
): Promise<LiveAnnotation[]> {
  const views = await resolveObjectCards(
    viewer,
    annotations.map((annotation) => {
      // A link saved before links had a type names no link type to read.
      if (!annotation.objectType) return {};
      const subject = annotationSubject(annotation.plugin, annotation);
      return {
        owner: { objectType: annotation.objectType, plugin: annotation.plugin },
        ...(subject ? { subject } : undefined),
        url: annotation.url,
      };
    }),
  );
  return annotations.map((annotation, index) =>
    liveAnnotation(annotation, views[index], fallback),
  );
}

/**
 * Return the live Annotations of each Conversation, as `readLiveAnnotations`
 * does, with one read for every Conversation.
 */
export async function readLiveAnnotationsById(
  viewer: User | undefined,
  byConversation: ReadonlyMap<string, readonly ConversationAnnotation[]>,
): Promise<Map<string, LiveAnnotation[]>> {
  const entries = [...byConversation];
  const live = await readLiveAnnotations(
    viewer,
    entries.flatMap(([, annotations]) => annotations),
  );
  let offset = 0;
  return new Map(
    entries.map(([conversationId, annotations]) => {
      const slice = live.slice(offset, offset + annotations.length);
      offset += annotations.length;
      return [conversationId, slice];
    }),
  );
}
