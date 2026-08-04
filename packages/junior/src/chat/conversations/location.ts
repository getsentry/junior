import {
  nonBlankStringSchema,
  sourceVisibilitySchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const locationSchema = z
  .object({
    id: nonBlankStringSchema,
    provider: nonBlankStringSchema,
    tenantId: nonBlankStringSchema.optional(),
    providerId: nonBlankStringSchema,
    visibility: sourceVisibilitySchema,
  })
  .strict();

export type Location = z.output<typeof locationSchema>;
