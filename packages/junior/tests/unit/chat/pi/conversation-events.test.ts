import { describe, expect, it } from "vitest";
import {
  agentHistoryItemSchema,
  conversationEventSchema,
  decodeStoredConversationEvent,
  type ConversationEvent,
  type ConversationEventData,
} from "@/chat/conversations/history";
import {
  historyItemFromPiMessage,
  piMessageFromHistoryItem,
  projectConversationEvents,
} from "@/chat/pi/conversation-events";

function event(
  seq: number,
  data: ConversationEventData,
  historyVersion = 2,
): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    historyVersion,
    createdAtMs: 1_000 + seq,
    data,
  });
}

describe("projectConversationEvents", () => {
  const instructionProvenance = {
    authority: "instruction" as const,
    actor: {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U123",
    },
  };
  const firstMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Investigate this" }],
    timestamp: 1_002,
  };
  const lastMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Continue" }],
    timestamp: 1_006,
  };
  const events = [
    event(0, {
      type: "handoff",
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
      triggeringToolCallId: "handoff-call",
      replacementHistory: [],
    }),
    event(1, { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" }),
    event(2, {
      type: "user_message",
      content: firstMessage.content,
      timestamp: firstMessage.timestamp,
      provenance: instructionProvenance,
    }),
    event(3, {
      type: "authorization_completed",
      kind: "mcp",
      provider: "linear",
      actorId: "U123",
      authorizationId: "auth-1",
    }),
    event(4, {
      type: "tool_execution_started",
      toolCallId: "tool-1",
      toolName: "github_search",
    }),
    event(5, {
      type: "authorization_requested",
      kind: "plugin",
      provider: "sentry",
      actorId: "U123",
      authorizationId: "auth-2",
      delivery: "private_link_sent",
    }),
    event(6, {
      type: "user_message",
      content: lastMessage.content,
      timestamp: lastMessage.timestamp,
      provenance: { authority: "context" },
    }),
    event(7, {
      type: "turn_started",
      turnId: "turn-1",
      inputMessageIds: ["message-1"],
      surface: "slack",
    }),
    event(8, {
      type: "turn_failed",
      turnId: "turn-1",
      failureCode: "model_execution_failed",
      eventId: "0123456789abcdef0123456789abcdef",
    }),
    event(9, {
      type: "turn_completed",
      turnId: "turn-2",
      outcome: "no_reply",
    }),
  ];

  it("projects messages, authorization observations, provenance, and model binding", () => {
    const projection = projectConversationEvents(events);

    expect(projection).toEqual({
      messages: [
        firstMessage,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'MCP authorization completed for provider "linear". Continue the blocked request and retry the provider operation if needed.',
            },
          ],
          timestamp: 1_003,
        },
        lastMessage,
      ],
      provenance: [
        instructionProvenance,
        { authority: "context" },
        { authority: "context" },
      ],
      seqs: [2, 3, 6],
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
    });
  });

  it("stops at maxSeq while retaining the epoch model binding", () => {
    const projection = projectConversationEvents(events, { maxSeq: 3 });

    expect(projection).toMatchObject({
      seqs: [2, 3],
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
    });
    expect(projection.messages).toHaveLength(2);
  });

  it("starts from replacement history and appends later messages", () => {
    const retained = {
      role: "user",
      content: [{ type: "text", text: "Retained request" }],
      timestamp: 2_000,
    };
    const summary = {
      role: "user",
      content: [{ type: "text", text: "Summary of earlier work" }],
      timestamp: 2_001,
    };
    const later = {
      role: "user",
      content: [{ type: "text", text: "New request" }],
      timestamp: 2_002,
    };

    const projection = projectConversationEvents([
      event(10, {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-5.4",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              content: retained.content,
              timestamp: retained.timestamp,
              provenance: instructionProvenance,
            },
            sourceEventSeq: 4,
          },
          {
            item: {
              type: "user_message",
              content: summary.content,
              timestamp: summary.timestamp,
              provenance: { authority: "context" },
            },
          },
        ],
      }),
      event(11, {
        type: "user_message",
        content: later.content,
        timestamp: later.timestamp,
        provenance: { authority: "context" },
      }),
    ]);

    expect(projection.messages).toEqual([retained, summary, later]);
    expect(projection.seqs).toEqual([4, 10, 11]);
  });

  it("round-trips native Pi message roles without leaking provenance", () => {
    const native = historyItemFromPiMessage(
      firstMessage,
      instructionProvenance,
    );

    expect(native).toEqual({
      type: "user_message",
      content: firstMessage.content,
      timestamp: firstMessage.timestamp,
      provenance: instructionProvenance,
    });
    expect(piMessageFromHistoryItem(native)).toEqual(firstMessage);
  });

  it("keeps Junior-owned history discriminants authoritative", () => {
    const native = historyItemFromPiMessage(
      {
        ...firstMessage,
        type: "tool_result",
      } as Parameters<typeof historyItemFromPiMessage>[0],
      instructionProvenance,
    );

    expect(native.type).toBe("user_message");
    expect(piMessageFromHistoryItem(native)).toMatchObject({ role: "user" });
    expect(
      agentHistoryItemSchema.safeParse({
        type: "assistant_message",
        role: "user",
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported stored events at the model-history boundary", () => {
    const unsupported = decodeStoredConversationEvent({
      schemaVersion: 1,
      seq: 12,
      historyVersion: 2,
      createdAtMs: 1_012,
      type: "old_context_marker",
      payload: { reason: "old-runtime-behavior" },
    });

    expect(() => projectConversationEvents([unsupported])).toThrow(
      'Unsupported conversation event "old_context_marker" at seq 12 (schema version 1)',
    );
  });

  it("omits volatile runtime bootstrap from durable agent history", () => {
    const projection = projectConversationEvents([
      event(20, {
        type: "user_message",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nvolatile\n</runtime-turn-context>",
          },
          { type: "text", text: "Keep this instruction." },
        ],
        timestamp: 2_000,
        provenance: { authority: "instruction" },
      }),
    ]);

    expect(projection.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Keep this instruction." }],
        timestamp: 2_000,
      },
    ]);
    expect(projection.seqs).toEqual([20]);
  });
});
