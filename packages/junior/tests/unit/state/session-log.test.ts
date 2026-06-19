import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  commitMessages,
  loadConnectedMcpProviders,
  loadMessages,
  loadProjection,
  loadProjectionWithRequester,
  recordAuthorizationCompleted,
  recordAuthorizationRequested,
  recordMcpProviderConnected,
  type SessionLogEntry,
  type SessionLogStore,
} from "@/chat/state/session-log";

function memoryStore(): SessionLogStore & {
  entries: SessionLogEntry[];
} {
  const entries: SessionLogEntry[] = [];

  return {
    entries,
    async append(args) {
      entries.push(...args.entries);
    },
    async read() {
      return [...entries];
    },
  };
}

describe("agent session log store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends Pi messages for a growing session projection", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;
    const second: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: 2,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first],
      ttlMs: 60_000,
    });
    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first, second],
      ttlMs: 60_000,
    });

    expect(store.entries).toEqual([
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: first,
      },
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: second,
      },
    ]);
    await expect(
      loadMessages({
        store,
        conversationId: "conversation-1",
        messageCount: 2,
      }),
    ).resolves.toEqual([first, second]);
  });

  it("records projection resets instead of rewriting unsafe history", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;
    const unsafe: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "unsafe" }],
      timestamp: 2,
    } as PiMessage;
    const replacement: PiMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "safe" }],
      timestamp: 3,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first, unsafe],
      ttlMs: 60_000,
    });
    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first, replacement],
      ttlMs: 60_000,
    });

    expect(store.entries).toEqual([
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: first,
      },
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: unsafe,
      },
      {
        schemaVersion: 1,
        type: "projection_reset",
        sessionId: "session_1",
        messages: [first, replacement],
      },
    ]);
    await expect(
      loadMessages({
        store,
        conversationId: "conversation-1",
        messageCount: 2,
      }),
    ).resolves.toEqual([first, replacement]);
    await expect(
      loadMessages({
        store,
        conversationId: "conversation-1",
        messageCount: 3,
      }),
    ).resolves.toBeUndefined();
  });

  it("filters prior session events after a reset", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;
    const replacement: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "replacement" }],
      timestamp: 2,
    } as PiMessage;
    const lateOldMessage: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "late old session" }],
      timestamp: 3,
    } as PiMessage;
    const next: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "next" }],
      timestamp: 4,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first],
      ttlMs: 60_000,
    });
    await recordMcpProviderConnected({
      store,
      conversationId: "conversation-1",
      provider: "old-provider",
      ttlMs: 60_000,
    });
    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [replacement],
      ttlMs: 60_000,
    });

    store.entries.push(
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: lateOldMessage,
      },
      {
        schemaVersion: 1,
        type: "mcp_provider_connected",
        sessionId: "session_0",
        provider: "old-provider-late",
      },
    );
    await recordMcpProviderConnected({
      store,
      conversationId: "conversation-1",
      provider: "new-provider",
      ttlMs: 60_000,
    });
    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [replacement, next],
      ttlMs: 60_000,
    });

    await expect(
      loadProjection({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual([replacement, next]);
    await expect(
      loadProjection({
        store,
        conversationId: "conversation-1",
        sessionId: "session_0",
      }),
    ).resolves.toEqual([first]);
    await expect(
      loadConnectedMcpProviders({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual(["new-provider"]);
  });

  it("keeps legacy entries without session ids readable", async () => {
    const store = memoryStore();
    const ignored: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ignored" }],
      timestamp: 1,
    } as PiMessage;
    const replacement: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "replacement" }],
      timestamp: 2,
    } as PiMessage;
    const next: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "next" }],
      timestamp: 3,
    } as PiMessage;

    // Simulate stored rows written before sessionId existed.
    const legacyEntries = [
      { schemaVersion: 1, type: "pi_message", message: ignored },
      {
        schemaVersion: 1,
        type: "projection_reset",
        messages: [replacement],
      },
      { schemaVersion: 1, type: "pi_message", message: next },
    ] as unknown as SessionLogEntry[];
    store.entries.push(...legacyEntries);

    await expect(
      loadProjection({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual([replacement, next]);
  });

  it("records connected MCP providers outside the Pi projection", async () => {
    const store = memoryStore();
    const message: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [message],
      ttlMs: 60_000,
    });
    await recordMcpProviderConnected({
      store,
      conversationId: "conversation-1",
      provider: "linear",
      ttlMs: 60_000,
    });
    await recordMcpProviderConnected({
      store,
      conversationId: "conversation-1",
      provider: "linear",
      ttlMs: 60_000,
    });

    expect(store.entries).toEqual([
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
      {
        schemaVersion: 1,
        type: "mcp_provider_connected",
        sessionId: "session_0",
        provider: "linear",
      },
    ]);
    await expect(
      loadConnectedMcpProviders({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual(["linear"]);
    await expect(
      loadMessages({
        store,
        conversationId: "conversation-1",
        messageCount: 1,
      }),
    ).resolves.toEqual([message]);
  });

  it("records authorization interrupts and projects completion to Pi", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = memoryStore();
    const message: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "list my orgs" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [message],
      ttlMs: 60_000,
    });
    await recordAuthorizationRequested({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      authorizationId: "auth-1",
      delivery: "private_link_sent",
      ttlMs: 60_000,
    });
    await recordAuthorizationRequested({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      authorizationId: "auth-1",
      delivery: "private_link_sent",
      ttlMs: 60_000,
    });
    await recordAuthorizationCompleted({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      authorizationId: "auth-1",
      ttlMs: 60_000,
    });
    await recordAuthorizationCompleted({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      authorizationId: "auth-1",
      ttlMs: 60_000,
    });

    expect(store.entries).toEqual([
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
      {
        schemaVersion: 1,
        type: "authorization_requested",
        sessionId: "session_0",
        createdAtMs: 1_000,
        kind: "plugin",
        provider: "sentry",
        requesterId: "U123",
        authorizationId: "auth-1",
        delivery: "private_link_sent",
      },
      {
        schemaVersion: 1,
        type: "authorization_completed",
        sessionId: "session_0",
        createdAtMs: 1_000,
        kind: "plugin",
        provider: "sentry",
        requesterId: "U123",
        authorizationId: "auth-1",
      },
    ]);

    await expect(
      loadProjection({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual([
      message,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Authorization completed for provider "sentry". Continue the blocked request and retry the provider operation if needed.',
          },
        ],
        timestamp: 1_000,
      },
    ]);

    const firstProjection = await loadProjection({
      store,
      conversationId: "conversation-1",
    });
    vi.setSystemTime(9_000);
    await expect(
      loadProjection({
        store,
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual(firstProjection);
  });
});

