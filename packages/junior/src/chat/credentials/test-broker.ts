import { randomUUID } from "node:crypto";
import type { CapabilityTarget } from "@/chat/capabilities/types";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";

export interface TestBrokerConfig {
  provider: string;
  domains: string[];
  envKey: string;
  placeholder: string;
}

export class TestCredentialBroker implements CredentialBroker {
  private config: TestBrokerConfig;

  constructor(config: TestBrokerConfig) {
    this.config = config;
  }

  async issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease> {
    const token = process.env.EVAL_TEST_CREDENTIAL_TOKEN?.trim() || "eval-test-token";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    return {
      id: randomUUID(),
      provider: this.config.provider,
      capability: input.capability,
      env: {
        [this.config.envKey]: this.config.placeholder
      },
      headerTransforms: this.config.domains.map((domain) => ({
        domain,
        headers: {
          Authorization: `Bearer ${token}`
        }
      })),
      expiresAt,
      metadata: {
        reason: input.reason,
        target: input.target?.owner && input.target?.repo ? `${input.target.owner}/${input.target.repo}` : "none"
      }
    };
  }
}
