import type { CapabilityTarget } from "@/chat/capabilities/types";
import { logInfo, logWarn } from "@/chat/observability";
import { extractCapabilityTarget, parseRepoTarget } from "@/chat/capabilities/target";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

// Spec: specs/skill-capabilities-spec.md (runtime capability resolution + injection)
// Spec: specs/security-policy.md (credential scope and lifecycle requirements)

export class SkillCapabilityRuntime {
  private readonly broker: CredentialBroker;
  private readonly invocationArgs?: string;

  constructor(params: { broker: CredentialBroker; invocationArgs?: string }) {
    this.broker = params.broker;
    this.invocationArgs = params.invocationArgs;
  }

  async issueCapabilityLease(input: {
    activeSkill: Skill | null;
    capability: string;
    repoRef?: string;
    reason: string;
  }): Promise<CredentialLease> {
    const activeSkill = input.activeSkill;

    const explicitTarget = input.repoRef ? parseRepoTarget(input.repoRef) : undefined;
    const target = explicitTarget
      ? explicitTarget
      : extractCapabilityTarget({
          skillName: activeSkill?.name ?? "unknown",
          commandText: "",
          invocationArgs: this.invocationArgs
        });

    return await this.broker.issue({
      capability: input.capability,
      target,
      reason: input.reason
    });
  }

  async resolveBashEnv(input: { command: string; activeSkill: Skill | null }): Promise<Record<string, string> | undefined> {
    const activeSkill = input.activeSkill;
    const required = activeSkill?.requiresCapabilities ?? [];
    if (!activeSkill || required.length === 0) {
      return undefined;
    }

    const target = extractCapabilityTarget({
      skillName: activeSkill.name,
      commandText: input.command,
      invocationArgs: this.invocationArgs
    });
    const targetRef = target?.owner && target?.repo ? `${target.owner}/${target.repo}` : "unknown";

    logInfo(
      "credential_issue_request",
      {},
      {
        "app.skill.name": activeSkill.name,
        "app.capability.count": required.length,
        "app.capability.target": targetRef
      },
      "Resolving capability-based credentials"
    );

    try {
      const allowedCapabilities = required;
      const githubCapabilities = allowedCapabilities.filter((capability) => capability.startsWith("github."));

      const env: Record<string, string> = {};
      if (githubCapabilities.length > 0) {
        // Issue one GitHub token per command by collapsing to the highest required permission.
        const capability = githubCapabilities.some((candidate) => candidate !== "github.issues.read")
          ? "github.issues.write"
          : "github.issues.read";
        const lease = await this.issueCapabilityLease({
          activeSkill,
          capability,
          repoRef: target?.owner && target?.repo ? `${target.owner}/${target.repo}` : undefined,
          reason: `skill:${activeSkill.name}:bash`
        });
        logInfo(
          "credential_issue_success",
          {},
          {
            "app.skill.name": activeSkill.name,
            "app.capability.name": capability,
            "app.capability.target": targetRef,
            "app.credential.provider": lease.provider,
            "app.credential.expires_at": lease.expiresAt
          },
          "Issued capability credential lease"
        );
        Object.assign(env, lease.env);
      }

      if (allowedCapabilities.length > 0 && Object.keys(env).length === 0) {
        logWarn(
          "credential_issue_no_supported_provider",
          {},
          {
            "app.skill.name": activeSkill.name,
            "app.capability.count": allowedCapabilities.length
          },
          "No provider-specific credential injector matched allowed capabilities"
        );
      }

      return Object.keys(env).length > 0 ? env : undefined;
    } catch (error) {
      logWarn(
        "credential_issue_failed",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.capability.target": targetRef,
          "error.message": error instanceof Error ? error.message : String(error)
        },
        "Capability credential resolution failed"
      );
      throw error;
    }
  }
}
