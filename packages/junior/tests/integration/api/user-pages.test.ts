import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  defineJuniorPlugin,
  pluginUserPageContentSchema,
  pluginUserPageLinksSchema,
} from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
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
    } finally {
      await fixture.close();
    }
  });
});
