import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../msw/server";
import {
  queueSlackApiError,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";
import { usersInfoOk } from "../../fixtures/slack/factories/api";

const {
  BASE_URL,
  EXAMPLE_OAUTH_CONFIG,
  GITHUB_OAUTH_CONFIG,
  LINEAR_OAUTH_CONFIG,
  SENTRY_OAUTH_CONFIG,
  lookupSlackActorMock,
  resolvePluginOAuthAccountMock,
  waitUntilCallbacks,
} = vi.hoisted(() => ({
  BASE_URL: "https://example.com",
  SENTRY_OAUTH_CONFIG: {
    clientIdEnv: "SENTRY_CLIENT_ID",
    clientSecretEnv: "SENTRY_CLIENT_SECRET",
    authorizeEndpoint: "https://sentry.io/oauth/authorize/",
    tokenEndpoint: "https://sentry.io/oauth/token/",
    scope: "event:read org:read project:read team:read",
    callbackPath: "/api/oauth/callback/sentry",
  },
  EXAMPLE_OAUTH_CONFIG: {
    clientIdEnv: "EXAMPLE_CLIENT_ID",
    clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
    authorizeEndpoint: "https://api.example.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.example.com/v1/oauth/token",
    authorizeParams: { audience: "workspace" },
    tokenAuthMethod: "basic",
    tokenExtraHeaders: { "Content-Type": "application/json" },
    callbackPath: "/api/oauth/callback/example",
  },
  LINEAR_OAUTH_CONFIG: {
    clientIdEnv: "LINEAR_CLIENT_ID",
    clientSecretEnv: "LINEAR_CLIENT_SECRET",
    authorizeEndpoint: "https://linear.app/oauth/authorize",
    tokenEndpoint: "https://api.linear.app/oauth/token",
    scope: "read,write",
    tokenSubject: "installation" as const,
    callbackPath: "/api/oauth/callback/linear",
  },
  GITHUB_OAUTH_CONFIG: {
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    authorizeEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    treatEmptyScopeAsUnreported: true,
    callbackPath: "/api/oauth/callback/github",
  },
  lookupSlackActorMock: vi.fn(),
  resolvePluginOAuthAccountMock: vi.fn(),
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getDisplayName: (provider: string) => {
      if (provider === "sentry") {
        return "Sentry";
      }
      if (provider === "example") {
        return "Example";
      }
      if (provider === "github") {
        return "GitHub";
      }
      if (provider === "linear") {
        return "Linear";
      }
      return undefined;
    },
    getOAuthConfig: (provider: string) => {
      if (provider === "sentry") {
        return SENTRY_OAUTH_CONFIG;
      }
      if (provider === "example") {
        return EXAMPLE_OAUTH_CONFIG;
      }
      if (provider === "github") {
        return GITHUB_OAUTH_CONFIG;
      }
      if (provider === "linear") {
        return LINEAR_OAUTH_CONFIG;
      }
      return undefined;
    },
    isProvider: (provider: string) =>
      provider === "sentry" ||
      provider === "example" ||
      provider === "github" ||
      provider === "linear",
    isCapability: () => false,
    isConfigKey: () => false,
    getProviders: () => [],
    getSkillRoots: () => [],
    createBroker: () => {
      throw new Error("not implemented in test");
    },
  },
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: {
      ...memoryConfig.bot,
      userName: "junior",
    },
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/slack/user", () => ({
  lookupSlackActor: lookupSlackActorMock,
}));

vi.mock("@/chat/plugins/credential-hooks", () => ({
  resolvePluginOAuthAccount: resolvePluginOAuthAccountMock,
}));

vi.mock("@/chat/conversations/projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/conversations/projection")>()),
  recordAuthenticationLinked: vi.fn(async () => undefined),
}));

import {
  createInstallationTokenStore,
  createUserTokenStore,
} from "@/chat/capabilities/factory";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { GET } from "@/handlers/oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";

const ORIGINAL_ENV = { ...process.env };

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

const testAgentRunner = neverRunAgentRunner();

beforeEach(async () => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  await disconnectStateAdapter();
  await getStateAdapter().connect();
  lookupSlackActorMock.mockReset();
  lookupSlackActorMock.mockResolvedValue({
    platform: "slack",
    teamId: "T777",
    userId: "U777",
    userName: "actor",
  });
  resolvePluginOAuthAccountMock.mockReset();
  resolvePluginOAuthAccountMock.mockResolvedValue(undefined);
  waitUntilCallbacks.length = 0;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await disconnectStateAdapter();
});

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

async function putStoredState(key: string, value: unknown): Promise<void> {
  await getStateAdapter().set(key, value);
}

async function getStoredState<T>(key: string): Promise<T | null> {
  return await getStateAdapter().get<T>(key);
}

