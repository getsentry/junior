import { describe, expect, it, vi } from "vitest";
import { createMcpTransportFetch } from "@/chat/mcp/transport-fetch";

describe("createMcpTransportFetch", () => {
  it("continues an ordinary redirect without replaying the MCP request", async () => {
    const serverUrl = new URL("https://mcp.example.test/mcp");
    const redirectedUrl = "https://mcp.example.test/v2/mcp";
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: redirectedUrl },
        }),
      )
      .mockResolvedValueOnce(new Response("redirected", { status: 200 }));
    const transportFetch = createMcpTransportFetch(serverUrl, baseFetch);

    const response = await transportFetch(serverUrl, {
      method: "POST",
      body: "request body",
      headers: { "content-type": "application/json" },
    });

    await expect(response.text()).resolves.toBe("redirected");
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const initialRequest = baseFetch.mock.calls[0]?.[0];
    expect(initialRequest).toBeInstanceOf(Request);
    expect((initialRequest as Request).url).toBe(serverUrl.href);
    expect(baseFetch.mock.calls[1]?.[0]).toEqual(new URL(redirectedUrl));
    expect(baseFetch.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      redirect: "follow",
    });
  });
});
