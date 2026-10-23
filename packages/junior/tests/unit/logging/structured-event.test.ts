import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmittedLogRecord } from "@/chat/logging";

/** Sentry logger methods that a test observes. */
interface SentryLoggerStub {
  info?: (body: string, attributes: Record<string, unknown>) => void;
}

async function loadLoggingModule(sentryLogger: SentryLoggerStub = {}) {
  vi.resetModules();
  vi.doMock("@/chat/sentry", () => ({
    captureException: () => undefined,
    captureMessage: () => undefined,
    getActiveSpan: () => ({ sampled: true }),
    logger: sentryLogger,
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("sends audit events to Sentry in production but not other info events", async () => {
    vi.stubEnv("SENTRY_ENVIRONMENT", "production");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.fn();
    const { logAudit, logInfo } = await loadLoggingModule({ info });

    logInfo("sandbox.egress.upstream.requested", {
      "app.grant.access": "read",
    });
    logAudit("sandbox.egress.upstream.requested", {
      "app.grant.access": "write",
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "sandbox.egress.upstream.requested",
      expect.objectContaining({
        "app.grant.access": "write",
        "app.log.audit": true,
      }),
    );
  });

  it("rejects non-namespaced application event names", async () => {
    const { logWarn } = await loadLoggingModule();

    expect(() => logWarn("agent_turn_failed")).toThrow(
      "use lowercase dot-delimited namespaces",
    );
  });
});
