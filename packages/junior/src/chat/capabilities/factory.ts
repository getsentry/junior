import type { StateAdapter } from "chat";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import type { CredentialContext } from "@/chat/credentials/context";
import {
  StateAdapterInstallationTokenStore,
  StateAdapterTokenStore,
} from "@/chat/credentials/state-adapter-token-store";
import type { InstallationTokenStore } from "@/chat/credentials/installation-token-store";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { getStateAdapter } from "@/chat/state/adapter";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";

const sandboxEgressRouters = new WeakMap<
  StateAdapter,
  Map<string, ProviderCredentialRouter>
>();

/** Create the user token store used by OAuth-backed credential brokers. */
export function createUserTokenStore(): UserTokenStore {
  return new StateAdapterTokenStore(getStateAdapter());
}

/** Create the token store used by installation OAuth grants. */
export function createInstallationTokenStore(
  workspaceId?: string,
): InstallationTokenStore {
  return new StateAdapterInstallationTokenStore(
    getStateAdapter(),
    workspaceId ?? getWorkspaceTeamId(),
  );
}

function createProviderCredentialRouter(
  stateAdapter: StateAdapter,
  workspaceId?: string,
): ProviderCredentialRouter {
  const brokersByProvider: Record<string, CredentialBroker> = {};

  for (const plugin of pluginCatalogRuntime.getProviders()) {
    const { name } = plugin.manifest;
    if (!plugin.manifest.credentials && !plugin.manifest.apiHeaders) {
      continue;
    }
    brokersByProvider[name] = pluginCatalogRuntime.createBroker(name, {
      installationTokenStore: new StateAdapterInstallationTokenStore(
        stateAdapter,
        workspaceId,
      ),
      userTokenStore: new StateAdapterTokenStore(stateAdapter),
    });
  }

  return new ProviderCredentialRouter({ brokersByProvider });
}

function getSandboxEgressRouter(): ProviderCredentialRouter {
  const stateAdapter = getStateAdapter();
  const workspaceId = getWorkspaceTeamId() ?? "local";
  let routers = sandboxEgressRouters.get(stateAdapter);
  if (!routers) {
    routers = new Map();
    sandboxEgressRouters.set(stateAdapter, routers);
  }
  let router = routers.get(workspaceId);
  if (!router) {
    router = createProviderCredentialRouter(stateAdapter, workspaceId);
    routers.set(workspaceId, router);
  }
  return router;
}

/** Issue one provider credential lease for host-side sandbox egress proxying. */
export async function issueProviderCredentialLease(input: {
  context: CredentialContext;
  provider: string;
  reason: string;
}): Promise<CredentialLease> {
  return await getSandboxEgressRouter().issue(input);
}
