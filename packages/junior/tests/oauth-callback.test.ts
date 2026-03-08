import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/server before importing the route handler
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    // Capture the callback but don't execute — we test the HTTP response only
    void fn;
  }
}));

// Mock state adapter
const mockStateStore = new Map<string, unknown>();
vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    get: async <T>(key: string): Promise<T | null> => (mockStateStore.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      mockStateStore.set(key, value);
    },
    delete: async (key: string) => {
      mockStateStore.delete(key);
    }
  })
}));

// Mock user token store
const mockTokenStore = new Map<string, unknown>();
vi.mock("@/chat/capabilities/factory", () => ({
  getUserTokenStore: () => ({
    get: async (userId: string, provider: string) => mockTokenStore.get(`${userId}:${provider}`),
    set: async (userId: string, provider: string, tokens: unknown) => {
      mockTokenStore.set(`${userId}:${provider}`, tokens);
    },
    delete: async (userId: string, provider: string) => {
      mockTokenStore.delete(`${userId}:${provider}`);
    }
  })
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
        scope: "event:read org:read project:read",
        callbackPath: "/api/oauth/callback/sentry"
      };
    }
    return undefined;
  },
  isPluginProvider: (provider: string) => provider === "sentry",
  getPluginCapabilityProviders: () => [],
  isPluginCapability: () => false,
  isPluginConfigKey: () => false,
  getPluginProviders: () => [],
  getPluginSkillRoots: () => [],
  createPluginBroker: () => { throw new Error("not implemented in test"); }
}));

// Mock generateAssistantReply
vi.mock("@/chat/respond", () => ({
  generateAssistantReply: vi.fn(async () => ({
    text: "test reply",
    diagnostics: { outcome: "success", toolCalls: [] }
  }))
}));

// Mock botConfig
vi.mock("@/chat/config", () => ({
  botConfig: { userName: "junior" }
}));

// Mock observability
vi.mock("@/chat/observability", () => ({
  logException: vi.fn(),
  logInfo: vi.fn()
}));

import { GET } from "@/handlers/oauth-callback";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  mockStateStore.clear();
  mockTokenStore.clear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

function makeContext(provider: string) {
  return { params: Promise.resolve({ provider }) };
}

describe("oauth callback handler", () => {
  it("returns styled HTML 404 for unknown provider", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/unknown?code=abc&state=xyz"),
      makeContext("unknown")
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Unknown provider");
  });

  it("returns styled HTML 400 when code or state is missing", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("missing required parameters");
  });

  it("returns styled HTML 400 for expired state", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=abc&state=nonexistent"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("expired");
  });

  it("returns styled HTML 400 for provider mismatch", async () => {
    const stateKey = "oauth-state:test-state-123";
    mockStateStore.set(stateKey, {
      userId: "U123",
      provider: "github" // mismatch with sentry
    });

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=abc&state=test-state-123"),
      makeContext("sentry")
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
      provider: "sentry"
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600
      })
    })) as unknown as typeof fetch;

    await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=auth-code&state=test-state-456"),
      makeContext("sentry")
    );

    expect(mockStateStore.has(stateKey)).toBe(false);
  });

  it("returns styled HTML 500 when client credentials are missing", async () => {
    const stateKey = "oauth-state:test-state-789";
    mockStateStore.set(stateKey, {
      userId: "U123",
      provider: "sentry"
    });
    delete process.env.SENTRY_CLIENT_ID;
    delete process.env.SENTRY_CLIENT_SECRET;

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=abc&state=test-state-789"),
      makeContext("sentry")
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
      threadTs: "123.456"
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200
      })
    })) as unknown as typeof fetch;

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=valid-code&state=exchange-test"),
      makeContext("sentry")
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Sentry account connected");

    const stored = mockTokenStore.get("U456:sentry") as { accessToken: string; refreshToken: string };
    expect(stored).toBeDefined();
    expect(stored.accessToken).toBe("new-access-token");
    expect(stored.refreshToken).toBe("new-refresh-token");
  });

  it("returns styled HTML 500 when token exchange fails", async () => {
    const stateKey = "oauth-state:fail-exchange";
    mockStateStore.set(stateKey, {
      userId: "U789",
      provider: "sentry"
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400
    })) as unknown as typeof fetch;

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=bad-code&state=fail-exchange"),
      makeContext("sentry")
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
      provider: "sentry"
    });

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?error=access_denied&state=deny-test"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("declined");
    // State should be cleaned up
    expect(mockStateStore.has(stateKey)).toBe(false);
  });

  it("returns styled HTML 400 for provider-returned errors", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?error=server_error&state=some-state"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("server_error");
  });

  it("escapes HTML in provider error parameter to prevent XSS", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?error=%3Cscript%3Ealert(1)%3C/script%3E&state=xss-test"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&amp;lt;script&amp;gt;");
  });

  it("escapes HTML in error message content to prevent XSS", async () => {
    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&state=xss-msg-test"),
      makeContext("sentry")
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<img");
    expect(body).toContain("&amp;lt;img");
  });

  it("shows pending-message status in success page", async () => {
    const stateKey = "oauth-state:pending-test";
    mockStateStore.set(stateKey, {
      userId: "U111",
      provider: "sentry",
      channelId: "C123",
      threadTs: "123.789",
      pendingMessage: "list my sentry issues"
    });

    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "token",
        refresh_token: "refresh",
        expires_in: 3600
      })
    })) as unknown as typeof fetch;

    const response = await GET(
      makeRequest("https://example.com/api/oauth/callback/sentry?code=code&state=pending-test"),
      makeContext("sentry")
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("being processed in Slack");
  });
});
