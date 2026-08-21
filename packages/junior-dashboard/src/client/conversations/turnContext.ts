import { z } from "zod";

import type { TranscriptViewTurnContext } from "../types";

/** Dashboard parser for the first persisted memory recall context version. */
export const memoryRecallContentSchema = z
  .object({
    memories: z.array(
      z
        .object({
          id: z.string(),
          content: z.string(),
          observedAtMs: z.number(),
          scope: z.enum(["private", "public"]),
          kind: z.enum(["preference", "procedure", "knowledge"]),
        })
        .strict(),
    ),
  })
  .strict();

export type MemoryRecallContent = z.output<typeof memoryRecallContentSchema>;

/** Parse the first native memory recall context version. */
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
