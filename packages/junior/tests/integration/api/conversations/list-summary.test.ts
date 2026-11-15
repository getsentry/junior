import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { storeConversationMetadataFixture } from "../../../fixtures/conversation-metadata";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API summaries", () => {
  test("shows the latest summary only where private content is visible", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const summarizedId = "slack:C123:summarized";
      const unsummarizedId = "slack:C123:unsummarized";
      const privateId = "slack:D123:private";
      for (const [conversationId, channelId, visibility] of [
        [summarizedId, "C123", "public"],
        [unsummarizedId, "C123", "public"],
        [privateId, "D123", "private"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          nowMs: Date.now(),
          destination: { platform: "slack", teamId: "T123", channelId },
          visibility,
        });
      }
      for (const [conversationId, throughSeq, outcomeStatus, summary] of [
        [summarizedId, 1, "in_progress", "The rollout plan is a draft."],
        [summarizedId, 2, "blocked", "The rollout waits on approval."],
        [privateId, 1, "done", "The private launch is done."],
      ] as const) {
        await storeConversationMetadataFixture(fixture.sql.db(), {
          conversationId,
          outcomeStatus,
          summary,
          throughSeq,
        });
      }

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations",
      );
      expect(response.status).toBe(200);
      const conversations = new Map(
        conversationFeedSchema
          .parse(await response.json())
          .conversations.map((item) => [item.conversationId, item]),
      );

      expect(conversations.get(summarizedId)).toMatchObject({
        outcomeStatus: "blocked",
        summary: "The rollout waits on approval.",
      });
      expect(conversations.get(unsummarizedId)).toBeDefined();
      expect(conversations.get(unsummarizedId)?.summary).toBeUndefined();
      expect(conversations.get(privateId)).toBeDefined();
      expect(conversations.get(privateId)?.summary).toBeUndefined();
      expect(conversations.get(privateId)?.outcomeStatus).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
