import type { CapabilityTarget } from "@/chat/capabilities/types";
import {
  getCapabilityProvider,
  type CapabilityProviderTargetDefinition,
} from "@/chat/capabilities/catalog";
import type { CapabilityCredentialRouter } from "@/chat/capabilities/router";
import { logInfo, logWarn } from "@/chat/logging";
import {
  createCapabilityTarget,
  extractCapabilityTarget,
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
    target: CapabilityProviderTargetDefinition;
    targetRef?: string;
  }): Promise<CapabilityTarget | undefined> {
    const activeSkill = input.activeSkill;
    const explicitTarget = input.targetRef
      ? createCapabilityTarget(input.target.type, input.targetRef)
      : undefined;
    if (explicitTarget) {
      return explicitTarget;
    }
    const inferredTarget = extractCapabilityTarget({
      invocationArgs: this.invocationArgs,
      target: input.target,
    });
    if (inferredTarget) {
      return inferredTarget;
    }

    if (!this.resolveConfiguration) {
      return undefined;
    }

    const configuredValue = await this.resolveConfiguration(
      input.target.configKey,
    );
    if (
      typeof configuredValue !== "string" ||
      configuredValue.trim().length === 0
    ) {
      return undefined;
    }

    const configuredTarget = createCapabilityTarget(
      input.target.type,
      configuredValue,
    );
    if (!configuredTarget) {
      logWarn(
        "config_value_invalid_for_capability_target",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.config.key": input.target.configKey,
        },
        `Configured ${input.target.configKey} is invalid for capability target resolution`,
      );
      return undefined;
    }

    const declaredConfig = activeSkill?.usesConfig ?? [];
    if (activeSkill && !declaredConfig.includes(input.target.configKey)) {
      logWarn(
        "config_key_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.config.key": input.target.configKey,
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
    const scope = target ? `${target.type}:${target.value.trim()}` : "none";
    return `${capability}:${scope}`;
  }

  private assertCapabilityDeclaredForActiveSkill(
    activeSkill: Skill | null,
    capability: string,
  ): void {
    const declared = activeSkill?.requiresCapabilities ?? [];
    if (activeSkill && declared.includes(capability)) {
      return;
    }

    logWarn(
      "credential_issue_blocked_by_skill_contract",
      {},
      {
        "app.skill.name": activeSkill?.name,
        "app.capability.name": capability,
      },
      "Blocked capability issuance because the active skill does not declare it",
    );

    throw new Error(
      `jr-rpc issue-credential requires an active skill that declares ${capability}; current active skill: ${activeSkill?.name ?? "none"}. Load the matching skill first.`,
    );
  }

  async issueCapabilityLease(input: {
    activeSkill: Skill | null;
    capability: string;
    targetRef?: string;
    reason: string;
  }): Promise<CredentialLease> {
    const capabilityProvider = getCapabilityProvider(input.capability);
    if (!capabilityProvider) {
      throw new Error(
        `Unsupported capability for lease issuance: ${input.capability}`,
      );
    }

    const activeSkill = input.activeSkill;
    const target = capabilityProvider.target
      ? await this.resolveCapabilityTarget({
          activeSkill,
          target: capabilityProvider.target,
          targetRef: input.targetRef,
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
    targetRef?: string;
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
    this.assertCapabilityDeclaredForActiveSkill(activeSkill, capability);
    const capabilityTarget = capabilityProvider.target
      ? await this.resolveCapabilityTarget({
          activeSkill,
          target: capabilityProvider.target,
          targetRef: input.targetRef,
        })
      : undefined;
    if (capabilityProvider.target && !capabilityTarget?.value.trim()) {
      throw new Error(
        `jr-rpc issue-credential requires ${capabilityProvider.target.type} target context; use --target <value>`,
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
        targetRef: input.targetRef,
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
