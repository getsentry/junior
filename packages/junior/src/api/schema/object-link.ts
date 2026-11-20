import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";

/** The most links that one object request may resolve. */
export const MAX_OBJECT_LINKS = 20;

const objectLinkUrlSchema = z.string().trim().min(1).max(2048);

/** One or more `url` query values. */
export const objectLinksQuerySchema = z
  .object({
    url: z.preprocess(
      (value) => (typeof value === "string" ? [value] : value),
      z.array(objectLinkUrlSchema).min(1).max(MAX_OBJECT_LINKS),
    ),
  })
  .strict();

/** The object cards of the links that resolved for the viewer. */
export const objectLinksReportSchema = z
  .object({
    objects: z
      .array(
        z
          .object({
            object: ownedObjectAnnotationSchema,
            url: objectLinkUrlSchema,
          })
          .strict(),
      )
      .max(MAX_OBJECT_LINKS),
  })
  .strict();

export type ObjectLinksReport = z.output<typeof objectLinksReportSchema>;

/** A participant asks to attach one linked object to a Conversation. */
export const attachObjectLinkBodySchema = z
  .object({ url: objectLinkUrlSchema })
  .strict();

/** `unchanged` when the Conversation already has the object. */
export const attachObjectLinkResponseSchema = z
  .object({ status: z.enum(["attached", "unchanged"]) })
  .strict();

export type AttachObjectLinkResponse = z.output<
  typeof attachObjectLinkResponseSchema
>;
