import { logInfo } from "@/chat/logging";
import {
  getPluginCapabilityProviders,
  getPluginCatalogSignature,
} from "@/chat/plugins/registry";

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
      signature: string;
      providers: CapabilityProviderDefinition[];
      capabilityToProvider: Map<string, CapabilityProviderDefinition>;
      configKeys: Set<string>;
    }
  | undefined;

function cloneProviderDefinition(
  provider: CapabilityProviderDefinition,
): CapabilityProviderDefinition {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys],
    ...(provider.target ? { target: { ...provider.target } } : {}),
  };
}

/** Build (and cache) the capability catalog from registered plugins. */
function getCapabilityCatalog() {
  const signature = getPluginCatalogSignature();
  if (cachedCatalog?.signature === signature) return cachedCatalog;

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

  cachedCatalog = { signature, providers, capabilityToProvider, configKeys };
  return cachedCatalog;
}

export function getCapabilityProvider(
  capability: string,
): CapabilityProviderDefinition | undefined {
  const provider = getCapabilityCatalog().capabilityToProvider.get(capability);
  return provider ? cloneProviderDefinition(provider) : undefined;
}

export function isKnownCapability(capability: string): boolean {
  return getCapabilityCatalog().capabilityToProvider.has(capability);
}

export function isKnownConfigKey(key: string): boolean {
  return getCapabilityCatalog().configKeys.has(key);
}

export function listCapabilityProviders(): CapabilityProviderDefinition[] {
  return getCapabilityCatalog().providers.map(cloneProviderDefinition);
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
