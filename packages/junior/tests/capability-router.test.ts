import { describe, expect, it } from "vitest";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type { CredentialBroker } from "@/chat/credentials/broker";

describe("provider credential router", () => {
  it("routes known capability issuance to provider broker", async () => {
    const broker: CredentialBroker = {
      issue: async (input) => ({
        id: "lease-1",
        provider: "github",
        capability: input.capability,
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    };
    const router = new ProviderCredentialRouter({
      brokersByProvider: {
        github: broker
      }
    });

    await expect(
      router.issue({
        capability: "github.issues.read",
        reason: "test"
      })
    ).resolves.toMatchObject({
      provider: "github",
      capability: "github.issues.read"
    });
  });

  it("rejects unsupported capabilities", async () => {
    const router = new ProviderCredentialRouter({
      brokersByProvider: {
        github: {
          issue: async () => {
            throw new Error("should not be called");
          }
        }
      }
    });

    await expect(
      router.issue({
        capability: "jira.issues.read",
        reason: "test"
      })
    ).rejects.toThrow("Unsupported capability");
  });

  it("rejects when provider broker is not registered", async () => {
    const router = new ProviderCredentialRouter({
      brokersByProvider: {}
    });

    await expect(
      router.issue({
        capability: "github.issues.read",
        reason: "test"
      })
    ).rejects.toThrow("No credential broker registered for provider: github");
  });
});
