import { getChatConfig } from "@/chat/config";
import type { ExperimentalFeature } from "@/config/experimental";

/** App-level opt-ins for unstable product features. */
export type ExperimentalFeaturesConfig = Readonly<
  Partial<Record<ExperimentalFeature, boolean>>
>;

/** Return whether one experimental feature is enabled via createApp({ experimental }). */
export function isExperimentalFeatureEnabled(
  feature: ExperimentalFeature,
): boolean {
  return getChatConfig().experimental[feature] === true;
}
