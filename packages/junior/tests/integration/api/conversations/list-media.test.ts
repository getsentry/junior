import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationFeedSchema } from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorAttachments } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API media", () => {
  test("lists the newest live files only where private content is visible", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const storage = createMemoryAttachmentStorage();
      const publicId = "slack:C123:media";
      const privateId = "slack:D123:media";
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
      const stored = [];
      for (const [index, filename] of [
        "first.png",
        "second.txt",
        "third.png",
        "fourth.png",
        "purged.png",
      ].entries()) {
        stored.push(
          await storeAttachment({
            conversationId: publicId,
            db: fixture.sql,
            file: {
              data: Buffer.from(filename),
              filename,
              mimeType: filename.endsWith(".png") ? "image/png" : "text/plain",
            },
            nowMs: 1_000 + index,
            storage,
          }),
        );
      }
      await fixture.sql
        .db()
        .update(juniorAttachments)
        .set({ deleteRequestedAt: new Date(2_000) })
        .where(eq(juniorAttachments.id, stored[4]!.id));
      await storeAttachment({
        conversationId: privateId,
        db: fixture.sql,
        file: {
          data: Buffer.from("secret"),
          filename: "secret.png",
          mimeType: "image/png",
        },
        storage,
      });

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations",
      );
      expect(response.status).toBe(200);
      const conversations = new Map(
        conversationFeedSchema
          .parse(await response.json())
          .conversations.map((item) => [item.conversationId, item]),
      );

      expect(conversations.get(publicId)?.media).toEqual([
        { contentType: "image/png", filename: "fourth.png", id: stored[3]!.id },
        { contentType: "image/png", filename: "third.png", id: stored[2]!.id },
        {
          contentType: "text/plain",
          filename: "second.txt",
          id: stored[1]!.id,
        },
      ]);
      expect(conversations.get(privateId)).toBeDefined();
      expect(conversations.get(privateId)?.media).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
