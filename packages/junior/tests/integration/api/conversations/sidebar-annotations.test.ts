import { readConversationDetail } from "@/api/conversations/detail";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, test } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setPlugins } from "@/chat/plugins/hooks/registry";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("conversation list sidebar annotations", () => {
  test("shows resource links as chips on viewable feed conversations", async () => {
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

      await createPluginAnnotations({
        conversationId: publicId,
        plugin: "junior",
        db: fixture.sql.db(),
      }).upsert({
        kind: "object",
        objectType: "automation",
        key: "daily",
        label: "Daily check",
        title: "Daily check",
        status: "blocked",
        url: null,
      });
      const feed = await readConversationFeedFromSql();
      expect(feed).toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: publicId,
            sidebarAnnotations: [
              {
                objectType: "automation",
                key: "daily",
                label: "Daily check",
                status: "blocked",
              },
              { icon: "circle-dot", key: "github", label: "junior" },
            ],
          }),
          expect.objectContaining({ conversationId: privateId }),
        ],
      });
      // Feed rows send only the chips. The detail sends the full annotations.
      for (const row of feed.conversations) {
        expect(row).not.toHaveProperty("annotations");
      }
      const detail = await readConversationDetail(publicId);
      expect(detail?.sidebarAnnotations).toEqual(
        feed.conversations.find((item) => item.conversationId === publicId)
          ?.sidebarAnnotations,
      );
      expect(detail?.annotations).toEqual([
        expect.objectContaining({
          objectType: "automation",
          key: "daily",
        }),
        expect.objectContaining({
          key: "getsentry/junior#1081",
          kind: "resource_link",
          label: "getsentry/junior#1081",
          plugin: "github",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        }),
      ]);
      expect(
        (await readConversationDetail(privateId))?.sidebarAnnotations,
      ).toBeUndefined();
    } finally {
      setPlugins([]);
      await fixture.close();
    }
  });

  test("search matches Annotations in the tree that the reader can see", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const publicId = "slack:C123:roach-public";
    const childId = "agent:roach-child";
    const privateId = "slack:D123:roach-private";

    try {
      await migrateSchema(fixture.sql);
      for (const [conversationId, visibility] of [
        [publicId, "public"],
        [privateId, "private"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          destination: {
            channelId: visibility === "public" ? "C123" : "D123",
            platform: "slack",
            teamId: "T123",
          },
          nowMs: 1_000,
          source: "slack",
          title: "Tidy up the release",
          visibility,
        });
      }
      // A child agent opens the pull request, so its root must match.
      await store.createChild({
        childConversationId: childId,
        kind: "task",
        parentConversationId: publicId,
      });
      for (const conversationId of [childId, privateId]) {
        await createPluginAnnotations({
          conversationId,
          db: fixture.sql.db(),
          plugin: "github",
        }).upsert({
          kind: "object",
          objectType: "code_change",
          key: "getsentry/roach#12",
          label: "getsentry/roach#12",
          title: "Retry flaky uploads",
          status: "open",
          url: "https://github.com/getsentry/roach/pull/12",
        });
      }

      const ids = async (q: string) =>
        (await readConversationFeedFromSql({ q })).conversations.map(
          (conversation) => conversation.conversationId,
        );
      await expect(ids("roach")).resolves.toEqual([publicId]);
      await expect(ids("FLAKY uploads")).resolves.toEqual([publicId]);
      await expect(ids("sentry/relay")).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
