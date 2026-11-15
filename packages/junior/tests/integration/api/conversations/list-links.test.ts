import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { purgeConversation } from "@/chat/conversations/retention";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API links", () => {
  test("lists the newest distinct links only where private content is visible", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const previousDashboard = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const publicId = "slack:C123:links";
      const privateId = "slack:D123:links";
      for (const [conversationId, channelId, visibility] of [
        [publicId, "C123", "public"],
        [privateId, "D123", "private"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          nowMs: Date.now(),
          destination: { platform: "slack", teamId: "T123", channelId },
          visibility,
        });
      }
      const messages: Array<[string, "user" | "assistant", string, boolean?]> =
        [
          [publicId, "user", "Start from https://old.example/one."],
          [
            publicId,
            "assistant",
            "Opened [the fix](https://github.com/getsentry/junior/pull/7). See https://example.com/a.",
          ],
          // A channel message that did not mention Junior stays out.
          [publicId, "user", "Lunch? https://ambient.example/menu", false],
          [
            publicId,
            "assistant",
            `Mail mailto:dev@example.com, read <https://example.com/b|the notes>, go back to https://junior.example.com/conversations/${encodeURIComponent(publicId)}, compare https://other.example.com/conversations/${encodeURIComponent(publicId)}, and see https://example.com/a again.`,
          ],
          [privateId, "assistant", "Secret plan: https://private.example/plan"],
        ];
      for (const [
        index,
        [conversationId, role, text, mention],
      ] of messages.entries()) {
        await getConversationEventStore().append(conversationId, [
          {
            createdAtMs: 1_000 + index,
            data: {
              messageId: `message-${index}`,
              role,
              text,
              type: "message",
              ...(mention === false
                ? { meta: { explicitMention: false } }
                : undefined),
            },
          },
        ]);
      }

      // The current dashboard does not ask, so it gets none and pays no
      // query for them.
      const plain = conversationFeedSchema.parse(
        await (
          await createJuniorApi().request("http://localhost/api/conversations")
        ).json(),
      );
      expect(plain.conversations.some((item) => item.links)).toBe(false);

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations?include=links",
      );
      expect(response.status).toBe(200);
      const conversations = new Map(
        conversationFeedSchema
          .parse(await response.json())
          .conversations.map((item) => [item.conversationId, item]),
      );

      // Newest message first, in text order within a message. Only a link
      // to this Conversation on this dashboard drops out.
      expect(conversations.get(publicId)?.links).toEqual([
        "https://example.com/b",
        `https://other.example.com/conversations/${encodeURIComponent(publicId)}`,
        "https://example.com/a",
      ]);
      expect(conversations.get(privateId)).toBeDefined();
      expect(conversations.get(privateId)?.links).toBeUndefined();

      // A transcript purge deletes where the messages use links, and marks
      // the links for attachment garbage collection.
      await purgeConversation(getSqlExecutor(), publicId);
      expect(
        await fixture.sql.query(
          `SELECT 1 FROM junior_message_attachments WHERE conversation_id = $1`,
          [publicId],
        ),
      ).toEqual([]);
      expect(
        await fixture.sql.query(
          `SELECT 1 FROM junior_attachments
           WHERE conversation_id = $1 AND delete_requested_at IS NULL`,
          [publicId],
        ),
      ).toEqual([]);
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
});
