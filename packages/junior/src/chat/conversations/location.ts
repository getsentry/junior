import { nonBlankStringSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Provider-neutral container associated with a conversation. */
// TODO(dcramer): Add the provider fields needed by Source and Delivery to
// identify the exact Conversation. For Slack, this includes threadTs.
export const locationSchema = z
  .object({
    /** Junior-owned stable identity for this location. */
    id: nonBlankStringSchema,
    /** Provider namespace that owns the provider and tenant identifiers. */
    provider: nonBlankStringSchema,
    /** Optional provider-native workspace, account, or tenant scope. */
    tenantId: nonBlankStringSchema.optional(),
    /** Provider-native identifier for the container within its tenant scope. */
    providerId: nonBlankStringSchema,
  })
  .strict();

/** Validated provider location associated with a conversation. */
export type Location = z.output<typeof locationSchema>;
