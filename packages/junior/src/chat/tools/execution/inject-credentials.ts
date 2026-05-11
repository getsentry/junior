import { logInfo } from "@/chat/logging";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import {
  COMMAND_PROXY_ACTIVE_PROVIDERS_ENV,
  COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS_ENV,
} from "@/chat/sandbox/command-proxy-env";

export interface CredentialInjection {
  headerTransforms?: Array<{ domain: string; [key: string]: unknown }>;
  env?: Record<string, string>;
}

export interface CommandProxyCredentialState {
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

/** Resolve credential injection for a tool call (only applies to bash). */
export function resolveCredentialInjection(
  toolName: string,
  command: string,
  capabilityRuntime: SkillCapabilityRuntime | undefined,
  sandbox: SkillSandbox,
  commandProxyState?: CommandProxyCredentialState,
): CredentialInjection {
  if (toolName !== "bash" || !capabilityRuntime) {
    return {};
  }

  const isJrRpcCommand = /^jr-rpc(?:\s|$)/.test(command.trim());
  if (isJrRpcCommand) {
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
    const skillName = sandbox.getActiveSkill()?.name;
    logInfo(
      "credential_inject_start",
      {},
      {
        "app.skill.name": skillName,
        "app.credential.delivery": "header_transform",
        "app.credential.header_domains": headerDomains,
      },
      `Injecting scoped credential headers for sandbox command (${skillName ?? "unknown skill"} → ${headerDomains.join(", ")})`,
    );
  }

  return { headerTransforms, env: resolvedEnv };
}
