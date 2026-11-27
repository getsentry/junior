import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { createContext, useContext } from "react";

type Annotation = NonNullable<ConversationDetailReport["annotations"]>[number];

/** Preview images of an object, such as the screenshots of a code change. */
type ObjectPreviews = NonNullable<Annotation["previewImages"]>;

const NO_PREVIEWS: ObjectPreviews = [];

function objectKey(object: { key: string; plugin: string }): string {
  return `${object.plugin}\n${object.key}`;
}

/**
 * Index the preview images of the objects of a Conversation. The server
 * reads them from each object's live card. Annotations come newest first,
 * so the newest one of an object wins.
 */
export function objectPreviewsFromAnnotations(
  annotations: ConversationDetailReport["annotations"],
): ReadonlyMap<string, ObjectPreviews> {
  const previews = new Map<string, ObjectPreviews>();
  for (const annotation of annotations ?? []) {
    const key = objectKey(annotation);
    if (!previews.has(key) && annotation.previewImages?.length) {
      previews.set(key, annotation.previewImages);
    }
  }
  return previews;
}

/** Preview images of the objects of the Conversation on screen. */
export const ObjectPreviewsContext = createContext<
  ReadonlyMap<string, ObjectPreviews>
>(new Map());

/**
 * Return the preview images of one object. Each `src` is a Junior image
 * path, never the address of the image.
 */
export function useObjectPreviews(object: {
  key: string;
  plugin: string;
}): ObjectPreviews {
  return (
    useContext(ObjectPreviewsContext).get(objectKey(object)) ?? NO_PREVIEWS
  );
}
