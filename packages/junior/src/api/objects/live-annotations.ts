/**
 * Annotations as people see them: each object reads its title and state
 * live, with the same resolver as the Inbox. An Annotation whose plugin has
 * no link type for its object keeps what it saved.
 */
import type { ConversationAnnotation, User } from "@sentry/junior-plugin-api";
import { annotationSubject } from "@/chat/plugins/annotations";
import { resolveObjectCards, type ObjectCardView } from "./subject-cards";

/**
 * What an Annotation shows when its object cannot be read live:
 * - `label`: only the stored label and link, for a viewer who cannot read
 *   the object or when its provider is down.
 * - `saved`: the saved facts, for a card that Junior posts once.
 */
export type AnnotationFallback = "label" | "saved";

function liveAnnotation(
  annotation: ConversationAnnotation,
  view: ObjectCardView | undefined,
  fallback: AnnotationFallback,
): ConversationAnnotation {
  if (!view) return annotation;
  const { createdAt, key, plugin, updatedAt } = annotation;
  if (view.object) {
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
  if (fallback === "saved") return annotation;
  return {
    kind: "resource_link",
    key,
    label: annotation.label,
    ...(annotation.objectType
      ? { objectType: annotation.objectType }
      : undefined),
    url: view.url,
    plugin,
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
): Promise<ConversationAnnotation[]> {
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
): Promise<Map<string, ConversationAnnotation[]>> {
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
