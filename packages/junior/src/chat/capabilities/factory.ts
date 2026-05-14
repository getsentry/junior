import type { StateAdapter } from "chat";
import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type {
  CredentialBroker,
  CredentialLease,
  CredentialHeaderTransform,
} from "@/chat/credentials/broker";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import {
  createPluginBroker,
  getPluginProviders,
} from "@/chat/plugins/registry";
import type { PluginDefinition, PluginManifest } from "@/chat/plugins/types";
import { getStateAdapter } from "@/chat/state/adapter";

const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const sandboxEgressRouters = new WeakMap<
  StateAdapter,
  ProviderCredentialRouter
>();

/** Create the user token store used by OAuth-backed credential brokers. */
export function createUserTokenStore(): UserTokenStore {
  return new StateAdapterTokenStore(getStateAdapter());
}

function resolveTestApiHeaderTransforms(
  manifest: PluginManifest,
): CredentialHeaderTransform[] {
  const { domains, apiHeaders } = manifest;
  if (!domains || !apiHeaders) {
    return [];
  }
  // Eval mode must not read deployment secrets; placeholders become dummy values.
  const headers = Object.fromEntries(
    Object.entries(apiHeaders).map(([key, value]) => [
      key,
      value.replace(ENV_PLACEHOLDER_RE, (_match, name) => {
        return `eval-test-${String(name).toLowerCase().replaceAll("_", "-")}`;
      }),
    ]),
  );
  return domains.map((domain) => ({ domain, headers }));
}

function createTestBroker(plugin: PluginDefinition): TestCredentialBroker {
  const { apiHeaders, credentials, name } = plugin.manifest;
  const commandEnv = resolvePluginCommandEnv(plugin.manifest);
  return new TestCredentialBroker({
    provider: name,
    ...(credentials
      ? {
          domains: credentials.domains,
          ...(credentials.apiHeaders
            ? { apiHeaders: credentials.apiHeaders }
            : {}),
          envKey: credentials.authTokenEnv,
          placeholder: resolveAuthTokenPlaceholder(credentials),
        }
      : {}),
    ...(apiHeaders
      ? {
          headerTransforms: () =>
            resolveTestApiHeaderTransforms(plugin.manifest),
        }
      : {}),
    ...(Object.keys(commandEnv).length > 0 ? { env: commandEnv } : {}),
  });
}

function createProviderCredentialRouter(
  userTokenStore: UserTokenStore,
): ProviderCredentialRouter {
  logCapabilityCatalogLoadedOnce();
  const useTestBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1";

  const brokersByProvider: Record<string, CredentialBroker> = {};

  for (const plugin of getPluginProviders()) {
    const { name } = plugin.manifest;
    if (!plugin.manifest.credentials && !plugin.manifest.apiHeaders) {
      continue;
    }
    brokersByProvider[name] = useTestBroker
      ? createTestBroker(plugin)
      : createPluginBroker(name, { userTokenStore });
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
