import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRemoteJWKSetMock: vi.fn(() => async () => null),
  decodeJwtMock: vi.fn(),
  getPluginDefinitionMock: vi.fn(),
  getPluginOAuthConfigMock: vi.fn(),
  getPluginProvidersMock: vi.fn(),
  issueProviderCredentialLeaseMock: vi.fn(),
  jwtVerifyMock: vi.fn(),
}));

export const createRemoteJWKSetMock = mocks.createRemoteJWKSetMock;
export const decodeJwtMock = mocks.decodeJwtMock;
export const getPluginDefinitionMock = mocks.getPluginDefinitionMock;
export const getPluginOAuthConfigMock = mocks.getPluginOAuthConfigMock;
export const getPluginProvidersMock = mocks.getPluginProvidersMock;
export const issueProviderCredentialLeaseMock =
  mocks.issueProviderCredentialLeaseMock;
export const jwtVerifyMock = mocks.jwtVerifyMock;

vi.mock("jose", () => ({
  createRemoteJWKSet: mocks.createRemoteJWKSetMock,
  decodeJwt: mocks.decodeJwtMock,
  jwtVerify: mocks.jwtVerifyMock,
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/plugins/registry", () => ({
  getPluginDefinition: mocks.getPluginDefinitionMock,
  getPluginOAuthConfig: mocks.getPluginOAuthConfigMock,
  getPluginProviders: mocks.getPluginProvidersMock,
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({ kind: "user-token-store" }),
  issueProviderCredentialLease: mocks.issueProviderCredentialLeaseMock,
}));

import {
  buildSandboxEgressNetworkPolicy as buildSandboxEgressNetworkPolicyImpl,
  matchesSandboxEgressDomain as matchesSandboxEgressDomainImpl,
  resolveSandboxEgressProviderForHost as resolveSandboxEgressProviderForHostImpl,
  resolveSandboxCommandEnvironment as resolveSandboxCommandEnvironmentImpl,
} from "@/chat/sandbox/egress-policy";
import { verifyVercelSandboxOidcToken as verifyVercelSandboxOidcTokenImpl } from "@/chat/sandbox/egress-oidc";
import {
  isSandboxEgressForwardedRequest as isSandboxEgressForwardedRequestImpl,
  proxySandboxEgressRequest as proxySandboxEgressRequestImpl,
} from "@/chat/sandbox/egress-proxy";
import {
  createSandboxEgressCredentialToken as createSandboxEgressCredentialTokenImpl,
  SANDBOX_EGRESS_PROXY_PATH as SANDBOX_EGRESS_PROXY_PATH_IMPL,
} from "@/chat/sandbox/egress-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CredentialUnavailableError as CredentialUnavailableErrorImpl } from "@/chat/credentials/broker";
import type { CredentialSubject } from "@/chat/credentials/context";
import { ALL as sandboxEgressHandler } from "@/handlers/sandbox-egress-proxy";

export const CredentialUnavailableError = CredentialUnavailableErrorImpl;
export const SANDBOX_EGRESS_PROXY_PATH = SANDBOX_EGRESS_PROXY_PATH_IMPL;

const egressPolicyServices = {
  getPluginProviders: getPluginProvidersMock,
};

/** Call the route handler with mocks already registered. */
export function ALL(request: Request): ReturnType<typeof sandboxEgressHandler> {
  return sandboxEgressHandler(request);
}

/** Build a sandbox egress network policy with mocked plugin providers. */
export function buildSandboxEgressNetworkPolicy(
  input?: Parameters<typeof buildSandboxEgressNetworkPolicyImpl>[0],
): ReturnType<typeof buildSandboxEgressNetworkPolicyImpl> {
  return buildSandboxEgressNetworkPolicyImpl(input, egressPolicyServices);
}

/** Check domain matching through the real egress policy implementation. */
export function matchesSandboxEgressDomain(
  ...args: Parameters<typeof matchesSandboxEgressDomainImpl>
): ReturnType<typeof matchesSandboxEgressDomainImpl> {
  return matchesSandboxEgressDomainImpl(...args);
}

/** Resolve command environment through the real policy implementation. */
export function resolveSandboxCommandEnvironment(): ReturnType<
  typeof resolveSandboxCommandEnvironmentImpl
