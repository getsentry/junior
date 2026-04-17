import type { CredentialRouter } from "@/chat/capabilities/router";
import { logInfo, logWarn } from "@/chat/logging";
import type {
  CredentialBroker,
  CredentialHeaderTransform,
  CredentialLease,
} from "@/chat/credentials/broker";
import { getPluginDefinition } from "@/chat/plugins/registry";
import type { Skill } from "@/chat/skills";

// Spec: specs/skill-capabilities-spec.md (plugin-owned credential injection)
// Spec: specs/security-policy.md (credential scope and lifecycle requirements)

function toHeaderTransforms(
  lease: CredentialLease,
): CredentialHeaderTransform[] {
  if (
    !Array.isArray(lease.headerTransforms) ||
    lease.headerTransforms.length === 0
  ) {
    return [];
  }

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

export class SkillCapabilityRuntime {
  private readonly router: CredentialRouter;
  private readonly requesterId?: string;
  private readonly enabledByProvider = new Map<
    string,
    {
      expiresAtMs: number;
      transforms: CredentialHeaderTransform[];
      env: Record<string, string>;
    }
  >();

  constructor(params: {
    broker?: CredentialBroker;
    router?: CredentialRouter;
    requesterId?: string;
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

    this.requesterId = params.requesterId;
  }

  async enableCredentialsForTurn(input: {
    activeSkill: Skill | null;
    reason: string;
  }): Promise<{ reused: boolean; expiresAt: string } | undefined> {
    const provider = input.activeSkill?.pluginProvider;
    if (!provider) {
      return undefined;
    }

    if (!this.requesterId) {
      throw new Error("Credential enablement requires requester context");
    }

    const plugin = getPluginDefinition(provider);
    if (!plugin?.manifest.credentials) {
      return undefined;
    }

    const existing = this.enabledByProvider.get(provider);
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
        "app.skill.name": input.activeSkill?.name,
        "app.credential.provider": provider,
      },
      "Issuing provider credential for current turn",
    );

    try {
      const lease = await this.router.issue({
        provider,
        reason: input.reason,
        requesterId: this.requesterId,
      });
      const transforms = toHeaderTransforms(lease);
      if (transforms.length === 0) {
        throw new Error(
          `Credential lease for ${provider} did not include header transforms`,
        );
      }
      const expiresAtMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error(
          `Credential lease for ${provider} returned invalid expiresAt`,
        );
      }

      this.enabledByProvider.set(provider, {
        expiresAtMs,
        transforms,
        env: lease.env,
      });

      logInfo(
        "credential_issue_success",
        {},
        {
          "app.skill.name": input.activeSkill?.name,
          "app.credential.provider": lease.provider,
          "app.credential.expires_at": lease.expiresAt,
          "app.credential.delivery": "header_transform",
        },
        "Issued provider credential lease",
      );
      return { reused: false, expiresAt: lease.expiresAt };
    } catch (error) {
      logWarn(
        "credential_issue_failed",
        {},
        {
          "app.skill.name": input.activeSkill?.name,
          "app.credential.provider": provider,
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Provider credential resolution failed",
      );
      throw error;
    }
  }

  getTurnHeaderTransforms(): CredentialHeaderTransform[] | undefined {
    const now = Date.now();
    const headerTransforms: CredentialHeaderTransform[] = [];
    for (const [provider, entry] of this.enabledByProvider.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByProvider.delete(provider);
        continue;
      }
      headerTransforms.push(...entry.transforms);
    }
    return headerTransforms.length > 0 ? headerTransforms : undefined;
  }

  getTurnEnv(): Record<string, string> | undefined {
    const now = Date.now();
    const env: Record<string, string> = {};
    for (const [provider, entry] of this.enabledByProvider.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByProvider.delete(provider);
        continue;
      }
      Object.assign(env, entry.env);
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  async enableCredentialsForCommand(input: {
    activeSkill: Skill | null;
    reason: string;
  }): Promise<void> {
    await this.enableCredentialsForTurn({
      activeSkill: input.activeSkill,
      reason: input.reason,
    });
  }
}
