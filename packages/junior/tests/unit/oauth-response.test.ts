import { describe, expect, it, vi } from "vitest";
import {
  fetchWithBoundedOAuthErrorBodies,
  readBoundedOAuthErrorBody,
} from "@/chat/oauth-response";

describe("OAuth error responses", () => {
  it("bounds provider-controlled bodies and cancels the remaining stream", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readBoundedOAuthErrorBody(
      new Response(body, { status: 500 }),
    );

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });

  it("bounds provider streams that keep yielding empty chunks", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readBoundedOAuthErrorBody(
      new Response(body, { status: 500 }),
    );

    expect(text).toBe("");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(16 * 1024 + 1);
  });

  it("preserves the HTTP status when the provider body stream fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("provider stream failed"));
      },
    });
    const wrappedFetch = fetchWithBoundedOAuthErrorBodies(
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "www-authenticate": 'Bearer realm="mcp"' },
            status: 401,
          }),
      ) as typeof fetch,
    );

    const response = await wrappedFetch("https://mcp.example.com/token");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
    await expect(response.text()).resolves.toBe("");
  });

  it("preserves the HTTP status when the provider body never yields", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      });
      const wrappedFetch = fetchWithBoundedOAuthErrorBodies(
        vi.fn(async () => new Response(body, { status: 504 })) as typeof fetch,
      );

      const responsePromise = wrappedFetch("https://mcp.example.com/token");
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;

      expect(response.status).toBe(504);
      expect(cancelled).toBe(true);
      await expect(response.text()).resolves.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports safe status metadata before returning an error response", async () => {
    let observedStatus: number | undefined;
    const wrappedFetch = fetchWithBoundedOAuthErrorBodies(
      vi.fn(async () => new Response("provider detail", { status: 503 })),
      (status) => {
        observedStatus = status;
      },
    );

    const response = await wrappedFetch("https://mcp.example.com/token");

    expect(response.status).toBe(503);
    expect(observedStatus).toBe(503);
  });
});
