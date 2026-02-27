import type { CapabilityTarget } from "@/chat/capabilities/types";
import { logInfo, logWarn } from "@/chat/observability";
import { extractCapabilityTarget, parseRepoTarget } from "@/chat/capabilities/target";
import type { CredentialBroker, CredentialHeaderTransform, CredentialLease } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

// Spec: specs/skill-capabilities-spec.md (runtime capability resolution + injection)
// Spec: specs/security-policy.md (credential scope and lifecycle requirements)

export class SkillCapabilityRuntime {
  private readonly broker: CredentialBroker;
  private readonly invocationArgs?: string;
  private readonly enabledByCapability = new Map<string, { expiresAtMs: number; transforms: CredentialHeaderTransform[] }>();

  constructor(params: { broker: CredentialBroker; invocationArgs?: string }) {
    this.broker = params.broker;
    this.invocationArgs = params.invocationArgs;
  }

  private resolveCapabilityTarget(activeSkill: Skill | null, repoRef?: string): CapabilityTarget | undefined {
    const explicitTarget = repoRef ? parseRepoTarget(repoRef) : undefined;
    if (explicitTarget) {
      return explicitTarget;
    }
    return extractCapabilityTarget({
      skillName: activeSkill?.name ?? "unknown",
      commandText: "",
      invocationArgs: this.invocationArgs
    });
  }

  async issueCapabilityLease(input: {
    activeSkill: Skill | null;
    capability: string;
    repoRef?: string;
    reason: string;
  }): Promise<CredentialLease> {
    const activeSkill = input.activeSkill;
    const target = this.resolveCapabilityTarget(activeSkill, input.repoRef);

    return await this.broker.issue({
      capability: input.capability,
      target,
      reason: input.reason
    });
  }

  private toHeaderTransforms(lease: CredentialLease): CredentialHeaderTransform[] {
    if (Array.isArray(lease.headerTransforms) && lease.headerTransforms.length > 0) {
      return lease.headerTransforms
        .filter(
          (transform) =>
            Boolean(transform?.domain?.trim()) &&
            transform.headers &&
            typeof transform.headers === "object" &&
            Object.keys(transform.headers).length > 0
        )
        .map((transform) => ({
          domain: transform.domain.trim(),
          headers: transform.headers
        }));
    }

    // Backwards-compatible fallback while brokers migrate to explicit header transforms.
    const githubToken = lease.env.GITHUB_TOKEN?.trim();
    if (lease.provider === "github" && githubToken) {
      return [
        {
          domain: "api.github.com",
          headers: {
            Authorization: `Bearer ${githubToken}`
          }
        }
      ];
    }

    return [];
  }

  async enableCapabilityForTurn(input: {
    activeSkill: Skill | null;
    capability: string;
    repoRef?: string;
    reason: string;
  }): Promise<{ reused: boolean; expiresAt: string }> {
    const capability = input.capability.trim();
    if (!capability) {
      throw new Error("jr-rpc issue-credential requires a capability argument");
    }
    if (!capability.startsWith("github.")) {
      throw new Error(`Unsupported capability provider for jr-rpc issue-credential: ${capability}`);
    }
    const activeSkill = input.activeSkill;
    const capabilityTarget = this.resolveCapabilityTarget(activeSkill, input.repoRef);
    if (!capabilityTarget?.owner || !capabilityTarget?.repo) {
      throw new Error("jr-rpc issue-credential requires repository context; use --repo <owner/repo>");
    }
    const declared = activeSkill?.requiresCapabilities ?? [];
    if (activeSkill && !declared.includes(capability)) {
      logWarn(
        "capability_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.capability.name": capability
        },
        "Capability issued even though it is not declared in the active skill (soft enforcement)"
      );
    }
    const existing = this.enabledByCapability.get(capability);
    const now = Date.now();
    if (existing && existing.expiresAtMs - now > 10_000) {
      return { reused: true, expiresAt: new Date(existing.expiresAtMs).toISOString() };
    }
    logInfo(
      "credential_issue_request",
      {},
      {
        "app.skill.name": activeSkill?.name,
        "app.capability.name": capability
      },
      "Issuing capability credential for current turn"
    );

    try {
      const lease = await this.issueCapabilityLease({
        activeSkill,
        capability,
        repoRef: input.repoRef,
        reason: input.reason
      });
      const transforms = this.toHeaderTransforms(lease);
      if (transforms.length === 0) {
        throw new Error(`Credential lease for ${capability} did not include header transforms`);
      }
      const expiresAtMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error(`Credential lease for ${capability} returned invalid expiresAt`);
      }
      this.enabledByCapability.set(capability, {
        expiresAtMs,
        transforms
      });
      logInfo(
        "credential_issue_success",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "app.credential.provider": lease.provider,
          "app.credential.expires_at": lease.expiresAt,
          "app.credential.delivery": "header_transform"
        },
        "Issued capability credential lease"
      );
      return { reused: false, expiresAt: lease.expiresAt };
    } catch (error) {
      logWarn(
        "credential_issue_failed",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "error.message": error instanceof Error ? error.message : String(error)
        },
        "Capability credential resolution failed"
      );
      throw error;
    }
  }

  getTurnHeaderTransforms(): CredentialHeaderTransform[] | undefined {
    const now = Date.now();
    const headerTransforms: CredentialHeaderTransform[] = [];
    for (const [capability, entry] of this.enabledByCapability.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByCapability.delete(capability);
        continue;
      }
      headerTransforms.push(...entry.transforms);
    }
    return headerTransforms.length > 0 ? headerTransforms : undefined;
  }
}
