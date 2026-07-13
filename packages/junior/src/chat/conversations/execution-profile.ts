import { z } from "zod";
import type { BotConfig } from "@/chat/config";
import {
  modelProfileSchema,
  STANDARD_MODEL_PROFILE,
} from "@/chat/model-profile";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";

export const conversationToolPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("host") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      toolNames: z.array(z.string().min(1)),
    })
    .strict(),
]);

export const conversationReasoningPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("adaptive") }).strict(),
  z
    .object({
      mode: z.literal("fixed"),
      level: z.enum(TURN_REASONING_LEVELS),
    })
    .strict(),
]);

/** Durable, provider-neutral behavior selected for every run in a conversation. */
export const conversationExecutionProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelProfile: modelProfileSchema,
    reasoning: conversationReasoningPolicySchema,
    instructions: z.array(z.string().trim().min(1)),
    toolPolicy: conversationToolPolicySchema,
  })
  .strict();

export type ConversationExecutionProfile = z.output<
  typeof conversationExecutionProfileSchema
>;

export type ConversationToolPolicy = z.output<
  typeof conversationToolPolicySchema
>;

export type ConversationReasoningPolicy = z.output<
  typeof conversationReasoningPolicySchema
>;

/** Persist or load the immutable execution profile for one conversation. */
export interface ConversationExecutionProfileStore {
  getOrCreateExecutionProfile(args: {
    conversationId: string;
    profile: ConversationExecutionProfile;
    nowMs?: number;
  }): Promise<ConversationExecutionProfile>;
}

/** Capture current host defaults as a stable profile for a new conversation. */
export function defaultConversationExecutionProfile(
  config: BotConfig,
): ConversationExecutionProfile {
  return {
    schemaVersion: 1,
    modelProfile: STANDARD_MODEL_PROFILE,
    reasoning: config.reasoningLevel
      ? { mode: "fixed", level: config.reasoningLevel }
      : { mode: "adaptive" },
    instructions: [],
    toolPolicy: { mode: "host" },
  };
}
