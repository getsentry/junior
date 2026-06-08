import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";
import type {
  InlinePluginManifestDefinition,
  PluginCatalogConfig,
  PluginManifestConfig,
} from "@/chat/plugins/types";

export type JuniorPluginInput = JuniorPluginRegistration | string;

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
  registrations: JuniorPluginRegistration[];
}

function cloneManifests(
  manifests: Record<string, PluginManifestConfig> | undefined,
): Record<string, PluginManifestConfig> | undefined {
  return manifests ? structuredClone(manifests) : undefined;
}

function cloneInlineManifests(
  registrations: JuniorPluginRegistration[],
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
                    : `${plugin.manifest!.name}.${capability}`,
                ) ?? [],
              configKeys:
                plugin.manifest.configKeys?.map((key) =>
                  key.includes(".") ? key : `${plugin.manifest!.name}.${key}`,
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

function assertUniquePluginNames(
  registrations: JuniorPluginRegistration[],
): void {
  const seen = new Set<string>();
  for (const plugin of registrations) {
    if (seen.has(plugin.name)) {
      throw new Error(`Duplicate plugin registration name "${plugin.name}"`);
    }
    seen.add(plugin.name);
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
  registration?: JuniorPluginRegistration;
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

/** Return registrations that expose in-process runtime hooks. */
export function pluginHookRegistrationsFromPluginSet(
  pluginSet: JuniorPluginSet | undefined,
): JuniorPluginRegistration[] {
  return (
    pluginSet?.registrations.filter(
      (plugin) => plugin.hooks || plugin.legacyStatePrefixes,
    ) ?? []
  );
}
