import { z } from "zod";

/** Verified object facts shared by Conversation annotations and Message cards. */
export const objectAnnotationSchema = z
  .object({
    kind: z.literal("object"),
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    objectType: z.enum(["task", "code_change", "automation", "item"]),
    title: z.string().trim().min(1).max(512),
    url: z
      .url()
      .max(2048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
      .nullable(),
    description: z.string().max(4000).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    fields: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(100),
            value: z.string().max(4000),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type ObjectAnnotation = z.output<typeof objectAnnotationSchema>;

/** A saved object snapshot with its trusted owner. */
export const ownedObjectAnnotationSchema = objectAnnotationSchema.extend({
  plugin: z.string().min(1),
});
export type OwnedObjectAnnotation = z.output<
  typeof ownedObjectAnnotationSchema
>;
