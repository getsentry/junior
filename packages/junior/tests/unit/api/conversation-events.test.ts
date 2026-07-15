import { describe, expect, it } from "vitest";
import { projectConversationReportEvents } from "@/api/conversations/events";
import {
  conversationDetailReportSchema,
  conversationReportEventSchema,
} from "@/api/conversations/schema";
import {
  conversationEventSchema,
  type ConversationEvent,
  type ConversationEventData,
  type ConversationModelMessage,
} from "@/chat/conversations/history";

function event(
  seq: number,
  data: ConversationEventData,
  createdAtMs = seq * 1_000,
): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    contextEpoch: 0,
    idempotencyKey: `private-idempotency-${seq}`,
    createdAtMs,
    data,
  });
}

describe("conversation report event projection", () => {
  it("keeps canonical sequence order and sources display text only from visible messages", () => {
    const events = [
      event(
        10,
        {
          type: "visible_message_recorded",
          messageId: "visible-1",
          role: "assistant",
          text: "one user-facing answer",
        },
        30_000,
      ),
      event(
        11,
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "one user-facing answer" },
              { type: "thinking", thinking: "private chain of thought" },
              {
                type: "toolCall",
                name: "search",
                arguments: { query: "private query" },
              },
            ],
          } as ConversationModelMessage,
        },
        10_000,
      ),
      event(
        12,
        {
          type: "tool_execution_started",
          toolCallId: "private-tool-call-id",
          toolName: "search",
          args: { query: "private query" },
        },
        5_000,
      ),
      event(
        13,
        { type: "visible_message_replied", messageId: "visible-1" },
        1_000,
      ),
    ];
    const projected = projectConversationReportEvents({
      canExposePayload: true,
      events,
    });

    expect(projected).toEqual([
      {
        seq: 10,
        createdAt: "1970-01-01T00:00:30.000Z",
        data: {
          type: "visible_message",
          messageId: "visible-1",
          role: "assistant",
          text: "one user-facing answer",
        },
      },
      {
        seq: 11,
        createdAt: "1970-01-01T00:00:10.000Z",
        data: {
          type: "model_activity",
          activities: ["thinking", "tool_call"],
        },
      },
      {
        seq: 12,
        createdAt: "1970-01-01T00:00:05.000Z",
        data: { type: "tool_started", name: "search" },
      },
      {
        seq: 13,
        createdAt: "1970-01-01T00:00:01.000Z",
        data: {
          type: "visible_message_replied",
          messageId: "visible-1",
        },
      },
    ]);
    expect(projected.map(({ seq }) => seq)).toEqual([10, 11, 12, 13]);
    expect(
      projected.filter(
        ({ seq, data }) => seq === 11 && data.type === "model_activity",
      ),
    ).toHaveLength(1);
    expect(
      JSON.stringify(projected).match(/one user-facing answer/g),
    ).toHaveLength(1);
  });

  it("keeps projected prefixes byte-equivalent when later facts arrive", () => {
    const events = [
      event(1, {
        type: "visible_message_recorded",
        messageId: "visible-1",
        role: "user",
        text: "question",
      }),
      event(2, {
        type: "visible_message_replied",
        messageId: "visible-1",
      }),
    ];
    const prefix = projectConversationReportEvents({
      canExposePayload: true,
      events: events.slice(0, 1),
    });
    const complete = projectConversationReportEvents({
      canExposePayload: true,
      events,
    });

    expect(JSON.stringify(prefix)).toBe(JSON.stringify(complete.slice(0, 1)));
  });

  it("redacts private content and strips every internal persistence or payload field", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const projected = projectConversationReportEvents({
      canExposePayload: false,
      events: [
        event(1, {
          type: "visible_message_recorded",
          messageId: "visible-private",
          role: "user",
          text: "private visible text",
          authorIdentityId: "private-actor-id",
          meta: {
            arbitraryMeta: "private arbitrary metadata",
            authorizationId: "private-authorization-id",
          },
        }),
        event(2, {
          type: "message",
          message: {
            role: "toolResult",
            name: "private-tool-name",
            toolCallId: "private-tool-call-id",
            isError: true,
            content: [{ type: "text", text: "private tool result" }],
            errorMessage: "private provider error",
          } as ConversationModelMessage,
        }),
        event(3, {
          type: "tool_execution_started",
          toolCallId: "private-tool-call-id",
          toolName: "safe_tool_name",
          args: { token: "private tool argument" },
        }),
        event(4, {
          type: "turn_failed",
          turnId: "turn-1",
          failureCode: "model_execution_failed",
          eventId,
        }),
        event(5, {
          type: "delivery_intended",
          deliveryId: "delivery:1",
          correlation: { kind: "turn", turnId: "private-turn-id" },
          messageId: "visible-private",
          deliveryKind: "assistant_reply",
          provider: "slack",
          partCount: 2,
        }),
        event(6, {
          type: "delivery_accepted",
          deliveryId: "delivery:1",
          providerMessageIds: ["123.456"],
        }),
        event(7, {
          type: "delivery_failed",
          deliveryId: "delivery:2",
          failureCode: "provider_rejected",
        }),
        event(8, {
          type: "authorization_requested",
          kind: "mcp",
          provider: "private-provider",
          actorId: "private-actor-id",
          authorizationId: "private-authorization-id",
          delivery: "private_link_sent",
        }),
        event(9, {
          type: "authorization_completed",
          kind: "mcp",
          provider: "private-provider",
          actorId: "private-actor-id",
          authorizationId: "private-authorization-id",
        }),
        event(10, {
          type: "visible_message_metadata_updated",
          messageId: "visible-private",
          meta: { privateUpdate: "private metadata update" },
        }),
      ],
    });

    expect(projected[0]?.data).toEqual({
      type: "visible_message",
      messageId: "visible-private",
      role: "user",
      redacted: true,
    });
    expect(projected[1]?.data).toEqual({
      type: "model_activity",
      activities: ["tool_result"],
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "schemaVersion",
      "idempotencyKey",
      "createdAtMs",
      "private visible text",
      "private-actor-id",
      "private arbitrary metadata",
      "private-authorization-id",
      "private-tool-name",
      "private-tool-call-id",
      "private tool result",
      "private provider error",
      "private tool argument",
      "model_execution_failed",
      "private-turn-id",
      eventId,
      "providerMessageIds",
      "123.456",
      "provider_rejected",
      "private-provider",
      "private metadata update",
      "correlation",
      "deliveryKind",
      "partCount",
      "actorId",
      "authorizationId",
      "eventId",
      "failureCode",
      "args",
      "content",
      "meta",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("emits only safe structural lifecycle, context, delivery, and child references", () => {
    const projected = projectConversationReportEvents({
      canExposePayload: true,
      events: [
        event(1, {
          type: "turn_started",
          turnId: "turn-1",
          inputMessageIds: ["private-input-id"],
          surface: "slack",
        }),
        event(2, {
          type: "context_epoch_started",
          reason: "compaction",
          modelProfile: "standard",
          modelId: "private-model-id",
        }),
        event(3, {
          type: "context_epoch_started",
          reason: "handoff",
          modelProfile: "fast",
          modelId: "private-handoff-model-id",
        }),
        event(4, {
          type: "context_epoch_started",
          reason: "rollback",
          modelProfile: "standard",
          modelId: "private-rollback-model-id",
        }),
        event(5, {
          type: "delivery_intended",
          deliveryId: "delivery:1",
          correlation: { kind: "turn", turnId: "turn-1" },
          messageId: "message-1",
          deliveryKind: "assistant_reply",
          provider: "slack",
          partCount: 1,
        }),
        event(6, {
          type: "delivery_accepted",
          deliveryId: "delivery:1",
          providerMessageIds: ["123.456"],
        }),
        event(7, {
          type: "subagent_started",
          subagentInvocationId: "subagent-invocation-1",
          subagentKind: "advisor",
          modelId: "private-child-model-id",
          parentToolCallId: "private-parent-tool-id",
          reasoningLevel: "private-reasoning-level",
          childConversationId: "child-conversation-1",
        }),
        event(8, {
          type: "subagent_ended",
          subagentInvocationId: "subagent-invocation-1",
          outcome: "error",
          errorCode: "private-child-error-code",
        }),
        event(9, {
          type: "subagent_ended",
          subagentInvocationId: "orphan-private-invocation-id",
          outcome: "aborted",
          errorCode: "orphan-private-error-code",
        }),
        event(10, {
          type: "turn_completed",
          turnId: "turn-2",
          outcome: "no_reply",
        }),
      ],
    });

    expect(projected.map(({ seq }) => seq)).toEqual([1, 2, 3, 5, 6, 7, 8, 10]);
    expect(projected.map(({ data }) => data)).toEqual([
      { type: "turn_lifecycle", turnId: "turn-1", state: "started" },
      { type: "context_compacted" },
      { type: "model_handoff" },
      { type: "delivery", deliveryId: "delivery:1", state: "intended" },
      { type: "delivery", deliveryId: "delivery:1", state: "accepted" },
      {
        type: "subagent_started",
        childConversationId: "child-conversation-1",
        subagentKind: "advisor",
      },
      {
        type: "subagent_ended",
        startedSeq: 7,
        outcome: "error",
      },
      { type: "turn_lifecycle", turnId: "turn-2", state: "no_reply" },
    ]);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "private-input-id",
      "private-model-id",
      "private-handoff-model-id",
      "private-rollback-model-id",
      "123.456",
      "subagent-invocation-1",
      "private-child-model-id",
      "private-parent-tool-id",
      "private-reasoning-level",
      "private-child-error-code",
      "orphan-private-invocation-id",
      "orphan-private-error-code",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("owns a strict runtime boundary for envelope and data fields", () => {
    const valid = {
      seq: 1,
      createdAt: "2026-07-15T12:00:00.000Z",
      data: {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "failed",
      },
    };

    expect(conversationReportEventSchema.safeParse(valid).success).toBe(true);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        contextEpoch: 0,
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: { ...valid.data, failureCode: "private-failure-code" },
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: { type: "visible_message", messageId: "m1", role: "user" },
      }).success,
    ).toBe(false);

    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        },
      }).success,
    ).toBe(true);

    const subagentEnded = {
      ...valid,
      data: {
        type: "subagent_ended",
        startedSeq: 1,
        outcome: "success",
      },
    };
    expect(conversationReportEventSchema.safeParse(subagentEnded).success).toBe(
      true,
    );
    expect(
      conversationReportEventSchema.safeParse({
        ...subagentEnded,
        data: { ...subagentEnded.data, startedSeq: undefined },
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...subagentEnded,
        data: { ...subagentEnded.data, childConversationId: "child-1" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-increasing event sequences at the detail boundary", () => {
    const summary = {
      displayTitle: "Report",
      cumulativeDurationMs: 0,
      conversationId: "conversation-1",
      status: "completed" as const,
      startedAt: "2026-07-15T12:00:00.000Z",
      lastSeenAt: "2026-07-15T12:00:00.000Z",
      lastProgressAt: "2026-07-15T12:00:00.000Z",
      surface: "internal" as const,
      generatedAt: "2026-07-15T12:00:00.000Z",
      eventHistory: { status: "available" as const },
    };
    const reportEvent = (seq: number) => ({
      seq,
      createdAt: "2026-07-15T12:00:00.000Z",
      data: {
        type: "turn_lifecycle" as const,
        turnId: `turn-${seq}`,
        state: "started" as const,
      },
    });

    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        events: [reportEvent(1), reportEvent(3)],
      }).success,
    ).toBe(true);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        events: [reportEvent(3), reportEvent(3)],
      }).success,
    ).toBe(false);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        events: [reportEvent(3), reportEvent(2)],
      }).success,
    ).toBe(false);
  });

  it("enforces event-history privacy invariants at the detail boundary", () => {
    const summary = {
      displayTitle: "Report",
      cumulativeDurationMs: 0,
      conversationId: "conversation-privacy",
      status: "completed" as const,
      startedAt: "2026-07-15T12:00:00.000Z",
      lastSeenAt: "2026-07-15T12:00:00.000Z",
      lastProgressAt: "2026-07-15T12:00:00.000Z",
      surface: "internal" as const,
      generatedAt: "2026-07-15T12:00:00.000Z",
    };
    const visibleEvent = (
      data:
        | { text: string; redacted?: never }
        | { redacted: true; text?: never },
    ) => ({
      seq: 1,
      createdAt: "2026-07-15T12:00:00.000Z",
      data: {
        type: "visible_message" as const,
        messageId: "message-1",
        role: "assistant" as const,
        ...data,
      },
    });

    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: { status: "expired", expiredAt: summary.generatedAt },
        events: [visibleEvent({ redacted: true })],
      }).success,
    ).toBe(false);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
        events: [visibleEvent({ text: "must not be exposed" })],
      }).success,
    ).toBe(false);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: { status: "available" },
        events: [visibleEvent({ redacted: true })],
      }).success,
    ).toBe(false);

    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: { status: "expired", expiredAt: summary.generatedAt },
        events: [],
      }).success,
    ).toBe(true);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
        events: [visibleEvent({ redacted: true })],
      }).success,
    ).toBe(true);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: { status: "available" },
        events: [visibleEvent({ text: "safe public text" })],
      }).success,
    ).toBe(true);
  });
});
