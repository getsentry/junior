import { describe, expect, it, vi } from "vitest";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type { CredentialBroker } from "@/chat/credentials/broker";

describe("provider credential router", () => {
  it("routes provider issuance to the matching broker", async () => {
    const broker: CredentialBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    const router = new ProviderCredentialRouter({
      brokersByProvider: {
        github: broker,
      },
    });

    await expect(
      router.issue({
        provider: "github",
        reason: "test",
      }),
    ).resolves.toMatchObject({
      provider: "github",
    });
    expect(broker.issue).toHaveBeenCalledWith({
      reason: "test",
    });
  });

  it("forwards requester context", async () => {
    const broker: CredentialBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    const router = new ProviderCredentialRouter({
      brokersByProvider: {
        github: broker,
      },
    });

    await router.issue({
      provider: "github",
      requesterId: "U123",
      reason: "test",
    });

    expect(broker.issue).toHaveBeenCalledWith({
      requesterId: "U123",
      reason: "test",
    });
  });

  it("rejects when the provider broker is not registered", async () => {
    const router = new ProviderCredentialRouter({
      brokersByProvider: {},
    });

    await expect(
      router.issue({
        provider: "github",
        reason: "test",
      }),
    ).rejects.toThrow("No credential broker registered for provider: github");
  });
});