async function getStoredTokens(userId: string, provider: string) {
  return await createUserTokenStore().get(userId, provider);
}

function configureSentryOAuthEnv() {
  process.env.SENTRY_CLIENT_ID = "client-id";
  process.env.SENTRY_CLIENT_SECRET = "client-secret";
  process.env.JUNIOR_BASE_URL = BASE_URL;
}

function configureExampleOAuthEnv() {
  process.env.EXAMPLE_CLIENT_ID = "example-client-id";
  process.env.EXAMPLE_CLIENT_SECRET = "example-client-secret";
  process.env.JUNIOR_BASE_URL = BASE_URL;
}

function configureLinearOAuthEnv() {
  process.env.LINEAR_CLIENT_ID = "linear-client-id";
  process.env.LINEAR_CLIENT_SECRET = "linear-client-secret";
  process.env.JUNIOR_BASE_URL = BASE_URL;
}

function configureGitHubOAuthEnv() {
  process.env.GITHUB_APP_CLIENT_ID = "github-client-id";
  process.env.GITHUB_APP_CLIENT_SECRET = "github-client-secret";
  process.env.JUNIOR_BASE_URL = BASE_URL;
}

type CapturedTokenRequest = {
  body: string;
  headers: Record<string, string>;
  method: string;
  url: string;
};

async function captureTokenRequest(
  request: Request,
): Promise<CapturedTokenRequest> {
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: await request.text(),
  };
}

const TOKEN_ENDPOINTS = [
  SENTRY_OAUTH_CONFIG.tokenEndpoint,
  EXAMPLE_OAUTH_CONFIG.tokenEndpoint,
  GITHUB_OAUTH_CONFIG.tokenEndpoint,
];

function mockJsonFetch(
  payload: Record<string, unknown>,
): CapturedTokenRequest[] {
  const requests: CapturedTokenRequest[] = [];
  mswServer.use(
    ...TOKEN_ENDPOINTS.map((endpoint) =>
      http.post(endpoint, async ({ request }) => {
        requests.push(await captureTokenRequest(request));
        return HttpResponse.json(payload);
      }),
    ),
  );
  return requests;
}

function mockFailedFetch(status: number): CapturedTokenRequest[] {
  const requests: CapturedTokenRequest[] = [];
  mswServer.use(
    ...TOKEN_ENDPOINTS.map((endpoint) =>
      http.post(endpoint, async ({ request }) => {
        requests.push(await captureTokenRequest(request));
        return HttpResponse.text("failed", { status });
      }),
    ),
  );
  return requests;
}

function mockInvalidJsonFetch(): CapturedTokenRequest[] {
  const requests: CapturedTokenRequest[] = [];
  mswServer.use(
    ...TOKEN_ENDPOINTS.map((endpoint) =>
      http.post(endpoint, async ({ request }) => {
        requests.push(await captureTokenRequest(request));
        return HttpResponse.text("not-json", {
          headers: { "Content-Type": "application/json" },
        });
      }),
    ),
  );
  return requests;
}

