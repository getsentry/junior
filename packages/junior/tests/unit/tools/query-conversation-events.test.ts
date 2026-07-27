import { createSlackSource } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationEvent,
  ConversationEventPage,
  ConversationEventStore,
} from "@/chat/conversations/history";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import { planToolExposure } from "@/chat/tool-exposure";
import { createQueryConversationEventsTool } from "@/chat/tools/query-conversation-events";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    schemaVersion: 1,
    conversationId: "slack:C123:1700000000.100000",
    createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    lastActivityAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    updatedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    execution: { status: "idle" },
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    visibility: "public",
    source: "slack",
    ...overrides,
  };
}

function event(seq: number, type: ConversationEvent["data"]["type"] = "message"): ConversationEvent {
  if (type === "message") {
    return {
      schemaVersion: 1,
      seq,
      historyVersion: 0,
      createdAtMs: Date.parse("2026-07-01T12:00:00.000Z") + seq * 1000,
      data: {
        type: "message",
        messageId: `m-${seq}`,
        role: "user",
        text: `hello ${seq}`,
      },
    };
  }
  if (type === "handoff") {
    return {
      schemaVersion: 1,
      seq,
      historyVersion: 1,
      createdAtMs: Date.parse("2026-07-01T12:00:00.000Z") + seq * 1000,
      data: {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "gpt-test",
        replacementHistory: [
          {
            message: { role: "user" },
          },
        ],
      },
    };
  }
  return {
    schemaVersion: 1,
    seq,
    historyVersion: 0,
    createdAtMs: Date.parse("2026-07-01T12:00:00.000Z") + seq * 1000,
    data: {
      type: "turn_started",
      turnId: `turn-${seq}`,
      inputMessageIds: [`m-${seq}`],
      surface: "slack",
    },
  };
}

type SlackToolRuntimeContext = Extract<
  ToolRuntimeContext,
  { source: { platform: "slack" } }
>;

function context(
  overrides: Partial<SlackToolRuntimeContext> = {},
): SlackToolRuntimeContext {
  return {
    conversationId: "slack:C123:1700000000.100000",
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
    ...overrides,
  };
}

function stores(args: {
  conversations?: Record<string, Conversation>;
  page?: ConversationEventPage;
  query?: ConversationEventStore["query"];
}) {
  const conversations = args.conversations ?? {
    "slack:C123:1700000000.100000": conversation(),
  };
  const conversationStore = {
    get: vi.fn(async ({ conversationId }: { conversationId: string }) =>
      conversations[conversationId],
    ),
  } as unknown as ConversationStore;
  const eventStore = {
    query:
      args.query ??
      vi.fn(async () => args.page ?? { events: [event(0), event(1)], hasOlder: false, hasNewer: false }),
  } as unknown as ConversationEventStore;
  return { conversationStore, eventStore };
}

