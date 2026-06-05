import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayProvider, type GatewayProvider } from "@ai-sdk/gateway";
import { generateText } from "ai";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { mockTestClock } from "../../fixtures/vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: vi.fn(),
}));

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type WebSearchTool = ReturnType<typeof createWebSearchTool>;
type WebSearchInput = Parameters<NonNullable<WebSearchTool["execute"]>>[0];

function testGatewayProvider(provider: unknown): GatewayProvider {
  return provider as GatewayProvider;
}

function generateTextResult(toolResults: unknown[]): GenerateTextResult {
  return { toolResults } as GenerateTextResult;
}

function unresolvedGenerateText(): ReturnType<typeof generateText> {
  return new Promise(() => {
    // Intentionally unresolved to trigger tool timeout.
  }) as ReturnType<typeof generateText>;
}

function requireExecute(tool: WebSearchTool) {
  const execute = tool.execute;
  if (!execute) {
    throw new Error("webSearch execute function missing");
  }
  return execute;
}

async function executeWebSearch(input: WebSearchInput) {
  return await requireExecute(createWebSearchTool())(input, {});
}

describe("createWebSearchTool", () => {
  const parallelSearch = { id: "parallel-search-tool" };
  const gatewayProvider = {
    chat: vi.fn((model: string) => ({ model })),
    tools: {
      parallelSearch: vi.fn(() => parallelSearch),
    },
  };

  beforeEach(() => {
    vi.mocked(createGatewayProvider).mockReturnValue(
      testGatewayProvider(gatewayProvider),
    );
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
    vi.mocked(generateText).mockResolvedValueOnce(
      generateTextResult([
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
      ]),
    );

    const result = await executeWebSearch({
      query: "vercel ai gateway",
      max_results: 2,
    });

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
    vi.mocked(generateText).mockResolvedValueOnce(generateTextResult([]));

    await executeWebSearch({ query: "anything" });

    expect(gatewayProvider.chat).toHaveBeenCalledWith("openai/gpt-5.4");
  });

  it("wraps AI SDK errors in web search error message", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('400 Invalid input: expected "function"'),
    );

    await expect(executeWebSearch({ query: "test query" })).resolves.toEqual({
      ok: false,
      query: "test query",
      result_count: 0,
      results: [],
      error: 'web search failed: 400 Invalid input: expected "function"',
      timeout: false,
      retryable: true,
    });
  });

  it("returns a retryable timeout error instead of throwing", async () => {
    mockTestClock();
    vi.mocked(generateText).mockImplementation(() => unresolvedGenerateText());

    const pending = executeWebSearch({ query: "test query" });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      query: "test query",
      result_count: 0,
      results: [],
      error: "web search failed: webSearch timed out",
      timeout: true,
      retryable: true,
    });
  });

  it("aborts the generateText call on timeout", async () => {
    mockTestClock();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(generateText).mockImplementation((options) => {
      capturedSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
      return unresolvedGenerateText();
    });

    const pending = executeWebSearch({ query: "slow query" });
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not abort signal on successful search", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(generateText).mockImplementation((options) => {
      capturedSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
      return Promise.resolve(generateTextResult([]));
    });

    await executeWebSearch({ query: "fast query" });
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("still reports timeout even if abort signal cleanup throws", async () => {
    mockTestClock();
    const brokenController = new AbortController();
    const originalAbort = brokenController.abort.bind(brokenController);
    brokenController.abort = () => {
      originalAbort();
      throw new Error("abort listener blew up");
    };

    const originalController = globalThis.AbortController;
    try {
      globalThis.AbortController = class extends originalController {
        constructor() {
          super();
          return brokenController;
        }
      } as typeof AbortController;
      vi.mocked(generateText).mockImplementation(() =>
        unresolvedGenerateText(),
      );

      const pending = executeWebSearch({ query: "boom query" });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        timeout: true,
        error: "web search failed: webSearch timed out",
      });
    } finally {
      globalThis.AbortController = originalController;
    }
  });

  it("marks authentication failures as non-retryable", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error(
        "AI Gateway authentication failed: No authentication provided.",
      ),
    );

    await expect(executeWebSearch({ query: "test" })).resolves.toEqual({
      ok: false,
      query: "test",
      result_count: 0,
      results: [],
      error:
        "web search failed: AI Gateway authentication failed: No authentication provided.",
      timeout: false,
      retryable: false,
    });
  });
});
