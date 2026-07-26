import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("sandbox egress signal route", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_SECRET: "test-secret",
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("consumes signals produced by a separate egress proxy process", async () => {
    const session = await import("@/chat/sandbox/egress/session");
    const handler = await import("@/handlers/sandbox-egress-signals");
    const token = session.createSandboxEgressCredentialToken({
      credentials: {
        actor: { type: "user", userId: "local-cli" },
      },
      egressId: "sbx_local_oauth",
      ttlMs: 60_000,
    });
    const context = session.parseSandboxEgressCredentialToken(token);
    expect(context).toBeDefined();
    await session.setSandboxEgressAuthRequiredSignal(context!, {
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.asset-upload",
      },
      authorization: {
        type: "oauth",
        provider: "github",
      },
    });

    const response = await handler.GET(token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      auth_required: {
        provider: "github",
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.asset-upload",
        },
        authorization: {
          type: "oauth",
          provider: "github",
        },
      },
    });
    await expect(
      handler.GET(token).then((result) => result.json()),
    ).resolves.toEqual({});
  });

  it("rejects an unsigned signal request", async () => {
    const handler = await import("@/handlers/sandbox-egress-signals");

    await expect(
      handler.GET("not-a-token").then((result) => result.status),
    ).resolves.toBe(401);
    await expect(
      handler.DELETE("not-a-token").then((result) => result.status),
    ).resolves.toBe(401);
  });
});
