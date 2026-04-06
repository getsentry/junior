import { logInfo } from "@/chat/logging";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";

export interface CredentialInjection {
  headerTransforms?: Array<{ domain: string; [key: string]: unknown }>;
  env?: Record<string, string>;
  shouldLog: boolean;
}

/** Resolve credential injection for a tool call (only applies to bash). */
export function resolveCredentialInjection(
  toolName: string,
  command: string,
  capabilityRuntime: SkillCapabilityRuntime | undefined,
  sandbox: SkillSandbox,
): CredentialInjection {
  if (toolName !== "bash" || !capabilityRuntime) {
    return { shouldLog: false };
  }

  const headerTransforms = capabilityRuntime.getTurnHeaderTransforms();
  const env = capabilityRuntime.getTurnEnv();
  const isCustomCommand = /^jr-rpc(?:\s|$)/.test(command.trim());
  const shouldLog =
    !isCustomCommand &&
    Boolean(headerTransforms && headerTransforms.length > 0);

  if (shouldLog) {
    const headerDomains = (headerTransforms ?? []).map(
      (transform) => transform.domain,
    );
    logInfo(
      "credential_inject_start",
      {},
      {
        "app.skill.name": sandbox.getActiveSkill()?.name,
        "app.credential.delivery": "header_transform",
        "app.credential.header_domains": headerDomains,
      },
      "Injecting scoped credential headers for sandbox command",
    );
  }

  return { headerTransforms, env, shouldLog };
}
