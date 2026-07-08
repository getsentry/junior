import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  commitMessages,
  instructionActors,
  loadActivityEntries,
  loadConnectedMcpProviders,
  loadMessages,
  loadProjection,
  loadProjectionWithActor,
  loadProjectionWithProvenance,
  recordAuthorizationCompleted,
  recordAuthorizationRequested,
  recordMcpProviderConnected,
  recordSubagentEnded,
  recordSubagentStarted,
  recordToolExecutionStarted,
  type PiMessageProvenance,
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
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: first,
      },
      {
        schemaVersion: 2,
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

  it("keeps host activity entries out of Pi projections", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conversation-1",
      messages: [first],
      ttlMs: 60_000,
    });
    await recordToolExecutionStarted({
      store,
      conversationId: "conversation-1",
      createdAtMs: 2,
      toolCallId: "call-1",
      toolName: "advisor",
      args: { question: "private" },
      ttlMs: 60_000,
    });
    await recordSubagentStarted({
      store,
      conversationId: "conversation-1",
      createdAtMs: 3,
      historyMode: "shared",
      parentConversationId: "conversation-1",
      parentToolCallId: "call-1",
      subagentInvocationId: "call-1",
      subagentKind: "advisor",
      transcriptRef: {
        type: "advisor_session",
        parentConversationId: "conversation-1",
        key: "junior:conversation-1:advisor_session",
      },
      ttlMs: 60_000,
    });
    await recordSubagentEnded({
      store,
      conversationId: "conversation-1",
      createdAtMs: 4,
      outcome: "success",
      subagentInvocationId: "call-1",
      ttlMs: 60_000,
    });

    await expect(
      loadProjection({ store, conversationId: "conversation-1" }),
    ).resolves.toEqual([first]);
    await expect(
      loadActivityEntries({ store, conversationId: "conversation-1" }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "tool_execution_started",
        toolCallId: "call-1",
      }),
      expect.objectContaining({
        type: "subagent_started",
        parentToolCallId: "call-1",
      }),
      expect.objectContaining({
        type: "subagent_ended",
        subagentInvocationId: "call-1",
      }),
    ]);
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
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: first,
      },
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: unsafe,
      },
      {
        schemaVersion: 2,
        type: "projection_reset",
        sessionId: "session_1",
        messages: [first, replacement],
        provenance: [{ authority: "context" }, { authority: "context" }],
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

  it("migrates legacy requester log metadata while reading", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;

    store.entries.push(
      {
        schemaVersion: 1,
        type: "pi_message",
        message: first,
        requester: { slackUserId: "U123", email: "alice@sentry.io" },
      } as unknown as SessionLogEntry,
      {
        schemaVersion: 1,
        type: "requester_recorded",
        requester: { slackUserId: "U456", email: "bob@sentry.io" },
      } as unknown as SessionLogEntry,
      {
        schemaVersion: 1,
        type: "authorization_completed",
        createdAtMs: 2,
        kind: "plugin",
        provider: "github",
        requesterId: "U456",
        authorizationId: "auth-1",
      } as unknown as SessionLogEntry,
    );

    const projection = await loadProjectionWithActor({
      store,
      conversationId: "conversation-1",
    });
    expect(projection.messages).toEqual([
      first,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Authorization completed for provider "github". Continue the blocked request and retry the provider operation if needed.',
          },
        ],
        timestamp: 2,
      },
    ]);
    // Legacy latest-wins actor metadata cannot be aligned to a specific
    // message, so attribution fails closed instead of adopting the recorded
    // actor for the whole projection.
    expect(projection.actor).toBeUndefined();
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
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
      {
        schemaVersion: 2,
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
      actorId: "U123",
      authorizationId: "auth-1",
      delivery: "private_link_sent",
      ttlMs: 60_000,
    });
    await recordAuthorizationRequested({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      actorId: "U123",
      authorizationId: "auth-1",
      delivery: "private_link_sent",
      ttlMs: 60_000,
    });
    await recordAuthorizationCompleted({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      actorId: "U123",
      authorizationId: "auth-1",
      ttlMs: 60_000,
    });
    await recordAuthorizationCompleted({
      store,
      conversationId: "conversation-1",
      kind: "plugin",
      provider: "sentry",
      actorId: "U123",
      authorizationId: "auth-1",
      ttlMs: 60_000,
    });

    expect(store.entries).toEqual([
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
      {
        schemaVersion: 2,
        type: "authorization_requested",
        sessionId: "session_0",
        createdAtMs: 1_000,
        kind: "plugin",
        provider: "sentry",
        actorId: "U123",
        authorizationId: "auth-1",
        delivery: "private_link_sent",
      },
      {
        schemaVersion: 2,
        type: "authorization_completed",
        sessionId: "session_0",
        createdAtMs: 1_000,
        kind: "plugin",
        provider: "sentry",
        actorId: "U123",
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

describe("session log message provenance", () => {
  const alice = {
    platform: "slack" as const,
    teamId: "T123",
    userId: "U123",
    userName: "alice",
    fullName: "Alice Example",
    email: "alice@sentry.io",
  };
  const bob = {
    platform: "slack" as const,
    teamId: "T123",
    userId: "U456",
    userName: "bob",
  };

  it("attaches instruction provenance to the last new user message on commit", async () => {
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
      conversationId: "conv-prov-1",
      messages: [contextMsg, turnMsg],
      ttlMs: 60_000,
      newMessageProvenance: { authority: "instruction", actor: alice },
    });

    // Instruction provenance lands on the LAST new user message (turnMsg);
    // the earlier context message stays unauthored context (field omitted).
    const piEntries = store.entries.filter((e) => e.type === "pi_message");
    expect(piEntries).toHaveLength(2);
    expect(
      (piEntries[0] as { provenance?: unknown }).provenance,
    ).toBeUndefined();
    expect((piEntries[1] as { provenance?: unknown }).provenance).toEqual({
      authority: "instruction",
      actor: alice,
    });

    // Provenance is not on the model-visible Pi message object.
    const msgPayload = piEntries[1] as {
      message?: { provenance?: unknown };
    };
    expect(msgPayload.message?.provenance).toBeUndefined();
  });

  it("returns aligned per-message provenance from loadMessagesWithProvenance", async () => {
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
      conversationId: "conv-prov-2",
      messages: [contextMsg, turnMsg],
      ttlMs: 60_000,
      newMessageProvenance: { authority: "instruction", actor: alice },
    });

    const { loadMessagesWithProvenance } =
      await import("@/chat/state/session-log");
    await expect(
      loadMessagesWithProvenance({
        store,
        conversationId: "conv-prov-2",
        messageCount: 2,
      }),
    ).resolves.toEqual({
      messages: [contextMsg, turnMsg],
      provenance: [
        { authority: "context" },
        { authority: "instruction", actor: alice },
      ],
    });
  });

  it("lets trailing provenance override the run actor default for steered messages", async () => {
    const store = memoryStore();
    const initial: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "start the deploy" }],
      timestamp: 1,
    } as PiMessage;
    const steered: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "actually run tests first" }],
      timestamp: 2,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-prov-steering",
      messages: [initial],
      ttlMs: 60_000,
      newMessageProvenance: { authority: "instruction", actor: alice },
    });
    await commitMessages({
      store,
      conversationId: "conv-prov-steering",
      messages: [initial, steered],
      ttlMs: 60_000,
      newMessageProvenance: { authority: "instruction", actor: alice },
      trailingMessageProvenance: [{ authority: "instruction", actor: bob }],
    });

    await expect(
      loadProjectionWithProvenance({
        store,
        conversationId: "conv-prov-steering",
      }),
    ).resolves.toEqual({
      messages: [initial, steered],
      provenance: [
        { authority: "instruction", actor: alice },
        { authority: "instruction", actor: bob },
      ],
    });
  });

  it("derives the latest instruction actor via loadProjectionWithActor", async () => {
    const store = memoryStore();
    const turnMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "question" }],
      timestamp: 1,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-prov-3",
      messages: [turnMsg],
      ttlMs: 60_000,
      newMessageProvenance: { authority: "instruction", actor: alice },
    });

    const { loadProjectionWithActor } =
      await import("@/chat/state/session-log");
    const projection = await loadProjectionWithActor({
      store,
      conversationId: "conv-prov-3",
    });

    expect(projection.actor).toMatchObject({
      slackUserId: "U123",
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
    expect(projection.messages).toHaveLength(1);
  });

  it("writes aligned provenance through a projection reset", async () => {
    const store = memoryStore();
    const first: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    } as PiMessage;
    const replacementUser: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "replacement user" }],
      timestamp: 2,
    } as PiMessage;
    const replacementSummary: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "context handoff" }],
      timestamp: 3,
    } as PiMessage;

    await commitMessages({
      store,
      conversationId: "conv-prov-4",
      messages: [first],
      ttlMs: 60_000,
    });
    // A reset with explicit per-message provenance keeps the retained actor
    // as an instruction while the synthetic summary is unauthored context.
    await commitMessages({
      store,
      conversationId: "conv-prov-4",
      messages: [replacementUser, replacementSummary],
      ttlMs: 60_000,
      provenance: [
        { authority: "instruction", actor: alice },
        { authority: "context" },
      ],
    });

    const resetEntry = store.entries.find(
      (entry) => entry.type === "projection_reset",
    );
    expect(resetEntry).toMatchObject({
      messages: [replacementUser, replacementSummary],
      provenance: [
        { authority: "instruction", actor: alice },
        { authority: "context" },
      ],
    });
    await expect(
      loadProjectionWithActor({ store, conversationId: "conv-prov-4" }),
    ).resolves.toMatchObject({ actor: { slackUserId: "U123" } });
  });

  it("fails closed on misaligned explicit provenance", async () => {
    const store = memoryStore();
    const turnMsg: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "question" }],
      timestamp: 1,
    } as PiMessage;

    await expect(
      commitMessages({
        store,
        conversationId: "conv-prov-5",
        messages: [turnMsg],
        ttlMs: 60_000,
        provenance: [
          { authority: "instruction", actor: alice },
          { authority: "context" },
        ],
      }),
    ).rejects.toThrow(/align/);
  });

  it("returns a single actor for a single-actor run", () => {
    expect(
      instructionActors([
        { authority: "context" },
        { authority: "instruction", actor: alice },
        { authority: "context" },
      ]),
    ).toEqual([alice]);
  });

  it("collects batched multi-actor input in first-seen order, distinct by ids", () => {
    const bob = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U456",
      userName: "bob",
    };
    // Same human as alice by identity ids, but a different display profile;
    // distinctness is by ids only, so it must collapse onto the first entry.
    const aliceRenamed = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U123",
      userName: "alice-mobile",
      fullName: "Alice On Mobile",
    };
    const provenance: PiMessageProvenance[] = [
      { authority: "instruction", actor: alice },
      { authority: "instruction", actor: bob },
      { authority: "instruction", actor: aliceRenamed },
    ];

    // First-seen order preserved; the second alice profile does not re-add.
    expect(instructionActors(provenance)).toEqual([alice, bob]);
  });

  it("treats matching user ids on different teams as distinct authors", () => {
    const aliceTeamB = {
      platform: "slack" as const,
      teamId: "T999",
      userId: "U123",
    };
    expect(
      instructionActors([
        { authority: "instruction", actor: alice },
        { authority: "instruction", actor: aliceTeamB },
      ]),
    ).toEqual([alice, aliceTeamB]);
  });

  it("does not collapse Slack actors whose concatenated team and user ids collide", () => {
    const first = {
      platform: "slack" as const,
      teamId: "T1",
      userId: "1U2",
    };
    const second = {
      platform: "slack" as const,
      teamId: "T11",
      userId: "U2",
    };

    expect(
      instructionActors([
        { authority: "instruction", actor: first },
        { authority: "instruction", actor: second },
      ]),
    ).toEqual([first, second]);
  });

  it("excludes context and unattributable instruction messages", () => {
    // A system-actor / no-human run: nothing carries an instruction actor.
    expect(
      instructionActors([
        { authority: "context" },
        { authority: "context", actor: alice },
        { authority: "instruction" },
      ]),
    ).toEqual([]);
  });

  it("is monotonic across a growing prefix, so continuation reuses the prefix set", () => {
    const bob = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U456",
      userName: "bob",
    };
    const full: PiMessageProvenance[] = [
      { authority: "instruction", actor: alice },
      { authority: "context" },
      { authority: "instruction", actor: bob },
    ];
    const committedPrefix = full.slice(0, 2);

    // The prefix set is a prefix of the full set: mid-run readers see a lower
    // bound and a continuation derived from the committed prefix is stable.
    expect(instructionActors(committedPrefix)).toEqual([alice]);
    expect(instructionActors(full)).toEqual([alice, bob]);
  });

  it("decodes legacy v1 entries as unauthored context", async () => {
    const store = memoryStore();
    const legacyContext: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "legacy context" }],
      timestamp: 1,
    } as PiMessage;
    const legacyInstruction: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "legacy instruction" }],
      timestamp: 2,
    } as PiMessage;

    store.entries.push(
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: legacyContext,
      } as unknown as SessionLogEntry,
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message: legacyInstruction,
        requester: {
          platform: "slack",
          slackUserId: "U123",
          slackUserName: "alice",
          teamId: "T123",
        },
      } as unknown as SessionLogEntry,
    );

    const { loadMessagesWithProvenance, loadProjectionWithActor } =
      await import("@/chat/state/session-log");
    await expect(
      loadMessagesWithProvenance({
        store,
        conversationId: "conv-prov-legacy",
        messageCount: 2,
      }),
    ).resolves.toEqual({
      messages: [legacyContext, legacyInstruction],
      provenance: [
        { authority: "context" },
        {
          authority: "instruction",
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
            userName: "alice",
          },
        },
      ],
    });
    await expect(
      loadProjectionWithActor({
        store,
        conversationId: "conv-prov-legacy",
      }),
    ).resolves.toMatchObject({ actor: { slackUserId: "U123" } });
  });
});
