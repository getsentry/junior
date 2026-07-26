import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "@/chat/runtime/agent-runner";

const { mcpCallback } = vi.hoisted(() => ({
  mcpCallback: vi.fn(async () => new Response("Connected")),
}));

vi.mock("@/handlers/mcp-oauth-callback", () => ({
  GET: mcpCallback,
}));

describe("local OAuth callback server", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    mcpCallback.mockClear();
  });

  it("ignores a duplicate callback from an earlier authorization", async () => {
    const { startLocalOAuthCallbackServer } =
      await import("@/chat/local/oauth-callback-server");
    const callback = await startLocalOAuthCallbackServer({} as AgentRunner);
    close = callback.close;

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
    const { startLocalOAuthCallbackServer } =
      await import("@/chat/local/oauth-callback-server");
    const callback = await startLocalOAuthCallbackServer({} as AgentRunner);
    close = callback.close;

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
});
