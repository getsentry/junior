import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { personalSpendReportSchema } from "@/api/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { seedPeople } from "./fixture";

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

describe("personal spend API", () => {
  afterEach(() => vi.useRealTimers());

  test("returns cached seven and thirty day spend from one viewer", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await seedPeople(fixture);
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ usage: { cost: { total: 0.1 } } })
        .where(eq(juniorConversations.conversationId, "slack:C1:123"));
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ usage: { cost: { total: 0.2 } } })
        .where(eq(juniorConversations.conversationId, "slack:C4:456"));
      await store.recordActivity({
        actor: {
          email: "alice@example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:older",
        destination: {
          channelId: "C1",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-05-25T12:00:00.000Z"),
        source: "slack",
      });
      await store.recordExecution({
        conversationId: "slack:C1:older",
        createdAtMs: Date.parse("2026-05-25T12:00:00.000Z"),
        execution: {
          runId: "older-turn",
          status: "idle",
          updatedAtMs: Date.parse("2026-05-25T12:01:00.000Z"),
        },
        lastActivityAtMs: Date.parse("2026-05-25T12:01:00.000Z"),
        metrics: { durationMs: 100, usage: { cost: { total: 0.4 } } },
        source: "slack",
        updatedAtMs: Date.parse("2026-05-25T12:01:00.000Z"),
      });
      await store.recordActivity({
        actor: {
          email: "alice@example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:future",
        destination: {
          channelId: "C1",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-06-16T12:00:00.000Z"),
        source: "slack",
      });
      await store.recordExecution({
        conversationId: "slack:C1:future",
        createdAtMs: Date.parse("2026-06-16T12:00:00.000Z"),
        execution: {
          runId: "future-turn",
          status: "idle",
          updatedAtMs: Date.parse("2026-06-16T12:01:00.000Z"),
        },
        lastActivityAtMs: Date.parse("2026-06-16T12:01:00.000Z"),
        metrics: { durationMs: 100, usage: { cost: { total: 10 } } },
        source: "slack",
        updatedAtMs: Date.parse("2026-06-16T12:01:00.000Z"),
      });

      const app = authenticatedApi("Alice@Example.com");
      const firstResponse = await app.request(
        "http://localhost/api/people/me/spend",
      );
      const first = personalSpendReportSchema.parse(await firstResponse.json());
      expect(first).toMatchObject({
        sevenDaysUsd: 0.3,
        thirtyDaysUsd: 0.7,
      });

      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ usage: { cost: { total: 1.1 } } })
        .where(eq(juniorConversations.conversationId, "slack:C1:123"));

      const cachedResponse = await app.request(
        "http://localhost/api/people/me/spend",
      );
      const cached = personalSpendReportSchema.parse(
        await cachedResponse.json(),
      );
      expect(cached).toEqual(first);

      vi.advanceTimersByTime(5 * 60_000 + 1);
      const refreshedResponse = await app.request(
        "http://localhost/api/people/me/spend",
      );
      const refreshed = personalSpendReportSchema.parse(
        await refreshedResponse.json(),
      );
      expect(refreshed).toMatchObject({
        sevenDaysUsd: 1.3,
        thirtyDaysUsd: 1.7,
      });
      expect(refreshed.generatedAt).not.toBe(first.generatedAt);
    } finally {
      await fixture.close();
    }
  });

  test("requires a verified viewer", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/people/me/spend",
    );
    expect(response.status).toBe(401);
  });
});
