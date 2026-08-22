import { z } from "zod";
import type { BotConfig } from "@/chat/config";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";

/** Keep durable profile names stable and safe to expose in tool schemas. */
export const modelProfileSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** A configured model role rather than a provider-specific model id. */
export type ModelProfile = z.output<typeof modelProfileSchema>;

/** Runtime configuration for one named execution profile. */
export interface ExecutionProfileConfig {
  modelId: string;
  reasoningLevel?: TurnReasoningLevel;
}

/** Identify durable profile bindings that the current host cannot resolve. */
export class ModelProfileNotConfiguredError extends Error {
  constructor(profile: ModelProfile) {
    super(`Model profile "${profile}" is not configured`);
    this.name = "ModelProfileNotConfiguredError";
  }
}

/** Resolve a stable model profile through the host-owned model catalog. */
export function modelIdForProfile(
  config: BotConfig,
  profile: ModelProfile,
): string {
  return profileConfig(config, profile).modelId;
}

/** Resolve the configured default profile's model. */
export function defaultModelId(config: BotConfig): string {
  return modelIdForProfile(config, config.defaultProfile);
}

/** Resolve a stable model profile through the host-owned profile catalog. */
export function profileConfig(
  config: BotConfig,
  profile: ModelProfile,
): ExecutionProfileConfig {
  const profileConfig = Object.hasOwn(config.profiles, profile)
    ? config.profiles[profile]
    : undefined;
  if (!profileConfig) {
    throw new ModelProfileNotConfiguredError(profile);
  }
  return profileConfig;
}
