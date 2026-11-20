import * as z from "zod";

/**
 * One saved preview image of an object, such as a pull request screenshot,
 * at 1x and 2x. Both name the Junior image route, never the image host.
 */
export const objectPreviewImageSchema = z
  .object({
    src: z.string().startsWith("/api/images/"),
    srcSet: z.string().min(1),
  })
  .strict();
