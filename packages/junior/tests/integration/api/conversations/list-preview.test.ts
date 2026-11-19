import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { getConversationEventStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API activity preview", () => {
  test("cuts long messages without splitting a mention or a character", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const messages = {
        // The cut falls inside a word.
        "slack:C123:long": "words ".repeat(5_000),
        // The mention starts before the cut and ends after it.
        "slack:C123:mention": `${"a".repeat(390)}<@UPARTICIPANT1> rest`,
        // A `<` in prose is not a Slack token.
        "slack:C123:prose": `x < y ${"words ".repeat(100)}`,
        // The cut falls between the two halves of the emoji.
        "slack:C123:emoji": `${"b".repeat(398)}😀 rest`,
      };
      for (const [index, [conversationId, text]] of Object.entries(
        messages,
      ).entries()) {
        await store.recordActivity({
          conversationId,
          nowMs: Date.now(),
          destination: { platform: "slack", teamId: "T123", channelId: "C123" },
          visibility: "public",
        });
        await getConversationEventStore().append(conversationId, [
          {
            createdAtMs: 1_000 + index,
            data: {
              messageId: `message-${index}`,
              role: "assistant",
              text,
              type: "message",
            },
          },
        ]);
      }

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations",
      );
      expect(response.status).toBe(200);
      const previews = new Map(
        conversationFeedSchema
          .parse(await response.json())
          .conversations.map((item) => [
            item.conversationId,
            item.activityPreview,
          ]),
      );

      expect(previews.get("slack:C123:long")?.text).toBe(
        `${"words ".repeat(66).trimEnd()}…`,
      );
      expect(previews.get("slack:C123:mention")?.text).toBe(
        `${"a".repeat(390)}…`,
      );
      expect(previews.get("slack:C123:prose")?.text).toBe(
        `x < y ${"words ".repeat(65).trimEnd()}…`,
      );
      expect(previews.get("slack:C123:emoji")?.text).toBe(
        `${"b".repeat(398)}…`,
      );
    } finally {
      await fixture.close();
    }
  });
});
