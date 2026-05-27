import type { StateAdapter } from "chat";
import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import {
  createPluginBroker,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { getStateAdapter } from "@/chat/state/adapter";

const sandboxEgressRouters = new WeakMap<
  StateAdapter,
  ProviderCredentialRouter
>();

/** Create the user token store used by OAuth-backed credential brokers. */
export function createUserTokenStore(): UserTokenStore {
  return new StateAdapterTokenStore(getStateAdapter());
}

function createProviderCredentialRouter(
  userTokenStore: UserTokenStore,
): ProviderCredentialRouter {
  logCapabilityCatalogLoadedOnce();

  const brokersByProvider: Record<string, CredentialBroker> = {};

  for (const plugin of getPluginProviders()) {
    const { name } = plugin.manifest;
    if (!plugin.manifest.credentials && !plugin.manifest.apiHeaders) {
      continue;
    }
    brokersByProvider[name] = createPluginBroker(name, { userTokenStore });
  }

  return new ProviderCredentialRouter({ brokersByProvider });
}

function getSandboxEgressRouter(): ProviderCredentialRouter {
  const stateAdapter = getStateAdapter();
  let router = sandboxEgressRouters.get(stateAdapter);
  if (!router) {
    router = createProviderCredentialRouter(
      new StateAdapterTokenStore(stateAdapter),
    );
    sandboxEgressRouters.set(stateAdapter, router);
  }
  return router;
}

/** Issue one provider credential lease for host-side sandbox egress proxying. */
export async function issueProviderCredentialLease(input: {
  provider: string;
  requesterId: string;
  reason: string;
}): Promise<CredentialLease> {
  return await getSandboxEgressRouter().issue(input);
}
