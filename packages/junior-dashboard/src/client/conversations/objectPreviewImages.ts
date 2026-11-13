import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { createContext, useContext } from "react";

type PreviewImages = NonNullable<
  NonNullable<ConversationDetailReport["annotations"]>[number]["previewImages"]
>;

/** Preview images of saved objects, by `objectPreviewImagesKey`. */
export type ObjectPreviewImages = ReadonlyMap<string, PreviewImages>;

/** Return the key of one saved object in `ObjectPreviewImages`. */
export function objectPreviewImagesKey(object: {
  key: string;
  plugin: string;
}): string {
  return `${object.plugin}\n${object.key}`;
}

/** Index the preview images that the API named for each saved object. */
export function objectPreviewImagesFromAnnotations(
  annotations: ConversationDetailReport["annotations"],
): ObjectPreviewImages {
  const images = new Map<string, PreviewImages>();
  for (const annotation of annotations ?? []) {
    if (annotation.previewImages?.length) {
      images.set(objectPreviewImagesKey(annotation), annotation.previewImages);
    }
  }
  return images;
}

/** Preview images of the objects saved on the Conversation on screen. */
export const ObjectPreviewImagesContext = createContext<ObjectPreviewImages>(
  new Map(),
);

/**
 * Return the preview images of one saved object. Each `src` is a Junior
 * image path, never the address of the image.
 */
export function useObjectPreviewImages(object: {
  key: string;
  plugin: string;
}): PreviewImages {
  return (
    useContext(ObjectPreviewImagesContext).get(
      objectPreviewImagesKey(object),
    ) ?? []
  );
}
