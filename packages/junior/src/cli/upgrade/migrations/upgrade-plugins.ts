import type { PluginRegistration } from "@sentry/junior-plugin-api";
import type {
  InlinePluginManifestDefinition,
  PluginCatalogConfig,
} from "@/chat/plugins/types";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromEnv,
  pluginCatalogConfigFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";
import type { MigrationContext } from "../types";

interface TrustedUpgradePlugin {
  load(): Promise<PluginRegistration>;
  packageName: string;
}

interface ResolvedUpgradePlugins {
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
}

const TRUSTED_UPGRADE_PLUGINS: TrustedUpgradePlugin[] = [
  {
    packageName: "@sentry/junior-scheduler",
    async load() {
      const { schedulerPlugin } = await import("@sentry/junior-scheduler");
      return schedulerPlugin();
    },
  },
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function baseCatalogConfig(
  context: MigrationContext,
): PluginCatalogConfig | undefined {
  return (
    context.pluginCatalogConfig ??
    (context.pluginSet
      ? pluginCatalogConfigFromPluginSet(context.pluginSet)
      : pluginCatalogConfigFromEnv())
  );
}

function inlinePluginName(definition: InlinePluginManifestDefinition): string {
  return definition.manifest.name;
}

function mergeInlineManifests(
  left: InlinePluginManifestDefinition[] | undefined,
  right: InlinePluginManifestDefinition[] | undefined,
): InlinePluginManifestDefinition[] | undefined {
  const merged = new Map<string, InlinePluginManifestDefinition>();
  for (const definition of [...(left ?? []), ...(right ?? [])]) {
    merged.set(inlinePluginName(definition), definition);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function mergeCatalogConfig(
  base: PluginCatalogConfig | undefined,
  added: PluginCatalogConfig | undefined,
): PluginCatalogConfig | undefined {
  if (!base) {
    return added;
  }
  if (!added) {
    return base;
  }
  const inlineManifests = mergeInlineManifests(
    base.inlineManifests,
    added.inlineManifests,
  );
  const packages = unique([
    ...(base.packages ?? []),
    ...(added.packages ?? []),
  ]);
  const manifests =
    base.manifests || added.manifests
      ? { ...added.manifests, ...base.manifests }
      : undefined;
  return {
    ...(inlineManifests ? { inlineManifests } : {}),
    ...(packages.length > 0 ? { packages } : {}),
    ...(manifests ? { manifests } : {}),
  };
}

function packageNamesFromContext(
  context: MigrationContext,
  catalog: PluginCatalogConfig | undefined,
): string[] {
  return unique([
    ...(context.pluginSet?.packageNames ?? []),
    ...(catalog?.packages ?? []),
  ]);
}

function hasRegistration(
  registrations: PluginRegistration[],
  pluginName: string,
): boolean {
  return registrations.some(
    (registration) => registration.manifest.name === pluginName,
  );
}

async function trustedRegistrationsForPackages(args: {
  packageNames: string[];
  registrations: PluginRegistration[];
}): Promise<PluginRegistration[]> {
  const registrations: PluginRegistration[] = [];
  for (const plugin of TRUSTED_UPGRADE_PLUGINS) {
    if (!args.packageNames.includes(plugin.packageName)) {
      continue;
    }
    const registration = await plugin.load();
    if (
      hasRegistration(args.registrations, registration.manifest.name) ||
      hasRegistration(registrations, registration.manifest.name)
    ) {
      continue;
    }
    registrations.push(registration);
  }
  return registrations;
}

/** Resolve one effective plugin set and catalog for all upgrade migrations. */
export async function resolveUpgradePlugins(
  context: MigrationContext,
): Promise<ResolvedUpgradePlugins> {
  const catalog = baseCatalogConfig(context);
  const packageNames = packageNamesFromContext(context, catalog);
  const baseRegistrations = context.pluginSet?.registrations ?? [];
  const trustedRegistrations = await trustedRegistrationsForPackages({
    packageNames,
    registrations: baseRegistrations,
  });
  const registrations = [...baseRegistrations, ...trustedRegistrations];
  const manifests =
    context.pluginSet?.manifests || catalog?.manifests
      ? {
          ...catalog?.manifests,
          ...context.pluginSet?.manifests,
        }
      : undefined;
  const pluginSet =
    packageNames.length > 0 || registrations.length > 0 || context.pluginSet
      ? defineJuniorPlugins(
          [...packageNames, ...registrations],
          manifests ? { manifests } : {},
        )
      : undefined;

  return {
    pluginCatalogConfig: mergeCatalogConfig(
      catalog,
      pluginCatalogConfigFromPluginSet(pluginSet),
    ),
    ...(pluginSet ? { pluginSet } : {}),
  };
}
