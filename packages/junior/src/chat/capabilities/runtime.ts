import type { CapabilityTarget } from "@/chat/capabilities/types";
import { getCapabilityProvider } from "@/chat/capabilities/catalog";
import type { CapabilityCredentialRouter } from "@/chat/capabilities/router";
import { logInfo, logWarn } from "@/chat/logging";
import {
  extractCapabilityTarget,
  parseRepoTarget,
} from "@/chat/capabilities/target";
import type {
  CredentialBroker,
  CredentialHeaderTransform,
  CredentialLease,
} from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

// Spec: specs/skill-capabilities-spec.md (runtime capability resolution + injection)
// Spec: specs/security-policy.md (credential scope and lifecycle requirements)

export class SkillCapabilityRuntime {
  private readonly router: CapabilityCredentialRouter;
  private readonly invocationArgs?: string;
  private readonly requesterId?: string;
  private readonly resolveConfiguration?: (key: string) => Promise<unknown>;
  private readonly enabledByCapability = new Map<
    string,
    {
      expiresAtMs: number;
      transforms: CredentialHeaderTransform[];
      env: Record<string, string>;
    }
  >();

  constructor(params: {
    broker?: CredentialBroker;
    router?: CapabilityCredentialRouter;
    invocationArgs?: string;
    requesterId?: string;
    resolveConfiguration?: (key: string) => Promise<unknown>;
  }) {
    if (params.router) {
      this.router = params.router;
    } else if (params.broker) {
      this.router = {
        issue: async (input) => await params.broker!.issue(input),
      };
    } else {
      throw new Error(
        "SkillCapabilityRuntime requires either router or broker",
      );
    }
    this.invocationArgs = params.invocationArgs;
    this.requesterId = params.requesterId;
    this.resolveConfiguration = params.resolveConfiguration;
  }

  private async resolveCapabilityTarget(input: {
    activeSkill: Skill | null;
    repoRef?: string;
    configKey?: string;
  }): Promise<CapabilityTarget | undefined> {
    const activeSkill = input.activeSkill;
    const explicitTarget = input.repoRef
      ? parseRepoTarget(input.repoRef)
      : undefined;
    if (explicitTarget) {
      return explicitTarget;
    }
    const inferredTarget = extractCapabilityTarget({
      invocationArgs: this.invocationArgs,
    });
    if (inferredTarget) {
      return inferredTarget;
    }

    if (!input.configKey || !this.resolveConfiguration) {
      return undefined;
    }

    const configuredRepo = await this.resolveConfiguration(input.configKey);
    if (
      typeof configuredRepo !== "string" ||
      configuredRepo.trim().length === 0
    ) {
      return undefined;
    }

    const configuredTarget = parseRepoTarget(configuredRepo);
    if (!configuredTarget) {
      logWarn(
        "config_value_invalid_for_capability_target",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.config.key": input.configKey,
        },
        `Configured ${input.configKey} is invalid for capability target resolution`,
      );
      return undefined;
    }

