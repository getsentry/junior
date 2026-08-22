import type {
  InlinePluginManifestDefinition,
  PluginCatalogConfig,
} from "@/chat/plugins/types";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromEnv,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import type { UpgradeContext } from "../types";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function baseCatalogConfig(
  context: UpgradeContext,
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
    ...(inlineManifests ? { inlineManifests } : undefined),
    ...(packages.length > 0 ? { packages } : undefined),
    ...(manifests ? { manifests } : undefined),
  };
}

function packageNamesFromContext(
  context: UpgradeContext,
  catalog: PluginCatalogConfig | undefined,
): string[] {
  return unique([
    ...(context.pluginSet?.packageNames ?? []),
    ...(catalog?.packages ?? []),
  ]);
}

/** Resolve the plugin catalog used by SQL upgrade migrations. */
export async function resolveUpgradePluginCatalog(
  context: UpgradeContext,
): Promise<PluginCatalogConfig | undefined> {
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

  return mergeCatalogConfig(
    catalog,
    pluginCatalogConfigFromPluginSet(pluginSet),
  );
}
