import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleDispatchCallback,
  verifyDispatchCallbackRequest,
} from "@/chat/agent-dispatch/signing";

describe("agent dispatch callback signing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "dispatch-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    vi.restoreAllMocks();
  });

  it("signs dispatch callbacks so the handler can verify them", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleDispatchCallback({
      id: "dispatch_123",
      expectedVersion: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://junior.example.com/api/internal/agent-dispatch");

    const request = new Request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    await expect(verifyDispatchCallbackRequest(request)).resolves.toEqual({
      id: "dispatch_123",
      expectedVersion: 3,
    });
  });

  it("rejects callbacks whose signature does not match the body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleDispatchCallback({
      id: "dispatch_123",
      expectedVersion: 3,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    headers.set("x-junior-dispatch-signature", "v1=deadbeef");
    const request = new Request(url, {
      method: init.method,
      headers,
      body: init.body,
    });

    await expect(
      verifyDispatchCallbackRequest(request),
    ).resolves.toBeUndefined();
  });
});
