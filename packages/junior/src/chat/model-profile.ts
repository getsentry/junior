import { z } from "zod";
import type { BotConfig } from "@/chat/config";

/** Stable model ownership choices for a main conversation projection. */
export const modelProfileSchema = z.enum(["standard", "advanced"]);

/** A configured model role rather than a provider-specific model id. */
export type ModelProfile = z.output<typeof modelProfileSchema>;

/** Resolve a stable model profile through the host-owned model catalog. */
export function modelIdForProfile(
  config: BotConfig,
  profile: ModelProfile,
): string {
  switch (profile) {
    case "standard":
      return config.modelId;
    case "advanced":
      return config.advancedModelId;
  }
}
