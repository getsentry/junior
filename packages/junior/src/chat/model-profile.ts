import { z } from "zod";
import type { BotConfig } from "@/chat/config";

export const STANDARD_MODEL_PROFILE = "standard";
export const DEFAULT_HANDOFF_MODEL_PROFILE = "handoff";

/** Keep durable profile names stable and safe to expose in tool schemas. */
export const modelProfileSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** A configured model role rather than a provider-specific model id. */
export type ModelProfile = z.output<typeof modelProfileSchema>;

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
  if (profile === STANDARD_MODEL_PROFILE) {
    return config.modelId;
  }
  const modelId = Object.hasOwn(config.modelProfiles, profile)
    ? config.modelProfiles[profile]
    : undefined;
  if (!modelId) {
    throw new ModelProfileNotConfiguredError(profile);
  }
  return modelId;
}
