import {
  nonBlankStringSchema,
  sourceVisibilitySchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const locationSchema = z
  .object({
    provider: z.literal("slack"),
    teamId: nonBlankStringSchema,
    channelId: nonBlankStringSchema,
    kind: z.enum(["channel", "dm", "group"]),
    visibility: sourceVisibilitySchema,
  })
  .strict();

export type Location = z.output<typeof locationSchema>;
