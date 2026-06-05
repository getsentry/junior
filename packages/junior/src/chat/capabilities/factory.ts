import type { StateAdapter } from "chat";
import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import type { CredentialContext } from "@/chat/credentials/context";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import {
  createPluginBroker,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { getStateAdapter } from "@/chat/state/adapter";

interface CapabilityFactoryDeps {
  createPluginBroker: typeof createPluginBroker;
  createUserTokenStoreForStateAdapter(
    stateAdapter: StateAdapter,
  ): UserTokenStore;
  getPluginProviders: typeof getPluginProviders;
  getStateAdapter: typeof getStateAdapter;
  logCapabilityCatalogLoadedOnce: typeof logCapabilityCatalogLoadedOnce;
  routerCache: WeakMap<StateAdapter, ProviderCredentialRouter>;
}

const sandboxEgressRouters = new WeakMap<
  StateAdapter,
  ProviderCredentialRouter
>();

const defaultCapabilityFactoryDeps: CapabilityFactoryDeps = {
  createPluginBroker,
  createUserTokenStoreForStateAdapter: (stateAdapter) =>
    new StateAdapterTokenStore(stateAdapter),
  getPluginProviders,
  getStateAdapter,
  logCapabilityCatalogLoadedOnce,
  routerCache: sandboxEgressRouters,
};

/** Create the user token store used by OAuth-backed credential brokers. */
export function createUserTokenStore(
  deps: CapabilityFactoryDeps = defaultCapabilityFactoryDeps,
): UserTokenStore {
  return deps.createUserTokenStoreForStateAdapter(deps.getStateAdapter());
}

function createProviderCredentialRouter(
  userTokenStore: UserTokenStore,
  deps: CapabilityFactoryDeps,
): ProviderCredentialRouter {
  deps.logCapabilityCatalogLoadedOnce();

  const brokersByProvider: Record<string, CredentialBroker> = {};

  for (const plugin of deps.getPluginProviders()) {
    const { name } = plugin.manifest;
    if (!plugin.manifest.credentials && !plugin.manifest.apiHeaders) {
      continue;
    }
    brokersByProvider[name] = deps.createPluginBroker(name, { userTokenStore });
  }

  return new ProviderCredentialRouter({ brokersByProvider });
}

function getSandboxEgressRouter(
  deps: CapabilityFactoryDeps,
): ProviderCredentialRouter {
  const stateAdapter = deps.getStateAdapter();
  let router = deps.routerCache.get(stateAdapter);
  if (!router) {
    router = createProviderCredentialRouter(
      deps.createUserTokenStoreForStateAdapter(stateAdapter),
      deps,
    );
    deps.routerCache.set(stateAdapter, router);
  }
  return router;
}

/** Issue one provider credential lease for host-side sandbox egress proxying. */
export async function issueProviderCredentialLease(
  input: {
    context: CredentialContext;
    provider: string;
    reason: string;
  },
  deps: CapabilityFactoryDeps = defaultCapabilityFactoryDeps,
): Promise<CredentialLease> {
  return await getSandboxEgressRouter(deps).issue(input);
}
