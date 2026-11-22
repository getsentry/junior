import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { createContext, useContext } from "react";

type SavedAnnotation = NonNullable<
  ConversationDetailReport["annotations"]
>[number];

/** What a saved object shows beyond its card facts. */
type SavedObject = {
  previewImages: NonNullable<SavedAnnotation["previewImages"]>;
  /** When Junior last saved the facts of the object. */
  updatedAt?: string;
};

/** Saved objects of the Conversation on screen, by `savedObjectKey`. */
type SavedObjects = ReadonlyMap<string, SavedObject>;

const NO_SAVED_OBJECT: SavedObject = { previewImages: [] };

function savedObjectKey(object: { key: string; plugin: string }): string {
  return `${object.plugin}\n${object.key}`;
}

/**
 * Index the saved objects of a Conversation. Annotations come newest first,
 * so the newest save of an object wins. A link Annotation can share the key
 * of an object Annotation. The object Annotation holds the facts and preview
 * images, so it wins over a newer link.
 */
export function savedObjectsFromAnnotations(
  annotations: ConversationDetailReport["annotations"],
): SavedObjects {
  const objects = new Map<string, SavedObject>();
  const links = new Set<string>();
  for (const annotation of annotations ?? []) {
    const key = savedObjectKey(annotation);
    if (objects.has(key) && !(links.has(key) && annotation.kind === "object")) {
      continue;
    }
    objects.set(key, {
      previewImages: annotation.previewImages ?? [],
      updatedAt: annotation.updatedAt,
    });
    if (annotation.kind === "object") links.delete(key);
    else links.add(key);
  }
  return objects;
}

/** Saved objects of the Conversation on screen. */
export const SavedObjectsContext = createContext<SavedObjects>(new Map());

/**
 * Return the saved state of one object. Each preview image `src` is a Junior
 * image path, never the address of the image.
 */
export function useSavedObject(object: {
  key: string;
  plugin: string;
}): SavedObject {
  return (
    useContext(SavedObjectsContext).get(savedObjectKey(object)) ??
    NO_SAVED_OBJECT
  );
}
