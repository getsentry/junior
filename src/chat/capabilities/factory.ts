import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { GitHubCredentialBroker } from "@/chat/credentials/github-broker";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { createPluginBroker, getPluginProviders } from "@/chat/plugins/registry";
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
export function createSkillCapabilityRuntime(options: {
  invocationArgs?: string;
  requesterId?: string;
  resolveConfiguration?: (key: string) => Promise<unknown>;
} = {}): SkillCapabilityRuntime {
  logCapabilityCatalogLoadedOnce();
  const useTestBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1";
  const userTokenStore = getUserTokenStore();

  // Hardcoded providers (not yet plugins)
  const brokersByProvider: Record<string, CredentialBroker> = {
    github: useTestBroker ? new TestCredentialBroker() : new GitHubCredentialBroker()
  };

  // Plugin providers
  for (const plugin of getPluginProviders()) {
    brokersByProvider[plugin.manifest.name] = useTestBroker
      ? new TestCredentialBroker()
      : createPluginBroker(plugin.manifest.name, { userTokenStore });
  }

  const router = new ProviderCredentialRouter({ brokersByProvider });

  return new SkillCapabilityRuntime({
    router,
    invocationArgs: options.invocationArgs,
    requesterId: options.requesterId,
    resolveConfiguration: options.resolveConfiguration
  });
}
