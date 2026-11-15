import { describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import {
  collectAttachmentGarbage,
  readLiveAttachment,
  requestAttachmentDeletion,
  storeAttachment,
} from "@/chat/attachments/store";
import { matchSlackAttachments } from "@/chat/slack/attachments";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { urlAttachmentId } from "@/chat/conversations/message-links";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Workers from before `url` rows keep running while a deploy rolls out. They
// read `junior_attachments` with these same file filters, so a `url` row
// must never look like a file to them.
describe("url Attachments", () => {
  it("stay out of every file reader, and live until purge", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const conversationId = "slack:C123:1700000000.000100";
      const nowMs = Date.now();
      await createSqlStore(fixture.sql).recordActivity({
        conversationId,
        nowMs,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        visibility: "public",
      });
      const storage = createMemoryAttachmentStorage();
      const file = await storeAttachment({
        conversationId,
        db: getSqlExecutor(),
        file: {
          data: Buffer.from("chart"),
          filename: "chart.png",
          mimeType: "image/png",
        },
        nowMs,
        storage,
      });
      await getConversationEventStore().append(conversationId, [
        {
          createdAtMs: nowMs,
          data: {
            messageId: "message-1",
            role: "user",
            text: "See https://example.com/plan.",
            type: "message",
          },
        },
      ]);
      const urlId = urlAttachmentId(conversationId, "https://example.com/plan");
      const urlRows = () =>
        fixture.sql.query(
          `SELECT id FROM junior_attachments WHERE kind = 'url' AND conversation_id = $1`,
          [conversationId],
        );
      const uses = () =>
        fixture.sql.query(
          `SELECT attachment_id FROM junior_message_attachments WHERE conversation_id = $1`,
          [conversationId],
        );
      expect(await urlRows()).toEqual([{ id: urlId }]);

      // The attachment route reads a file by id.
      expect(
        await readLiveAttachment({
          attachmentId: urlId,
          conversationId,
          db: getSqlExecutor(),
        }),
      ).toBeNull();
      // Slack matches files by their Slack file id.
      expect(
        await matchSlackAttachments({
          conversationId,
          db: getSqlExecutor(),
          providerIds: ["F1"],
        }),
      ).toEqual([]);
      const feed = conversationFeedSchema.parse(
        await (
          await createJuniorApi().request(
            "http://localhost/api/conversations?include=links,media",
          )
        ).json(),
      );
      expect(feed.conversations).toMatchObject([
        {
          conversationId,
          links: ["https://example.com/plan"],
          media: [
            { contentType: "image/png", filename: "chart.png", id: file.id },
          ],
        },
      ]);

      // Files expire after 30 days. A link has no bytes, so it stays with
      // its message.
      const later = nowMs + 31 * DAY_MS;
      await collectAttachmentGarbage({
        db: getSqlExecutor(),
        nowMs: later,
        storage,
      });
      expect(storage.objects.size).toBe(0);
      expect(await urlRows()).toEqual([{ id: urlId }]);

      // A purge by a worker from before `url` rows only marks the row. The
      // next collection deletes the row and where messages use it.
      await requestAttachmentDeletion(
        getSqlExecutor(),
        [conversationId],
        later,
      );
      expect(await uses()).toEqual([{ attachment_id: urlId }]);
      await collectAttachmentGarbage({
        db: getSqlExecutor(),
        nowMs: later,
        storage,
      });
      expect(await urlRows()).toEqual([]);
      expect(await uses()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
