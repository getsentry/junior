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
  return getCapabilityCatalog().providers.map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys],
  }));
}

let startupCatalogSignature: string | null = null;

export function logCapabilityCatalogLoadedOnce(): void {
  const providers = listCapabilityProviders();
  const signature = JSON.stringify(
    providers.map((provider) => ({
      provider: provider.provider,
      capabilities: provider.capabilities,
      configKeys: provider.configKeys,
      target: provider.target,
    })),
  );
  if (startupCatalogSignature === signature) {
    return;
  }
  startupCatalogSignature = signature;

  const capabilityNames = providers
    .flatMap((provider) => provider.capabilities)
    .sort();
  const configKeys = [
    ...new Set(providers.flatMap((provider) => provider.configKeys)),
  ].sort();
  logInfo(
    "capability_catalog_loaded",
    {},
    {
      "app.capability.providers": providers.map(
        (provider) => provider.provider,
      ),
      "app.capability.count": capabilityNames.length,
      "app.capability.names": capabilityNames,
      "app.config.key_count": configKeys.length,
      "app.config.keys": configKeys,
    },
    "Loaded capability provider catalog",
  );
}
