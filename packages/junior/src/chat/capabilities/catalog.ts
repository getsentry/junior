import { logInfo } from "@/chat/logging";
import {
  getPluginCapabilityProviders,
  getPluginCatalogSignature,
} from "@/chat/plugins/registry";

interface CapabilityCatalogSource {
  getPluginCapabilityProviders(): CapabilityProviderDefinition[];
  getPluginCatalogSignature(): string;
}

interface CapabilityCatalogDeps extends CapabilityCatalogSource {
  logInfo: typeof logInfo;
}

export interface CapabilityProviderTargetDefinition {
  type: string;
  configKey: string;
  commandFlags?: string[];
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
    }
  | undefined;

const defaultCapabilityCatalogDeps: CapabilityCatalogDeps = {
  getPluginCapabilityProviders,
  getPluginCatalogSignature,
  logInfo,
};

function cloneProviderDefinition(
  provider: CapabilityProviderDefinition,
): CapabilityProviderDefinition {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys],
    ...(provider.target
      ? {
          target: {
            ...provider.target,
            ...(provider.target.commandFlags
              ? { commandFlags: [...provider.target.commandFlags] }
              : {}),
          },
        }
      : {}),
  };
}

/** Build (and cache) the capability catalog from registered plugins. */
function getCapabilityCatalog(source: CapabilityCatalogSource) {
  const signature = source.getPluginCatalogSignature();
  if (cachedCatalog?.signature === signature) return cachedCatalog;

  const providers = source.getPluginCapabilityProviders();
  const capabilityToProvider = new Map<string, CapabilityProviderDefinition>();

  for (const provider of providers) {
    for (const capability of provider.capabilities) {
      if (capabilityToProvider.has(capability)) {
        throw new Error(
          `Duplicate capability registration for "${capability}"`,
        );
      }
      capabilityToProvider.set(capability, provider);
    }
  }

  cachedCatalog = { signature, providers, capabilityToProvider };
  return cachedCatalog;
}

/** Return the plugin provider that owns a capability. */
export function getCapabilityProvider(
  capability: string,
  source: CapabilityCatalogSource = defaultCapabilityCatalogDeps,
): CapabilityProviderDefinition | undefined {
  const provider =
    getCapabilityCatalog(source).capabilityToProvider.get(capability);
  return provider ? cloneProviderDefinition(provider) : undefined;
}

/** Check whether a capability is registered by any plugin provider. */
export function isKnownCapability(
  capability: string,
  source: CapabilityCatalogSource = defaultCapabilityCatalogDeps,
): boolean {
  return getCapabilityCatalog(source).capabilityToProvider.has(capability);
}

/** List all registered capability providers. */
export function listCapabilityProviders(
  source: CapabilityCatalogSource = defaultCapabilityCatalogDeps,
): CapabilityProviderDefinition[] {
  return getCapabilityCatalog(source).providers.map(cloneProviderDefinition);
}

let catalogLogged = false;

/** Log the capability catalog contents once at startup. */
export function logCapabilityCatalogLoadedOnce(
  deps: CapabilityCatalogDeps = defaultCapabilityCatalogDeps,
): void {
  if (catalogLogged) return;
  catalogLogged = true;

  const { providers } = getCapabilityCatalog(deps);
  const capabilityNames = providers.flatMap((p) => p.capabilities).sort();
  const configKeys = [
    ...new Set(providers.flatMap((p) => p.configKeys)),
  ].sort();
  deps.logInfo(
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
