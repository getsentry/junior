import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import {
  SandboxEgressCredentialError,
  sandboxEgressCredentialLease,
} from "@/chat/sandbox/egress/credentials";

const {
  getOAuthConfigMock,
  getProvidersMock,
  hasEgressCredentialHooks,
  issuePluginCredential,
  issueProviderCredentialLease,
  getStateAdapter,
  getUserTokenMock,
  createUserTokenStore,
} = vi.hoisted(() => ({
  getOAuthConfigMock: vi.fn(),
  getProvidersMock: vi.fn(() => [
    {
      manifest: {
        name: "sentry",
        credentials: { domains: ["sentry.io"] },
      },
    },
  ]),
  hasEgressCredentialHooks: vi.fn(),
  issuePluginCredential: vi.fn(),
  issueProviderCredentialLease: vi.fn(),
  getStateAdapter: vi.fn(),
  getUserTokenMock: vi.fn(async () => undefined),
  createUserTokenStore: vi.fn(() => ({
    get: getUserTokenMock,
  })),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getOAuthConfig: getOAuthConfigMock,
    getProviders: getProvidersMock,
  },
}));
vi.mock("@/chat/plugins/credential-hooks", () => ({
  hasEgressCredentialHooks,
  selectPluginGrant: vi.fn(),
  issuePluginCredential,
}));
vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore,
  issueProviderCredentialLease,
}));
vi.mock("@/chat/state/adapter", () => ({ getStateAdapter }));

const PROVIDER = "sentry";
const EGRESS_ID = "test-egress-id";

function brokerGrant() {
  return {
    grant: { name: "default", access: "read" as const, reason: "test" },
    source: "broker" as const,
  };
}

function credentialContext() {
  return {
    credentials: { actor: { type: "user" as const, userId: "U123" } },
    egressId: EGRESS_ID,
    expiresAtMs: Date.now() + 60_000,
    contextId: "ctx-test",
  };
}

