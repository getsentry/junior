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
 * The object that an Annotation points to: one of the plugin's registered
 * subject kinds (`inboxSubjects`), such as `issue`, and the provider's id
 * of the object, such as GitHub's id of the issue. Unlike `key`, the id
 * stays the same when the object moves or its repository is renamed. An
 * Inbox item with the same subject is about the same object.
 */
export const objectSubjectSchema = z
  .object({
    kind: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(256),
  })
  .strict();
export type ObjectSubject = z.output<typeof objectSubjectSchema>;

/** What a Conversation did to the object of an Annotation. */
export const annotationActionSchema = z.enum(["created", "changed"]);
export type AnnotationAction = z.output<typeof annotationActionSchema>;

/**
 * The card of an object: verified facts that a link type reads for one
 * viewer, shown on Annotations and Message cards. No Annotation saves it.
 * Plugins select small facts from responses they already have. Each surface owns
 * its layout. Omit unknown facts; do not infer approval or passing checks.
 *
 * These facts support both compact previews and full details. Each surface
 * selects the fields it needs; preview rules must not remove facts.
 *
 * Keep raw responses, diffs, logs, credentials, and comments out of this schema.
 * Return only facts that the Conversation audience may see. An annotation
 * never grants provider access.
 */
export const objectAnnotationSchema = z
  .object({
    kind: z.literal("object"),
    key: z.string().trim().min(1).max(256),
    subject: objectSubjectSchema.optional(),
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

/** The card of an object with its trusted owner. */
export const ownedObjectAnnotationSchema = objectAnnotationSchema.safeExtend({
  /**
   * When the provider last returned the card's data. Junior sets it only
   * on a card that a cache serves after its TTL, because a read failed.
   */
  fetchedAt: z.iso.datetime().optional(),
  plugin: z.string().min(1),
});
export type OwnedObjectAnnotation = z.output<
  typeof ownedObjectAnnotationSchema
>;

/**
 * The object of an Annotation, as Junior stores it: its subject, its type,
 * its title, and its link. Search finds the object by its title and link,
 * and a card shows them when the provider is down. A card reads every other
 * fact of the object live. Set `subject` whenever the provider id is known.
 */
export const savedObjectAnnotationSchema = z
  .object({
    kind: z.literal("object"),
    key: z.string().trim().min(1).max(256),
    subject: objectSubjectSchema.optional(),
    objectType: objectTypeSchema,
    title: z.string().trim().min(1).max(512),
    url: z
      .url()
      .max(2048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
      .nullable(),
  })
  .strict();
export type SavedObjectAnnotation = z.output<
  typeof savedObjectAnnotationSchema
>;

/**
 * One object that a tool or hook created or changed, to save as an
 * Annotation of the Conversation.
 */
export const annotatedObjectSchema = savedObjectAnnotationSchema.safeExtend({
  action: annotationActionSchema,
});
export type AnnotatedObject = z.output<typeof annotatedObjectSchema>;
