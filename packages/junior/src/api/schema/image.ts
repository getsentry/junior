import * as z from "zod";
import { IMAGE_WIDTHS, type ImageWidth } from "@/chat/images/ids";

/** Route parameters for one image. */
export const imageParamsSchema = z
  .object({ id: z.string().min(1).max(4000) })
  .strict();

/** The width of one image, from the fixed set, and its optional version. */
export const imageQuerySchema = z
  .object({
    v: z.string().min(1).max(64).optional(),
    w: z
      .string()
      .transform(Number)
      .refine((width): width is ImageWidth =>
        IMAGE_WIDTHS.some((allowed) => allowed === width),
      ),
  })
  .strict();
