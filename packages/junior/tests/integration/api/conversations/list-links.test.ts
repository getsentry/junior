import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { getConversationEventStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API links", () => {
  test("lists the newest distinct links only where private content is visible", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
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
            `Mail mailto:dev@example.com, read <https://example.com/b|the notes>, go back to https://junior.example.com/conversations/${encodeURIComponent(publicId)}, and see https://example.com/a again.`,
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

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations",
      );
      expect(response.status).toBe(200);
      const conversations = new Map(
        conversationFeedSchema
          .parse(await response.json())
          .conversations.map((item) => [item.conversationId, item]),
      );

      // Newest message first, in text order within a message.
      expect(conversations.get(publicId)?.links).toEqual([
        "https://example.com/b",
        "https://example.com/a",
        "https://github.com/getsentry/junior/pull/7",
      ]);
      expect(conversations.get(privateId)).toBeDefined();
      expect(conversations.get(privateId)?.links).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
