import { randomUUID } from "node:crypto";
import type { CapabilityTarget } from "@/chat/capabilities/types";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";

export class TestCredentialBroker implements CredentialBroker {
  async issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease> {
    const isSentry = input.capability.startsWith("sentry.");
    if (!input.capability.startsWith("github.") && !isSentry && !input.capability.startsWith("app.test.")) {
      throw new Error(`Unsupported test capability: ${input.capability}`);
    }

    const token = process.env.EVAL_TEST_CREDENTIAL_TOKEN?.trim() || "eval-test-token";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const domain = isSentry ? "sentry.io" : "api.github.com";
    const envKey = isSentry ? "SENTRY_AUTH_TOKEN" : "GITHUB_TOKEN";

    return {
      id: randomUUID(),
      provider: "test",
      capability: input.capability,
      env: {
        [envKey]: token
      },
      headerTransforms: [
        {
          domain,
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      ],
      expiresAt,
      metadata: {
        reason: input.reason,
        target: input.target?.owner && input.target?.repo ? `${input.target.owner}/${input.target.repo}` : "none"
      }
    };
  }
}
