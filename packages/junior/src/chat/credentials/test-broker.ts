import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialHeaderTransform,
  CredentialLease,
} from "@/chat/credentials/broker";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";

interface TestBrokerConfig {
  provider: string;
  domains?: string[];
  apiHeaders?: Record<string, string>;
  headerTransforms?: () => CredentialHeaderTransform[];
  env?: Record<string, string>;
  envKey?: string;
  placeholder?: string;
}

/** Issue deterministic placeholder credential leases for eval runs. */
export class TestCredentialBroker implements CredentialBroker {
  private readonly config: TestBrokerConfig;

  constructor(config: TestBrokerConfig) {
    this.config = config;
  }

  async issue(input: { reason: string }): Promise<CredentialLease> {
    const token =
      process.env.EVAL_TEST_CREDENTIAL_TOKEN?.trim() || "eval-test-token";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const env = {
      ...(this.config.env ?? {}),
      ...(this.config.envKey && this.config.placeholder
        ? { [this.config.envKey]: this.config.placeholder }
        : {}),
    };
    const tokenTransforms =
      this.config.domains?.map((domain) => ({
        domain,
        headers: {
          ...(this.config.apiHeaders ?? {}),
          Authorization: `Bearer ${token}`,
        },
      })) ?? [];

    return {
      id: randomUUID(),
      provider: this.config.provider,
      env,
      headerTransforms: mergeHeaderTransforms([
        ...(this.config.headerTransforms?.() ?? []),
        ...tokenTransforms,
      ]),
      expiresAt,
      metadata: {
        reason: input.reason,
      },
    };
  }
}
