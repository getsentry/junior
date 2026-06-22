import type { PluginRegistration } from "@sentry/junior-plugin-api";
import type {
  InlinePluginManifestDefinition,
  PluginCatalogConfig,
  PluginManifestConfig,
} from "./chat/plugins/types";

export type JuniorPluginInput = PluginRegistration | string;

export interface JuniorPluginSetOptions {
  /** Install-level manifest overrides applied before validation. */
  manifests?: Record<string, PluginManifestConfig>;
}

/** Reusable plugin registrations and manifest overrides. */
export interface JuniorPluginSet {
  /** Install-level manifest overrides applied before validation. */
  manifests?: Record<string, PluginManifestConfig>;
  /** Manifest-only plugin packages included by package name. */
  packageNames: string[];
  /** JavaScript plugin definitions included by package factories. */
  registrations: PluginRegistration[];
}

function cloneManifests(
  manifests: Record<string, PluginManifestConfig> | undefined,
): Record<string, PluginManifestConfig> | undefined {
  return manifests ? structuredClone(manifests) : undefined;
}

function cloneInlineManifests(
  registrations: PluginRegistration[],
): InlinePluginManifestDefinition[] | undefined {
  const inlineManifests = registrations.flatMap((plugin) =>
    plugin.manifest
      ? [
          {
            manifest: {
              ...structuredClone(plugin.manifest),
              capabilities:
                plugin.manifest.capabilities?.map((capability) =>
                  capability.includes(".")
                    ? capability
                    : `${plugin.manifest.name}.${capability}`,
                ) ?? [],
              configKeys:
                plugin.manifest.configKeys?.map((key) =>
                  key.includes(".") ? key : `${plugin.manifest.name}.${key}`,
                ) ?? [],
              ...(plugin.manifest.target
                ? {
                    target: {
                      ...plugin.manifest.target,
                      configKey: plugin.manifest.target.configKey.includes(".")
                        ? plugin.manifest.target.configKey
                        : `${plugin.manifest.name}.${plugin.manifest.target.configKey}`,
                    },
                  }
                : {}),
            },
            ...(plugin.packageName ? { packageName: plugin.packageName } : {}),
          },
        ]
      : [],
  );
  return inlineManifests.length > 0 ? inlineManifests : undefined;
}

function assertUniquePluginNames(registrations: PluginRegistration[]): void {
  const seen = new Set<string>();
  for (const plugin of registrations) {
    const name = plugin.manifest.name;
    if (seen.has(name)) {
      throw new Error(`Duplicate plugin registration name "${name}"`);
    }
    seen.add(name);
  }
}

function assertUniquePackageNames(packageNames: string[]): void {
  const seen = new Set<string>();
  for (const packageName of packageNames) {
    if (seen.has(packageName)) {
      throw new Error(`Duplicate plugin package name "${packageName}"`);
    }
    seen.add(packageName);
  }
}

function normalizePluginInput(input: JuniorPluginInput): {
  packageName?: string;
  registration?: PluginRegistration;
} {
  if (typeof input === "string") {
    return { packageName: input };
  }
  return { registration: input };
}

/** Define package-name plugins and JS plugin definitions for one app. */
export function defineJuniorPlugins(
  inputs: JuniorPluginInput[],
  options: JuniorPluginSetOptions = {},
): JuniorPluginSet {
  const normalized = inputs.map(normalizePluginInput);
  const packageNames = normalized.flatMap((input) =>
    input.packageName ? [input.packageName] : [],
  );
  const registrations = normalized.flatMap((input) =>
    input.registration ? [input.registration] : [],
  );
  assertUniquePackageNames(packageNames);
  assertUniquePluginNames(registrations);
  const manifests = cloneManifests(options.manifests);
  return {
    packageNames,
    registrations: registrations.map((plugin) => ({ ...plugin })),
    ...(manifests ? { manifests } : {}),
  };
}

/** Build the manifest catalog config implied by one plugin set. */
export function pluginCatalogConfigFromPluginSet(
  pluginSet: JuniorPluginSet | undefined,
): PluginCatalogConfig | undefined {
  if (!pluginSet) {
    return undefined;
  }

  const packages = [
    ...new Set([
      ...pluginSet.packageNames,
      ...pluginSet.registrations.flatMap((plugin) =>
        plugin.packageName ? [plugin.packageName] : [],
      ),
    ]),
  ];
  const manifests = cloneManifests(pluginSet.manifests);
  const inlineManifests = cloneInlineManifests(pluginSet.registrations);

  if (packages.length === 0 && !manifests && !inlineManifests) {
    return undefined;
  }

  return {
    ...(inlineManifests ? { inlineManifests } : {}),
    ...(packages.length > 0 ? { packages } : {}),
    ...(manifests ? { manifests } : {}),
  };
}

function readEnvPluginPackages(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const value = env.JUNIOR_PLUGIN_PACKAGES;
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("JUNIOR_PLUGIN_PACKAGES must be valid JSON", {
      cause: error,
    });
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      "JUNIOR_PLUGIN_PACKAGES must be a JSON array of package names",
    );
  }

  return parsed;
}

/** Build the manifest catalog config implied by plugin package env. */
export function pluginCatalogConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PluginCatalogConfig | undefined {
  const packages = readEnvPluginPackages(env);
  return packages ? { packages } : undefined;
}

/** Return registrations that expose in-process runtime hooks. */
export function pluginHookRegistrationsFromPluginSet(
  pluginSet: JuniorPluginSet | undefined,
): PluginRegistration[] {
  return pluginSet?.registrations.filter((plugin) => plugin.hooks) ?? [];
}
