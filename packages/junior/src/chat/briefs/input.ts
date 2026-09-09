import { codeChangeStateSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";

export const briefEntrySchema = z
  .object({
    index: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "tool"]),
    author: z.string().trim().min(1).max(400).optional(),
    text: z.string().min(1),
    createdAtMs: z.number().int().nonnegative(),
    turnId: z.string().min(1).optional(),
  })
  .strict();

export const briefCodeChangeSchema = z
  .object({
    repository: z.string().trim().min(1).max(400),
    number: z.number().int().positive(),
    title: z.string().trim().min(1).max(400).optional(),
    url: z.string().url().max(2_048),
    state: codeChangeStateSchema,
  })
  .strict();

export const briefResourceSchema = z
  .object({
    label: z.string().trim().min(1).max(400),
    url: z.string().url().max(2_048),
    status: z.string().trim().min(1).max(400).optional(),
  })
  .strict();

export const briefInputSchema = z
  .object({
    conversationId: z.string().min(1),
    title: z.string().trim().min(1).max(400).optional(),
    visibility: z.enum(["private", "public"]),
    location: z
      .object({
        provider: z.string().trim().min(1).max(100),
        channelName: z.string().trim().min(1).max(400).optional(),
      })
      .strict()
      .optional(),
    entries: z.array(briefEntrySchema),
    codeChanges: z.array(briefCodeChangeSchema),
    resources: z.array(briefResourceSchema),
  })
  .strict();

export type BriefEntry = z.output<typeof briefEntrySchema>;
export type BriefCodeChange = z.output<typeof briefCodeChangeSchema>;
export type BriefResource = z.output<typeof briefResourceSchema>;
export type BriefInput = z.output<typeof briefInputSchema>;

/** Parse the provider-neutral input used by every Brief generator adapter. */
export function parseBriefInput(input: unknown): BriefInput {
  const parsed = briefInputSchema.parse(input);
  return {
    ...parsed,
    entries: [...parsed.entries].sort(
      (left, right) =>
        left.index - right.index || left.createdAtMs - right.createdAtMs,
    ),
  };
}
