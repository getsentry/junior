import { describe, expect, it, vi } from "vitest";
import type { ConversationSearchScope } from "@/chat/conversations/search";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { createSqlConversationSearchStore } from "@/chat/conversations/sql/search";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createSlackConversationSearchTool } from "@/chat/slack/tools/conversation-search";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const scope: ConversationSearchScope = {
  kind: "public_provider_tenant",
  provider: "slack",
  providerTenantId: "T123",
};

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("searchConversationHistory", () => {
  it("searches the authorized public workspace and returns cross-channel permalinks", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const conversations = createSqlStore(fixture.sql);
      const messages = createSqlConversationMessageStore(fixture.sql);
      const search = createSqlConversationSearchStore(fixture.sql);
      await conversations.recordActivity({
        conversationId: "slack:CARCHIVE:1700000000.100000",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "CARCHIVE",
        },
        nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
        source: "slack",
        visibility: "public",
      });
      await messages.record("slack:CARCHIVE:1700000000.100000", [
        {
          messageId: "1700000000.100001",
          role: "user",
          text: "We decided the launch checklist needs a rollback owner.",
          createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
        },
      ]);
      const getPermalink = vi.fn(async () =>
        Promise.resolve(
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
        ),
      );
      const tool = createSlackConversationSearchTool(
        scope,
        "slack:CREQUEST:1700000000.900000",
        {
          store: search,
          getPermalink,
        },
      );

      const result = await executeTool(tool, {
        query: "launch checklist",
        limit: null,
      });

      expect(getPermalink).toHaveBeenCalledWith({
        channelId: "CARCHIVE",
        messageTs: "1700000000.100000",
      });
      expect(result).toEqual({
        ok: true,
        status: "success",
        query: "launch checklist",
        count: 1,
        threads: [
          {
            conversation_id: "slack:CARCHIVE:1700000000.100000",
            thread_ts: "1700000000.100000",
            message_id: "1700000000.100001",
            message_role: "user",
            message_timestamp: "2026-07-01T12:00:00.000Z",
            excerpt: expect.stringContaining("rollback owner"),
            permalink:
              "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  });
});
