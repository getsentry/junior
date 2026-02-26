import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "@/chat/tools/web-search";

function createJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  } as Response;
}

describe("createWebSearchTool", () => {
  afterEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.AI_WEB_SEARCH_MODEL;
    delete process.env.AI_ROUTER_MODEL;
    delete process.env.AI_MODEL;
    vi.unstubAllGlobals();
  });

  it("uses AI Gateway parallel search and maps tool results", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.AI_WEB_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createJsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      results: [
                        {
                          title: "Vercel AI Gateway",
                          url: "https://vercel.com/docs/ai-gateway",
                          content: "Gateway docs"
                        }
                      ]
                    })
                  }
                }
              ]
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }
    const result = await tool.execute({ query: "vercel ai gateway", max_results: 2 }, {} as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer test-key"
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "xai/grok-4-fast-reasoning",
      messages: [{ role: "user", content: "vercel ai gateway" }],
      tools: [
        {
          type: "tool",
          tool: {
            type: "provider-defined",
            id: "vercel/parallel-search",
            args: {
              query: "vercel ai gateway",
              maxResults: 2
            }
          }
        }
      ],
      tool_choice: "required"
    });
    expect(result).toEqual({
      ok: true,
      model: "xai/grok-4-fast-reasoning",
      query: "vercel ai gateway",
      result_count: 1,
      results: [
        {
          title: "Vercel AI Gateway",
          url: "https://vercel.com/docs/ai-gateway",
          snippet: "Gateway docs"
        }
      ]
    });
  });

  it("throws when gateway credentials are missing", async () => {
    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }
    await expect(tool.execute({ query: "test" }, {} as any)).rejects.toThrow(
      "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)"
    );
  });
});
