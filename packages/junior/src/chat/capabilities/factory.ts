import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth-token-placeholder";
import {
  createPluginBroker,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { getStateAdapter } from "@/chat/state";

let _userTokenStore: UserTokenStore | undefined;

export function getUserTokenStore(): UserTokenStore {
  if (!_userTokenStore) {
    _userTokenStore = new StateAdapterTokenStore(getStateAdapter());
  }
  return _userTokenStore;
}

// Encapsulation boundary for capability runtime construction.
// Swap broker strategy here (provider router, test broker, etc.) without
// changing agent orchestration code in respond.ts.
export function createSkillCapabilityRuntime(
  options: {
    invocationArgs?: string;
    requesterId?: string;
    resolveConfiguration?: (key: string) => Promise<unknown>;
  } = {},
): SkillCapabilityRuntime {
  logCapabilityCatalogLoadedOnce();
  const useTestBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1";
  const userTokenStore = getUserTokenStore();

  const brokersByProvider: Record<string, CredentialBroker> = {};

  // Plugin providers
  for (const plugin of getPluginProviders()) {
    const { credentials, name } = plugin.manifest;
    if (!credentials) {
      continue;
    }
    const placeholder = resolveAuthTokenPlaceholder(credentials);
    brokersByProvider[name] = useTestBroker
      ? new TestCredentialBroker({
          provider: name,
          domains: credentials.apiDomains,
          apiHeaders: credentials.apiHeaders,
          envKey: credentials.authTokenEnv,
          placeholder,
        })
      : createPluginBroker(name, { userTokenStore });
  }

  const router = new ProviderCredentialRouter({ brokersByProvider });

  return new SkillCapabilityRuntime({
    router,
    invocationArgs: options.invocationArgs,
    requesterId: options.requesterId,
    resolveConfiguration: options.resolveConfiguration,
  });
}
