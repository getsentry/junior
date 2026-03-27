import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  withScope: (
    callback: (
      scope: Record<string, (key: string, value: unknown) => void>,
    ) => void,
  ) => {
    callback({
      setExtra: () => undefined,
      setTag: () => undefined,
      setUser: () => undefined,
      setContext: () => undefined,
    });
  },
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  getActiveSpan: vi.fn(() => undefined),
  spanToJSON: vi.fn(() => ({})),
  setTag: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn(
    async (_args, callback: () => Promise<unknown>) => await callback(),
  ),
}));

describe("logging context ids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches conversation, turn, and agent ids to emitted records", async () => {
    const { log, registerLogRecordSink, withLogContext } =
      await import("@/chat/logging");
    const records: Array<{
      eventName: string;
      attributes: Record<string, unknown>;
    }> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push({
        eventName: record.eventName,
        attributes: record.attributes,
      });
    });

    try {
      await withLogContext(
        {
          conversationId: "conversation-1",
          turnId: "turn-1",
          agentId: "turn-1",
        },
        async () => {
          log.info(
            "agent_turn_started",
            { "app.message.kind": "user_inbound" },
            "Agent turn started",
          );
        },
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe("agent_turn_started");
    expect(records[0].attributes).toEqual(
      expect.objectContaining({
        "gen_ai.conversation.id": "conversation-1",
        "app.turn.id": "turn-1",
        "app.agent.id": "turn-1",
        "event.name": "agent_turn_started",
      }),
    );
  });

  it("prioritizes correlation ids early in dev console output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log, withLogContext } = await import("@/chat/logging");
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    try {
      await withLogContext(
        {
          conversationId: "conversation-2",
          turnId: "turn-2",
          agentId: "turn-2",
        },
        async () => {
          log.info(
            "agent_message_in",
            { "app.message.kind": "user_inbound" },
            "Agent message received",
          );
        },
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    const conversationIndex = line.indexOf("gen_ai.conversation.id=");
    const turnIndex = line.indexOf("app.turn.id=");
    const eventNameIndex = line.indexOf("event.name=");
    expect(conversationIndex).toBeGreaterThan(-1);
    expect(turnIndex).toBeGreaterThan(conversationIndex);
    expect(eventNameIndex).toBeGreaterThan(turnIndex);
    expect(line).not.toContain("app.agent.id=");
  });

  it("suppresses noisy ambient context in dev console output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log, withLogContext } = await import("@/chat/logging");
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    try {
      await withLogContext(
        {
          conversationId: "slack:C123:1710000000.001",
          turnId: "turn-3",
          agentId: "turn-3",
          platform: "slack",
          slackThreadId: "slack:C123:1710000000.001",
          slackChannelId: "C123",
          slackUserId: "U123",
          slackUserName: "dcramer",
          assistantUserName: "junior",
          modelId: "anthropic/claude-sonnet-4.6",
          httpMethod: "POST",
          httpPath: "/api/webhooks/slack",
          urlFull: "https://junior.example.com/api/webhooks/slack",
          userAgent: "Slackbot 1.0",
        },
        async () => {
          log.info(
            "agent_message_in",
            {
              "app.message.id": "1710000000.002",
              "app.message.kind": "user_inbound",
              "messaging.message.id": "1710000000.002",
            },
            "Agent message received",
          );
        },
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("gen_ai.conversation.id=slack:C123:1710000000.001");
    expect(line).toContain("app.turn.id=turn-3");
    expect(line).toContain("event.name=agent_message_in");
    expect(line).toContain("messaging.message.id=1710000000.002");
    expect(line).not.toContain("app.agent.id=");
    expect(line).not.toContain("app.platform=");
    expect(line).not.toContain("messaging.system=");
    expect(line).not.toContain("messaging.destination.name=");
    expect(line).not.toContain("messaging.message.conversation_id=");
    expect(line).not.toContain("enduser.id=");
    expect(line).not.toContain("enduser.pseudo_id=");
    expect(line).not.toContain("gen_ai.agent.name=");
    expect(line).not.toContain("http.request.method=");
    expect(line).not.toContain("url.path=");
    expect(line).not.toContain("url.full=");
    expect(line).not.toContain("user_agent.original=");
    expect(line).not.toContain("app.message.id=");
  });

  it("keeps sink records rich while compacting info-level console payload previews", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log, registerLogRecordSink } = await import("@/chat/logging");
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const records: Array<Record<string, unknown>> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push(record.attributes);
    });
    const repeated = "LONGPAYLOAD".repeat(60);

    try {
      log.info(
        "agent_tool_call_completed",
        {
          "gen_ai.tool.name": "loadSkill",
          "gen_ai.tool.call.result": JSON.stringify({
            ok: true,
            description: "Loaded notion skill",
            instructions: repeated,
          }),
        },
        "Agent tool call completed",
      );
    } finally {
      unregister();
      vi.unstubAllEnvs();
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.["gen_ai.tool.call.result"]).toContain(repeated);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("gen_ai.tool.call.result=");
    expect(line).toContain("[");
    expect(line.length).toBeLessThan(500);
  });

  it("keeps full payload details in warn-level console output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log } = await import("@/chat/logging");
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const payload = `prefix-${"LONGPAYLOAD".repeat(20)}-suffix`;

    try {
      log.warn(
        "agent_tool_call_failed",
        {
          "gen_ai.tool.name": "loadSkill",
          "gen_ai.tool.call.result": payload,
        },
        "Agent tool call failed",
      );
    } finally {
      vi.unstubAllEnvs();
    }

    const line = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain(payload);
    expect(line).not.toContain("[246 chars]");
  });

  it("shows counts without dumping catalog arrays in console output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { log } = await import("@/chat/logging");
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    try {
      log.info(
        "capability_catalog_loaded",
        {
          "app.capability.count": 5,
          "app.capability.names": [
            "github.issues.comment",
            "github.issues.read",
            "sentry.api",
          ],
          "app.capability.providers": ["github", "notion", "sentry"],
          "app.config.key_count": 3,
          "app.config.keys": ["github.repo", "sentry.org", "sentry.project"],
        },
        "Loaded capability provider catalog",
      );
    } finally {
      vi.unstubAllEnvs();
    }

    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("app.capability.count=5");
    expect(line).toContain("app.config.key_count=3");
    expect(line).not.toContain("app.capability.names=");
    expect(line).not.toContain("app.capability.providers=");
    expect(line).not.toContain("app.config.keys=");
  });

  it("redacts PEM private key bodies without regex backtracking", async () => {
    const { log, registerLogRecordSink } = await import("@/chat/logging");
    const records: Array<{ body: string }> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push({ body: record.body });
    });

    try {
      log.error(
        "pem_key_logged",
        {},
        [
          "-----BEGIN PRIVATE KEY-----",
          "super-secret-material",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.body).toContain("-----BEGIN PRIVATE KEY-----");
    expect(records[0]?.body).toContain("...redacted...");
    expect(records[0]?.body).toContain("-----END PRIVATE KEY-----");
    expect(records[0]?.body).not.toContain("super-secret-material");
  });

  it("redacts malformed PEM private key tails without dropping later log content", async () => {
    const { log, registerLogRecordSink } = await import("@/chat/logging");
    const records: Array<{ body: string }> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push({ body: record.body });
    });

    try {
      log.error(
        "pem_key_logged",
        {},
        [
          "prefix",
          "-----BEGIN RSA PRIVATE KEY-----",
          "super-secret-material",
          "truncated-without-footer",
          "",
          "suffix after malformed key",
        ].join("\n"),
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.body).toContain("prefix");
    expect(records[0]?.body).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(records[0]?.body).toContain("...redacted...");
    expect(records[0]?.body).toContain("suffix after malformed key");
    expect(records[0]?.body).not.toContain("super-secret-material");
    expect(records[0]?.body).not.toContain("truncated-without-footer");
  });

  it("redacts PEM private keys embedded in escaped JSON strings", async () => {
    const { log, registerLogRecordSink } = await import("@/chat/logging");
    const records: Array<{ body: string }> = [];
    const unregister = registerLogRecordSink((record) => {
      records.push({ body: record.body });
    });

    try {
      log.error(
        "pem_key_logged",
        {},
        JSON.stringify({
          key: "-----BEGIN PRIVATE KEY-----\\nsuper-secret-material\\n-----END PRIVATE KEY-----",
          ok: true,
        }),
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.body).toContain("-----BEGIN PRIVATE KEY-----");
    expect(records[0]?.body).toContain("...redacted...");
    expect(records[0]?.body).toContain("-----END PRIVATE KEY-----");
    expect(records[0]?.body).not.toContain("super-secret-material");
  });
});
