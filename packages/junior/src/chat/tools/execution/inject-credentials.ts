import { logInfo } from "@/chat/logging";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import {
  COMMAND_PROXY_ACTIVE_PROVIDERS_ENV,
  COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS_ENV,
} from "@/chat/sandbox/command-proxy-env";

interface CredentialInjection {
  headerTransforms?: Array<{ domain: string; [key: string]: unknown }>;
  env?: Record<string, string>;
}

interface CommandProxyCredentialState {
  activeProviders: string[];
  authRequiredProviders: string[];
}

function listEnv(values: string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

function commandProxyEnv(
  state: CommandProxyCredentialState | undefined,
): Record<string, string> {
  if (!state) {
    return {};
  }

  const activeProviders = listEnv(state.activeProviders);
  const authRequiredProviders = listEnv(state.authRequiredProviders);
  return {
    ...(activeProviders
      ? {
          [COMMAND_PROXY_ACTIVE_PROVIDERS_ENV]: activeProviders,
        }
      : {}),
    ...(authRequiredProviders
      ? {
          [COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS_ENV]: authRequiredProviders,
        }
      : {}),
  };
}

/** Resolve host-owned credential injection for a sandbox bash command. */
export function resolveCredentialInjection(
  capabilityRuntime: SkillCapabilityRuntime | undefined,
  commandProxyState?: CommandProxyCredentialState,
): CredentialInjection {
  if (!capabilityRuntime) {
    return {};
  }

  const headerTransforms = capabilityRuntime.getTurnHeaderTransforms();
  const env = {
    ...(capabilityRuntime.getTurnEnv() ?? {}),
    ...commandProxyEnv(commandProxyState),
  };
  const resolvedEnv = Object.keys(env).length > 0 ? env : undefined;
  const shouldLog = Boolean(headerTransforms && headerTransforms.length > 0);

  if (shouldLog) {
    const headerDomains = (headerTransforms ?? []).map(
      (transform) => transform.domain,
    );
    const providers = capabilityRuntime.getEnabledProviders();
    logInfo(
      "credential_inject_start",
      {},
      {
        "app.credential.providers": providers,
        "app.credential.delivery": "header_transform",
        "app.credential.header_domains": headerDomains,
      },
      `Injecting scoped credential headers for sandbox command (${providers.join(", ")} → ${headerDomains.join(", ")})`,
    );
  }

  return { headerTransforms, env: resolvedEnv };
}
