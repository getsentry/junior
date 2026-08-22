import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "@/chat/sentry";
const sentry = vi.hoisted(() => {
  const scope = {
    setContext: vi.fn(),
    setExtra: vi.fn(),
    setTag: vi.fn(),
    setUser: vi.fn(),
  };
  return {
    captureException: vi.fn(() => "event-id"),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    },
    scope,
    setTag: vi.fn(),
    setUser: vi.fn(),
    withScope: vi.fn((callback: (scope: unknown) => void) => callback(scope)),
  };
});

vi.mock("@/chat/sentry", () => ({
  captureException: sentry.captureException,
  getActiveSpan: () => undefined,
  logger: sentry.logger,
  setTag: sentry.setTag,
  setUser: sentry.setUser,
  spanToJSON: () => ({}),
  withScope: sentry.withScope,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

function asSentryScope(value: unknown): Scope {
  return value as Scope;
}

describe("Sentry context", () => {
  it("extends only the active sanitized log context", async () => {
    const { getLogContextAttributes, setTags, withLogContext } =
      await import("@/chat/logging");

    setTags({ runId: "outside" });
    expect(getLogContextAttributes()).toEqual({});

    await withLogContext({ conversationId: "conversation" }, async () => {
      setTags({
        destinationName: "Bearer abcdefghijklmnopqrstuvwxyz",
        runId: "run",
      });

      expect(getLogContextAttributes()).toEqual({
        "app.run.id": "run",
        "gen_ai.conversation.id": "conversation",
        "messaging.destination.name": "Bearer abcd...wxyz",
      });
    });

    expect(getLogContextAttributes()).toEqual({});
  });

  it("uses native user identity and a small tag allowlist", async () => {
    const { setTags } = await import("@/chat/logging");

    setTags({
      conversationId: "thread_123",
      platform: "slack",
      messageConversationId: "thread_123",
      userId: "U123",
      userName: "alice",
      userEmail: "Alice@Example.COM",
      destinationName: "C123",
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
      asSentryScope(scope),
      {
        conversationId: "thread_123",
        userId: "U123",
        userName: "alice",
        userEmail: "Alice@Example.COM",
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

  it("applies bound and local context when capturing exceptions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { logException, setTags, withLogContext } =
      await import("@/chat/logging");

    const eventId = await withLogContext(
      {
        conversationId: "thread_123",
        platform: "slack",
        userId: "U123",
        userName: "alice",
        userEmail: "Alice@Example.COM",
      },
      async () => {
        setTags({
          assistantUserName: "junior",
          modelId: "openai/gpt-5.4",
        });
        return logException(new Error("boom"), "turn.failed");
      },
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
    expect(sentry.scope.setTag).toHaveBeenCalledWith(
      "gen_ai.agent.name",
      "junior",
    );
    expect(sentry.scope.setContext).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        "gen_ai.conversation.id": "thread_123",
        "gen_ai.request.model": "openai/gpt-5.4",
        "messaging.system": "slack",
      }),
    );
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("lets explicit exception attributes override inherited tags", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { logException, setTags, withLogContext } =
      await import("@/chat/logging");

    await withLogContext({}, async () => {
      setTags({ modelId: "xai/grok-4.5" });
      logException(new Error("boom"), "turn.failed", {
        "gen_ai.request.model": "openai/gpt-5.6-luna",
      });
    });

    const modelTagCalls = sentry.scope.setTag.mock.calls.filter(
      ([key]) => key === "gen_ai.request.model",
    );
    expect(modelTagCalls.at(-1)).toEqual([
      "gen_ai.request.model",
      "openai/gpt-5.6-luna",
    ]);
  });
});
