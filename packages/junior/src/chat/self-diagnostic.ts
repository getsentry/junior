import { z } from "zod";
import { modelProfileSchema } from "@/chat/model-profile";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";

const modelConfigurationSchema = z.strictObject({
  modelProfile: modelProfileSchema,
  modelId: z.string().min(1),
  reasoningLevel: z.enum(TURN_REASONING_LEVELS),
});

/** Allowlisted live execution facts. Never expose credentials or raw config. */
export const selfDiagnosticSchema = z.strictObject({
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  supportsImageInput: z.boolean(),
  active: modelConfigurationSchema,
  defaultProfile: modelProfileSchema,
  profiles: z.array(
    modelConfigurationSchema.extend({
      configuredReasoningLevel: z.enum(TURN_REASONING_LEVELS).nullable(),
      handoffAvailable: z.boolean(),
    }),
  ),
});

export type SelfDiagnostic = z.output<typeof selfDiagnosticSchema>;
