import { readConversationDetail } from "@/api/conversations/detail";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { githubPlugin } from "@sentry/junior-github";
import type { User } from "@sentry/junior-plugin-api";
import { describe, expect, test, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { juniorConversationParticipants } from "@/db/schema";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import {
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  stubGitHubApp,
} from "../../../fixtures/github-objects";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { signedInViewer } from "../../../fixtures/user";
import { mswServer } from "../../../msw/server";

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
        title: "Daily check",
        url: null,
      });
      const feed = await readConversationFeedFromSql();
      expect(feed).toMatchObject({
        conversations: [
          expect.objectContaining({
            conversationId: publicId,
            sidebarAnnotations: [
              // No link to read, so the chip shows only the type.
              { objectType: "automation", key: "daily", label: "Automation" },
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
          // No link type reads the link, so its host is the label.
          label: "github.com",
          plugin: "github",
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
          subject: { id: "1200", kind: "pull_request" },
          title: "Retry flaky uploads",
          url: "https://github.com/getsentry/roach/pull/12",
        });
      }
      // GitHub renamed the repository later. The Annotations keep the old
      // key and link, and the code change records hold the new name.
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      await recordCodeChange(fixture.sql.db(), "github", {
        number: 12,
        openedAt: new Date(1_000),
        providerId: "1200",
        repository: { name: "getsentry/cockroach", providerId: "repo-roach" },
        state: "open",
        updatedAt: new Date(1_000),
      });

      const ids = async (q: string) =>
        (await readConversationFeedFromSql({ q })).conversations.map(
          (conversation) => conversation.conversationId,
        );
      await expect(ids("roach")).resolves.toEqual([publicId]);
      await expect(ids("getsentry/roach#12")).resolves.toEqual([publicId]);
      await expect(ids("FLAKY uploads")).resolves.toEqual([publicId]);
      await expect(ids("getsentry/cockroach#12")).resolves.toEqual([publicId]);
      await expect(
        ids("https://github.com/getsentry/cockroach/pull/12"),
      ).resolves.toEqual([publicId]);
      await expect(ids("getsentry/cockroach#13")).resolves.toEqual([]);
      await expect(ids("sentry/relay")).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("shows each row's objects as the viewer can read them now, with its child agents' objects", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/36`, () =>
        HttpResponse.json(
          pullRequest(36, {
            merged: true,
            state: "closed",
            title: "Retry flaky uploads",
          }),
        ),
      ),
      // What GitHub shows signed out.
      http.get(
        `${GITHUB_REPO}/pull/36`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const rootId = "slack:C123:live-chips";
    const childId = "agent:live-chips-child";
    try {
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      await linkGitHubMember();
      const alice = await signedInViewer("alice@example.com");
      const bob = await signedInViewer("bob@example.com");
      const store = getConversationStore();
      await store.recordActivity({
        conversationId: rootId,
        destination: { channelId: "C123", platform: "slack", teamId: "T123" },
        nowMs: Date.now(),
        source: "slack",
        title: "Fix the uploads",
        visibility: "public",
      });
      await getDb()
        .insert(juniorConversationParticipants)
        .values(
          [alice, bob].map((viewer) => ({
            lastMessageAt: new Date(),
            rootConversationId: rootId,
            userId: viewer.id,
          })),
        );
      // A child agent opened the pull request.
      await store.createChild({
        childConversationId: childId,
        kind: "task",
        parentConversationId: rootId,
      });
      await createPluginAnnotations({
        conversationId: childId,
        db: getDb(),
        plugin: "github",
      }).upsert({
        kind: "object",
        objectType: "code_change",
        key: "getsentry/junior#36",
        title: "Draft: retry uploads",
        url: `${GITHUB_REPO}/pull/36`,
      });

      const chips = async (viewer: User) =>
        (await readConversationFeedFromSql({ viewer })).conversations.find(
          (row) => row.conversationId === rootId,
        )?.sidebarAnnotations;
      await expect(chips(alice)).resolves.toEqual([
        {
          key: "getsentry/junior#36",
          label: "junior",
          objectType: "code_change",
          status: "merged",
          title: "Retry flaky uploads",
          url: `${GITHUB_REPO}/pull/36`,
        },
      ]);
      // A reader who cannot see the repository gets only the label.
      await expect(chips(bob)).resolves.toEqual([
        {
          key: "getsentry/junior#36",
          label: "junior",
          objectType: "code_change",
          url: `${GITHUB_REPO}/pull/36`,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      await closeDb();
    }
  });
});
