import { afterEach, describe, expect, it } from "vitest";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { juniorConversationEvents } from "@/db/schema";

const CURRENT_CONVERSATION_ID = "slack:C123:1700000000.100000";

function context(): ToolRuntimeContext {
  return {
    conversationId: CURRENT_CONVERSATION_ID,
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    location: {
      id: "location:T123:C123",
      provider: "slack",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.100000",
    },
    source: { kind: "scheduled_task" },
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

async function executeTool(input: Record<string, unknown>) {
  const tool = createSearchConversationEventsTool(context());
  if (!tool.execute) throw new Error("tool execute function missing");
  return await tool.execute(input, {});
}

async function recordSlackConversation(args: {
  channelId: string;
  conversationId: string;
  teamId?: string;
  visibility: "private" | "public";
}) {
  await getConversationStore().recordActivity({
    conversationId: args.conversationId,
    destination: {
      platform: "slack",
      teamId: args.teamId ?? "T123",
      channelId: args.channelId,
    },
    nowMs: 1,
    source: "slack",
    visibility: args.visibility,
  });
}

describe("searchConversationEvents", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("queries bounded stored events and omits replacement history", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    const events = getConversationEventStore();
    await events.append(CURRENT_CONVERSATION_ID, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "m-1",
          role: "user",
          text: "first",
        },
      },
      {
        createdAtMs: 2,
        data: {
          type: "message",
          messageId: "m-2",
          role: "assistant",
          text: "second",
        },
      },
    ]);
    await events.replaceHistory(CURRENT_CONVERSATION_ID, {
      createdAtMs: 3,
      data: {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "test/model",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              content: [],
              timestamp: 3,
              provenance: { authority: "context" },
            },
          },
        ],
      },
    });

    const page = await executeTool({
      conversation_id: CURRENT_CONVERSATION_ID,
      after_seq: 0,
      limit: 2,
    });

    expect(page).toMatchObject({
      conversation_id: CURRENT_CONVERSATION_ID,
      has_older: true,
      has_newer: false,
      truncated: false,
      events: [
        { seq: 1, data: { type: "message", text: "second" } },
        {
          seq: 2,
          data: {
            type: "handoff",
            replacement_history_count: 1,
          },
        },
      ],
    });
    expect(page.events[1]).not.toMatchObject({
      data: { replacementHistory: expect.anything() },
    });

    await expect(
      executeTool({
        after_seq: 0,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      conversation_id: CURRENT_CONVERSATION_ID,
      events: [
        { seq: 1, data: { type: "message", text: "second" } },
        {
          seq: 2,
          data: {
            type: "handoff",
            replacement_history_count: 1,
          },
        },
      ],
    });
    await expect(
      executeTool({
        conversation_id: null,
        after_seq: 0,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      conversation_id: CURRENT_CONVERSATION_ID,
      events: [
        { seq: 1, data: { type: "message", text: "second" } },
        {
          seq: 2,
          data: {
            type: "handoff",
            replacement_history_count: 1,
          },
        },
      ],
    });

    await expect(
      executeTool({
        conversation_id: CURRENT_CONVERSATION_ID,
        before_seq: 2,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      events: [{ seq: 1 }],
      has_older: true,
      has_newer: true,
    });
    await expect(
      executeTool({
        conversation_id: CURRENT_CONVERSATION_ID,
        after_seq: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      events: [{ seq: 1 }],
      has_older: true,
      has_newer: true,
    });

    await events.append(CURRENT_CONVERSATION_ID, [
      {
        createdAtMs: 4,
        data: {
          type: "tool_result",
          toolCallId: "tool-1",
          toolName: "oversized",
          isError: false,
          content: [{ type: "text", text: "x".repeat(20_000) }],
          timestamp: 4,
        },
      },
    ]);
    const oversized = await executeTool({
      conversation_id: CURRENT_CONVERSATION_ID,
      types: ["tool_result"],
    });

    expect(oversized.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          type: "tool_result",
          toolCallId: "tool-1",
          toolName: "oversized",
          payload_omitted: true,
          payload_json_bytes: expect.any(Number),
        }),
      }),
    ]);
    expect(oversized.events[0]!.data).not.toHaveProperty("json_preview");

    await events.append(
      CURRENT_CONVERSATION_ID,
      Array.from({ length: 10 }, (_, index) => ({
        createdAtMs: 5 + index,
        data: {
          type: "message" as const,
          messageId: `large-${index}`,
          role: "assistant" as const,
          text: "y".repeat(3_500),
        },
      })),
    );
    const bounded = await executeTool({
      conversation_id: CURRENT_CONVERSATION_ID,
      types: ["message"],
    });

    expect(bounded.omitted_event_count).toBeGreaterThan(0);
    expect(bounded.has_older).toBe(true);
    expect(bounded.events.at(-1)?.data).toMatchObject({
      messageId: "large-9",
    });
    expect(
      new TextEncoder().encode(JSON.stringify(bounded.events)).byteLength,
    ).toBeLessThanOrEqual(20_000);

    const boundedNewer = await executeTool({
      conversation_id: CURRENT_CONVERSATION_ID,
      after_seq: 3,
      types: ["message"],
    });
    expect(boundedNewer.omitted_event_count).toBeGreaterThan(0);
    expect(boundedNewer.has_newer).toBe(true);
    expect(boundedNewer.events[0]?.data).toMatchObject({
      messageId: "large-0",
    });
  });

  it("omits replacement history from unknown event versions", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    await getDb()
      .insert(juniorConversationEvents)
      .values({
        conversationId: CURRENT_CONVERSATION_ID,
        seq: 0,
        historyVersion: 1,
        schemaVersion: 2,
        type: "handoff",
        payload: {
          modelId: "future/model",
          replacementHistory: [{ message: { role: "user" } }],
        },
        createdAt: new Date(1),
      });

    const page = await executeTool({
      conversation_id: CURRENT_CONVERSATION_ID,
    });

    expect(page.events).toEqual([
      expect.objectContaining({
        data: {
          type: "unknown",
          originalType: "handoff",
          payload: {
            modelId: "future/model",
            replacement_history_count: 1,
          },
        },
      }),
    ]);
  });

  it("only exposes other public conversations in the same Slack workspace", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    const publicConversationId = "slack:C999:1700000000.200000";
    await recordSlackConversation({
      channelId: "C999",
      conversationId: publicConversationId,
      visibility: "public",
    });
    await getConversationEventStore().append(publicConversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "turn_started",
          turnId: "turn-1",
          inputMessageIds: ["m-1"],
          surface: "slack",
        },
      },
    ]);

    await expect(
      executeTool({
        conversation_id: publicConversationId,
        types: ["turn_started"],
      }),
    ).resolves.toMatchObject({
      events: [{ data: { type: "turn_started" } }],
    });

    const privateConversationId = "slack:D999:1700000000.300000";
    await recordSlackConversation({
      channelId: "D999",
      conversationId: privateConversationId,
      visibility: "private",
    });
    await expect(
      executeTool({ conversation_id: privateConversationId }),
    ).rejects.toThrow(
      `Conversation events are not accessible: ${privateConversationId}`,
    );
  });
});
