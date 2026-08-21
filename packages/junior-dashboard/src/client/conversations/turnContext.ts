import { z } from "zod";

import type { TranscriptViewTurnContext } from "../types";

const recalledMemorySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    observedAtMs: z.number(),
    kind: z.enum(["preference", "procedure", "knowledge"]),
  })
  .strict();

const legacyMemoryRecallContentSchema = z
  .object({
    memories: z.array(
      recalledMemorySchema.extend({
        scope: z.enum(["personal", "conversation"]),
      }),
    ),
  })
  .strict();

/** Dashboard parser for the current persisted memory recall context. */
export const memoryRecallContentSchema = z
  .object({
    memories: z.array(
      recalledMemorySchema.extend({
        scope: z.enum(["private", "public"]),
      }),
    ),
  })
  .strict();

type LegacyMemoryRecallContent = z.output<
  typeof legacyMemoryRecallContentSchema
>;
export type MemoryRecallContent =
  | LegacyMemoryRecallContent
  | z.output<typeof memoryRecallContentSchema>;

/** Parse supported native memory recall context versions. */
export function memoryRecallContent(context: TranscriptViewTurnContext) {
  if (context.pluginName !== "memory" || context.kind !== "recall") {
    return undefined;
  }
  const schema =
    context.version === 1
      ? legacyMemoryRecallContentSchema
      : context.version === 2
        ? memoryRecallContentSchema
        : undefined;
  if (!schema) {
    return undefined;
  }
  const parsed = schema.safeParse(context.content);
  return parsed.success ? parsed.data : undefined;
}
