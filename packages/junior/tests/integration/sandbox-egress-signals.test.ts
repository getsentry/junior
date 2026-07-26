import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("sandbox egress signal route", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_SECRET: "test-secret",
      JUNIOR_STATE_ADAPTER: "memory",
      NODE_ENV: "development",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns and consumes broker signals", async () => {
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

    const request = new Request(
      "http://127.0.0.1:3000/api/internal/sandbox-egress/token/signals",
    );
    const response = await handler.GET(request, token);

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
      handler.GET(request, token).then((result) => result.json()),
    ).resolves.toEqual({});
  });

  it("rejects an unsigned signal request", async () => {
    const handler = await import("@/handlers/sandbox-egress-signals");
    const request = new Request(
      "http://127.0.0.1:3000/api/internal/sandbox-egress/token/signals",
    );

    await expect(
      handler.GET(request, "not-a-token").then((result) => result.status),
    ).resolves.toBe(401);
    await expect(
      handler.DELETE(request, "not-a-token").then((result) => result.status),
    ).resolves.toBe(401);
  });

  it("is unavailable outside the loopback development server", async () => {
    const handler = await import("@/handlers/sandbox-egress-signals");

    await expect(
      handler
        .GET(
          new Request(
            "https://junior.example/api/internal/sandbox-egress/token/signals",
          ),
          "not-a-token",
        )
        .then((result) => result.status),
    ).resolves.toBe(404);
    process.env.NODE_ENV = "production";
    await expect(
      handler
        .GET(
          new Request(
            "http://127.0.0.1:3000/api/internal/sandbox-egress/token/signals",
          ),
          "not-a-token",
        )
        .then((result) => result.status),
    ).resolves.toBe(404);
  });
});