> {
  return resolveSandboxCommandEnvironmentImpl(egressPolicyServices);
}

/** Verify a sandbox OIDC token with mocked jose and discovery fetches. */
export function verifyVercelSandboxOidcToken(
  ...args: Parameters<typeof verifyVercelSandboxOidcTokenImpl>
): ReturnType<typeof verifyVercelSandboxOidcTokenImpl> {
  return verifyVercelSandboxOidcTokenImpl(...args);
}

/** Detect forwarded sandbox egress requests through the real proxy helper. */
export function isSandboxEgressForwardedRequest(
  ...args: Parameters<typeof isSandboxEgressForwardedRequestImpl>
): ReturnType<typeof isSandboxEgressForwardedRequestImpl> {
  return isSandboxEgressForwardedRequestImpl(...args);
}

/** Proxy a request through the real egress implementation. */
export function proxySandboxEgressRequest(
  request: Parameters<typeof proxySandboxEgressRequestImpl>[0],
  deps: Parameters<typeof proxySandboxEgressRequestImpl>[1] = {},
): ReturnType<typeof proxySandboxEgressRequestImpl> {
  return proxySandboxEgressRequestImpl(request, {
    ...deps,
    issueProviderCredentialLease: issueProviderCredentialLeaseMock,
    resolveProviderForHost: (host) =>
      resolveSandboxEgressProviderForHostImpl(host, egressPolicyServices),
  });
}

/** Create a signed egress credential token with the test secret. */
export function createSandboxEgressCredentialToken(
  ...args: Parameters<typeof createSandboxEgressCredentialTokenImpl>
): ReturnType<typeof createSandboxEgressCredentialTokenImpl> {
  return createSandboxEgressCredentialTokenImpl(...args);
}

export const EGRESS_ID = "junior-sbx";
export const REQUESTER_ID = "U123";

let activeCredentialToken: string | undefined;

/** Reset mocked proxy dependencies and memory state before each egress test. */
export async function setupSandboxEgressProxyTest(): Promise<void> {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  process.env.JUNIOR_SECRET = "test-secret";
  activeCredentialToken = undefined;
  getPluginDefinitionMock.mockReset();
  getPluginOAuthConfigMock.mockReset();
  getPluginOAuthConfigMock.mockReturnValue(undefined);
  getPluginProvidersMock.mockReturnValue([sentryPlugin()]);
  createRemoteJWKSetMock.mockClear();
  createRemoteJWKSetMock.mockReturnValue(async () => null);
  decodeJwtMock.mockReset();
  issueProviderCredentialLeaseMock.mockReset();
  jwtVerifyMock.mockReset();
  await disconnectStateAdapter();
}

/** Restore process globals and memory state after each egress test. */
export async function cleanupSandboxEgressProxyTest(): Promise<void> {
  await disconnectStateAdapter();
  delete process.env.JUNIOR_STATE_ADAPTER;
  delete process.env.JUNIOR_BASE_URL;
  delete process.env.JUNIOR_SECRET;
  delete process.env.SENTRY_BOT_EMAIL;
  vi.restoreAllMocks();
}

/** Build the Sentry plugin fixture used by egress policy and forwarding tests. */
export function sentryPlugin() {
  return {
    manifest: {
      name: "sentry",
      displayName: "Sentry",
      description: "Sentry",
      capabilities: ["sentry.api"],
      configKeys: [],
      envVars: {
        SENTRY_BOT_EMAIL: {},
      },
      commandEnv: {
        SENTRY_AUTHOR_EMAIL: "${SENTRY_BOT_EMAIL}",
        SENTRY_READ_ONLY: "1",
      },
      credentials: {
        type: "oauth-bearer",
        domains: ["sentry.io", "us.sentry.io"],
        authTokenEnv: "SENTRY_AUTH_TOKEN",
        authTokenPlaceholder: "host_managed_credential",
      },
    },
  };
}

/** Build the GitHub plugin fixture used by delegated credential tests. */
export function githubPlugin() {
  return {
    manifest: {
      name: "github",
      displayName: "GitHub",
      description: "GitHub",
      capabilities: ["github.api"],
      configKeys: [],
      envVars: {},
      commandEnv: {
        GITHUB_READ_ONLY: "1",
        GITHUB_TOKEN: "ghp_host_managed_credential",
      },
      domains: ["api.github.com", "github.com"],
    },
  };
}

