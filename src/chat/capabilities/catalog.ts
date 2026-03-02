import { logInfo } from "@/chat/observability";
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

const CAPABILITY_PROVIDERS: CapabilityProviderDefinition[] = [
  {
    provider: "github",
    capabilities: [
      "github.issues.read",
      "github.issues.write",
      "github.issues.comment",
      "github.labels.write"
    ],
    configKeys: ["github.repo"],
    target: {
      type: "repo",
      configKey: "github.repo"
    }
  },
  // Plugin-provided capabilities are merged below
  ...getPluginCapabilityProviders()
];

const capabilityToProvider = new Map<string, CapabilityProviderDefinition>();
const configKeySet = new Set<string>();
let startupCatalogLogged = false;

for (const provider of CAPABILITY_PROVIDERS) {
  for (const capability of provider.capabilities) {
    if (capabilityToProvider.has(capability)) {
      throw new Error(`Duplicate capability registration for "${capability}"`);
    }
    capabilityToProvider.set(capability, provider);
  }
  for (const configKey of provider.configKeys) {
    configKeySet.add(configKey);
  }
}

export function getCapabilityProvider(capability: string): CapabilityProviderDefinition | undefined {
  return capabilityToProvider.get(capability);
}

export function isKnownCapability(capability: string): boolean {
  return capabilityToProvider.has(capability);
}

export function isKnownConfigKey(key: string): boolean {
  return configKeySet.has(key);
}

export function listCapabilityProviders(): CapabilityProviderDefinition[] {
  return CAPABILITY_PROVIDERS.map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys]
  }));
}

export function logCapabilityCatalogLoadedOnce(): void {
  if (startupCatalogLogged) {
    return;
  }
  startupCatalogLogged = true;

  const providers = listCapabilityProviders();
  const capabilityNames = providers.flatMap((provider) => provider.capabilities).sort();
  const configKeys = [...new Set(providers.flatMap((provider) => provider.configKeys))].sort();
  logInfo(
    "capability_catalog_loaded",
    {},
    {
      "app.capability.providers": providers.map((provider) => provider.provider),
      "app.capability.count": capabilityNames.length,
      "app.capability.names": capabilityNames,
      "app.config.key_count": configKeys.length,
      "app.config.keys": configKeys
    },
    "Loaded capability provider catalog"
  );
}
