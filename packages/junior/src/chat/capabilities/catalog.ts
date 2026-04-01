import { logInfo } from "@/chat/logging";
import { getPluginCapabilityProviders } from "@/chat/plugins/registry";

export interface CapabilityProviderTargetDefinition {
  type: "repo";
  configKey: string;
}

export interface CapabilityProviderDefinition {
  provider: string;
  capabilities: string[];
  configKeys: string[];
  target?: CapabilityProviderTargetDefinition;
}

let cachedCatalog:
  | {
      providers: CapabilityProviderDefinition[];
      capabilityToProvider: Map<string, CapabilityProviderDefinition>;
      configKeys: Set<string>;
    }
  | undefined;

/** Build (and cache) the capability catalog from registered plugins. */
function getCapabilityCatalog() {
  if (cachedCatalog) return cachedCatalog;

  const providers = getPluginCapabilityProviders();
  const capabilityToProvider = new Map<string, CapabilityProviderDefinition>();
  const configKeys = new Set<string>();

  for (const provider of providers) {
    for (const capability of provider.capabilities) {
      if (capabilityToProvider.has(capability)) {
        throw new Error(
          `Duplicate capability registration for "${capability}"`,
        );
      }
      capabilityToProvider.set(capability, provider);
    }
    for (const configKey of provider.configKeys) {
      configKeys.add(configKey);
    }
  }

  cachedCatalog = { providers, capabilityToProvider, configKeys };
  return cachedCatalog;
}

export function getCapabilityProvider(
  capability: string,
): CapabilityProviderDefinition | undefined {
  return getCapabilityCatalog().capabilityToProvider.get(capability);
}

export function isKnownCapability(capability: string): boolean {
  return getCapabilityCatalog().capabilityToProvider.has(capability);
}

export function isKnownConfigKey(key: string): boolean {
  return getCapabilityCatalog().configKeys.has(key);
}

export function listCapabilityProviders(): CapabilityProviderDefinition[] {
  return getCapabilityCatalog().providers;
}

let catalogLogged = false;

/** Log the capability catalog contents once at startup. */
export function logCapabilityCatalogLoadedOnce(): void {
  if (catalogLogged) return;
  catalogLogged = true;

  const { providers } = getCapabilityCatalog();
  const capabilityNames = providers.flatMap((p) => p.capabilities).sort();
  const configKeys = [
    ...new Set(providers.flatMap((p) => p.configKeys)),
  ].sort();
  logInfo(
    "capability_catalog_loaded",
    {},
    {
      "app.capability.providers": providers.map((p) => p.provider),
      "app.capability.count": capabilityNames.length,
      "app.capability.names": capabilityNames,
      "app.config.key_count": configKeys.length,
      "app.config.keys": configKeys,
    },
    "Loaded capability provider catalog",
  );
}
