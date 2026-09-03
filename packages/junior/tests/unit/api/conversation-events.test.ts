import { describe, expect, it } from "vitest";
import {
  defineConversationEvent,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { projectConversationReportEventPage } from "@/api/conversations/events";
import {
  conversationDetailReportSchema,
  conversationReportEventSchema,
} from "@/api/schema/conversation";
import {
  conversationEventSchema,
  decodeStoredConversationEvent,
  type ConversationEvent,
  type ConversationEventData,
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

function assistantMessage(
  content: unknown[],
  timestamp = 0,
): ConversationEventData {
  return {
    type: "assistant_message",
    content,
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    usage: {},
    stopReason: "stop",
    timestamp,
  };
}

describe("conversation report event projection", () => {
  it("renders registered plugin events and skips them after removal", async () => {
    const captured = defineConversationEvent({
      name: "memories_captured",
      version: 1,
      schema: z.object({ count: z.number().int().positive() }).strict(),
      renderEvent(value) {
        return {
          icon: "brain",
          title: `${value.count} memories captured`,
        };
      },
    });
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory test plugin",
        },
        conversationEvents: [captured],
      }),
    ]);
    const pluginEvent = event(1, {
      type: "structured_event",
      namespace: "memory",
      name: "memories_captured",
      version: 1,
      turnId: "turn-1",
      content: { count: 2 },
    });
    try {
      expect(
        projectConversationReportEventPage({
          canExposePayload: true,
          events: [pluginEvent],
        }),
      ).toEqual([
        {
          seq: 1,
          createdAt: new Date(1_000).toISOString(),
          data: {
            type: "structured_event",
            namespace: "memory",
            name: "memories_captured",
            version: 1,
            turnId: "turn-1",
            presentation: {
              icon: "brain",
              title: "2 memories captured",
            },
          },
        },
      ]);
      setPlugins([]);
      expect(
        projectConversationReportEventPage({
          canExposePayload: true,
          events: [pluginEvent],
        }),
      ).toEqual([]);
    } finally {
      setPlugins(previous);
    }
  });

  it("omits registered plugin events without a presentation", async () => {
    const background = defineConversationEvent({
      name: "background_completed",
      version: 1,
      schema: z.object({ count: z.number().int().nonnegative() }).strict(),
      renderEvent(value) {
        return value.count === 0 ? undefined : { title: "Background work" };
      },
    });
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "background",
          displayName: "Background",
          description: "Background event test plugin",
        },
        conversationEvents: [background],
      }),
    ]);
    try {
      expect(
        projectConversationReportEventPage({
          canExposePayload: true,
          events: [
            event(1, {
              type: "structured_event",
              namespace: "background",
              name: "background_completed",
              version: 1,
              content: { count: 0 },
            }),
          ],
        }),
      ).toEqual([]);
    } finally {
      setPlugins(previous);
    }
  });

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
      projectConversationReportEventPage({
        canExposePayload: true,
        events: [unsupported],
      }),
    ).toEqual([]);
  });

  it("projects the stored actor identity for each visible user message", () => {
    const message = event(1, {
      type: "message",
      messageId: "message-1",
      role: "user",
      text: "good catch",
      meta: {
        author: {
          fullName: "Taylor Chen",
          isBot: false,
          userId: "U0TAYLOR",
          userName: "taylor",
        },
      },
    });

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events: [message],
      }),
    ).toEqual([
      {
        seq: 1,
        createdAt: "1970-01-01T00:00:01.000Z",
        data: {
          type: "message",
          messageId: "message-1",
          role: "user",
          text: "good catch",
          actorIdentity: {
            fullName: "Taylor Chen",
            slackUserId: "U0TAYLOR",
            slackUserName: "taylor",
          },
        },
      },
    ]);

    expect(
      projectConversationReportEventPage({
        canExposePayload: false,
        events: [message],
      }),
    ).toEqual([
      {
        seq: 1,
        createdAt: "1970-01-01T00:00:01.000Z",
        data: {
          type: "message",
          messageId: "message-1",
          role: "user",
          redacted: true,
        },
      },
    ]);
  });

  it("projects delivered attachments only when payload is visible", () => {
    const delivered = event(1, {
      type: "attachments_delivered",
      attachments: [
        {
          id: "att-1",
          filename: "chart.png",
          contentType: "image/png",
          bytes: 18211,
        },
      ],
      toolCallId: "call-send-1",
    });

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events: [delivered],
      }),
    ).toEqual([
      {
        seq: 1,
        createdAt: "1970-01-01T00:00:01.000Z",
        data: {
          type: "attachments_delivered",
          attachments: [
            {
              id: "att-1",
              filename: "chart.png",
              contentType: "image/png",
              bytes: 18211,
            },
          ],
        },
      },
    ]);

    expect(
      projectConversationReportEventPage({
        canExposePayload: false,
        events: [delivered],
      }),
    ).toEqual([]);
  });

  it("projects turn input message ids across report pages", () => {
    const events = [
      event(1, {
        type: "message",
        messageId: "context-1",
        role: "user",
        text: "can you clarify that?",
        meta: { explicitMention: false },
      }),
      event(2, {
        type: "turn_started",
        turnId: "turn-1",
        inputMessageIds: ["context-1", "earlier-page-input-id"],
        surface: "slack",
      }),
    ];

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events,
      }).map((entry) => entry.data),
    ).toEqual([
      {
        type: "message",
        messageId: "context-1",
        role: "user",
        text: "can you clarify that?",
        explicitMention: false,
      },
      {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "started",
        inputMessageIds: ["context-1", "earlier-page-input-id"],
      },
    ]);
  });

  it("projects turn context only across the authorized payload boundary", () => {
    const context = event(1, {
      type: "turn_context",
      turnId: "turn-1",
      pluginName: "memory",
      kind: "recall",
      version: 1,
      content: {
        memories: [{ id: "memory-1", content: "Use pnpm." }],
      },
    });

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events: [context],
      }),
    ).toEqual([
      {
        seq: 1,
        createdAt: new Date(1_000).toISOString(),
        data: {
          type: "turn_context",
          turnId: "turn-1",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [{ id: "memory-1", content: "Use pnpm." }],
          },
        },
      },
    ]);
    expect(
      projectConversationReportEventPage({
        canExposePayload: false,
        events: [context],
      }),
    ).toEqual([]);
  });

  it("keeps canonical sequence order and projects authorized assistant activity", () => {
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
        assistantMessage(
          [
            { type: "text", text: "one user-facing answer" },
            { type: "thinking", thinking: "private chain of thought" },
            {
              type: "toolCall",
              id: "private-tool-call-id",
              name: "search",
              arguments: { query: "private query" },
            },
          ],
          10_000,
        ),
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
    const projected = projectConversationReportEventPage({
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
        seq: 11,
        createdAt: "1970-01-01T00:00:10.000Z",
        data: {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "private-tool-call-id",
              name: "search",
              status: "running",
              startedAt: "1970-01-01T00:00:10.000Z",
              startedSeq: 11,
              input: { query: "private query" },
            },
          ],
          assistant: {
            parts: [
              {
                type: "reasoning",
                text: "private chain of thought",
              },
              {
                type: "tool_call",
                toolCallId: "private-tool-call-id",
              },
            ],
          },
        },
      },
      {
        seq: 12,
        createdAt: "1970-01-01T00:00:05.000Z",
        data: {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "private-tool-call-id",
              name: "search",
              status: "running",
              startedAt: "1970-01-01T00:00:05.000Z",
              startedSeq: 12,
            },
          ],
        },
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
    expect(projected.map(({ seq }) => seq)).toEqual([10, 11, 12, 13]);
    expect(
      JSON.stringify(projected).match(/one user-facing answer/g),
    ).toHaveLength(1);
    expect(JSON.stringify(projected)).toContain("private chain of thought");

    const redacted = projectConversationReportEventPage({
      canExposePayload: false,
      events,
    });
    expect(redacted[1]?.data).toEqual({
      type: "tool_calls",
      calls: [
        {
          toolCallId: "private-tool-call-id",
          name: "search",
          status: "running",
          startedAt: "1970-01-01T00:00:10.000Z",
          startedSeq: 11,
        },
      ],
      assistant: {
        parts: [
          { type: "reasoning", redacted: true },
          {
            type: "tool_call",
            toolCallId: "private-tool-call-id",
          },
        ],
      },
    });
  });

  it("projects reasoning-only assistant history as an additive event", () => {
    const events = [
      event(
        1,
        assistantMessage([
          { type: "thinking", thinking: "Check the final answer." },
        ]),
      ),
    ];

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events,
      })[0]?.data,
    ).toEqual({
      type: "assistant_message",
      parts: [{ type: "reasoning", text: "Check the final answer." }],
    });
    expect(
      projectConversationReportEventPage({
        canExposePayload: false,
        events,
      })[0]?.data,
    ).toEqual({
      type: "assistant_message",
      parts: [{ type: "reasoning", redacted: true }],
    });
  });

  it("drops provider-redacted thinking before reporting", () => {
    const redactedOnly = [
      event(
        1,
        assistantMessage([
          {
            type: "thinking",
            thinking: "provider-private reasoning",
            redacted: true,
          },
        ]),
      ),
    ];
    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events: redactedOnly,
      }),
    ).toEqual([]);

    const withTool = [
      event(
        1,
        assistantMessage([
          {
            type: "thinking",
            thinking: "provider-private reasoning",
            redacted: true,
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "search",
            arguments: { query: "visible query" },
          },
        ]),
      ),
    ];
    const projected = projectConversationReportEventPage({
      canExposePayload: true,
      events: withTool,
    });
    expect(projected[0]?.data).toMatchObject({
      type: "tool_calls",
      calls: [{ toolCallId: "call-1", name: "search" }],
    });
    expect(JSON.stringify(projected)).not.toContain(
      "provider-private reasoning",
    );
  });

  it("projects parallel calls, structured outcomes, and safe native content", () => {
    const projected = projectConversationReportEventPage({
      canExposePayload: true,
      events: [
        event(
          1,
          assistantMessage([
            {
              type: "toolCall",
              id: "call-1",
              name: "search",
              arguments: { query: "first" },
            },
            {
              type: "toolCall",
              id: "call-2",
              name: "fetch",
              arguments: { url: "https://example.com" },
            },
          ]),
        ),
        event(2, {
          type: "tool_result",
          toolCallId: "call-1",
          toolName: "search",
          content: [{ type: "text", text: "model-visible error summary" }],
          details: {
            query: "first",
            providerSecret: "must stay host-only",
          },
          isError: true,
          timestamp: 2_000,
        }),
        event(3, {
          type: "tool_result",
          toolCallId: "call-2",
          toolName: "fetch",
          content: [
            { type: "text", text: "native result" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
          details: { url: "https://example.com" },
          isError: false,
          timestamp: 3_000,
        }),
      ],
    });

    expect(projected.map(({ data }) => data)).toEqual([
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "call-1",
            name: "search",
            status: "running",
            startedAt: "1970-01-01T00:00:01.000Z",
            startedSeq: 1,
            input: { query: "first" },
          },
          {
            toolCallId: "call-2",
            name: "fetch",
            status: "running",
            startedAt: "1970-01-01T00:00:01.000Z",
            startedSeq: 1,
            input: { url: "https://example.com" },
          },
        ],
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "call-1",
            name: "search",
            status: "error",
            output: "model-visible error summary",
          },
        ],
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "call-2",
            name: "fetch",
            status: "completed",
            output: [
              { type: "text", text: "native result" },
              { type: "image", mimeType: "image/png" },
            ],
          },
        ],
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("must not escape");
    expect(JSON.stringify(projected)).not.toContain("must stay host-only");
    expect(JSON.stringify(projected)).not.toContain("No matches");
    expect(JSON.stringify(projected)).not.toContain("AAAA");
  });

  it("projects dashboard source with visible message metadata", () => {
    const [projected] = projectConversationReportEventPage({
      canExposePayload: true,
      events: [
        event(1, {
          type: "message",
          messageId: "event-1",
          role: "user",
          text: "event details",
          meta: {
            eventType: "pull_request.merged",
            trustedSummary: "David merged PR #42.",
            provider: "private-provider",
            source: "web",
          },
        }),
      ],
    });

    expect(projected?.data).toEqual({
      type: "message",
      messageId: "event-1",
      role: "user",
      source: "web",
      eventType: "pull_request.merged",
      trustedSummary: "David merged PR #42.",
      text: "event details",
    });
  });

  it("projects known Slack source with visible message metadata", () => {
    const [projected] = projectConversationReportEventPage({
      canExposePayload: true,
      events: [
        event(1, {
          type: "message",
          messageId: "event-1",
          role: "user",
          text: "from slack",
          meta: {
            source: "slack",
          },
        }),
      ],
    });

    expect(projected?.data).toEqual({
      type: "message",
      messageId: "event-1",
      role: "user",
      source: "slack",
      text: "from slack",
    });
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
    const prefix = projectConversationReportEventPage({
      canExposePayload: true,
      events: events.slice(0, 1),
    });
    const complete = projectConversationReportEventPage({
      canExposePayload: true,
      events,
    });

    expect(JSON.stringify(prefix)).toBe(JSON.stringify(complete.slice(0, 1)));
  });

  it("does not use future start context to rewrite a native tool result", () => {
    const result = event(1, {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "result_tool",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 1_000,
    });
    const futureStart = event(2, {
      type: "tool_execution_started",
      toolCallId: "call-1",
      toolName: "search",
    });

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events: [result],
        toolStartEvents: [futureStart],
      }),
    ).toEqual([
      {
        seq: 1,
        createdAt: "1970-01-01T00:00:01.000Z",
        data: {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "call-1",
              name: "result_tool",
              status: "completed",
              output: "result",
            },
          ],
        },
      },
    ]);
  });

  it("redacts private content and strips every internal persistence or payload field", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const projected = projectConversationReportEventPage({
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
            trustedSummary: "private resource summary",
          },
        }),
        event(2, {
          type: "tool_result",
          toolName: "safe_tool_name",
          toolCallId: "private-tool-call-id",
          isError: true,
          content: [{ type: "text", text: "private tool result" }],
          errorMessage: "private provider error",
          timestamp: 2,
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
          failureReason: "network",
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
      type: "tool_calls",
      calls: [
        {
          toolCallId: "private-tool-call-id",
          name: "safe_tool_name",
          status: "error",
        },
      ],
    });
    expect(projected[2]?.data).toEqual({
      type: "tool_calls",
      calls: [
        {
          toolCallId: "private-tool-call-id",
          name: "safe_tool_name",
          status: "running",
          startedAt: "1970-01-01T00:00:03.000Z",
          startedSeq: 3,
        },
      ],
    });
    expect(projected[3]?.data).toEqual({
      type: "turn_lifecycle",
      turnId: "turn-1",
      state: "failed",
      failureCode: "model_execution_failed",
      failureReason: "network",
      eventId,
    });
    expect(projected[4]?.data).toEqual({
      type: "turn_lifecycle",
      turnId: "turn-delivery-1",
      state: "failed",
      failureCode: "delivery_failed",
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "schemaVersion",
      "idempotencyKey",
      "createdAtMs",
      "private visible text",
      "private-actor-id",
      "private arbitrary metadata",
      "private resource summary",
      "private-authorization-id",
      "private tool result",
      "private provider error",
      "private-provider",
      "actorId",
      "authorizationId",
      "args",
      "content",
      "meta",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("exposes only generated continuation summaries to authorized viewers", () => {
    const events = [
      event(1, {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-5.4",
        summary: "Continue monitoring CI.",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              content: "Private retained user message.",
              timestamp: 1,
              provenance: { authority: "context" },
            },
          },
          {
            item: {
              type: "user_message",
              content: "Other private replacement context.",
              timestamp: 1,
              provenance: { authority: "context" },
            },
          },
        ],
      }),
      event(2, {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        summary: "Fix the remaining test.",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              content: [
                {
                  type: "text",
                  text: "More private replacement context.",
                },
              ],
              timestamp: 2,
              provenance: { authority: "context" },
            },
          },
        ],
      }),
    ];

    expect(
      projectConversationReportEventPage({
        canExposePayload: true,
        events,
      }).map((entry) => entry.data),
    ).toEqual([
      {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-5.4",
        summary: "Continue monitoring CI.",
      },
      {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        summary: "Fix the remaining test.",
      },
    ]);

    const redacted = JSON.stringify(
      projectConversationReportEventPage({
        canExposePayload: false,
        events,
      }),
    );
    expect(redacted).not.toContain("Private retained user message.");
    expect(redacted).not.toContain("Continue monitoring CI.");
    expect(redacted).not.toContain("Fix the remaining test.");
  });

  it("emits only safe structural lifecycle, context, and child references", () => {
    const projected = projectConversationReportEventPage({
      canExposePayload: true,
      events: [
        event(1, {
          type: "turn_started",
          turnId: "turn-1",
          inputMessageIds: ["private-input-id"],
          surface: "slack",
        }),
        event(2, {
          type: "turn_routed",
          turnId: "turn-1",
          modelProfile: "handoff",
          modelId: "private-routed-model-id",
          reasoningLevel: "high",
          confidence: 0.93,
          source: "router",
        }),
        event(3, {
          type: "compaction",
          modelProfile: "standard",
          modelId: "private-model-id",
          details: {
            reason: "capacity",
            estimatedInputTokens: 361_000,
            triggerTokens: 360_000,
            inputLimitTokens: 380_000,
            inputMessageCount: 42,
            retainedMessageCount: 2,
            summaryChars: 1_200,
          },
          replacementHistory: [],
        }),
        event(4, {
          type: "tool_execution_started",
          toolCallId: "private-handoff-tool-call-id",
          toolName: "handoff",
        }),
        event(5, {
          type: "handoff",
          modelProfile: "fast",
          modelId: "private-handoff-model-id",
          reasoningLevel: "high",
          triggeringToolCallId: "private-handoff-tool-call-id",
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
      1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13,
    ]);
    expect(projected.map(({ data }) => data)).toEqual([
      {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "started",
        inputMessageIds: ["private-input-id"],
      },
      {
        type: "turn_routed",
        turnId: "turn-1",
        modelProfile: "handoff",
        modelId: "private-routed-model-id",
        reasoningLevel: "high",
        confidence: 0.93,
        source: "router",
      },
      {
        type: "compaction",
        modelProfile: "standard",
        modelId: "private-model-id",
        details: {
          reason: "capacity",
          estimatedInputTokens: 361_000,
          triggerTokens: 360_000,
          inputLimitTokens: 380_000,
          inputMessageCount: 42,
          retainedMessageCount: 2,
          summaryChars: 1_200,
        },
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "private-handoff-tool-call-id",
            name: "handoff",
            status: "running",
            startedAt: "1970-01-01T00:00:04.000Z",
            startedSeq: 4,
          },
        ],
      },
      {
        type: "handoff",
        modelProfile: "fast",
        modelId: "private-handoff-model-id",
        reasoningLevel: "high",
        triggeringToolCallId: "private-handoff-tool-call-id",
      },
      {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "failed",
        failureCode: "delivery_failed",
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "private-parent-tool-id",
            name: "advisor",
            status: "running",
            startedAt: "1970-01-01T00:00:08.000Z",
            startedSeq: 8,
          },
        ],
      },
      {
        type: "subagent",
        startedSeq: 9,
        startedAt: "1970-01-01T00:00:09.000Z",
        childConversationId: "child-conversation-1",
        subagentKind: "advisor",
        parentToolCallId: "private-parent-tool-id",
        status: "running",
      },
      {
        type: "subagent",
        startedSeq: 9,
        startedAt: "1970-01-01T00:00:09.000Z",
        childConversationId: "child-conversation-1",
        subagentKind: "advisor",
        parentToolCallId: "private-parent-tool-id",
        status: "error",
      },
      {
        type: "subagent",
        startedSeq: 11,
        startedAt: "1970-01-01T00:00:11.000Z",
        childConversationId: "legacy-child-conversation",
        subagentKind: "advisor",
        status: "running",
      },
      { type: "turn_lifecycle", turnId: "turn-2", state: "no_reply" },
    ]);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "subagent-invocation-1",
      "private-child-model-id",
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
        failureCode: "model_execution_failed",
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
          failureCode: "model_execution_failed",
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
        data: { ...valid.data, failureCode: "not_a_real_code" },
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
          type: "subagent",
          startedSeq: 1,
          startedAt: "2026-07-15T12:00:00.000Z",
          childConversationId: "child-1",
          subagentKind: "advisor",
          status: "running",
        },
      }).success,
    ).toBe(true);

    const subagentEnded = {
      ...valid,
      data: {
        type: "subagent",
        startedSeq: 1,
        startedAt: "2026-07-15T12:00:00.000Z",
        childConversationId: "child-1",
        subagentKind: "advisor",
        status: "completed",
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
        data: { ...subagentEnded.data, childConversationId: undefined },
      }).success,
    ).toBe(false);

    const terminalTool = {
      ...valid,
      data: {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "call-1",
            name: "search",
            status: "completed",
          },
        ],
      },
    };
    expect(conversationReportEventSchema.safeParse(terminalTool).success).toBe(
      true,
    );
    expect(
      conversationReportEventSchema.safeParse({
        ...terminalTool,
        data: {
          ...terminalTool.data,
          calls: [{ ...terminalTool.data.calls[0], startedSeq: 1 }],
        },
      }).success,
    ).toBe(false);
  });

  it("matches assistant tool references by id count", () => {
    const envelope = {
      seq: 1,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const call = {
      toolCallId: "call-1",
      name: "search",
      status: "running" as const,
    };

    expect(
      conversationReportEventSchema.safeParse({
        ...envelope,
        data: {
          type: "tool_calls",
          calls: [call, call],
          assistant: {
            parts: [
              { type: "tool_call", toolCallId: "call-1" },
              { type: "tool_call", toolCallId: "call-1" },
            ],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      conversationReportEventSchema.safeParse({
        ...envelope,
        data: {
          type: "tool_calls",
          calls: [call, { ...call, toolCallId: "call-2" }],
          assistant: {
            parts: [
              { type: "tool_call", toolCallId: "call-1" },
              { type: "tool_call", toolCallId: "call-1" },
            ],
          },
        },
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
      isParticipant: false,
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
      isParticipant: false,
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
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
        events: [
          {
            seq: 1,
            createdAt: summary.generatedAt,
            data: {
              type: "tool_calls",
              calls: [
                {
                  toolCallId: "private-call",
                  name: "search",
                  status: "running",
                  input: { query: "must not be exposed" },
                },
              ],
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      conversationDetailReportSchema.safeParse({
        ...summary,
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
        events: [
          {
            seq: 1,
            createdAt: summary.generatedAt,
            data: {
              type: "tool_calls",
              calls: [
                {
                  toolCallId: "private-call",
                  name: "search",
                  status: "completed",
                  output: { matches: "must not be exposed" },
                },
              ],
            },
          },
        ],
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
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
        events: [
          {
            seq: 1,
            createdAt: summary.generatedAt,
            data: {
              type: "tool_calls",
              calls: [
                {
                  toolCallId: "private-call",
                  name: "search",
                  status: "running",
                },
              ],
            },
          },
          {
            seq: 2,
            createdAt: summary.generatedAt,
            data: {
              type: "tool_calls",
              calls: [
                {
                  toolCallId: "private-call",
                  name: "search",
                  status: "completed",
                },
              ],
            },
          },
        ],
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
