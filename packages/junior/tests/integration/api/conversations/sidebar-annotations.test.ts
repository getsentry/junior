import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, test } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list sidebar annotations", () => {
  test("includes resource links on viewable feed conversations", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const publicId = "slack:C123:annotated-public";
    const privateId = "slack:D123:annotated-private";

    try {
      setPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "github",
            displayName: "GitHub",
            description: "GitHub sidebar test plugin",
          },
          hooks: {
            conversationSidebar(ctx) {
              return {
                annotationsByConversationId: Object.fromEntries(
                  Object.keys(ctx.annotationsByConversationId).map(
                    (conversationId) => [
                      conversationId,
                      [{ icon: "circle-dot", key: "github", label: "junior" }],
                    ],
                  ),
                ),
              };
            },
          },
        }),
      ]);
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: publicId,
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: 2_000,
        source: "slack",
        title: "Public annotated conversation",
        visibility: "public",
      });
      await store.recordActivity({
        conversationId: privateId,
        destination: {
          channelId: "D123",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: 1_000,
        source: "slack",
        title: "Private annotated conversation",
        visibility: "private",
      });
      for (const conversationId of [publicId, privateId]) {
        const annotations = createPluginAnnotations({
          conversationId,
          db: fixture.sql.db(),
          plugin: "github",
        });
        await annotations.upsert({
          kind: "resource_link",
          key: "getsentry/junior#1081",
          label: "getsentry/junior#1081",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        });
      }

      const feed = await readConversationFeedFromSql();
      expect(feed).toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: publicId,
            sidebarAnnotations: [
              { icon: "circle-dot", key: "github", label: "junior" },
            ],
            annotations: [
              expect.objectContaining({
                key: "getsentry/junior#1081",
                kind: "resource_link",
                label: "getsentry/junior#1081",
                plugin: "github",
                status: "open",
                url: "https://github.com/getsentry/junior/pull/1081",
              }),
            ],
          }),
          expect.objectContaining({ conversationId: privateId }),
        ],
      });
      expect(
        feed.conversations.find((item) => item.conversationId === privateId),
      ).not.toHaveProperty("annotations");
    } finally {
      setPlugins([]);
      await fixture.close();
    }
  });
});