/** Build a provider with forwarding domains but no token placeholder. */
export function headerOnlyPlugin() {
  return {
    manifest: {
      name: "header-only",
      displayName: "Header Only",
      description: "Header-only",
      capabilities: ["header-only.api"],
      configKeys: [],
      envVars: {},
      commandEnv: {
        HEADER_ONLY_READ_ONLY: "1",
      },
      domains: ["api.example.com"],
    },
  };
}

/** Sign the active proxy URL credential as a user actor. */
export function setSandboxEgressUserActor(userId = REQUESTER_ID): void {
  activeCredentialToken = createSandboxEgressCredentialToken({
    credentials: { actor: { type: "user", userId } },
    egressId: EGRESS_ID,
    ttlMs: 60_000,
  });
}

/** Sign the active proxy URL credential as a system actor. */
export function setSandboxEgressSystemActor(input?: {
  subject?: CredentialSubject;
}): void {
  activeCredentialToken = createSandboxEgressCredentialToken({
    credentials: {
      actor: { type: "system", id: "scheduler" },
      ...(input?.subject ? { subject: input.subject } : {}),
    },
    egressId: EGRESS_ID,
    ttlMs: 60_000,
  });
}

/** Replace the active credential token for negative proxy-context tests. */
export function setActiveSandboxEgressCredentialToken(
  token: string | undefined,
): void {
  activeCredentialToken = token;
}

/** Return the currently active signed credential token for request assertions. */
export function activeSandboxEgressCredentialToken(): string | undefined {
  return activeCredentialToken;
}

/** Mock a Sentry provider lease with a host-specific header transform. */
export function mockSentryLease(
  domain = "sentry.io",
  token = "sentry-token",
): void {
  issueProviderCredentialLeaseMock.mockResolvedValue({
    id: "lease-1",
    provider: "sentry",
    env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
    headerTransforms: [
      {
        domain,
        headers: { Authorization: `Bearer ${token}` },
      },
    ],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

/** Mock a GitHub provider lease with its bearer header transform. */
export function mockGitHubLease(token = "github-token"): void {
  issueProviderCredentialLeaseMock.mockResolvedValue({
    id: "lease-github",
    provider: "github",
    env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
    headerTransforms: [
      {
        domain: "api.github.com",
        headers: { Authorization: `Bearer ${token}` },
      },
    ],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

/** Build a forwarded request shaped like Vercel Sandbox egress traffic. */
export function egressRequest(
  input: {
    host?: string;
    method?: string;
    path?: string;
    proxyPath?: string;
    forwardedPath?: string | null;
    scheme?: string | null;
    port?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Request {
  const upstreamPath = input.path ?? "/api/0/issues/";
  const proxyPath =
    input.proxyPath ??
    (activeCredentialToken
      ? `${SANDBOX_EGRESS_PROXY_PATH}/${activeCredentialToken}`
      : upstreamPath);
  const forwardedPath =
    input.forwardedPath === undefined ? upstreamPath : input.forwardedPath;
  return new Request(`https://junior.example.com${proxyPath}`, {
    method: input.method ?? "GET",
    headers: {
      "vercel-forwarded-host": input.host ?? "sentry.io",
      ...(input.scheme === null
        ? {}
        : { "vercel-forwarded-scheme": input.scheme ?? "https" }),
      "vercel-sandbox-oidc-token": "signed-token",
      ...(forwardedPath !== null
        ? { "vercel-forwarded-path": forwardedPath }
        : {}),
      ...(input.port ? { "vercel-forwarded-port": input.port } : {}),
      ...(input.headers ?? {}),
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

/** Proxy a sandbox egress request with a successful sandbox OIDC verifier. */
export function proxy(
  request: Request,
  fetchMock: typeof fetch = vi.fn(
    async () => new Response("ok"),
  ) as typeof fetch,
): Promise<Response> {
  return proxySandboxEgressRequest(request, {
    fetch: fetchMock,
    verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
  });
}
