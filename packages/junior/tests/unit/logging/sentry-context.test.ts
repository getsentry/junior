import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => {
  const scope = {
    setContext: vi.fn(),
    setExtra: vi.fn(),
    setTag: vi.fn(),
    setUser: vi.fn(),
  };
  return {
    captureException: vi.fn(() => "event-id"),
    scope,
    setTag: vi.fn(),
    setUser: vi.fn(),
    withScope: vi.fn((callback: (scope: unknown) => void) => callback(scope)),
  };
});

vi.mock("@/chat/sentry", () => ({
  captureException: sentry.captureException,
  getActiveSpan: () => undefined,
  setTag: sentry.setTag,
  setUser: sentry.setUser,
  spanToJSON: () => ({}),
  withScope: sentry.withScope,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Sentry context", () => {
  it("uses native user identity and a small tag allowlist", async () => {
    const { setTags } = await import("@/chat/logging");

    setTags({
      conversationId: "thread_123",
      platform: "slack",
      slackThreadId: "thread_123",
      slackUserId: "U123",
      slackUserName: "alice",
      slackUserEmail: "Alice@Example.COM",
      slackChannelId: "C123",
      runId: "run_123",
      assistantUserName: "junior",
      modelId: "openai/gpt-5.4",
      httpMethod: "POST",
    });

    expect(sentry.setUser).toHaveBeenCalledWith({
      id: "U123",
      ip_address: null,
      username: "alice",
      email: "alice@example.com",
    });
    expect(sentry.setTag).toHaveBeenCalledWith("messaging.system", "slack");
    expect(sentry.setTag).toHaveBeenCalledWith("gen_ai.agent.name", "junior");
    expect(sentry.setTag).toHaveBeenCalledWith(
      "gen_ai.request.model",
      "openai/gpt-5.4",
    );
    expect(sentry.setTag).toHaveBeenCalledWith("http.request.method", "POST");
    expect(sentry.setTag).not.toHaveBeenCalledWith(
      "gen_ai.conversation.id",
      "thread_123",
    );
    expect(sentry.setTag).not.toHaveBeenCalledWith(
      "messaging.message.conversation_id",
      "thread_123",
    );
    expect(sentry.setTag).not.toHaveBeenCalledWith(
      "messaging.destination.name",
      "C123",
    );
    expect(sentry.setTag).not.toHaveBeenCalledWith("enduser.id", "U123");
    expect(sentry.setTag).not.toHaveBeenCalledWith(
      "enduser.pseudo.id",
      "alice",
    );
    expect(sentry.setTag).not.toHaveBeenCalledWith("app.run.id", "run_123");
  });

  it("keeps user attributes in scoped context without tagging them", async () => {
    const logging = await import("@/chat/logging");
    const scope = {
      setContext: vi.fn(),
      setTag: vi.fn(),
      setUser: vi.fn(),
    };

    logging.setSentryScopeContext(
      scope as unknown as Parameters<typeof logging.setSentryScopeContext>[0],
      {
        conversationId: "thread_123",
        slackUserId: "U123",
        slackUserName: "alice",
        slackUserEmail: "Alice@Example.COM",
        modelId: "openai/gpt-5.4",
      },
    );

    expect(scope.setUser).toHaveBeenCalledWith({
      id: "U123",
      ip_address: null,
      username: "alice",
      email: "alice@example.com",
    });
    expect(scope.setTag).toHaveBeenCalledWith(
      "gen_ai.request.model",
      "openai/gpt-5.4",
    );
    expect(scope.setTag).not.toHaveBeenCalledWith(
      "gen_ai.conversation.id",
      "thread_123",
    );
    expect(scope.setTag).not.toHaveBeenCalledWith("enduser.id", "U123");
    expect(scope.setTag).not.toHaveBeenCalledWith("enduser.pseudo.id", "alice");
    expect(scope.setContext).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        "enduser.id": "U123",
        "enduser.pseudo.id": "alice",
      }),
    );
  });

  it("applies native user identity when capturing exceptions with context", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { logException } = await import("@/chat/logging");

    const eventId = logException(
      new Error("boom"),
      "turn_failed",
      {
        slackUserId: "U123",
        slackUserName: "alice",
        slackUserEmail: "Alice@Example.COM",
        modelId: "openai/gpt-5.4",
      },
      {},
      "Turn failed",
    );

    expect(eventId).toBe("event-id");
    expect(sentry.scope.setUser).toHaveBeenCalledWith({
      id: "U123",
      ip_address: null,
      username: "alice",
      email: "alice@example.com",
    });
    expect(sentry.scope.setTag).toHaveBeenCalledWith(
      "gen_ai.request.model",
      "openai/gpt-5.4",
    );
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});
