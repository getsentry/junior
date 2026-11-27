import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { pluginOperationalReportFeedSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { useAppContext } from "../../../fixtures/app-context";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
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

describe("people plugin reports API", () => {
  test("requires a verified viewer and returns the profile report feed", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const unauthenticated = await createJuniorApi().request(
        "http://localhost/api/people/alice@example.com/plugin-reports",
      );
      expect(unauthenticated.status).toBe(401);

      await resolveViewerUser("alice@example.com");
      useAppContext({
        plugins: [
          defineJuniorPlugin({
            manifest: {
              name: "agent-demo",
              displayName: "Agent Demo",
              description: "Agent demo",
            },
            hooks: {
              profileReport(ctx) {
                return {
                  title: "Agent Demo",
                  metrics: [
                    {
                      label: "subject",
                      value: ctx.subject.email,
                    },
                  ],
                };
              },
            },
          }),
        ],
      });
      const response = await authenticatedApi("viewer@example.com").request(
        "http://localhost/api/people/alice@example.com/plugin-reports",
      );
      expect(response.status).toBe(200);
      const body = pluginOperationalReportFeedSchema.parse(
        await response.json(),
      );
      expect(body.source).toBe("plugins");
      expect(body.reports).toEqual([
        {
          pluginName: "agent-demo",
          title: "Agent Demo",
          metrics: [{ label: "subject", value: "alice@example.com" }],
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
