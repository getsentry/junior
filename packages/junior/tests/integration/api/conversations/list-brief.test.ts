import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API Briefs", () => {
  test("shows the latest Brief only where private content is visible", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const briefedId = "slack:C123:briefed";
      const unbriefedId = "slack:C123:unbriefed";
      const privateId = "slack:D123:private";
      for (const [conversationId, channelId, visibility] of [
        [briefedId, "C123", "public"],
        [unbriefedId, "C123", "public"],
        [privateId, "D123", "private"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          nowMs: Date.now(),
          destination: { platform: "slack", teamId: "T123", channelId },
          visibility,
        });
      }
      for (const [conversationId, turnId, status, summary] of [
        [briefedId, "turn-1", "in_progress", "The rollout plan is a draft."],
        [briefedId, "turn-2", "blocked", "The rollout waits on approval."],
        [privateId, "turn-1", "done", "The private launch is done."],
      ] as const) {
        await appendConversationBrief(fixture.sql.db(), {
          conversationId,
          turnId,
          throughSeq: 0,
          content: conversationBriefFixture({ status, summary }),
          searchText: summary,
          modelId: "test-model",
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

      expect(conversations.get(briefedId)?.brief).toEqual({
        intent: "Complete the requested work.",
        status: "blocked",
        summary: "The rollout waits on approval.",
      });
      expect(conversations.get(unbriefedId)).toBeDefined();
      expect(conversations.get(unbriefedId)?.brief).toBeUndefined();
      expect(conversations.get(privateId)).toBeDefined();
      expect(conversations.get(privateId)?.brief).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
