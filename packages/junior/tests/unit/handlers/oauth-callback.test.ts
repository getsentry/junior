import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  BASE_URL,
  EXAMPLE_OAUTH_CONFIG,
  SENTRY_OAUTH_CONFIG,
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
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig: (provider: string) => {
    if (provider === "sentry") {
      return SENTRY_OAUTH_CONFIG;
    }
    if (provider === "example") {
      return EXAMPLE_OAUTH_CONFIG;
    }
    return undefined;
  },
  isPluginProvider: (provider: string) =>
    provider === "sentry" || provider === "example",
  getPluginCapabilityProviders: () => [],
  isPluginCapability: () => false,
  isPluginConfigKey: () => false,
  getPluginProviders: () => [],
  getPluginSkillRoots: () => [],
  createPluginBroker: () => {
    throw new Error("not implemented in test");
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

import { createUserTokenStore } from "@/chat/capabilities/factory";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { GET } from "@/handlers/oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

beforeEach(async () => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  await disconnectStateAdapter();
  await getStateAdapter().connect();
  waitUntilCallbacks.length = 0;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
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

function mockJsonFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockFailedFetch(status: number) {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status,
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("oauth callback handler", () => {
  it("returns styled HTML 404 for unknown provider", async () => {
    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/unknown?code=abc&state=xyz",
      ),
      "unknown",
      testWaitUntil,
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
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("expired");
    expect(body).toContain(
      "ask Junior to connect your Sentry account again to get a new link",
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
    );

    expect(await getStoredState(stateKey)).toBeFalsy();
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
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Sentry account connected");

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
    const fetchMock = mockJsonFetch({
      access_token: "example-access-token",
      refresh_token: "example-refresh-token",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/example?code=valid-code&state=example-exchange",
      ),
      "example",
      testWaitUntil,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "application/json",
          authorization: `Basic ${Buffer.from("example-client-id:example-client-secret").toString("base64")}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "valid-code",
          redirect_uri: `${BASE_URL}/api/oauth/callback/example`,
        }),
      }),
    );

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
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("failed");
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
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("declined");
    expect(body).toContain(
      "ask Junior to connect your Sentry account again if you change your mind",
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
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img");
  });

  it("shows pending-message status in success page", async () => {
    const stateKey = "oauth-state:pending-test";
    await putStoredState(stateKey, {
      userId: "U111",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.789",
      pendingMessage: "list my sentry issues",
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
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("being processed in Slack");
  });
});
