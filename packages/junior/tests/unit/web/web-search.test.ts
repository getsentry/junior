import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { resolveGatewayCredential } from "@/chat/pi/gateway-auth";
import { castThroughUnknown } from "@sentry/junior-plugin-api";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: vi.fn(),
}));

vi.mock("@/chat/pi/gateway-auth", () => ({
  resolveGatewayCredential: vi.fn(),
}));

describe("createWebSearchTool", () => {
  const defaultModelId = "openai/gpt-5.4";
  const parallelSearch = { id: "parallel-search-tool" };
  const gatewayProvider = {
    chat: vi.fn((model: string) => ({ model })),
    tools: {
      parallelSearch: vi.fn(() => parallelSearch),
    },
  };

  beforeEach(() => {
    vi.mocked(createGatewayProvider).mockReturnValue(gatewayProvider as never);
    vi.mocked(resolveGatewayCredential).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses AI Gateway parallel search and maps tool results", async () => {
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

    const tool = createWebSearchTool("anthropic/claude-sonnet-4.6");
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const result = await tool.execute(
      { query: "vercel ai gateway", max_results: 2 },
      {} as never,
    );

    expect(createGatewayProvider).toHaveBeenCalledWith({});
    expect(gatewayProvider.tools.parallelSearch).toHaveBeenCalledWith({
      mode: "agentic",
      maxResults: 2,
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: "anthropic/claude-sonnet-4.6" },
        prompt: "vercel ai gateway",
        toolChoice: { type: "tool", toolName: "parallelSearch" },
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4.6",
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

  it("passes the shared OIDC credential into the gateway provider", async () => {
    vi.mocked(resolveGatewayCredential).mockResolvedValue({
      mode: "oidc",
      token: "oidc-token",
    });
    vi.mocked(generateText).mockResolvedValueOnce({
      toolResults: [],
    } as never);

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await tool.execute({ query: "oidc query" }, {} as never);

    expect(createGatewayProvider).toHaveBeenCalledWith({
      apiKey: "oidc-token",
    });
  });

  it("propagates AI SDK errors", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('400 Invalid input: expected "function"'),
    );

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await expect(
      tool.execute({ query: "test query" }, {} as never),
    ).rejects.toThrow('400 Invalid input: expected "function"');
  });

  it("throws when search times out", async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally unresolved to trigger tool timeout.
        }) as never,
    );

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const pending = Promise.resolve(
      tool.execute({ query: "test query" }, {} as never),
    );
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(settled).resolves.toMatchObject({
      message: "webSearch timed out",
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

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const pending = Promise.resolve(
      tool.execute({ query: "slow query" }, {} as never),
    );
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    // Credential resolution is async before generateText starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(settled).resolves.toMatchObject({
      message: "webSearch timed out",
    });
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

    const tool = createWebSearchTool(defaultModelId);
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
        return castThroughUnknown<AbortController>(brokenController);
      }
    } as typeof AbortController;

    vi.mocked(generateText).mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally unresolved to trigger tool timeout.
        }) as never,
    );

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    const pending = Promise.resolve(
      tool.execute({ query: "boom query" }, {} as never),
    );
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(settled).resolves.toMatchObject({
      message: "webSearch timed out",
    });

    globalThis.AbortController = originalAC;

    vi.useRealTimers();
  });

  it("propagates authentication failures", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error(
        "AI Gateway authentication failed: No authentication provided.",
      ),
    );

    const tool = createWebSearchTool(defaultModelId);
    if (typeof tool.execute !== "function") {
      throw new Error("webSearch execute function missing");
    }

    await expect(tool.execute({ query: "test" }, {} as never)).rejects.toThrow(
      "AI Gateway authentication failed: No authentication provided.",
    );
  });
});