describe("sandboxEgressCredentialLease — credential error normalization", () => {
  it("converts broker CredentialUnavailableError to auth_required with OAuth authorization", async () => {
    hasEgressCredentialHooks.mockReturnValue(false);
    getOAuthConfigMock.mockReturnValue({
      clientIdEnv: "SENTRY_CLIENT_ID",
      clientSecretEnv: "SENTRY_CLIENT_SECRET",
      authorizeEndpoint: "https://sentry.io/oauth/authorize/",
      tokenEndpoint: "https://sentry.io/oauth/token/",
      scope: "event:read org:read",
      callbackPath: "/api/oauth/callback/sentry",
    });
    issueProviderCredentialLease.mockRejectedValue(
      new CredentialUnavailableError(
        PROVIDER,
        "No sentry credentials available.",
      ),
    );
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    getStateAdapter.mockReturnValue(stateStub);

    const selection = brokerGrant();
    await expect(
      sandboxEgressCredentialLease(PROVIDER, selection, credentialContext()),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxEgressCredentialError &&
        e.kind === "auth_required" &&
        e.provider === PROVIDER &&
        e.grant.name === "default" &&
        e.authorization?.type === "oauth" &&
        e.authorization?.provider === PROVIDER &&
        e.authorization?.scope === "event:read org:read",
    );
  });

  it("converts broker CredentialUnavailableError to auth_required without authorization when provider has no OAuth config", async () => {
    hasEgressCredentialHooks.mockReturnValue(false);
    getOAuthConfigMock.mockReturnValue(undefined); // no OAuth configured
    issueProviderCredentialLease.mockRejectedValue(
      new CredentialUnavailableError(
        PROVIDER,
        "No sentry credentials available.",
      ),
    );
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    getStateAdapter.mockReturnValue(stateStub);

    await expect(
      sandboxEgressCredentialLease(
        PROVIDER,
        brokerGrant(),
        credentialContext(),
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxEgressCredentialError &&
        e.kind === "auth_required" &&
        e.provider === PROVIDER &&
        e.authorization === undefined, // no OAuth → no authorization on the error
    );
  });

  it("propagates non-credential broker errors unchanged", async () => {
    hasEgressCredentialHooks.mockReturnValue(false);
    getOAuthConfigMock.mockReturnValue(undefined);
    const tokenStoreError = new Error("token store unavailable");
    issueProviderCredentialLease.mockRejectedValue(tokenStoreError);
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    getStateAdapter.mockReturnValue(stateStub);

    await expect(
      sandboxEgressCredentialLease(
        PROVIDER,
        brokerGrant(),
        credentialContext(),
      ),
    ).rejects.toThrow("token store unavailable");
  });

  it("converts plugin unavailable results to unavailable credential errors", async () => {
    hasEgressCredentialHooks.mockReturnValue(true);
    getOAuthConfigMock.mockReturnValue({ scope: "read" });
    issuePluginCredential.mockResolvedValue({
      type: "unavailable",
      message: "plugin cannot issue credential for this actor",
    });
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    getStateAdapter.mockReturnValue(stateStub);

    const pluginSelection = {
      grant: { name: "user-write", access: "write" as const },
      source: "plugin" as const,
    };
    await expect(
      sandboxEgressCredentialLease(
        PROVIDER,
        pluginSelection,
        credentialContext(),
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxEgressCredentialError &&
        e.kind === "unavailable" &&
        e.provider === PROVIDER &&
        e.grant.name === "user-write",
    );
  });

  it("reuses installation leases across sandboxes", async () => {
    hasEgressCredentialHooks.mockReturnValue(true);
    issuePluginCredential.mockClear();
    const state = new Map<string, unknown>();
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value)),
      delete: vi.fn((key: string) => state.delete(key)),
    };
    getStateAdapter.mockReturnValue(stateStub);
    issuePluginCredential.mockResolvedValue({
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer scoped-token" },
          },
        ],
      },
    });
    const first = {
      grant: {
        name: "installation-write",
        access: "write" as const,
      },
      source: "plugin" as const,
    };
    const secondContext = {
      ...credentialContext(),
      egressId: "other-egress",
      contextId: "ctx-other",
    };

    await sandboxEgressCredentialLease(PROVIDER, first, credentialContext());
    await sandboxEgressCredentialLease(PROVIDER, first, secondContext);
    await sandboxEgressCredentialLease(PROVIDER, first, credentialContext());

    expect(issuePluginCredential).toHaveBeenCalledTimes(1);
    expect(stateStub.set.mock.calls.map(([key]) => key)).toEqual([
      "sandbox-egress-lease:sentry:installation-write:shared",
    ]);
  });

  it("keeps user grants isolated by actor", async () => {
    hasEgressCredentialHooks.mockReturnValue(true);
    issuePluginCredential.mockClear();
    getUserTokenMock.mockReset();
    getUserTokenMock.mockImplementation(async (userId: string) => ({
      accessToken: userId === "U123" ? "user-token-u123" : "user-token-u999",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30 * 60_000,
    }));
    const state = new Map<string, unknown>();
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value)),
      delete: vi.fn((key: string) => state.delete(key)),
    };
    getStateAdapter.mockReturnValue(stateStub);
    issuePluginCredential.mockImplementation(
      async (input: { actor: { type?: string; userId?: string } }) => ({
        type: "lease",
        lease: {
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "sentry.io",
              headers: {
                Authorization: `Bearer ${
                  input.actor.userId === "U999"
                    ? "user-token-u999"
                    : "user-token-u123"
                }`,
              },
            },
          ],
        },
      }),
    );
    const grant = {
      grant: {
        name: "user-write",
        access: "write" as const,
      },
      source: "plugin" as const,
    };
    const otherActor = {
      credentials: { actor: { type: "user" as const, userId: "U999" } },
      egressId: EGRESS_ID,
      expiresAtMs: Date.now() + 60_000,
      contextId: "ctx-other-user",
    };

    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    await sandboxEgressCredentialLease(PROVIDER, grant, otherActor);

    expect(issuePluginCredential).toHaveBeenCalledTimes(2);
    expect(stateStub.set.mock.calls.map(([key]) => key)).toEqual([
      "sandbox-egress-lease:sentry:user-write:user:U123",
      "sandbox-egress-lease:sentry:user-write:user:U999",
    ]);
  });

  it("reuses a user lease only while the stored token still matches", async () => {
    hasEgressCredentialHooks.mockReturnValue(true);
    issuePluginCredential.mockClear();
    getUserTokenMock.mockReset();
    getUserTokenMock.mockResolvedValue({
      accessToken: "user-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30 * 60_000,
    });
    const state = new Map<string, unknown>();
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value)),
      delete: vi.fn((key: string) => state.delete(key)),
    };
    getStateAdapter.mockReturnValue(stateStub);
    issuePluginCredential.mockResolvedValue({
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer user-token" },
          },
        ],
      },
    });
    const grant = {
      grant: {
        name: "user-write",
        access: "write" as const,
      },
      source: "plugin" as const,
    };

    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    expect(issuePluginCredential).toHaveBeenCalledTimes(1);

    getUserTokenMock.mockResolvedValue(undefined);
    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    expect(issuePluginCredential).toHaveBeenCalledTimes(2);
    expect(stateStub.delete).toHaveBeenCalledWith(
      "sandbox-egress-lease:sentry:user-write:user:U123",
    );

    getUserTokenMock.mockResolvedValue({
      accessToken: "user-token",
      refreshToken: "refresh",
      expiresAt: Date.now() - 1,
    });
    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    expect(issuePluginCredential).toHaveBeenCalledTimes(3);

    getUserTokenMock.mockResolvedValue({
      accessToken: "rotated-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30 * 60_000,
    });
    issuePluginCredential.mockResolvedValue({
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer rotated-token" },
          },
        ],
      },
    });
    await sandboxEgressCredentialLease(PROVIDER, grant, credentialContext());
    expect(issuePluginCredential).toHaveBeenCalledTimes(4);
  });

  it("keeps user grants isolated by delegated subject on system runs", async () => {
    hasEgressCredentialHooks.mockReturnValue(true);
    issuePluginCredential.mockClear();
    getUserTokenMock.mockReset();
    getUserTokenMock.mockImplementation(async (userId: string) => ({
      accessToken: userId === "U123" ? "user-token-u123" : "user-token-u999",
      refreshToken: "refresh",
      expiresAt: Date.now() + 30 * 60_000,
    }));
    const state = new Map<string, unknown>();
    const stateStub = {
      connect: vi.fn(),
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value)),
      delete: vi.fn((key: string) => state.delete(key)),
    };
    getStateAdapter.mockReturnValue(stateStub);
    issuePluginCredential.mockImplementation(
      async (input: {
        credentialSubject?: { userId?: string };
      }) => ({
        type: "lease",
        lease: {
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "sentry.io",
              headers: {
                Authorization: `Bearer ${
                  input.credentialSubject?.userId === "U999"
                    ? "user-token-u999"
                    : "user-token-u123"
                }`,
              },
            },
          ],
        },
      }),
    );
    const grant = {
      grant: {
        name: "user-write",
        access: "write" as const,
      },
      source: "plugin" as const,
    };
    const firstSubject = {
      credentials: {
        actor: { platform: "system" as const, name: "resource-event" },
        subject: {
          type: "user" as const,
          userId: "U123",
          allowedWhen: "event-task" as const,
          taskId: "task-1",
          binding: {
            type: "event-task" as const,
            plugin: "github",
            taskId: "task-1",
            signature: "sig-1",
          },
        },
      },
      egressId: EGRESS_ID,
      expiresAtMs: Date.now() + 60_000,
      contextId: "ctx-subject-1",
    };
    const secondSubject = {
      ...firstSubject,
      credentials: {
        ...firstSubject.credentials,
        subject: {
          ...firstSubject.credentials.subject,
          userId: "U999",
          taskId: "task-2",
          binding: {
            ...firstSubject.credentials.subject.binding,
            taskId: "task-2",
            signature: "sig-2",
          },
        },
      },
      contextId: "ctx-subject-2",
    };

    await sandboxEgressCredentialLease(PROVIDER, grant, firstSubject);
    await sandboxEgressCredentialLease(PROVIDER, grant, secondSubject);

    expect(issuePluginCredential).toHaveBeenCalledTimes(2);
    expect(stateStub.set.mock.calls.map(([key]) => key)).toEqual([
      "sandbox-egress-lease:sentry:user-write:subject:U123",
      "sandbox-egress-lease:sentry:user-write:subject:U999",
    ]);
  });
});
