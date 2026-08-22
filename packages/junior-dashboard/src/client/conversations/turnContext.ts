import { z } from "zod";

import type { TranscriptViewTurnContext } from "../types";

/** Dashboard parser for persisted memory recall context version 1. */
export const memoryRecallContentSchema = z
  .object({
    memories: z.array(
      z
        .object({
          id: z.string(),
          content: z.string(),
          observedAtMs: z.number(),
          scope: z
            .enum(["personal", "conversation", "private", "public"])
            .transform((scope) =>
              scope === "personal"
                ? "private"
                : scope === "conversation"
                  ? "public"
                  : scope,
            ),
          kind: z.enum(["preference", "procedure", "knowledge"]),
        })
        .strict(),
    ),
  })
  .strict();

export type MemoryRecallContent = z.output<typeof memoryRecallContentSchema>;

/** Parse memory recall context version 1 and normalize stored scope values. */
export function memoryRecallContent(context: TranscriptViewTurnContext) {
  if (
    context.pluginName !== "memory" ||
    context.kind !== "recall" ||
    context.version !== 1
  ) {
    return undefined;
  }
  const parsed = memoryRecallContentSchema.safeParse(context.content);
  return parsed.success ? parsed.data : undefined;
}
