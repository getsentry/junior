import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: vi.fn(),
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
    process.env.AI_WEB_SEARCH_MODEL = "openai/gpt-5.4";
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
        model: { model: "openai/gpt-5.4" },
        prompt: "vercel ai gateway",
        toolChoice: { type: "tool", toolName: "parallelSearch" },
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: "success",
      model: "openai/gpt-5.4",
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

  it("uses the default search model when AI_WEB_SEARCH_MODEL is unset, ignoring AI_MODEL/AI_FAST_MODEL", async () => {
    delete process.env.AI_WEB_SEARCH_MODEL;
    process.env.AI_FAST_MODEL = "openai/gpt-5.4";
    process.env.AI_MODEL = "anthropic/claude-sonnet-4.6";
    vi.mocked(generateText).mockResolvedValueOnce({ toolResults: [] } as never);

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await tool.execute({ query: "anything" }, {} as never);

    expect(gatewayProvider.chat).toHaveBeenCalledWith("openai/gpt-5.4");
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
      status: "error",
      query: "test query",
      result_count: 0,
      results: [],
      error: 'web search failed: 400 Invalid input: expected "function"',
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
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      status: "error",
      query: "test query",
      result_count: 0,
      results: [],
      error: "web search failed: webSearch timed out",
      timeout: true,
      retryable: true,
    });
    vi.useRealTimers();
  });

  it("aborts the generateText call on timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(generateText).mockImplementation(((opts: {
      abortSignal?: AbortSignal;
    }) => {
      capturedSignal = opts.abortSignal;
      return new Promise(() => {
        // Intentionally unresolved to trigger tool timeout.
      });
    }) as never);

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const pending = tool.execute({ query: "slow query" }, {} as never);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("does not abort signal on successful search", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(generateText).mockImplementation(((opts: {
      abortSignal?: AbortSignal;
    }) => {
      capturedSignal = opts.abortSignal;
      return Promise.resolve({ toolResults: [] });
    }) as never);

    const tool = createWebSearchTool();
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await tool.execute({ query: "fast query" }, {} as never);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("still reports timeout even if abort signal cleanup throws", async () => {
    vi.useFakeTimers();
    const brokenController = new AbortController();
    const originalAbort = brokenController.abort.bind(brokenController);
    brokenController.abort = () => {
      originalAbort();
      throw new Error("abort listener blew up");
    };

    // Patch AbortController to return our broken one
    const originalAC = globalThis.AbortController;
    globalThis.AbortController = class extends originalAC {
      constructor() {
        super();
        return brokenController as unknown as AbortController;
      }
    } as typeof AbortController;

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

    const pending = tool.execute({ query: "boom query" }, {} as never);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    globalThis.AbortController = originalAC;

    expect(result).toMatchObject({
      ok: false,
      timeout: true,
      error: "web search failed: webSearch timed out",
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
        status: "error",
        query: "test",
        result_count: 0,
        results: [],
        error:
          "web search failed: AI Gateway authentication failed: No authentication provided.",
        timeout: false,
        retryable: false,
      },
    );
  });
});
