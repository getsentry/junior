import { describe, expect, it } from "vitest";
import {
  conversationEventSchema,
  type ConversationEvent,
  type ConversationEventData,
} from "@/chat/conversations/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";

function event(seq: number, data: ConversationEventData): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    contextEpoch: 2,
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
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
    }),
    event(1, { type: "mcp_provider_connected", provider: "github" }),
    event(2, {
      type: "message",
      message: firstMessage,
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
    event(6, { type: "message", message: lastMessage }),
  ];

  it("projects messages, authorization observations, provenance, and model binding", () => {
    const projection = projectConversationEvents(events);

    expect(projection).toEqual({
      messages: [
        firstMessage,
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text" })],
          timestamp: 1_003,
        }),
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
});
