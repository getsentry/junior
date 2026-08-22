import { z } from "zod";

import type { TranscriptViewTurnContext } from "../types";

const recalledMemoryFields = {
  id: z.string(),
  content: z.string(),
  observedAtMs: z.number(),
  kind: z.enum(["preference", "procedure", "knowledge"]),
};

const legacyMemoryRecallContentSchema = z
  .object({
    memories: z.array(
      z
        .object({
          ...recalledMemoryFields,
          scope: z.enum(["personal", "conversation"]),
        })
        .strict(),
    ),
  })
  .strict();

/** Dashboard parser for the current persisted memory recall context. */
export const memoryRecallContentSchema = z
  .object({
    memories: z.array(
      z
        .object({
          ...recalledMemoryFields,
          scope: z.enum(["private", "public"]),
        })
        .strict(),
    ),
  })
  .strict();

export type MemoryRecallContent = z.output<typeof memoryRecallContentSchema>;

/** Parse current recall context and normalize its previous stored values. */
export function memoryRecallContent(context: TranscriptViewTurnContext) {
  if (
    context.pluginName !== "memory" ||
    context.kind !== "recall" ||
    context.version !== 1
  ) {
    return undefined;
  }
  const current = memoryRecallContentSchema.safeParse(context.content);
  if (current.success) return current.data;
  const legacy = legacyMemoryRecallContentSchema.safeParse(context.content);
  if (legacy.success) {
    return {
      memories: legacy.data.memories.map((memory) => ({
        ...memory,
        scope: memory.scope === "personal" ? "private" : "public",
      })),
    } satisfies MemoryRecallContent;
  }
  return undefined;
}
