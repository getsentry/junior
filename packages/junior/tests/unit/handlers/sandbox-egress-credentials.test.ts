import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import {
  SandboxEgressCredentialError,
  sandboxEgressCredentialLease,
} from "@/chat/sandbox/egress/credentials";

const {
  getOAuthConfigMock,
  hasEgressCredentialHooks,
  issuePluginCredential,
  issueProviderCredentialLease,
  getStateAdapter,
} = vi.hoisted(() => ({
  getOAuthConfigMock: vi.fn(),
  hasEgressCredentialHooks: vi.fn(),
  issuePluginCredential: vi.fn(),
  issueProviderCredentialLease: vi.fn(),
  getStateAdapter: vi.fn(),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getOAuthConfig: getOAuthConfigMock,
  },
}));
vi.mock("@/chat/plugins/credential-hooks", () => ({
  hasEgressCredentialHooks,
  selectPluginGrant: vi.fn(),
  issuePluginCredential,
}));
vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: vi.fn(() => ({})),
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
});
