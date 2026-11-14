/**
 * Preview images of object annotations, as Junior image paths. The browser
 * never gets the saved image URL in an image `src`, and the plugin that owns
 * the annotation checks each viewer when the image is read.
 */
import {
  encodeObjectImageRef,
  type ConversationAnnotation,
} from "@sentry/junior-plugin-api";
import type * as z from "zod";
import type { objectPreviewImageSchema } from "@/api/schema/object-preview-image";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { imagePath } from "./ids";

// Cards show at most a before and after pair in each of two rows. Each path
// has a signed id, so a long list would make every detail poll larger.
const MAX_PREVIEW_IMAGES = 4;

type ObjectPreviewImage = z.output<typeof objectPreviewImageSchema>;

/**
 * Return the preview images of an object annotation at 1x and 2x of a 320
 * pixel card slot, when its plugin serves images. Return nothing for other
 * annotations.
 */
export function objectPreviewImages(
  annotation: ConversationAnnotation,
): ObjectPreviewImage[] | undefined {
  if (annotation.kind !== "object") return undefined;
  const urls =
    annotation.facts?.type === "code_change"
      ? annotation.facts.previewImageUrls
      : undefined;
  if (
    !urls ||
    !getPlugins().some(
      (plugin) => plugin.manifest.name === annotation.plugin && plugin.images,
    )
  ) {
    return undefined;
  }
  return urls.slice(0, MAX_PREVIEW_IMAGES).map((url) => {
    const image = {
      ref: encodeObjectImageRef({ key: annotation.key, url }),
      source: annotation.plugin,
    };
    const small = imagePath(image, 320);
    return { src: small, srcSet: `${small} 1x, ${imagePath(image, 640)} 2x` };
  });
}
