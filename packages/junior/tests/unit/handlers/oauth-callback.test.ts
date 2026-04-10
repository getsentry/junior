import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { waitUntilCallbacks, generateAssistantReplyMock } = vi.hoisted(() => ({
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
  generateAssistantReplyMock: vi.fn(async (..._args: unknown[]) => ({
    text: "test reply",
    diagnostics: { outcome: "success", toolCalls: [] },
  })),
}));

// Mock state adapter
const mockStateStore = new Map<string, unknown>();
vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    connect: async () => {},
    disconnect: async () => {},
    get: async <T>(key: string): Promise<T | null> =>
      (mockStateStore.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      mockStateStore.set(key, value);
    },
    delete: async (key: string) => {
      mockStateStore.delete(key);
    },
  }),
}));

// Mock user token store
const mockTokenStore = new Map<string, unknown>();
vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({
    get: async (userId: string, provider: string) =>
      mockTokenStore.get(`${userId}:${provider}`),
    set: async (userId: string, provider: string, tokens: unknown) => {
      mockTokenStore.set(`${userId}:${provider}`, tokens);
    },
    delete: async (userId: string, provider: string) => {
      mockTokenStore.delete(`${userId}:${provider}`);
    },
  }),
}));

// Mock plugin registry — provide sentry OAuth config
vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig: (provider: string) => {
    if (provider === "sentry") {
      return {
        clientIdEnv: "SENTRY_CLIENT_ID",
        clientSecretEnv: "SENTRY_CLIENT_SECRET",
        authorizeEndpoint: "https://sentry.io/oauth/authorize/",
        tokenEndpoint: "https://sentry.io/oauth/token/",
        scope: "event:read org:read project:read team:read",
        callbackPath: "/api/oauth/callback/sentry",
      };
    }
    if (provider === "example") {
      return {
        clientIdEnv: "EXAMPLE_CLIENT_ID",
        clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
        authorizeEndpoint: "https://api.example.com/v1/oauth/authorize",
        tokenEndpoint: "https://api.example.com/v1/oauth/token",
        authorizeParams: { audience: "workspace" },
        tokenAuthMethod: "basic",
        tokenExtraHeaders: { "Content-Type": "application/json" },
        callbackPath: "/api/oauth/callback/example",
      };
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

// Mock generateAssistantReply
vi.mock("@/chat/respond", () => ({
  generateAssistantReply: generateAssistantReplyMock,
}));

// Mock botConfig
vi.mock("@/chat/config", () => ({
  botConfig: { userName: "junior" },
}));

// Mock observability
vi.mock("@/chat/logging", () => ({
  logException: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET } from "@/handlers/oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

beforeEach(() => {
  mockStateStore.clear();
  mockTokenStore.clear();
  waitUntilCallbacks.length = 0;
  generateAssistantReplyMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
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
    mockStateStore.set(stateKey, {
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
    mockStateStore.set(stateKey, {
      userId: "U123",
      provider: "sentry",
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

    await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=auth-code&state=test-state-456",
      ),
      "sentry",
      testWaitUntil,
    );

    expect(mockStateStore.has(stateKey)).toBe(false);
  });

  it("returns styled HTML 500 when client credentials are missing", async () => {
    const stateKey = "oauth-state:test-state-789";
    mockStateStore.set(stateKey, {
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
    mockStateStore.set(stateKey, {
      userId: "U456",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.456",
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200,
      }),
    })) as unknown as typeof fetch;

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

    const stored = mockTokenStore.get("U456:sentry") as {
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
    mockStateStore.set(stateKey, {
      userId: "U999",
      provider: "example",
    });

    process.env.EXAMPLE_CLIENT_ID = "example-client-id";
    process.env.EXAMPLE_CLIENT_SECRET = "example-client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "example-access-token",
        refresh_token: "example-refresh-token",
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
          redirect_uri: "https://example.com/api/oauth/callback/example",
        }),
      }),
    );

    const stored = mockTokenStore.get("U999:example") as {
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
    mockStateStore.set(stateKey, {
      userId: "U456",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.456",
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200,
        scope: "event:read org:read project:read",
      }),
    })) as unknown as typeof fetch;

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
    expect(mockTokenStore.get("U456:sentry")).toBeUndefined();
    expect(waitUntilCallbacks).toHaveLength(0);
  });

  it("returns styled HTML 500 when token exchange fails", async () => {
    const stateKey = "oauth-state:fail-exchange";
    mockStateStore.set(stateKey, {
      userId: "U789",
      provider: "sentry",
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
    })) as unknown as typeof fetch;

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
    mockStateStore.set(stateKey, {
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
    // State should be cleaned up
    expect(mockStateStore.has(stateKey)).toBe(false);
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
    mockStateStore.set(stateKey, {
      userId: "U111",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.789",
      pendingMessage: "list my sentry issues",
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "token",
        refresh_token: "refresh",
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

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

  it("resumes pending messages with persisted thread context after token exchange", async () => {
    const stateKey = "oauth-state:resume-test";
    mockStateStore.set(stateKey, {
      userId: "U111",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.789",
      pendingMessage: "list my sentry issues",
    });
    mockStateStore.set("thread-state:slack:C123:123.789", {
      conversation: {
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "You need the budget by Friday.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "user-1",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: 2,
            author: {
              userId: "U111",
              userName: "dcramer",
            },
          },
        ],
      },
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "token",
        refresh_token: "refresh",
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/sentry?code=code&state=resume-test",
      ),
      "sentry",
      testWaitUntil,
    );

    expect(response.status).toBe(200);
    expect(waitUntilCallbacks).toHaveLength(2);

    for (const callback of waitUntilCallbacks) {
      await callback();
    }

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "list my sentry issues",
    );
  });
});
