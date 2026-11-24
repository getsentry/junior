import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { CONTENT_VERSION_HEADER, conversationFeedSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { storeConversationMetadataFixture } from "../../../fixtures/conversation-metadata";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list API page versions", () => {
  test("answers an unchanged page with 304 and no body", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const conversationId = "slack:C123:versioned";
      await createSqlStore(fixture.sql).recordActivity({
        conversationId,
        nowMs: Date.now(),
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        visibility: "public",
      });
      const app = createJuniorApi();
      const read = (search: string, version?: string) =>
        app.request(`http://localhost/api/conversations${search}`, {
          headers: version ? { [CONTENT_VERSION_HEADER]: version } : {},
        });

      const first = await read("");
      const version = first.headers.get(CONTENT_VERSION_HEADER)!;
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      expect(
        conversationFeedSchema.parse(await first.json()).conversations,
      ).toEqual([expect.objectContaining({ conversationId })]);

      const unchanged = await read("", version);
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get(CONTENT_VERSION_HEADER)).toBe(version);
      expect(unchanged.headers.get("cache-control")).toBe("private, no-store");

      // Another query is another page, with its own version.
      const archived = await read("?status=archived", version);
      expect(archived.status).toBe(200);
      expect(
        conversationFeedSchema.parse(await archived.json()).conversations,
      ).toEqual([]);

      await storeConversationMetadataFixture(fixture.sql.db(), {
        conversationId,
        summary: "The plan changed.",
      });
      const changed = await read("", version);
      expect(changed.status).toBe(200);
      expect(changed.headers.get(CONTENT_VERSION_HEADER)).not.toBe(version);
      expect(
        conversationFeedSchema.parse(await changed.json()).conversations,
      ).toEqual([
        expect.objectContaining({
          conversationId,
          summary: "The plan changed.",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
