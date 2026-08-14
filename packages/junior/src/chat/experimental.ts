/**
 * Known unstable product features that must be opted into explicitly.
 * Add new keys here as features graduate from private experiments; remove them
 * once they become stable defaults.
 */
export const EXPERIMENTAL_FEATURES = ["acp", "subagents"] as const;

/** One known experimental feature name. */
export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];

/** App-level opt-ins for unstable product features. */
export type ExperimentalFeaturesConfig = Readonly<
  Partial<Record<ExperimentalFeature, boolean>>
>;

const EXPERIMENTAL_FEATURE_SET = new Set<string>(EXPERIMENTAL_FEATURES);

let configuredExperimental: ExperimentalFeaturesConfig = {};

function isExperimentalFeature(value: string): value is ExperimentalFeature {
  return EXPERIMENTAL_FEATURE_SET.has(value);
}

/** Replace app-level experimental opt-ins and return the previous setting. */
export function setExperimentalFeatures(
  config?: ExperimentalFeaturesConfig,
): ExperimentalFeaturesConfig {
  const previous = { ...configuredExperimental };
  if (config === undefined) {
    configuredExperimental = {};
    return previous;
  }

  const next: Partial<Record<ExperimentalFeature, boolean>> = {};
  for (const [rawName, enabled] of Object.entries(config)) {
    if (enabled === undefined) {
      continue;
    }
    if (typeof enabled !== "boolean") {
      throw new Error(
        `experimental.${rawName} must be a boolean when provided`,
      );
    }
    if (!isExperimentalFeature(rawName)) {
      throw new Error(
        `experimental.${rawName} is not a known experimental feature. Known features: ${EXPERIMENTAL_FEATURES.join(", ")}`,
      );
    }
    next[rawName] = enabled;
  }
  configuredExperimental = next;
  return previous;
}

/** Return a copy of the app-level experimental opt-ins configured by createApp(). */
export function getExperimentalFeatures(): ExperimentalFeaturesConfig {
  return { ...configuredExperimental };
}

/** Return whether one experimental feature is enabled via createApp({ experimental }). */
export function isExperimentalFeatureEnabled(
  feature: ExperimentalFeature,
): boolean {
  return configuredExperimental[feature] === true;
}
