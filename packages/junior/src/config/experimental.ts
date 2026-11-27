// The experimental group: `createApp({ experimental })` opt-ins for unstable
// product features.
import * as z from "zod";
import { optionCheck } from "@/config/fields";

/**
 * Known unstable product features that must be opted into explicitly.
 * Add new keys here as features graduate from private experiments; remove them
 * once they become stable defaults.
 */
const EXPERIMENTAL_FEATURES = [
  "guardian-agent",
  "operator-tools",
  "passive-routing",
  "user-customization",
] as const;

/** One known experimental feature name. */
export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];

const EXPERIMENTAL_FEATURE_SET = new Set<string>(EXPERIMENTAL_FEATURES);

function isExperimentalFeature(value: string): value is ExperimentalFeature {
  return EXPERIMENTAL_FEATURE_SET.has(value);
}

/** Known feature names mapped to booleans. Unset features stay off. */
export const experimentalSchema = z
  .record(z.string(), z.unknown())
  .transform((features, ctx) => {
    const enabled: Partial<Record<ExperimentalFeature, boolean>> = {};
    for (const [name, value] of Object.entries(features)) {
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "boolean") {
        ctx.addIssue({
          code: "custom",
          ...optionCheck(
            `experimental.${name} must be a boolean when provided`,
          ),
        });
        return z.NEVER;
      }
      if (!isExperimentalFeature(name)) {
        ctx.addIssue({
          code: "custom",
          ...optionCheck(
            `experimental.${name} is not a known experimental feature. Known features: ${EXPERIMENTAL_FEATURES.join(", ")}`,
          ),
        });
        return z.NEVER;
      }
      enabled[name] = value;
    }
    return enabled;
  })
  .default({});
