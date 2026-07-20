import { describe, expect, it } from "vitest";
import { projectConversationReportEvents } from "@/api/conversations/events";
import {
  conversationDetailReportSchema,
  conversationReportEventSchema,
} from "@/api/conversations/schema";
import {
  conversationEventSchema,
  decodeStoredConversationEvent,
  type ConversationEvent,
  type ConversationEventData,
  type ConversationAgentStepPayload,
} from "@/chat/conversations/history";

function event(
  seq: number,
  data: ConversationEventData,
  createdAtMs = seq * 1_000,
): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    historyVersion: 0,
    idempotencyKey: `private-idempotency-${seq}`,
    createdAtMs,
    data,
  });
}

describe("conversation report event projection", () => {
  it("ignores unsupported stored events", () => {
    const unsupported = decodeStoredConversationEvent({
      schemaVersion: 3,
      seq: 1,
      historyVersion: 0,
      createdAtMs: 1_000,
      type: "future_runtime_fact",
      payload: { privateValue: "must-not-be-reported" },
    });

    expect(
      projectConversationReportEvents({
        canExposePayload: true,
        events: [unsupported],
      }),
    ).toEqual([]);
  });

  it("keeps canonical sequence order and sources display text only from visible messages", () => {
    const events = [
      event(
        10,
        {
          type: "message",
          messageId: "visible-1",
          role: "assistant",
          text: "one user-facing answer",
        },
        30_000,
      ),
      event(
        11,
        {
          type: "agent_step",
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
          } as ConversationAgentStepPayload,
        },
        10_000,
      ),
      event(
        12,
        {
          type: "tool_execution_started",
          toolCallId: "private-tool-call-id",
          toolName: "search",
        },
        5_000,
      ),
      event(13, { type: "message_handled", messageId: "visible-1" }, 1_000),
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
          type: "message",
          messageId: "visible-1",
          role: "assistant",
          text: "one user-facing answer",
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
          type: "message_handled",
          messageId: "visible-1",
        },
      },
    ]);
    expect(projected.map(({ seq }) => seq)).toEqual([10, 12, 13]);
    expect(
      JSON.stringify(projected).match(/one user-facing answer/g),
    ).toHaveLength(1);
  });

  it("keeps projected prefixes byte-equivalent when later facts arrive", () => {
    const events = [
      event(1, {
        type: "message",
        messageId: "visible-1",
        role: "user",
        text: "question",
      }),
      event(2, {
        type: "message_handled",
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
          type: "message",
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
          type: "agent_step",
          message: {
            role: "toolResult",
            name: "private-tool-name",
            toolCallId: "private-tool-call-id",
            isError: true,
            content: [{ type: "text", text: "private tool result" }],
            errorMessage: "private provider error",
          } as ConversationAgentStepPayload,
        }),
        event(3, {
          type: "tool_execution_started",
          toolCallId: "private-tool-call-id",
          toolName: "safe_tool_name",
        }),
        event(4, {
          type: "turn_failed",
          turnId: "turn-1",
          failureCode: "model_execution_failed",
          eventId,
        }),
        event(5, {
          type: "turn_failed",
          turnId: "turn-delivery-1",
          failureCode: "delivery_failed",
        }),
        event(6, {
          type: "authorization_requested",
          kind: "mcp",
          provider: "private-provider",
          actorId: "private-actor-id",
          authorizationId: "private-authorization-id",
          delivery: "private_link_sent",
        }),
        event(7, {
          type: "authorization_completed",
          kind: "mcp",
          provider: "private-provider",
          actorId: "private-actor-id",
          authorizationId: "private-authorization-id",
        }),
      ],
    });

    expect(projected[0]?.data).toEqual({
      type: "message",
      messageId: "visible-private",
      role: "user",
      redacted: true,
    });
    expect(projected[1]?.data).toEqual({
      type: "tool_started",
      name: "safe_tool_name",
    });
    expect(projected[2]?.data).toEqual({
      type: "turn_lifecycle",
      turnId: "turn-1",
      state: "failed",
      failureKind: "agent",
    });
    expect(projected[3]?.data).toEqual({
      type: "turn_lifecycle",
      turnId: "turn-delivery-1",
      state: "failed",
      failureKind: "delivery",
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
      "model_execution_failed",
      eventId,
      "private-provider",
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

  it("emits only safe structural lifecycle, context, and child references", () => {
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
          type: "compaction",
          modelProfile: "standard",
          modelId: "private-model-id",
          replacementHistory: [],
        }),
        event(3, {
          type: "tool_execution_started",
          toolCallId: "private-handoff-tool-call-id",
          toolName: "handoff",
        }),
        event(4, {
          type: "handoff",
          modelProfile: "fast",
          modelId: "private-handoff-model-id",
          triggeringToolCallId: "private-handoff-tool-call-id",
          replacementHistory: [],
        }),
        event(6, {
          type: "rollback",
          modelProfile: "standard",
          modelId: "private-rollback-model-id",
          replacementHistory: [],
        }),
        event(7, {
          type: "turn_failed",
          turnId: "turn-1",
          failureCode: "delivery_failed",
        }),
        event(8, {
          type: "tool_execution_started",
          toolCallId: "private-parent-tool-id",
          toolName: "advisor",
        }),
        event(9, {
          type: "subagent_started",
          subagentInvocationId: "subagent-invocation-1",
          subagentKind: "advisor",
          modelId: "private-child-model-id",
          parentToolCallId: "private-parent-tool-id",
          reasoningLevel: "private-reasoning-level",
          childConversationId: "child-conversation-1",
        }),
        event(10, {
          type: "subagent_ended",
          subagentInvocationId: "subagent-invocation-1",
          outcome: "error",
          errorCode: "private-child-error-code",
        }),
        event(11, {
          type: "subagent_started",
          subagentInvocationId: "legacy-subagent-invocation",
          subagentKind: "advisor",
          childConversationId: "legacy-child-conversation",
        }),
        event(12, {
          type: "subagent_ended",
          subagentInvocationId: "orphan-private-invocation-id",
          outcome: "aborted",
          errorCode: "orphan-private-error-code",
        }),
        event(13, {
          type: "turn_completed",
          turnId: "turn-2",
          outcome: "no_reply",
        }),
      ],
    });

    expect(projected.map(({ seq }) => seq)).toEqual([
      1, 2, 3, 4, 7, 8, 9, 10, 11, 13,
    ]);
    expect(projected.map(({ data }) => data)).toEqual([
      { type: "turn_lifecycle", turnId: "turn-1", state: "started" },
      { type: "compaction" },
      { type: "tool_started", name: "handoff" },
      { type: "handoff", toolStartedSeq: 3 },
      {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "failed",
        failureKind: "delivery",
      },
      { type: "tool_started", name: "advisor" },
      {
        type: "subagent_started",
        childConversationId: "child-conversation-1",
        subagentKind: "advisor",
        toolStartedSeq: 8,
      },
      {
        type: "subagent_ended",
        startedSeq: 9,
        outcome: "error",
      },
      {
        type: "subagent_started",
        childConversationId: "legacy-child-conversation",
        subagentKind: "advisor",
      },
      { type: "turn_lifecycle", turnId: "turn-2", state: "no_reply" },
    ]);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "private-input-id",
      "private-model-id",
      "private-handoff-model-id",
      "private-handoff-tool-call-id",
      "private-rollback-model-id",
      "subagent-invocation-1",
      "private-child-model-id",
      "private-parent-tool-id",
      "private-reasoning-level",
      "private-child-error-code",
      "legacy-subagent-invocation",
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
        failureKind: "agent",
      },
    };

    expect(conversationReportEventSchema.safeParse(valid).success).toBe(true);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: { type: "turn_lifecycle", turnId: "turn-1", state: "failed" },
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "succeeded",
          failureKind: "agent",
        },
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        historyVersion: 0,
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
        data: { type: "message", messageId: "m1", role: "user" },
      }).success,
    ).toBe(false);
    expect(
      conversationReportEventSchema.safeParse({
        ...valid,
        data: { type: "model_activity", activities: ["thinking"] },
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
        type: "message" as const,
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
