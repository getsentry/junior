import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { resolveGatewayModel } from "@/chat/pi/client";

const { spans } = vi.hoisted(() => ({
  spans: [] as Array<{ name: string; attributes: Record<string, unknown> }>,
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  withSpan: vi.fn(
    async (
      name: string,
      _op: string,
      _context: unknown,
      callback: (
        setSpanAttributes: (attributes: Record<string, unknown>) => void,
      ) => Promise<unknown>,
      attributes: Record<string, unknown> = {},
    ) => {
      const span = { name, attributes: { ...attributes } };
      spans.push(span);
      return await callback((next) => Object.assign(span.attributes, next));
    },
  ),
}));

const { createToolWaitWarmer } = await import("@/chat/cache-warming/tool-wait");

const model = resolveGatewayModel("anthropic/claude-opus-5.5");

describe("cache warming telemetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    spans.length = 0;
  });

  it("records a skipped warmup and its reason on the warmup span", async () => {
    vi.useFakeTimers();
    const warmer = createToolWaitWarmer("local:test:cache-warming-telemetry");
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
      ],
      api: "anthropic-messages",
      provider: "vercel-ai-gateway",
      model: model.id,
      usage: {
        input: 10,
        output: 10,
        cacheRead: 60_000,
        cacheWrite: 0,
        totalTokens: 60_020,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    await warmer.record(
      {
        model,
        context: { systemPrompt: "Look it up.", messages: [] },
        cacheRetention: "short",
        startedAtMs: Date.now(),
      },
      message,
    );

    // No tool waits are recorded, so the first warmup skips.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    warmer.stop();

    expect(spans).toEqual([
      {
        name: "cache_warming.warmup",
        attributes: expect.objectContaining({
          "app.cache_warming.cycle": 1,
          "app.cache_warming.outcome": "skipped",
          "app.cache_warming.prefix_tokens": 60_000,
          "app.cache_warming.skip_reason": "few_gaps",
          "app.cache_warming.trigger": "tool_wait",
        }),
      },
    ]);
  });
});
