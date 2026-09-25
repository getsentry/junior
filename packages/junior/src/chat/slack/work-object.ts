import { z } from "zod";

// This is the outbound subset Junior uses, not the full Slack schema. The SDK
// allows arbitrary entity/field types and does not tie fields to their entity.
// https://docs.slack.dev/messaging/work-objects-implementation#entity-payload-schema
const url = z.url({ protocol: /^https?$/ });
const textField = z
  .strictObject({
    type: z.literal("string"),
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.string(),
    long: z.boolean().optional(),
    format: z.literal("markdown").optional(),
    link: url.optional(),
  })
  .refine((field) => !field.format || !field.link, {
    message: "Slack string fields cannot combine format and link",
  });

const customField = z.discriminatedUnion("type", [
  textField,
  z.strictObject({
    type: z.literal("slack#/types/timestamp"),
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.number().int(),
    link: url.optional(),
  }),
]);

const payload = z.strictObject({
  attributes: z.strictObject({
    title: z.strictObject({ text: z.string().min(1) }),
    display_id: z.string().optional(),
    display_type: z.string().optional(),
    product_name: z.string().optional(),
  }),
  custom_fields: z.array(customField).optional(),
});
// Slack rejected JSON punctuation in external_ref.id (JUNIOR-A3). Use the
// conservative alphabet shared by Automation IDs and base64url annotation IDs;
// this is Junior's supported subset, not Slack's full accepted pattern.
/** Reject reference characters that can make Slack silently discard metadata. */
export const slackExternalRefIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, "Unsupported Slack external reference ID");

const entity = z.strictObject({
  external_ref: z.strictObject({
    id: slackExternalRefIdSchema,
    type: z.string().min(1).optional(),
  }),
  url,
});

/** Validate notification and detail metadata before Slack can ignore bad fields. */
export const slackEntitySchema = z.discriminatedUnion("entity_type", [
  entity.extend({
    entity_type: z.literal("slack#/entities/item"),
    // Items have no fields object. All values go in custom_fields.
    entity_payload: payload.extend({ fields: z.never().optional() }),
  }),
  entity.extend({
    entity_type: z.literal("slack#/entities/task"),
    entity_payload: payload.extend({
      fields: z
        .strictObject({
          status: z.strictObject({ value: z.string() }).optional(),
        })
        .optional(),
    }),
  }),
]);

export type SlackEntity = z.output<typeof slackEntitySchema>;
export type SlackTextField = z.output<typeof textField>;
