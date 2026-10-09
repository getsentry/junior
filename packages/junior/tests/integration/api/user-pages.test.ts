import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  defineJuniorPlugin,
  pluginUserPageContentSchema,
  pluginUserPageLinksSchema,
} from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import type { JuniorApiEnv } from "@/api/route";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

function plugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term memory storage and recall.",
    },
    userPages: [
      {
        id: "memories",
        label: "Memories",
        description: "Personal facts Junior remembers about you.",
        read(ctx) {
          return {
            type: "list" as const,
            emptyText: "No personal memories yet.",
            records: ctx.viewer.identities.map((identity) => ({
              id: `${identity.provider}:${identity.providerSubjectId}`,
              title: ctx.viewer.email,
            })),
          };
        },
      },
      {
        id: "storage",
        label: "Memory storage",
        description: "Admin-only storage setup.",
        navigation: "admin",
        read() {
          return {
            type: "list" as const,
            records: [
              {
                id: "storage",
                title: "Memory storage",
                actions: [
                  {
                    href: "/api/plugins/memory/storage/connect",
                    label: "Connect",
                    method: "GET" as const,
                  },
                ],
              },
            ],
          };
        },
      },
    ],
  });
}

function authenticatedApi(email: string) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) {
      throw new Error(`missing viewer for ${email}`);
    }
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("plugin user page API", () => {
  afterEach(() => setPlugins([]));

  test("discovers registered pages without exposing their reader", async () => {
    setPlugins([plugin()]);

    const response = await createJuniorApi().request(
      "http://localhost/api/user-pages",
    );

    expect(response.status).toBe(200);
    expect(pluginUserPageLinksSchema.parse(await response.json())).toEqual([
      {
        description: "Personal facts Junior remembers about you.",
        id: "memories",
        label: "Memories",
        navigation: "profile",
        pluginDisplayName: "Memory",
        pluginName: "memory",
      },
    ]);
  });

  test("requires an authenticated viewer to read a page", async () => {
    setPlugins([plugin()]);

    const response = await createJuniorApi().request(
      "http://localhost/api/user-pages/memory/memories",
    );

    expect(response.status).toBe(401);
  });

  test("passes validated search and pagination state to the page reader", async () => {
    let receivedInput: unknown;
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Long-term memory storage and recall.",
        },
        userPages: [
          {
            id: "memories",
            label: "Memories",
            description: "Personal facts Junior remembers about you.",
            read(_ctx, input) {
              receivedInput = input;
              return {
                type: "list",
                records: [],
              };
            },
          },
        ],
      }),
    ]);

    const response = await authenticatedApi("viewer@example.com").request(
      "http://localhost/api/user-pages/memory/memories?q=runbooks&filter=preferences&cursor=next-page&limit=12",
    );

    expect(response.status).toBe(200);
    expect(receivedInput).toEqual({
      cursor: "next-page",
      filter: "preferences",
      limit: 12,
      query: "runbooks",
    });

    const emptyLimit = await authenticatedApi("viewer@example.com").request(
      "http://localhost/api/user-pages/memory/memories?limit=",
    );
    expect(emptyLimit.status).toBe(200);
    expect(receivedInput).toEqual({ limit: 20 });

    const invalid = await authenticatedApi("viewer@example.com").request(
      "http://localhost/api/user-pages/memory/memories?limit=500",
    );
    expect(invalid.status).toBe(400);
  });

  test("passes only identities linked to the authenticated viewer", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C123:user-page",
        actor: {
          email: "viewer@example.com",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        title: "Viewer conversation",
        visibility: "public",
      });
      await store.recordActivity({
        conversationId: "slack:C123:other-user-page",
        actor: {
          email: "other@example.com",
          platform: "slack",
          slackUserId: "U999",
          teamId: "T123",
        },
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        title: "Other viewer conversation",
        visibility: "public",
      });
      setPlugins([plugin()]);

      const response = await authenticatedApi("VIEWER@example.com").request(
        "http://localhost/api/user-pages/memory/memories",
      );

      expect(response.status).toBe(200);
      expect(pluginUserPageContentSchema.parse(await response.json())).toEqual({
        type: "list",
        emptyText: "No personal memories yet.",
        records: [
          {
            id: "slack:U123",
            title: "viewer@example.com",
          },
        ],
      });

      // Admin pages stay hidden and unreadable until the viewer is an admin.
      const adminPageUrl = "http://localhost/api/user-pages/memory/storage";
      const hidden = await authenticatedApi("viewer@example.com").request(
        "http://localhost/api/user-pages",
      );
      expect(
        pluginUserPageLinksSchema
          .parse(await hidden.json())
          .map((page) => page.id),
      ).toEqual(["memories"]);
      expect(
        (await authenticatedApi("viewer@example.com").request(adminPageUrl))
          .status,
      ).toBe(404);

      await setUserAdminFromSql(getDb(), "viewer@example.com", true);
      const listed = await authenticatedApi("viewer@example.com").request(
        "http://localhost/api/user-pages",
      );
      expect(
        pluginUserPageLinksSchema
          .parse(await listed.json())
          .map((page) => [page.id, page.navigation]),
      ).toEqual([
        ["memories", "profile"],
        ["storage", "admin"],
      ]);
      const served =
        await authenticatedApi("viewer@example.com").request(adminPageUrl);
      expect(served.status).toBe(200);
      expect(
        pluginUserPageContentSchema.parse(await served.json()).records[0]
          ?.actions,
      ).toEqual([
        {
          href: "/api/plugins/memory/storage/connect",
          label: "Connect",
          method: "GET",
        },
      ]);

      // Revoking takes effect on the next request.
      await setUserAdminFromSql(getDb(), "viewer@example.com", false);
      expect(
        (await authenticatedApi("viewer@example.com").request(adminPageUrl))
          .status,
      ).toBe(404);
    } finally {
      await fixture.close();
    }
  });
});
