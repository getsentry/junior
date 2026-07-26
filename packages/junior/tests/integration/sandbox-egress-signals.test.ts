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
    vi.unstubAllGlobals();
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        return request.method === "DELETE"
          ? await handler.DELETE(request)
          : await handler.GET(request);
      }),
    );
    const { createLocalSandboxEgressSignalTransport } =
      await import("@/chat/local/sandbox-egress-signals");
    const signals = createLocalSandboxEgressSignalTransport(
      "http://127.0.0.1:3000",
    );
    await expect(signals.consume(token)).resolves.toMatchObject({
      authRequired: {
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
    await expect(signals.consume(token)).resolves.toEqual({});
    await signals.clear(token);
  });

  it("does not require the dev server for ordinary sandbox commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("dev server unavailable");
      }),
    );
    const { createLocalSandboxEgressSignalTransport } =
      await import("@/chat/local/sandbox-egress-signals");
    const signals = createLocalSandboxEgressSignalTransport(
      "http://127.0.0.1:3000",
    );

    await expect(signals.clear("unused")).resolves.toBeUndefined();
    await expect(signals.consume("unused")).resolves.toEqual({});
  });

  it("rejects an unsigned signal request", async () => {
    const handler = await import("@/handlers/sandbox-egress-signals");
    const request = new Request(
      "http://127.0.0.1:3000/api/internal/sandbox-egress/signals",
    );

    await expect(
      handler.GET(request).then((result) => result.status),
    ).resolves.toBe(401);
    await expect(
      handler.DELETE(request).then((result) => result.status),
    ).resolves.toBe(401);
  });

  it("is unavailable outside the loopback development server", async () => {
    const handler = await import("@/handlers/sandbox-egress-signals");

    await expect(
      handler
        .GET(
          new Request(
            "https://junior.example/api/internal/sandbox-egress/signals",
          ),
        )
        .then((result) => result.status),
    ).resolves.toBe(404);
    process.env.NODE_ENV = "production";
    await expect(
      handler
        .GET(
          new Request(
            "http://127.0.0.1:3000/api/internal/sandbox-egress/signals",
          ),
        )
        .then((result) => result.status),
    ).resolves.toBe(404);
  });
});
