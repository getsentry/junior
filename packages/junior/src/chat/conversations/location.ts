import { nonBlankStringSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";

/** One place outside Junior where a Conversation can be delivered. */
// TODO(dcramer): Add the fields Location needs to identify the exact provider
// Conversation. For Slack, this includes threadTs.
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

/** Validated Location associated with a Conversation. */
export type Location = z.output<typeof locationSchema>;
