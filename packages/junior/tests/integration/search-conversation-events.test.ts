import { turnBehavior } from "@/chat/conversations/kind-behavior";
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
import type { ConversationEmbedder } from "@/chat/conversations/embedding";
import {
  embedConversationEvents,
  type ConversationEventEmbedder,
} from "@/chat/conversations/event-embedding";
import { storeConversationEventLexemes } from "@/chat/conversations/event-lexemes";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { juniorConversationEvents } from "@/db/schema";

const rootTurnTools = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

const CURRENT_CONVERSATION_ID = "slack:C123:1700000000.100000";

function context(): ToolRuntimeContext {
  return {
    turnTools: rootTurnTools,
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
    turnTools: rootTurnTools,
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
  options: { embedder?: ConversationEmbedder } = {},
) {
  const tool = createSearchConversationEventsTool(toolContext, options);
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

// The fake embedding model puts text about one topic on one axis, so a query
// matches an event by meaning without a shared word.
const TOPICS = [/pull request|getsentry\/junior#\d+/i, /lease/i];
function topicVector(text: string): number[] {
  return [...TOPICS.map((topic) => (topic.test(text) ? 1 : 0)), 0.01];
}
const eventEmbedder: ConversationEventEmbedder = {
  model: "test-embedding",
  async embedDocuments(texts) {
    return {
      model: "test-embedding",
      provider: "test",
      vectors: texts.map(topicVector),
    };
  },
};
const queryEmbedder: ConversationEmbedder = async ({ text }) => ({
  model: "test-embedding",
  provider: "test",
  vector: topicVector(text),
});

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

  it("finds history that compaction replaced by words and by meaning", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    const events = getConversationEventStore();
    const filler = "worker 3 ok\n".repeat(2_000);
    await events.append(CURRENT_CONVERSATION_ID, [
      {
        createdAtMs: 1,
        data: {
          type: "user_message",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>dashboard skills</runtime-turn-context>",
            },
            // Text cut inside an emoji keeps half of its surrogate pair,
            // which Postgres jsonb rejects.
            {
              type: "text",
              text: `Why does the queue test fail? ${"\u{1F600}".slice(0, 1)}`,
            },
          ],
          timestamp: 1,
          provenance: { authority: "instruction" },
        },
      },
      {
        createdAtMs: 2,
        data: {
          type: "assistant_message",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "cat logs/ci-7421.log", attempt: 7733 },
            },
          ],
          timestamp: 2,
        },
      },
      {
        createdAtMs: 3,
        data: {
          type: "tool_result",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [
            {
              type: "text",
              text: `${filler}lease token mismatch at packages/junior/src/chat/queue/lease.ts:42\n${filler}`,
            },
          ],
          timestamp: 3,
        },
      },
      {
        createdAtMs: 4,
        data: {
          type: "message",
          messageId: "m-fix",
          role: "assistant",
          text: "Opened getsentry/junior#4821 with the fix.",
        },
      },
    ]);
    await events.replaceHistory(CURRENT_CONVERSATION_ID, {
      createdAtMs: 5,
      data: {
        type: "compaction",
        modelId: "test/model",
        replacementHistory: [],
      },
    });

    // A file name matches inside a path, and the excerpt shows the line.
    const byPath = await executeTool({ query: "lease.ts" });
    expect(byPath.events[0]).toMatchObject({
      seq: 2,
      data: { type: "tool_result", payload_omitted: true },
      excerpt: expect.stringContaining(
        "lease token mismatch at packages/junior/src/chat/queue/lease.ts:42",
      ),
    });
    expect(byPath).not.toHaveProperty("has_older");
    await expect(executeTool({ query: "ci-7421.log" })).resolves.toMatchObject({
      events: [{ seq: 1, data: { type: "assistant_message" } }],
    });
    // A number inside a file name matches on its own.
    await expect(executeTool({ query: "7421" })).resolves.toMatchObject({
      events: [{ seq: 1, data: { type: "assistant_message" } }],
    });
    await expect(executeTool({ query: "7733" })).resolves.toMatchObject({
      events: [{ seq: 1, data: { type: "assistant_message" } }],
    });
    await expect(executeTool({ query: "4821" })).resolves.toMatchObject({
      events: [
        { seq: 3, excerpt: "Opened getsentry/junior#4821 with the fix." },
      ],
    });
    // Runtime context is not searchable text.
    await expect(executeTool({ query: "dashboard" })).resolves.toMatchObject({
      events: [],
    });
    await expect(
      executeTool({ query: "lease.ts", types: ["message"] }),
    ).resolves.toMatchObject({ events: [] });

    // Without vectors, a query with no shared word finds nothing.
    await expect(
      executeTool({ query: "pull request" }, context(), {
        embedder: queryEmbedder,
      }),
    ).resolves.toMatchObject({ events: [] });
    await expect(
      embedConversationEvents(getDb(), eventEmbedder, CURRENT_CONVERSATION_ID),
    ).resolves.toBe(4);
    await expect(
      embedConversationEvents(getDb(), eventEmbedder, CURRENT_CONVERSATION_ID),
    ).resolves.toBe(0);
    const byMeaning = await executeTool({ query: "pull request" }, context(), {
      embedder: queryEmbedder,
    });
    expect(byMeaning.events[0]).toMatchObject({ seq: 3 });

    // Stored lexemes give the same matches. Newer events without stored
    // lexemes stay searchable, and an event without text gets empty ones.
    await expect(
      storeConversationEventLexemes(getDb(), CURRENT_CONVERSATION_ID),
    ).resolves.toBe(4);
    await expect(
      storeConversationEventLexemes(getDb(), CURRENT_CONVERSATION_ID),
    ).resolves.toBe(0);
    await events.append(CURRENT_CONVERSATION_ID, [
      {
        createdAtMs: 6,
        data: {
          type: "user_message",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>queue</runtime-turn-context>",
            },
          ],
          timestamp: 6,
          provenance: { authority: "instruction" },
        },
      },
      {
        createdAtMs: 7,
        data: {
          type: "message",
          messageId: "m-retry",
          role: "assistant",
          text: "Retried the lease fix in getsentry/junior#4822.",
        },
      },
    ]);
    await expect(executeTool({ query: "lease.ts" })).resolves.toMatchObject({
      events: [{ seq: 2 }],
    });
    await expect(executeTool({ query: "dashboard" })).resolves.toMatchObject({
      events: [],
    });
    await expect(executeTool({ query: "4822" })).resolves.toMatchObject({
      events: [{ seq: 6 }],
    });
    await expect(
      storeConversationEventLexemes(getDb(), CURRENT_CONVERSATION_ID),
    ).resolves.toBe(2);
    await expect(executeTool({ query: "4822" })).resolves.toMatchObject({
      events: [{ seq: 6 }],
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
      executeTool({ conversation_id: privateWebConversationId, query: "x" }),
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
