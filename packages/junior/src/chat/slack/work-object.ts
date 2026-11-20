import * as z from "zod";

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
    product_icon: z
      .strictObject({ url, alt_text: z.string().min(1) })
      .optional(),
  }),
  custom_fields: z.array(customField).optional(),
  display_order: z.array(z.string()).optional(),
});
/**
 * Limit IDs to Junior's safe subset. Slack drops all message metadata when an
 * ID has JSON punctuation or is longer than 128 characters.
 */
export const slackExternalRefIdSchema = z
  .string()
  .min(1)
  .max(128)
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

// Slack ignores all metadata of a message above 4,000 bytes and returns the
// `metadata_too_large` warning (Sentry JUNIOR-A4). Slack does not document the
// limit. A public test quotes the number from Slack's warning text, and found
// that Slack counts each non-ASCII UTF-16 unit as a 6-byte `\uXXXX` escape:
// https://slack.green/en/blog/slack-message-metadata
const SLACK_METADATA_MAX_BYTES = 4_000;

/** Return whether Slack keeps message metadata with these entities. */
export function fitsSlackMetadataLimit(entities: SlackEntity[]): boolean {
  const json = JSON.stringify({ entities });
  // Also count "/" as the 2-byte "\/" escape. That test did not check it, so
  // assume the larger size.
  const escapes =
    5 * (json.match(/[\u0080-\uffff]/g)?.length ?? 0) +
    (json.match(/\//g)?.length ?? 0);
  return json.length + escapes <= SLACK_METADATA_MAX_BYTES;
}
