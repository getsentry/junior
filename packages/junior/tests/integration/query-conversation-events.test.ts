import { createSlackSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { createQueryConversationEventsTool } from "@/chat/tools/query-conversation-events";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { juniorConversationEvents } from "@/db/schema";

const CURRENT_CONVERSATION_ID = "slack:C123:1700000000.100000";

type SlackToolRuntimeContext = Extract<
  ToolRuntimeContext,
  { source: { platform: "slack" } }
>;

function context(): SlackToolRuntimeContext {
  return {
    conversationId: CURRENT_CONVERSATION_ID,
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    source: createSlackSource({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.100000",
      type: "pub",
    }),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

async function executeTool(input: Record<string, unknown>) {
  const tool = createQueryConversationEventsTool(context());
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

describe("queryConversationEvents", () => {
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
      ok: true,
      status: "success",
      conversation_id: CURRENT_CONVERSATION_ID,
      has_older: true,
      has_newer: false,
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
