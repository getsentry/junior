// The memory group: `createApp({ memory })` and `AI_MEMORY_MODEL`.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

/** Memory settings. */
export const memorySchema = z
  .strictObject({
    /** Disable automatic prompt recall while keeping explicit memory tools available. */
    disableRecall: z.boolean().optional(),
    /** Disable passive memory extraction from completed sessions. */
    disableExtraction: z.boolean().optional(),
    /** Model for extraction and supersession. Unset uses the app structured model. */
    modelId: z.string().optional(),
  })
  .prefault({});

/** Read the memory group from env. */
export function readMemoryEnv(env: Env): z.input<typeof memorySchema> {
  return { modelId: toOptionalTrimmed(env["AI_MEMORY_MODEL"]) };
}
