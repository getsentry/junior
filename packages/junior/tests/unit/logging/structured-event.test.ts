import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmittedLogRecord } from "@/chat/logging";

async function loadLoggingModule() {
  vi.resetModules();
  vi.doMock("@/chat/sentry", () => ({
    captureException: () => undefined,
    captureMessage: () => undefined,
    getActiveSpan: () => ({ sampled: true }),
    logger: { info: vi.fn() },
    setTag: () => undefined,
    setUser: () => undefined,
    spanToJSON: () => ({
      span_id: "span-123",
      trace_id: "trace-123",
    }),
    withScope: (callback: (scope: { setExtra: () => void }) => void) =>
      callback({ setExtra() {} }),
  }));
  return await import("@/chat/logging");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("@/chat/sentry");
});

describe("structured log events", () => {
  it("inherits bound context and active trace correlation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { logWarn, registerLogRecordSink, withLogContext } =
      await loadLoggingModule();
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => records.push(record));

    try {
      await withLogContext(
        {
          conversationId: "conversation-123",
          runId: "run-123",
        },
        async () => {
          logWarn("agent.turn.empty_output.exhausted", {
            "app.ai.empty_output.attempt": 1,
          });
        },
      );
    } finally {
      unregister();
    }

    expect(records).toEqual([
      expect.objectContaining({
        body: "agent.turn.empty_output.exhausted",
        eventName: "agent.turn.empty_output.exhausted",
        level: "warn",
        attributes: expect.objectContaining({
          "app.ai.empty_output.attempt": 1,
          "app.run.id": "run-123",
          "event.name": "agent.turn.empty_output.exhausted",
          "gen_ai.conversation.id": "conversation-123",
          span_id: "span-123",
          trace_id: "trace-123",
        }),
      }),
    ]);
  });

  it("retains only Work Object delivery info events in production Sentry logs", async () => {
    vi.stubEnv("SENTRY_ENVIRONMENT", "production");
    const { logInfo } = await loadLoggingModule();
    const { logger } = await import("@/chat/sentry");
    logInfo("agent.turn.started");
    logInfo("slack.work_object.post.started", {
      "app.slack.work_object.count": 1,
    });
    logInfo("slack.work_object.post.accepted", {
      "messaging.message.id": "1700000000.000001",
    });
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "slack.work_object.post.started",
      expect.objectContaining({ "app.slack.work_object.count": 1 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "slack.work_object.post.accepted",
      expect.objectContaining({ "messaging.message.id": "1700000000.000001" }),
    );
  });

  it("rejects non-namespaced application event names", async () => {
    const { logWarn } = await loadLoggingModule();

    expect(() => logWarn("agent_turn_failed")).toThrow(
      "use lowercase dot-delimited namespaces",
    );
  });
});
