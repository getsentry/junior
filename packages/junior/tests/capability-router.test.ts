import { describe, expect, it, vi } from "vitest";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type { CredentialBroker } from "@/chat/credentials/broker";
import * as catalog from "@/chat/capabilities/catalog";

describe("provider credential router", () => {
  it("routes known capability issuance to provider broker", async () => {
    const providerSpy = vi.spyOn(catalog, "getCapabilityProvider").mockReturnValue({
      provider: "github",
      capabilities: ["github.issues.read"],
      configKeys: ["github.repo"],
      target: { type: "repo", configKey: "github.repo" }
    });
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
    providerSpy.mockRestore();
  });

  it("rejects unsupported capabilities", async () => {
    const providerSpy = vi.spyOn(catalog, "getCapabilityProvider").mockReturnValue(undefined);
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
    providerSpy.mockRestore();
  });

  it("rejects when provider broker is not registered", async () => {
    const providerSpy = vi.spyOn(catalog, "getCapabilityProvider").mockReturnValue({
      provider: "github",
      capabilities: ["github.issues.read"],
      configKeys: ["github.repo"],
      target: { type: "repo", configKey: "github.repo" }
    });
    const router = new ProviderCredentialRouter({
      brokersByProvider: {}
    });

    await expect(
      router.issue({
        capability: "github.issues.read",
        reason: "test"
      })
    ).rejects.toThrow("No credential broker registered for provider: github");
    providerSpy.mockRestore();
  });
});