    const declaredConfig = activeSkill?.usesConfig ?? [];
    if (activeSkill && !declaredConfig.includes(input.configKey)) {
      logWarn(
        "config_key_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.config.key": input.configKey,
        },
        "Configuration key used by runtime is not declared in active skill frontmatter (soft enforcement)",
      );
    }

    return configuredTarget;
  }

  private capabilityCacheKey(
    capability: string,
    target?: CapabilityTarget,
  ): string {
    const owner = target?.owner?.trim().toLowerCase();
    const repo = target?.repo?.trim().toLowerCase();
    const scope = owner && repo ? `${owner}/${repo}` : "none";
    return `${capability}:${scope}`;
  }

  async issueCapabilityLease(input: {
    activeSkill: Skill | null;
    capability: string;
    repoRef?: string;
    reason: string;
  }): Promise<CredentialLease> {
    const capabilityProvider = getCapabilityProvider(input.capability);
    if (!capabilityProvider) {
      throw new Error(
        `Unsupported capability for lease issuance: ${input.capability}`,
      );
    }

    const activeSkill = input.activeSkill;
    const target =
      capabilityProvider.target?.type === "repo"
        ? await this.resolveCapabilityTarget({
            activeSkill,
            repoRef: input.repoRef,
            configKey: capabilityProvider.target.configKey,
          })
        : undefined;

    return await this.router.issue({
      capability: input.capability,
      target,
      reason: input.reason,
      requesterId: this.requesterId,
    });
  }

  private toHeaderTransforms(
    lease: CredentialLease,
  ): CredentialHeaderTransform[] {
    if (
      Array.isArray(lease.headerTransforms) &&
      lease.headerTransforms.length > 0
    ) {
      return lease.headerTransforms
        .filter(
          (transform) =>
            Boolean(transform?.domain?.trim()) &&
            transform.headers &&
            typeof transform.headers === "object" &&
            Object.keys(transform.headers).length > 0,
        )
        .map((transform) => ({
          domain: transform.domain.trim(),
          headers: transform.headers,
        }));
    }

    return [];
  }

  async enableCapabilityForTurn(input: {
    activeSkill: Skill | null;
    capability: string;
    repoRef?: string;
    reason: string;
  }): Promise<{ reused: boolean; expiresAt: string }> {
    if (!this.requesterId) {
      throw new Error("jr-rpc issue-credential requires requester context");
    }
    const capability = input.capability.trim();
    if (!capability) {
      throw new Error("jr-rpc issue-credential requires a capability argument");
    }
    const capabilityProvider = getCapabilityProvider(capability);
    if (!capabilityProvider) {
      throw new Error(
        `Unsupported capability for jr-rpc issue-credential: ${capability}`,
      );
    }
    const activeSkill = input.activeSkill;
    const capabilityTarget =
      capabilityProvider.target?.type === "repo"
        ? await this.resolveCapabilityTarget({
            activeSkill,
            repoRef: input.repoRef,
            configKey: capabilityProvider.target.configKey,
          })
        : undefined;
    if (
      capabilityProvider.target?.type === "repo" &&
      (!capabilityTarget?.owner || !capabilityTarget?.repo)
    ) {
      throw new Error(
        "jr-rpc issue-credential requires repository context; use --repo <owner/repo>",
      );
    }
    const declared = activeSkill?.requiresCapabilities ?? [];
    if (activeSkill && !declared.includes(capability)) {
      logWarn(
        "capability_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.capability.name": capability,
        },
        "Capability issued even though it is not declared in the active skill (soft enforcement)",
      );
    }
    const cacheKey = this.capabilityCacheKey(capability, capabilityTarget);
    const existing = this.enabledByCapability.get(cacheKey);
    const now = Date.now();
    if (existing && existing.expiresAtMs - now > 10_000) {
      return {
        reused: true,
        expiresAt: new Date(existing.expiresAtMs).toISOString(),
      };
    }
    logInfo(
      "credential_issue_request",
      {},
      {
        "app.skill.name": activeSkill?.name,
        "app.capability.name": capability,
      },
      "Issuing capability credential for current turn",
    );

    try {
      const lease = await this.issueCapabilityLease({
        activeSkill,
        capability,
        repoRef: input.repoRef,
        reason: input.reason,
      });
      const transforms = this.toHeaderTransforms(lease);
      if (transforms.length === 0) {
        throw new Error(
          `Credential lease for ${capability} did not include header transforms`,
        );
      }
      const expiresAtMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error(
          `Credential lease for ${capability} returned invalid expiresAt`,
        );
      }
      this.enabledByCapability.set(cacheKey, {
        expiresAtMs,
        transforms,
        env: lease.env,
      });
      logInfo(
        "credential_issue_success",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "app.credential.provider": lease.provider,
          "app.credential.expires_at": lease.expiresAt,
          "app.credential.delivery": "header_transform",
        },
        "Issued capability credential lease",
      );
      return { reused: false, expiresAt: lease.expiresAt };
    } catch (error) {
      logWarn(
        "credential_issue_failed",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Capability credential resolution failed",
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

  getTurnEnv(): Record<string, string> | undefined {
    const now = Date.now();
    const env: Record<string, string> = {};
    for (const [capability, entry] of this.enabledByCapability.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByCapability.delete(capability);
        continue;
      }
      Object.assign(env, entry.env);
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }
}
