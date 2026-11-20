import * as z from "zod";
import { type ObjectFacts, objectFactsSchema } from "./object-facts";
import { type ObjectType, objectTypeSchema } from "./object-presentation";

/** Return whether facts fit an object type. Deployment facts also fit an item. */
export function objectFactsMatchType(
  facts: ObjectFacts,
  objectType: ObjectType,
): boolean {
  return facts.type === "deployment"
    ? objectType === "deployment" || objectType === "item"
    : facts.type === objectType;
}

/** The largest size of object facts, in UTF-8 bytes of their JSON. */
export const OBJECT_FACTS_MAX_BYTES = 4096;

/** Return the size that the object facts limit counts. */
export function objectFactsBytes(facts: ObjectFacts): number {
  return utf8ByteLength(JSON.stringify(facts));
}

// Count the UTF-8 bytes of text without encoding it.
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Verified facts shared by Conversation annotations and Message cards.
 * Plugins select small facts from responses they already have. Each surface owns
 * its layout. Omit unknown facts; do not infer approval or passing checks.
 *
 * These facts support both compact previews and full details. Each surface
 * selects the fields it needs; preview rules must not remove saved facts.
 *
 * Keep raw responses, diffs, logs, credentials, and comments out of this schema.
 * Return only facts that the Conversation audience may see. An annotation
 * never grants provider access.
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
        (facts) => objectFactsBytes(facts) <= OBJECT_FACTS_MAX_BYTES,
        "Object facts must not exceed 4 KiB",
      )
      .optional(),
  })
  .strict()
  .refine(
    (annotation) =>
      !annotation.facts ||
      objectFactsMatchType(annotation.facts, annotation.objectType),
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