describe("session log requester identity", () => {
  it("attaches requester to the last new user message on commit", async () => {
    const store = memoryStore();
    const contextMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "prior context" }],
      timestamp: 1,
    } as PiMessage;
    const turnMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "current question" }],
      timestamp: 2,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-req-1",
      messages: [contextMsg, turnMsg],
      ttlMs: 60_000,
      requester: {
        slackUserId: "U123",
        slackUserName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
    });

    // Requester is attached to the LAST new user message (turnMsg), not contextMsg
    const entries = store.entries;
    const piEntries = entries.filter((e) => e.type === "pi_message");
    expect(piEntries).toHaveLength(2);
    expect((piEntries[0] as { requester?: unknown }).requester).toBeUndefined();
    expect((piEntries[1] as { requester?: unknown }).requester).toMatchObject({
      slackUserId: "U123",
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    // Requester is NOT on the Pi message object (not model-visible)
    const msgPayload = piEntries[1] as { message?: { requester?: unknown } };
    expect(msgPayload.message?.requester).toBeUndefined();
  });

  it("derives requester from session log via loadProjectionWithRequester", async () => {
    const store = memoryStore();
    const turnMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "question" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-req-2",
      messages: [turnMsg],
      ttlMs: 60_000,
      requester: { slackUserId: "U456", email: "bob@sentry.io" },
    });

    const { loadProjectionWithRequester } =
      await import("@/chat/state/session-log");
    const projection = await loadProjectionWithRequester({
      store,
      conversationId: "conv-req-2",
    });

    expect(projection.requester).toMatchObject({
      slackUserId: "U456",
      email: "bob@sentry.io",
    });
    expect(projection.messages).toHaveLength(1);
  });

  it("records requester metadata without resetting session-scoped facts", async () => {
    const store = memoryStore();
    const turnMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "question" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-req-3",
      messages: [turnMsg],
      ttlMs: 60_000,
    });
    await recordMcpProviderConnected({
      store,
      conversationId: "conv-req-3",
      provider: "github",
      ttlMs: 60_000,
    });
    await commitMessages({
      store,
      conversationId: "conv-req-3",
      messages: [turnMsg],
      ttlMs: 60_000,
      requester: { slackUserId: "U999", email: "drew@sentry.io" },
    });

    expect(store.entries.map((entry) => entry.type)).toEqual([
      "pi_message",
      "mcp_provider_connected",
      "requester_recorded",
    ]);
    await expect(
      loadProjectionWithRequester({
        store,
        conversationId: "conv-req-3",
      }),
    ).resolves.toMatchObject({
      messages: [turnMsg],
      requester: {
        slackUserId: "U999",
        email: "drew@sentry.io",
      },
    });
    await expect(
      loadConnectedMcpProviders({
        store,
        conversationId: "conv-req-3",
      }),
    ).resolves.toEqual(["github"]);
  });

  it("preserves requester through a projection reset without a new requester", async () => {
    const store = memoryStore();
    const msg1: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;
    const msg2: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "replaced" }],
      timestamp: 2,
    } as PiMessage;

    // First commit with requester
    await commitMessages({
      store,
      conversationId: "conv-req-4",
      messages: [msg1],
      ttlMs: 60_000,
      requester: { slackUserId: "U789", email: "carol@sentry.io" },
    });

    // Trigger a reset by replacing history
    await commitMessages({
      store,
      conversationId: "conv-req-4",
      messages: [msg2],
      ttlMs: 60_000,
    });

    const { loadProjectionWithRequester } =
      await import("@/chat/state/session-log");
    const projection = await loadProjectionWithRequester({
      store,
      conversationId: "conv-req-4",
    });

    expect(projection.requester?.slackUserId).toBe("U789");
    expect(projection.messages).toHaveLength(1);
  });
});
