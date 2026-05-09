import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type {
  CredentialBroker,
  CredentialHeaderTransform,
} from "@/chat/credentials/broker";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import {
  createPluginBroker,
  getPluginProviders,
} from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";
import { getStateAdapter } from "@/chat/state/adapter";

const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function createUserTokenStore(): UserTokenStore {
  return new StateAdapterTokenStore(getStateAdapter());
}

function resolveTestApiHeaderTransforms(
  manifest: PluginManifest,
): CredentialHeaderTransform[] {
  const { apiDomains, apiHeaders } = manifest;
  if (!apiDomains || !apiHeaders) {
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
  return apiDomains.map((domain) => ({ domain, headers }));
}

// Encapsulation boundary for capability runtime construction.
// Swap broker strategy here (provider router, test broker, etc.) without
// changing agent orchestration code in respond.ts.
export function createSkillCapabilityRuntime(
  options: {
    requesterId?: string;
  } = {},
): SkillCapabilityRuntime {
  logCapabilityCatalogLoadedOnce();
  const useTestBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1";
  const userTokenStore = createUserTokenStore();

  const brokersByProvider: Record<string, CredentialBroker> = {};

  // Plugin providers
  for (const plugin of getPluginProviders()) {
    const { apiHeaders, credentials, name } = plugin.manifest;
    if (!credentials && !apiHeaders) {
      continue;
    }
    if (!credentials) {
      brokersByProvider[name] = useTestBroker
        ? new TestCredentialBroker({
            provider: name,
            headerTransforms: () =>
              resolveTestApiHeaderTransforms(plugin.manifest),
            ...(plugin.manifest.commandEnv
              ? { env: plugin.manifest.commandEnv }
              : {}),
          })
        : createPluginBroker(name, { userTokenStore });
      continue;
    }

    const placeholder = resolveAuthTokenPlaceholder(credentials);
    brokersByProvider[name] = useTestBroker
      ? new TestCredentialBroker({
          provider: name,
          domains: credentials.apiDomains,
          ...(credentials.apiHeaders
            ? { apiHeaders: credentials.apiHeaders }
            : {}),
          ...(apiHeaders
            ? {
                headerTransforms: () =>
                  resolveTestApiHeaderTransforms(plugin.manifest),
              }
            : {}),
          ...(plugin.manifest.commandEnv
            ? { env: plugin.manifest.commandEnv }
            : {}),
          envKey: credentials.authTokenEnv,
          placeholder,
        })
      : createPluginBroker(name, { userTokenStore });
  }

  const router = new ProviderCredentialRouter({ brokersByProvider });

  return new SkillCapabilityRuntime({
    router,
    requesterId: options.requesterId,
  });
}
