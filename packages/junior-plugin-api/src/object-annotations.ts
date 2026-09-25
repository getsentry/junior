import { z } from "zod";

/**
 * Verified object facts shared by Conversation annotations and Message cards.
 *
 * Design intent for richer objects (not fields supported by this schema yet):
 *
 * All objects: keep the owner, stable key, label, title, and source URL. Add the
 * time the owner checked the facts; a storage update is not a provider check.
 * Save a small preview. Load larger details separately. Omit unavailable facts;
 * unknown reviews or checks must not imply approval or success.
 *
 * Code change: answer "What must happen before this can merge?"
 * Preview: repository and number, lifecycle state, author, review state, and
 * check counts by result. Keep lifecycle, reviews, and checks separate.
 * Details: reviewers, failing check links, conflicts, source and target branches,
 * and file/line counts. Do not save diffs, check logs, or review threads here.
 *
 * Task: answer "Who owns this, and where does it stand?"
 * Preview: identifier, status, assignee, and priority.
 * Details: project, cycle, due date, labels, description, and blockers. The
 * owner supplies only fields its provider supports. Do not copy comment history.
 *
 * Automation: answer "What will run, when, and is it healthy?"
 * Preview: trigger summary, state, and warning.
 * Details: instruction, owner, Destination, next scheduled run when applicable,
 * and last outcome. Read details from the existing Automation record instead of
 * adding another copy of instructions or run history to the annotation.
 *
 * Item: retain a useful title, source link, and optional status when no specific
 * object type fits. Do not give an unknown item task or code-change semantics.
 * A future deployment annotation should answer "Did this reach the target?"
 * Preview: project, environment, deployment state, and revision.
 * Details: initiator, start/end times, log links, and source code change. Save
 * neither logs nor provider responses. No tool emits deployment annotations yet.
 *
 * Plugins own provider facts and their meaning. Each surface owns its layout.
 * These targets do not add fields, live lookups, or actions. Before extending
 * storage, see "Enrichment direction" in
 * packages/junior/src/chat/conversations/README.md.
 */
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
    trigger: z.string().max(4000).optional(),
    warning: z.string().max(1000).optional(),
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