describe("oauth callback handler", () => {
  it("returns styled HTML 404 for unknown provider", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/unknown?code=abc&state=xyz",
      ),
      "unknown",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Unknown provider");
  });

  it("returns styled HTML 400 when code or state is missing", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry"),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("missing required parameters");
  });

  it("returns styled HTML 400 for expired state", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=abc&state=nonexistent",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("expired");
    expect(body).toContain(
      "connect your Sentry account again to get a new link",
    );
  });

  it("returns styled HTML 400 for provider mismatch", async () => {
    const stateKey = "oauth-state:test-state-123";
    await putStoredState(stateKey, {
      userId: "U123",
      provider: "github", // mismatch with sentry
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=abc&state=test-state-123",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("mismatch");
  });

  it("deletes state key after reading (one-time use)", async () => {
    const stateKey = "oauth-state:test-state-456";
    await putStoredState(stateKey, {
      userId: "U123",
      provider: "sentry",
    });

    configureSentryOAuthEnv();
    mockJsonFetch({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=auth-code&state=test-state-456",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(await getStoredState(stateKey)).toBeFalsy();
  });

  it("handles callbacks when the state adapter starts disconnected", async () => {
    const stateKey = "oauth-state:cold-start";
    await putStoredState(stateKey, {
      userId: "U123",
      provider: "sentry",
    });

    configureSentryOAuthEnv();
    mockJsonFetch({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    await getStateAdapter().disconnect();

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=auth-code&state=cold-start",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    expect(await getStoredTokens("U123", "sentry")).toMatchObject({
      accessToken: "new-access",
    });
  });

  it("returns styled HTML 500 when client credentials are missing", async () => {
    const stateKey = "oauth-state:test-state-789";
    await putStoredState(stateKey, {
      userId: "U123",
      provider: "sentry",
    });
    delete process.env.SENTRY_CLIENT_ID;
    delete process.env.SENTRY_CLIENT_SECRET;

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=abc&state=test-state-789",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("credentials");
  });

  it("exchanges code for tokens and stores them", async () => {
    const stateKey = "oauth-state:exchange-test";
    await putStoredState(stateKey, {
      userId: "U456",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.456",
    });

    configureSentryOAuthEnv();
    mockJsonFetch({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 7200,
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=valid-code&state=exchange-test",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Sentry account connected");
    expect(body).toContain("You can close this tab and return to Slack.");
    expect(body).not.toContain("You can close this tab and return to Junior.");

    const stored = (await getStoredTokens("U456", "sentry")) as {
      accessToken: string;
      refreshToken: string;
      scope?: string;
    };
    expect(stored).toBeDefined();
    expect(stored.accessToken).toBe("new-access-token");
    expect(stored.refreshToken).toBe("new-refresh-token");
    expect(stored.scope).toBe("event:read org:read project:read team:read");
  });

  it("uses basic auth and json body for token exchange without expires_in", async () => {
    const stateKey = "oauth-state:example-exchange";
    await putStoredState(stateKey, {
      userId: "U999",
      provider: "example",
    });

    configureExampleOAuthEnv();
    const requests = mockJsonFetch({
      access_token: "example-access-token",
      refresh_token: "example-refresh-token",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/example?code=valid-code&state=example-exchange",
      ),
      "example",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.example.com/v1/oauth/token",
      method: "POST",
      headers: expect.objectContaining({
        accept: "application/json",
        authorization: `Basic ${Buffer.from("example-client-id:example-client-secret").toString("base64")}`,
        "content-type": "application/json",
      }),
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      grant_type: "authorization_code",
      code: "valid-code",
      redirect_uri: `${BASE_URL}/api/oauth/callback/example`,
    });

    const stored = (await getStoredTokens("U999", "example")) as {
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
    };
    expect(stored).toMatchObject({
      accessToken: "example-access-token",
      refreshToken: "example-refresh-token",
    });
    expect(stored.expiresAt).toBeUndefined();
  });

  it("stores installation tokens after a Slack admin completes OAuth", async () => {
    configureLinearOAuthEnv();
    await putStoredState("oauth-state:linear-install", {
      userId: "U777",
      provider: "linear",
      actor: { platform: "slack", teamId: "T777", userId: "U777" },
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U777", isAdmin: true }),
    });
    mswServer.use(
      http.post("https://api.linear.app/oauth/token", () =>
        HttpResponse.json({
          access_token: "linear-access-token",
          refresh_token: "linear-refresh-token",
          scope: "read,write",
        }),
      ),
    );

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/linear?code=valid-code&state=linear-install",
      ),
      "linear",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    expect(await createInstallationTokenStore().get("linear")).toMatchObject({
      accessToken: "linear-access-token",
      refreshToken: "linear-refresh-token",
    });
    expect(await getStoredTokens("U777", "linear")).toBeUndefined();
  });

  it("blocks installation OAuth callbacks from Slack non-admins", async () => {
    configureLinearOAuthEnv();
    await putStoredState("oauth-state:linear-non-admin", {
      userId: "U777",
      provider: "linear",
      actor: { platform: "slack", teamId: "T777", userId: "U777" },
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U777", isAdmin: false }),
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/linear?code=valid-code&state=linear-non-admin",
      ),
      "linear",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Only a Slack workspace admin");
    expect(await createInstallationTokenStore().get("linear")).toBeUndefined();
  });

  it("does not replace an existing installation token", async () => {
    configureLinearOAuthEnv();
    await createInstallationTokenStore().set("linear", {
      accessToken: "existing-access-token",
      refreshToken: "existing-refresh-token",
      scope: "read,write",
    });
    await putStoredState("oauth-state:linear-existing", {
      userId: "U777",
      provider: "linear",
      actor: { platform: "slack", teamId: "T777", userId: "U777" },
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U777", isAdmin: true }),
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/linear?code=valid-code&state=linear-existing",
      ),
      "linear",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(409);
    expect(await createInstallationTokenStore().get("linear")).toMatchObject({
      accessToken: "existing-access-token",
    });
  });

  it("stores GitHub App user tokens when GitHub returns an empty OAuth scope", async () => {
    const stateKey = "oauth-state:github-exchange";
    await putStoredState(stateKey, {
      userId: "U777",
      provider: "github",
    });

    configureGitHubOAuthEnv();
    resolvePluginOAuthAccountMock.mockResolvedValue({
      id: "12345",
      label: "actor",
      url: "https://github.com/actor",
    });
    mockJsonFetch({
      access_token: "github-user-token",
      refresh_token: "github-refresh-token",
      expires_in: 28_800,
      scope: "",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/github?code=valid-code&state=github-exchange",
      ),
      "github",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    const stored = (await getStoredTokens("U777", "github")) as {
      account?: { id: string; label?: string; url?: string };
      accessToken: string;
      refreshToken: string;
      scope?: string;
    };
    expect(stored).toMatchObject({
      accessToken: "github-user-token",
      account: {
        id: "12345",
        label: "actor",
        url: "https://github.com/actor",
      },
      refreshToken: "github-refresh-token",
    });
    expect(stored.scope).toBeUndefined();
    expect(resolvePluginOAuthAccountMock).toHaveBeenCalledWith({
      provider: "github",
      tokens: expect.objectContaining({
        accessToken: "github-user-token",
        refreshToken: "github-refresh-token",
      }),
    });
  });

  it("keeps a successful OAuth connection when identity linking fails", async () => {
    const stateKey = "oauth-state:github-identity-link-failure";
    await putStoredState(stateKey, {
      userId: "U777",
      provider: "github",
      actor: { platform: "slack", teamId: "T777", userId: "U777" },
    });

    configureGitHubOAuthEnv();
    resolvePluginOAuthAccountMock.mockResolvedValue({
      id: "12345",
      handle: "actor",
      label: "actor",
    });
    mockJsonFetch({
      access_token: "github-user-token",
      refresh_token: "github-refresh-token",
      expires_in: 28_800,
      scope: "",
    });
    queueSlackApiError("users.info", { error: "user_not_found" });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/github?code=valid-code&state=github-identity-link-failure",
      ),
      "github",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    expect(await getStoredTokens("U777", "github")).toMatchObject({
      accessToken: "github-user-token",
      account: { id: "12345", handle: "actor" },
    });
  });

  it("rejects callback grants whose explicit scope is missing required access", async () => {
    const stateKey = "oauth-state:missing-scope";
    await putStoredState(stateKey, {
      userId: "U456",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.456",
    });

    configureSentryOAuthEnv();
    mockJsonFetch({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 7200,
      scope: "event:read org:read project:read",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=valid-code&state=missing-scope",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("did not grant the access Junior requires");
    expect(await getStoredTokens("U456", "sentry")).toBeUndefined();
    expect(waitUntilCallbacks).toHaveLength(0);
  });

  it("returns styled HTML 500 when token exchange fails", async () => {
    const stateKey = "oauth-state:fail-exchange";
    await putStoredState(stateKey, {
      userId: "U789",
      provider: "sentry",
    });

    configureSentryOAuthEnv();
    mockFailedFetch(400);

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=bad-code&state=fail-exchange",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("failed");
  });

  it("returns styled HTML 500 when token exchange returns invalid JSON", async () => {
    const stateKey = "oauth-state:invalid-token-json";
    await putStoredState(stateKey, {
      userId: "U789",
      provider: "sentry",
    });

    configureSentryOAuthEnv();
    mockInvalidJsonFetch();

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=bad-code&state=invalid-token-json",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("incomplete token response");
    expect(await getStoredTokens("U789", "sentry")).toBeUndefined();
  });

  it("returns styled HTML 400 when user denies authorization", async () => {
    const stateKey = "oauth-state:deny-test";
    await putStoredState(stateKey, {
      userId: "U999",
      provider: "sentry",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?error=access_denied&state=deny-test",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("declined");
    expect(body).toContain(
      "connect your Sentry account again if you change your mind",
    );
    expect(body).not.toContain("auth command");
    expect(await getStoredState(stateKey)).toBeFalsy();
  });

  it("returns styled HTML 400 for provider-returned errors", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?error=server_error&state=some-state",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("server_error");
  });

  it("escapes HTML in provider error parameter to prevent XSS", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?error=%3Cscript%3Ealert(1)%3C/script%3E&state=xss-test",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("escapes HTML in error message content to prevent XSS", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&state=xss-msg-test",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img");
  });

  it("shows resumable-turn status in success page", async () => {
    const stateKey = "oauth-state:pending-test";
    await putStoredState(stateKey, {
      userId: "U111",
      provider: "sentry",
      channelId: "C123",
      source: createSlackSource({
        teamId: "T123",
        channelId: "C123",
        threadTs: "123.789",

        visibility: "private",
      }),
      threadTs: "123.789",
      resumeConversationId: "slack:C123:123.789",
      resumeSessionId: "turn-123",
    });

    configureSentryOAuthEnv();
    mockJsonFetch({
      access_token: "token",
      refresh_token: "refresh",
      expires_in: 3600,
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=code&state=pending-test",
      ),
      "sentry",
      testWaitUntil,
      { agentRunner: testAgentRunner },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("being processed in Slack");
    expect(body).toContain("You can close this tab and return to Slack.");
    expect(body).not.toContain("You can close this tab and return to Junior.");
  });
});
