import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { logException } from "@/chat/logging";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: vi.fn(),
}));

vi.mock("@/chat/logging", () => ({
  logException: vi.fn(),
}));

describe("createWebSearchTool", () => {
  const parallelSearch = { id: "parallel-search-tool" };
  const gatewayProvider = {
    chat: vi.fn((model: string) => ({ model })),
    tools: {
      parallelSearch: vi.fn(() => parallelSearch),
    },
  };

  beforeEach(() => {
    vi.mocked(createGatewayProvider).mockReturnValue(gatewayProvider as never);
  });

  afterEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.AI_WEB_SEARCH_MODEL;
    delete process.env.AI_FAST_MODEL;
    delete process.env.AI_MODEL;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses AI Gateway parallel search and maps tool results", async () => {
    process.env.AI_WEB_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
    vi.mocked(generateText).mockResolvedValueOnce({
      toolResults: [
        {
          type: "tool-result",
          toolName: "parallelSearch",
          output: {
            results: [
              {
                title: "Vercel AI Gateway",
                url: "https://vercel.com/docs/ai-gateway",
                excerpt: "Gateway docs",
              },
            ],
          },
        },
      ],
    } as never);

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const result = await tool.execute(
      { query: "vercel ai gateway", max_results: 2 },
      {} as never,
    );

    expect(createGatewayProvider).toHaveBeenCalledWith();
    expect(gatewayProvider.tools.parallelSearch).toHaveBeenCalledWith({
      mode: "agentic",
      maxResults: 2,
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: "xai/grok-4-fast-reasoning" },
        prompt: "vercel ai gateway",
        toolChoice: { type: "tool", toolName: "parallelSearch" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      model: "xai/grok-4-fast-reasoning",
      query: "vercel ai gateway",
      result_count: 1,
      results: [
        {
          title: "Vercel AI Gateway",
          url: "https://vercel.com/docs/ai-gateway",
          snippet: "Gateway docs",
        },
      ],
    });
  });

  it("wraps AI SDK errors in web search error message", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('400 Invalid input: expected "function"'),
    );

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await expect(
      tool.execute({ query: "test query" }, {} as never),
    ).resolves.toEqual({
      ok: false,
      query: "test query",
      result_count: 0,
      results: [],
      error:
        'web search failed: web search failed: 400 Invalid input: expected "function"',
      timeout: false,
      retryable: true,
    });
  });

  it("returns a retryable timeout error instead of throwing", async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally unresolved to trigger tool timeout.
        }) as never,
    );

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const pending = tool.execute({ query: "test query" }, {} as never);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      query: "test query",
      result_count: 0,
      results: [],
      error: "web search failed: webSearch timed out",
      timeout: true,
      retryable: true,
    });
    vi.useRealTimers();
  });

  it("marks authentication failures as non-retryable", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error(
        "AI Gateway authentication failed: No authentication provided.",
      ),
    );

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await expect(tool.execute({ query: "test" }, {} as never)).resolves.toEqual(
      {
        ok: false,
        query: "test",
        result_count: 0,
        results: [],
        error:
          "web search failed: web search failed: AI Gateway authentication failed: No authentication provided.",
        timeout: false,
        retryable: false,
      },
    );
    expect(vi.mocked(logException)).not.toHaveBeenCalled();
  });
});
