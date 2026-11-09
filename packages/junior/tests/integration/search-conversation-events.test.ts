import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
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
    source: { kind: "scheduled_automation" },
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

/** Tool context of a Turn in a web Conversation. */
function webContext(conversationId: string): ToolRuntimeContext {
  return {
    conversationId,
    destination: { platform: "local", conversationId },
    source: createWebSource(conversationId),
    egress: context().egress,
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

async function executeTool(
  input: Record<string, unknown>,
  toolContext: ToolRuntimeContext = context(),
) {
  const tool = createSearchConversationEventsTool(toolContext);
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
        type: "compaction",
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
      events: [
        { seq: 1, data: { type: "message", text: "second" } },
        {
          seq: 2,
          data: {
            type: "compaction",
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
            type: "compaction",
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
            type: "compaction",
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
        schemaVersion: 99,
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

  it("exposes public conversations of every surface and isolates private ones", async () => {
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
    const otherWorkspaceConversationId = "slack:C888:1700000000.250000";
    await recordSlackConversation({
      channelId: "C888",
      conversationId: otherWorkspaceConversationId,
      teamId: "T999",
      visibility: "public",
    });
    const webActor = webActorFromUser({
      displayName: "Ana",
      email: "ana@example.com",
      id: "user-ana",
    });
    const publicWebConversationId = "local:web:public-events";
    const privateWebConversationId = "local:web:private-events";
    await recordWebConversationActivity({
      actor: webActor,
      conversationId: publicWebConversationId,
      nowMs: 1,
      rootVisibility: "public",
    });
    await recordWebConversationActivity({
      actor: webActor,
      conversationId: privateWebConversationId,
      nowMs: 1,
      rootVisibility: "private",
    });
    const turnStarted = [
      {
        createdAtMs: 1,
        data: {
          type: "turn_started" as const,
          turnId: "turn-1",
          inputMessageIds: ["m-1"],
          surface: "slack" as const,
        },
      },
    ];
    for (const conversationId of [
      CURRENT_CONVERSATION_ID,
      publicConversationId,
      otherWorkspaceConversationId,
      publicWebConversationId,
    ]) {
      await getConversationEventStore().append(conversationId, turnStarted);
    }

    // Public is public: a Slack requester reads public Slack Conversations
    // of any workspace and public web Conversations.
    for (const conversationId of [
      publicConversationId,
      otherWorkspaceConversationId,
      publicWebConversationId,
    ]) {
      await expect(
        executeTool({
          conversation_id: conversationId,
          types: ["turn_started"],
        }),
      ).resolves.toMatchObject({
        events: [{ data: { type: "turn_started" } }],
      });
    }
    // A web requester reads public Slack Conversations.
    await expect(
      executeTool(
        { conversation_id: CURRENT_CONVERSATION_ID, types: ["turn_started"] },
        webContext(publicWebConversationId),
      ),
    ).resolves.toMatchObject({
      events: [{ data: { type: "turn_started" } }],
    });

    const privateConversationId = "slack:D999:1700000000.300000";
    await recordSlackConversation({
      channelId: "D999",
      conversationId: privateConversationId,
      visibility: "private",
    });
    // A private Conversation stays isolated from every other surface.
    await expect(
      executeTool({ conversation_id: privateConversationId }),
    ).rejects.toThrow(
      `Conversation events are not accessible: ${privateConversationId}`,
    );
    await expect(
      executeTool({ conversation_id: privateWebConversationId }),
    ).rejects.toThrow(
      `Conversation events are not accessible: ${privateWebConversationId}`,
    );
    await expect(
      executeTool(
        { conversation_id: privateConversationId },
        webContext(publicWebConversationId),
      ),
    ).rejects.toThrow(
      `Conversation events are not accessible: ${privateConversationId}`,
    );
    // Another Conversation in the same private channel or DM has the same
    // audience, so it reads the private Conversation.
    const privateNeighborId = "slack:D999:1700000000.350000";
    await recordSlackConversation({
      channelId: "D999",
      conversationId: privateNeighborId,
      visibility: "private",
    });
    await getConversationEventStore().append(
      privateConversationId,
      turnStarted,
    );
    await expect(
      executeTool(
        { conversation_id: privateConversationId, types: ["turn_started"] },
        { ...context(), conversationId: privateNeighborId },
      ),
    ).resolves.toMatchObject({
      events: [{ data: { type: "turn_started" } }],
    });
    // A missing Conversation gets the same error as a private one.
    const missingConversationId = "slack:C404:1700000000.400000";
    await expect(
      executeTool({ conversation_id: missingConversationId }),
    ).rejects.toThrow(
      `Conversation events are not accessible: ${missingConversationId}`,
    );
  });
});
