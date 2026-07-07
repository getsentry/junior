import { describe, expect, it, vi } from "vitest";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import type { CredentialBroker } from "@/chat/credentials/broker";

const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};

describe("provider credential router", () => {
  it("routes provider issuance to the matching broker", async () => {
    const broker: CredentialBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        env: {},
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
        context: USER_CREDENTIAL_CONTEXT,
        provider: "github",
        reason: "test",
      }),
    ).resolves.toMatchObject({
      provider: "github",
    });
    expect(broker.issue).toHaveBeenCalledWith({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test",
    });
  });

  it("forwards credential context", async () => {
    const broker: CredentialBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    const router = new ProviderCredentialRouter({
      brokersByProvider: {
        github: broker,
      },
    });

    await router.issue({
      context: {
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: "v1=test",
          },
        },
      },
      provider: "github",
      reason: "test",
    });

    expect(broker.issue).toHaveBeenCalledWith({
      context: {
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: "v1=test",
          },
        },
      },
      reason: "test",
    });
  });

  it("rejects when the provider broker is not registered", async () => {
    const router = new ProviderCredentialRouter({
      brokersByProvider: {},
    });

    await expect(
      router.issue({
        context: USER_CREDENTIAL_CONTEXT,
        provider: "github",
        reason: "test",
      }),
    ).rejects.toThrow("No credential broker registered for provider: github");
  });
});
