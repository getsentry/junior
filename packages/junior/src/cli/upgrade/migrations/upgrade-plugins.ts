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

interface ResolvedUpgradePlugins {
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
}

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
      ? { ...base.manifests, ...added.manifests }
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

/** Resolve one effective plugin set and catalog for all upgrade migrations. */
export async function resolveUpgradePlugins(
  context: MigrationContext,
): Promise<ResolvedUpgradePlugins> {
  const catalog = baseCatalogConfig(context);
  const packageNames = packageNamesFromContext(context, catalog);
  const registrations = context.pluginSet?.registrations ?? [];
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
