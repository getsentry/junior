import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AgentRunner } from "@/chat/runtime/agent-runner";

const { mcpCallback } = vi.hoisted(() => ({
  mcpCallback: vi.fn(async () => new Response("Connected")),
}));

vi.mock("@/handlers/mcp-oauth-callback", () => ({
  GET: mcpCallback,
}));

import { startLocalOAuthCallbackServer } from "@/chat/local/oauth-callback-server";

describe("local OAuth callback server", () => {
  let close: (() => Promise<void>) | undefined;

  async function startCallback() {
    const callback = await startLocalOAuthCallbackServer({} as AgentRunner);
    close = callback.close;
    return callback;
  }

  afterEach(async () => {
    await close?.();
    close = undefined;
    mcpCallback.mockClear();
    vi.restoreAllMocks();
  });

  it("ignores a duplicate callback from an earlier authorization", async () => {
    const callback = await startCallback();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=first",
    );
    const firstResponse = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=first`,
    );
    await callback.waitForAuthorization();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=second",
    );
    const staleResponse = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=first`,
    );
    const secondResponse = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=second`,
    );
    await callback.waitForAuthorization();

    expect(firstResponse.status).toBe(200);
    expect(staleResponse.status).toBe(409);
    expect(secondResponse.status).toBe(200);
    expect(mcpCallback).toHaveBeenCalledTimes(2);
  });

  it("lets a later authorization replace a canceled wait", async () => {
    const callback = await startCallback();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=first",
    );
    callback.cancelAuthorization();
    callback.beginAuthorization(
      "https://provider.example/authorize?state=second",
    );

    const staleResponse = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=first`,
    );
    const secondResponse = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=second`,
    );
    await callback.waitForAuthorization();

    expect(staleResponse.status).toBe(409);
    expect(secondResponse.status).toBe(200);
    expect(mcpCallback).toHaveBeenCalledOnce();
  });

  it("rejects a malformed provider path without invoking a callback", async () => {
    const callback = await startCallback();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=valid-state",
    );
    const response = await fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/%?state=valid-state`,
    );
    callback.cancelAuthorization();

    expect(response.status).toBe(404);
    expect(mcpCallback).not.toHaveBeenCalled();
  });

  it("bounds a malformed Host header to a client error", async () => {
    const callback = await startCallback();

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          headers: { host: "[" },
          hostname: "127.0.0.1",
          path: "/",
          port: callback.port,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(status).toBe(400);
    expect(mcpCallback).not.toHaveBeenCalled();
  });

  it("stops the wait timeout while a provider callback is processing", async () => {
    let finishCallback: (() => void) | undefined;
    mcpCallback.mockImplementationOnce(
      async () =>
        await new Promise<Response>((resolve) => {
          finishCallback = () => resolve(new Response("Connected"));
        }),
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const callback = await startCallback();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=processing",
    );
    const waitTimeout = setTimeoutSpy.mock.results.at(-1)?.value;
    const response = fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=processing`,
    );
    await vi.waitFor(() => expect(mcpCallback).toHaveBeenCalledOnce());

    expect(clearTimeoutSpy).toHaveBeenCalledWith(waitTimeout);
    finishCallback?.();
    await expect(response).resolves.toMatchObject({ status: 200 });
    await callback.waitForAuthorization();
  });

  it("bounds provider callback processing with a separate timeout", async () => {
    let finishCallback: (() => void) | undefined;
    mcpCallback.mockImplementationOnce(
      async () =>
        await new Promise<Response>((resolve) => {
          finishCallback = () => resolve(new Response("Connected"));
        }),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const callback = await startCallback();

    callback.beginAuthorization(
      "https://provider.example/authorize?state=processing-timeout",
    );
    const response = fetch(
      `http://127.0.0.1:${callback.port}/api/oauth/callback/mcp/github?state=processing-timeout`,
    );
    await vi.waitFor(() => expect(mcpCallback).toHaveBeenCalledOnce());
    const processingTimer = [...setTimeoutSpy.mock.calls]
      .reverse()
      .find((call) => call[1] === 60_000)?.[0];
    expect(processingTimer).toEqual(expect.any(Function));

    (processingTimer as () => void)();

    await expect(callback.waitForAuthorization()).rejects.toThrow(
      "Timed out completing OAuth authorization",
    );
    await expect(response).resolves.toMatchObject({ status: 504 });
    finishCallback?.();
  });
});
