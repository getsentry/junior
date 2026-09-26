import { z } from "zod";
import { objectFactsSchema } from "./object-facts";
import { objectTypeSchema } from "./object-presentation";

/**
 * Verified facts shared by Conversation annotations and Message cards.
 * Plugins select small facts from responses they already have. Each surface owns
 * its layout. Omit unknown facts; do not infer approval or passing checks.
 *
 * Code changes show branch, status, and a description preview. Tasks show ownership and planning context.
 * Deployments show the target and revision. Automations show the trigger, state,
 * and warning; their existing detail view owns instructions and run history.
 * Other Items keep a title, source link, and optional status.
 *
 * Keep raw responses, diffs, logs, credentials, and comments out of this schema.
 * See "Object facts" in packages/junior/src/chat/conversations/README.md.
 */
export const objectAnnotationSchema = z
  .object({
    kind: z.literal("object"),
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    objectType: objectTypeSchema,
    title: z.string().trim().min(1).max(512),
    url: z
      .url()
      .max(2048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
      .nullable(),
    description: z.string().max(4000).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    trigger: z.string().max(4000).optional(),
    warning: z.string().max(1000).optional(),
    displayType: z.string().trim().min(1).max(80).optional(),
    sourceUpdatedAt: z.iso.datetime({ offset: true }).optional(),
    facts: objectFactsSchema
      .refine(
        (facts) =>
          new TextEncoder().encode(JSON.stringify(facts)).length <= 4096,
        "Object facts must not exceed 4 KiB",
      )
      .optional(),
  })
  .strict()
  .refine(
    (annotation) =>
      !annotation.facts ||
      (annotation.facts.type === "deployment"
        ? annotation.objectType === "deployment" ||
          annotation.objectType === "item"
        : annotation.facts.type === annotation.objectType),
    "Object facts must match the object type",
  );
export type ObjectAnnotation = z.output<typeof objectAnnotationSchema>;

/** A saved object snapshot with its trusted owner. */
export const ownedObjectAnnotationSchema = objectAnnotationSchema.safeExtend({
  plugin: z.string().min(1),
});
export type OwnedObjectAnnotation = z.output<
  typeof ownedObjectAnnotationSchema
>;
