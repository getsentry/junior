import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  },
  withScope: (callback: (scope: Record<string, (key: string, value: unknown) => void>) => void) => {
    callback({
      setExtra: () => undefined,
      setTag: () => undefined,
      setUser: () => undefined,
      setContext: () => undefined
    });
  },
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  getActiveSpan: vi.fn(() => undefined),
  spanToJSON: vi.fn(() => ({})),
  setTag: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn(async (_args, callback: () => Promise<unknown>) => await callback())
}));

describe("logging context ids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches conversation, turn, and agent ids to emitted records", async () => {
    const { log, registerLogRecordSink, withLogContext } = await import("@/chat/logging");
    const records: Array<{ eventName: string; attributes: Record<string, unknown> }> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push({
        eventName: record.eventName,
        attributes: record.attributes
      });
    });

    try {
      await withLogContext(
        {
          conversationId: "conversation-1",
          turnId: "turn-1",
          agentId: "turn-1"
        },
        async () => {
          log.info("agent_turn_started", { "app.message.kind": "user_inbound" }, "Agent turn started");
        }
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe("agent_turn_started");
    expect(records[0].attributes).toEqual(
      expect.objectContaining({
        "app.conversation.id": "conversation-1",
        "app.turn.id": "turn-1",
        "app.agent.id": "turn-1",
        "event.name": "agent_turn_started"
      })
    );
  });

  it("prioritizes correlation ids early in dev console output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log, withLogContext } = await import("@/chat/logging");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await withLogContext(
        {
          conversationId: "conversation-2",
          turnId: "turn-2",
          agentId: "turn-2"
        },
        async () => {
          log.info("agent_message_in", { "app.message.kind": "user_inbound" }, "Agent message received");
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    const conversationIndex = line.indexOf("app.conversation.id=");
    const turnIndex = line.indexOf("app.turn.id=");
    const agentIndex = line.indexOf("app.agent.id=");
    const eventNameIndex = line.indexOf("event.name=");
    expect(conversationIndex).toBeGreaterThan(-1);
    expect(turnIndex).toBeGreaterThan(conversationIndex);
    expect(agentIndex).toBeGreaterThan(turnIndex);
    expect(eventNameIndex).toBeGreaterThan(agentIndex);
  });
});
