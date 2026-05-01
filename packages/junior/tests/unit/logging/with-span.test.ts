import { afterEach, describe, expect, it, vi } from "vitest";

const { startSpan } = vi.hoisted(() => ({
  startSpan: vi.fn(
    async (_options: unknown, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock("@/chat/sentry", () => ({
  startSpan,
}));

describe("withSpan", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("inherits parent log context attributes on child spans", async () => {
    const { withSpan } = await import("@/chat/logging");

    await withSpan(
      "chat.reply",
      "chat.reply",
      {
        conversationId: "thread_123",
        runId: "run_123",
      },
      async () => {
        await withSpan(
          "chat.route_thinking",
          "chat.route_thinking",
          {
            modelId: "openai/gpt-4o-mini",
          },
          async () => {},
        );
      },
    );

    expect(startSpan).toHaveBeenCalledTimes(2);

    const outerSpanOptions = startSpan.mock.calls[0]?.[0] as {
      attributes: Record<string, unknown>;
    };
    const innerSpanOptions = startSpan.mock.calls[1]?.[0] as {
      attributes: Record<string, unknown>;
    };

    expect(outerSpanOptions.attributes["gen_ai.conversation.id"]).toBe(
      "thread_123",
    );
    expect(innerSpanOptions.attributes["gen_ai.conversation.id"]).toBe(
      "thread_123",
    );
    expect(innerSpanOptions.attributes["app.run.id"]).toBe("run_123");
    expect(innerSpanOptions.attributes["gen_ai.request.model"]).toBe(
      "openai/gpt-4o-mini",
    );
  });
});