describe("queryConversationEvents", () => {
  it("is deferred under the conversation-events catalog source", () => {
    const tool = createQueryConversationEventsTool(context());
    const exposure = planToolExposure({ queryConversationEvents: tool });
    expect(tool.exposure).toBe("deferred");
    expect(tool.source).toEqual({
      id: "conversation-events",
      description: expect.stringContaining("conversation event log"),
    });
    expect(Object.keys(exposure.catalogTools)).toContain(
      "queryConversationEvents",
    );
    expect(Object.keys(exposure.directTools)).not.toContain(
      "queryConversationEvents",
    );
  });

  it("returns a bounded raw event page for the current conversation", async () => {
    const { conversationStore, eventStore } = stores({
      page: {
        events: [event(0), event(1, "turn_started")],
        hasOlder: false,
        hasNewer: true,
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await expect(
      tool.execute!(
        {
          conversation_id: "slack:C123:1700000000.100000",
          after_seq: null,
          before_seq: null,
          limit: null,
          types: null,
          include_replacement_history: null,
        },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      conversation_id: "slack:C123:1700000000.100000",
      count: 2,
      has_older: false,
      has_newer: true,
      include_replacement_history: false,
      events: [
        {
          seq: 0,
          data: { type: "message", text: "hello 0" },
        },
        {
          seq: 1,
          data: { type: "turn_started", turnId: "turn-1" },
        },
      ],
    });
    expect(eventStore.query).toHaveBeenCalledWith(
      "slack:C123:1700000000.100000",
      { limit: 25 },
    );
  });

  it("strips replacementHistory unless explicitly requested", async () => {
    const { conversationStore, eventStore } = stores({
      page: {
        events: [event(2, "handoff")],
        hasOlder: false,
        hasNewer: false,
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    const stripped = await tool.execute!(
      {
        conversation_id: "slack:C123:1700000000.100000",
        include_replacement_history: false,
      },
      {},
    );
    expect(stripped.events[0]).toMatchObject({
      seq: 2,
      data: {
        type: "handoff",
        replacement_history_omitted: true,
        replacement_history_count: 1,
      },
    });
    expect(stripped.events[0]).not.toMatchObject({
      data: { replacementHistory: expect.anything() },
    });

    const full = await tool.execute!(
      {
        conversation_id: "slack:C123:1700000000.100000",
        include_replacement_history: true,
      },
      {},
    );
    expect(full.events[0]).toMatchObject({
      data: {
        type: "handoff",
        replacementHistory: [{ message: { role: "user" } }],
      },
    });
  });

  it("allows the current conversation tree even when private", async () => {
    const currentId = "slack:D123:1700000000.100000";
    const childId = "advisor:child-1";
    const { conversationStore, eventStore } = stores({
      conversations: {
        [currentId]: conversation({
          conversationId: currentId,
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "D123",
          },
          visibility: "private",
        }),
        [childId]: conversation({
          conversationId: childId,
          lineage: { parentConversationId: currentId },
          visibility: "private",
        }),
      },
      page: {
        events: [event(0)],
        hasOlder: false,
        hasNewer: false,
      },
    });
    const tool = createQueryConversationEventsTool(
      context({
        conversationId: currentId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        source: createSlackSource({
          teamId: "T123",
          channelId: "D123",
          threadTs: "1700000000.100000",
          type: "priv",
        }),
      }),
      { conversationStore, eventStore },
    );

    await expect(
      tool.execute!({ conversation_id: childId }, {}),
    ).resolves.toMatchObject({
      ok: true,
      conversation_id: childId,
      count: 1,
    });
  });

  it("allows another public conversation in the same Slack workspace", async () => {
    const otherId = "slack:C999:1700000000.200000";
    const { conversationStore, eventStore } = stores({
      conversations: {
        "slack:C123:1700000000.100000": conversation(),
        [otherId]: conversation({
          conversationId: otherId,
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C999",
          },
          visibility: "public",
        }),
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await expect(
      tool.execute!({ conversation_id: otherId }, {}),
    ).resolves.toMatchObject({
      ok: true,
      conversation_id: otherId,
    });
  });

  it("rejects private conversations outside the current tree", async () => {
    const otherId = "slack:D999:1700000000.200000";
    const { conversationStore, eventStore } = stores({
      conversations: {
        "slack:C123:1700000000.100000": conversation(),
        [otherId]: conversation({
          conversationId: otherId,
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "D999",
          },
          visibility: "private",
        }),
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await expect(
      tool.execute!({ conversation_id: otherId }, {}),
    ).rejects.toThrow(`Conversation events are not accessible: ${otherId}`);
  });

  it("rejects public conversations from another Slack workspace", async () => {
    const otherId = "slack:C999:1700000000.200000";
    const { conversationStore, eventStore } = stores({
      conversations: {
        "slack:C123:1700000000.100000": conversation(),
        [otherId]: conversation({
          conversationId: otherId,
          destination: {
            platform: "slack",
            teamId: "TOTHER",
            channelId: "C999",
          },
          visibility: "public",
        }),
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await expect(
      tool.execute!({ conversation_id: otherId }, {}),
    ).rejects.toThrow(`Conversation events are not accessible: ${otherId}`);
  });

  it("rejects purged transcripts", async () => {
    const { conversationStore, eventStore } = stores({
      conversations: {
        "slack:C123:1700000000.100000": conversation({
          transcriptPurgedAtMs: Date.parse("2026-07-10T00:00:00.000Z"),
        }),
      },
    });
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await expect(
      tool.execute!(
        { conversation_id: "slack:C123:1700000000.100000" },
        {},
      ),
    ).rejects.toThrow("Conversation transcript was purged");
  });

  it("forwards type and seq bounds to the event store", async () => {
    const { conversationStore, eventStore } = stores({});
    const tool = createQueryConversationEventsTool(context(), {
      conversationStore,
      eventStore,
    });

    await tool.execute!(
      {
        conversation_id: "slack:C123:1700000000.100000",
        after_seq: 3,
        before_seq: 10,
        limit: 5,
        types: ["turn_started", "tool_execution_started"],
      },
      {},
    );

    expect(eventStore.query).toHaveBeenCalledWith(
      "slack:C123:1700000000.100000",
      {
        afterSeq: 3,
        beforeSeq: 10,
        limit: 5,
        types: ["turn_started", "tool_execution_started"],
      },
    );
  });
});
