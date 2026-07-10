import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { activeSpan, getActiveSpan, getTraceData, parentSpan, startSpan } =
  vi.hoisted(() => ({
    activeSpan: {
      setAttribute: vi.fn(),
    },
    parentSpan: {
      setAttribute: vi.fn(),
    },
    getActiveSpan: vi.fn(),
    getTraceData: vi.fn(),
    startSpan: vi.fn(
      async (
        _options: unknown,
        callback: (span: unknown) => Promise<unknown>,
      ) => callback(activeSpan),
    ),
  }));

vi.mock("@/chat/sentry", () => ({
  getActiveSpan,
  getTraceData,
  startSpan,
}));

describe("withSpan", () => {
  beforeEach(() => {
    getActiveSpan.mockReturnValue(activeSpan);
  });

  afterEach(() => {
    vi.clearAllMocks();
    getTraceData.mockReset();
    vi.resetModules();
  });

  it("provides the started span across async callback work", async () => {
    getActiveSpan.mockReturnValue(parentSpan);
    const { withSpan } = await import("@/chat/logging");

    await withSpan(
      "execute_tool demo",
      "gen_ai.execute_tool",
      {},
      async (span) => {
        await Promise.resolve();
        span.setAttributes({ "gen_ai.tool.call.result": '{"ok":true}' });
      },
    );

    expect(activeSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.tool.call.result",
      '{"ok":true}',
    );
    expect(parentSpan.setAttribute).not.toHaveBeenCalled();
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

  it("normalizes Pi toolUse finish reasons on span attributes", async () => {
    const { setSpanAttributes, withSpan } = await import("@/chat/logging");

    await withSpan("chat openai/gpt-5.4", "gen_ai.chat", {}, async () => {}, {
      "gen_ai.response.finish_reasons": ["toolUse"],
    });
    setSpanAttributes({ finishReason: "toolUse" });

    const spanOptions = startSpan.mock.calls[0]?.[0] as {
      attributes: Record<string, unknown>;
    };
    expect(spanOptions.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "tool_use",
    ]);
    expect(activeSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.response.finish_reasons",
      ["tool_use"],
    );
  });

  it("extracts Sentry trace propagation headers", async () => {
    getTraceData.mockReturnValue({
      "sentry-trace": "trace-span-1",
      baggage: "sentry-release=abc",
      traceparent: "00-trace-span-01",
      other: "ignored",
    });
    const { getTracePropagationHeaders } = await import("@/chat/logging");

    expect(getTracePropagationHeaders()).toEqual({
      "sentry-trace": "trace-span-1",
      baggage: "sentry-release=abc",
      traceparent: "00-trace-span-01",
    });
    expect(getTraceData).toHaveBeenCalledWith({ propagateTraceparent: true });
  });
});
