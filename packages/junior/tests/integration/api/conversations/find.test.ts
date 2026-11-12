import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { conversationFindSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation find API", () => {
  test("never gives the model a Conversation outside the viewer's feed", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      // Public, with a Brief that fits the description, but the viewer
      // never took part in it.
      const otherId = "slack:C123:other";
      await createSqlStore(fixture.sql).recordActivity({
        conversationId: otherId,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        nowMs: Date.now(),
        title: "Payments rollout",
        visibility: "public",
      });
      await appendConversationBrief(fixture.sql.db(), {
        content: conversationBriefFixture({
          summary: "The payments-v42 rollout waits on a rollback approval.",
        }),
        conversationId: otherId,
        modelId: "test-model",
        searchText: "payments rollback approval",
        throughSeq: 0,
        turnId: "turn-1",
      });
      const viewer = await resolveViewerUser("viewer@example.com");
      if (!viewer) throw new Error("missing viewer");
      const app = new Hono<JuniorApiEnv>();
      app.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      app.route("/", createJuniorApi());

      // The viewer's feed is empty, so no candidate goes to the model and
      // nothing comes back.
      const response = await app.request(
        "http://localhost/api/conversations/find",
        {
          body: JSON.stringify({
            description: "the payments rollout that needed a rollback approval",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(conversationFindSchema.parse(await response.json())).toEqual({
        matches: [],
      });
    } finally {
      await fixture.close();
    }
  });
});
