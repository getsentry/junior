import { beforeEach, describe, expect, it, vi } from "vitest";

const { healthGetMock, webhooksPostMock } = vi.hoisted(() => ({
  healthGetMock: vi.fn(async () => new Response("health", { status: 200 })),
  webhooksPostMock: vi.fn(async (_request: Request, context: { params: Promise<{ platform: string }> }) => {
    const { platform } = await context.params;
    return new Response(`webhook:${platform}`, { status: 202 });
  })
}));

vi.mock("@/handlers/health", () => ({
  GET: healthGetMock
}));

vi.mock("@/handlers/webhooks", () => ({
  POST: webhooksPostMock
}));

import { GET, POST } from "@/handlers/router";

function routeContext(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

describe("handlers router", () => {
  beforeEach(() => {
    healthGetMock.mockClear();
    webhooksPostMock.mockClear();
  });

  it("routes catch-all health requests", async () => {
    const response = await GET(new Request("http://localhost/api/health"), routeContext(["health"]));
    expect(response.status).toBe(200);
    expect(healthGetMock).toHaveBeenCalledTimes(1);
  });

  it("accepts legacy api-prefixed health route form", async () => {
    const response = await GET(new Request("http://localhost/api/health"), routeContext(["api", "health"]));
    expect(response.status).toBe(200);
    expect(healthGetMock).toHaveBeenCalledTimes(1);
  });

  it("routes catch-all webhook requests", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack", { method: "POST" }),
      routeContext(["webhooks", "slack"])
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("webhook:slack");
    expect(webhooksPostMock).toHaveBeenCalledTimes(1);
    expect(await webhooksPostMock.mock.calls[0][1].params).toEqual({ platform: "slack" });
  });

  it("accepts legacy api-prefixed webhook route form", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack", { method: "POST" }),
      routeContext(["api", "webhooks", "slack"])
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("webhook:slack");
    expect(webhooksPostMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for multi-segment webhook routes", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/slack/unexpected", { method: "POST" }),
      routeContext(["webhooks", "slack", "unexpected"])
    );
    expect(response.status).toBe(404);
    expect(webhooksPostMock).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const response = await GET(new Request("http://localhost/api/unknown"), routeContext(["unknown"]));
    expect(response.status).toBe(404);
    expect(healthGetMock).not.toHaveBeenCalled();
    expect(webhooksPostMock).not.toHaveBeenCalled();
  });
});
