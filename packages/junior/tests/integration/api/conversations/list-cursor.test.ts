import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { pinConversation } from "@/api/conversations/pin";
import { apiErrorSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API cursor", () => {
  test("pages the feed in order, with pins first on every page", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      for (const [conversationId, nowMs] of [
        ["slack:C1:newest", 3_000],
        ["slack:C1:middle", 2_000],
        ["slack:C1:oldest", 1_000],
      ] as const) {
        await store.recordActivity({
          actor: {
            email: "morgan@example.com",
            platform: "slack",
            slackUserId: "U1",
            teamId: "T1",
          },
          conversationId,
          destination: { platform: "slack", teamId: "T1", channelId: "C1" },
          nowMs,
          source: "slack",
        });
      }
      const viewer = await resolveViewerUser("morgan@example.com");
      expect(viewer).toBeDefined();
      const ids = (feed: { conversations: { conversationId: string }[] }) =>
        feed.conversations.map(({ conversationId }) => conversationId);

      // A full page ends with a cursor; the next page starts after it.
      const first = await readConversationFeedFromSql({ limit: 2, viewer });
      expect(ids(first)).toEqual(["slack:C1:newest", "slack:C1:middle"]);
      const second = await readConversationFeedFromSql({
        cursor: first.nextCursor,
        limit: 2,
        viewer,
      });
      expect(ids(second)).toEqual(["slack:C1:oldest"]);
      expect(second.nextCursor).toBeUndefined();

      // A pinned old row leads page one, and page two goes on with the
      // unpinned rows after the cursor.
      await pinConversation(viewer!, "slack:C1:oldest", { pinned: true });
      const pinnedFirst = await readConversationFeedFromSql({
        limit: 2,
        viewer,
      });
      expect(ids(pinnedFirst)).toEqual(["slack:C1:oldest", "slack:C1:newest"]);
      expect(
        ids(
          await readConversationFeedFromSql({
            cursor: pinnedFirst.nextCursor,
            limit: 2,
            viewer,
          }),
        ),
      ).toEqual(["slack:C1:middle"]);

      const badCursor = await createJuniorApi().request(
        "http://localhost/api/conversations?cursor=not-a-cursor",
      );
      expect(badCursor.status).toBe(400);
      expect(apiErrorSchema.parse(await badCursor.json())).toEqual({
        error: "Invalid cursor.",
      });
    } finally {
      await fixture.close();
    }
  });
});
