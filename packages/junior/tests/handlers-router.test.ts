import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  healthGetMock,
  mcpOauthCallbackGetMock,
  oauthCallbackGetMock,
  queueCallbackPostMock,
  webhooksPostMock,
} = vi.hoisted(() => ({
  healthGetMock: vi.fn(async () => new Response("health", { status: 200 })),
  mcpOauthCallbackGetMock: vi.fn(
    async (
      _request: Request,
      context: { params: Promise<{ provider: string }> },
    ) => {
      const { provider } = await context.params;
      return new Response(`mcp-oauth:${provider}`, { status: 200 });
    },
  ),
  oauthCallbackGetMock: vi.fn(
    async (
      _request: Request,
      context: { params: Promise<{ provider: string }> },
    ) => {
      const { provider } = await context.params;
      return new Response(`oauth:${provider}`, { status: 200 });
    },
  ),
  queueCallbackPostMock: vi.fn(
    async () => new Response("queue:ok", { status: 200 }),
  ),
  webhooksPostMock: vi.fn(
    async (
      _request: Request,
      context: { params: Promise<{ platform: string }> },
    ) => {
      const { platform } = await context.params;
      return new Response(`webhook:${platform}`, { status: 202 });
    },
  ),
}));

vi.mock("@/handlers/health", () => ({
  GET: healthGetMock,
}));

vi.mock("@/handlers/mcp-oauth-callback", () => ({
  GET: mcpOauthCallbackGetMock,
}));

vi.mock("@/handlers/oauth-callback", () => ({
  GET: oauthCallbackGetMock,
}));

vi.mock("@/handlers/queue-callback", () => ({
  POST: queueCallbackPostMock,
}));

vi.mock("@/handlers/webhooks", () => ({
  POST: webhooksPostMock,
}));

import { GET, POST } from "@/handlers/router";

function routeContext(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

describe("handlers router", () => {
  beforeEach(() => {
    healthGetMock.mockClear();
    mcpOauthCallbackGetMock.mockClear();
    oauthCallbackGetMock.mockClear();
    queueCallbackPostMock.mockClear();
    webhooksPostMock.mockClear();
  });

  it("routes catch-all health requests", async () => {
    const response = await GET(
      new Request("http://localhost/api/health"),
      routeContext(["health"]),
    );
    expect(response.status).toBe(200);
    expect(healthGetMock).toHaveBeenCalledTimes(1);
  });

  it("accepts legacy api-prefixed health route form", async () => {
    const response = await GET(
      new Request("http://localhost/api/health"),
      routeContext(["api", "health"]),
    );
    expect(response.status).toBe(200);
    expect(healthGetMock).toHaveBeenCalledTimes(1);
  });

  it("routes catch-all webhook requests", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack", { method: "POST" }),
      routeContext(["webhooks", "slack"]),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("webhook:slack");
    expect(webhooksPostMock).toHaveBeenCalledTimes(1);
    expect(await webhooksPostMock.mock.calls[0][1].params).toEqual({
      platform: "slack",
    });
  });

  it("routes queue callback requests", async () => {
    const response = await POST(
      new Request("http://localhost/api/queue/callback", { method: "POST" }),
      routeContext(["queue", "callback"]),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("queue:ok");
    expect(queueCallbackPostMock).toHaveBeenCalledTimes(1);
  });

  it("accepts legacy api-prefixed queue callback route form", async () => {
    const response = await POST(
      new Request("http://localhost/api/queue/callback", { method: "POST" }),
      routeContext(["api", "queue", "callback"]),
    );
    expect(response.status).toBe(200);
    expect(queueCallbackPostMock).toHaveBeenCalledTimes(1);
  });

  it("routes oauth callback requests", async () => {
    const response = await GET(
      new Request("http://localhost/api/oauth/callback/sentry"),
      routeContext(["oauth", "callback", "sentry"]),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("oauth:sentry");
    expect(oauthCallbackGetMock).toHaveBeenCalledTimes(1);
    expect(await oauthCallbackGetMock.mock.calls[0][1].params).toEqual({
      provider: "sentry",
    });
  });

  it("routes MCP oauth callback requests before generic oauth callbacks", async () => {
    const response = await GET(
      new Request("http://localhost/api/oauth/callback/mcp/sentry"),
      routeContext(["oauth", "callback", "mcp", "sentry"]),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mcp-oauth:sentry");
    expect(mcpOauthCallbackGetMock).toHaveBeenCalledTimes(1);
    expect(await mcpOauthCallbackGetMock.mock.calls[0][1].params).toEqual({
      provider: "sentry",
    });
    expect(oauthCallbackGetMock).not.toHaveBeenCalled();
  });

  it("accepts legacy api-prefixed oauth callback route form", async () => {
    const response = await GET(
      new Request("http://localhost/api/oauth/callback/sentry"),
      routeContext(["api", "oauth", "callback", "sentry"]),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("oauth:sentry");
    expect(oauthCallbackGetMock).toHaveBeenCalledTimes(1);
  });

  it("accepts legacy api-prefixed MCP oauth callback route form", async () => {
    const response = await GET(
      new Request("http://localhost/api/oauth/callback/mcp/sentry"),
      routeContext(["api", "oauth", "callback", "mcp", "sentry"]),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mcp-oauth:sentry");
    expect(mcpOauthCallbackGetMock).toHaveBeenCalledTimes(1);
  });

  it("accepts legacy api-prefixed webhook route form", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack", { method: "POST" }),
      routeContext(["api", "webhooks", "slack"]),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("webhook:slack");
    expect(webhooksPostMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for multi-segment webhook routes", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack/unexpected", {
        method: "POST",
      }),
      routeContext(["webhooks", "slack", "unexpected"]),
    );
    expect(response.status).toBe(404);
    expect(webhooksPostMock).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const response = await GET(
      new Request("http://localhost/api/unknown"),
      routeContext(["unknown"]),
    );
    expect(response.status).toBe(404);
    expect(healthGetMock).not.toHaveBeenCalled();
    expect(webhooksPostMock).not.toHaveBeenCalled();
  });
});
