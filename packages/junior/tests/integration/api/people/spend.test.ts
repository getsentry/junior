import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { personalSpendReportSchema } from "@/api/schema";
import { readPersonalSpendFromSql } from "@/api/people/spend.query";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  createConversationId,
  recordWebConversationActivity,
} from "@/chat/conversations/web-input";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
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

  test("counts dashboard conversations and skips system identities", async () => {
    const nowMs = Date.parse("2026-06-15T12:00:00.000Z");
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await seedPeople(fixture);
      const webConversationId = createConversationId({
        actorEmail: "alice@example.com",
        idempotencyKey: "web-spend",
      });
      await recordWebConversationActivity({
        actor: {
          email: "Alice@Example.com",
          fullName: "Alice Example",
          platform: "web",
          userId: "alice@example.com",
        },
        conversationId: webConversationId,
        conversationStore: store,
        nowMs: Date.parse("2026-06-14T09:00:00.000Z"),
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ usage: { cost: { total: 0.05 } } })
        .where(eq(juniorConversations.conversationId, webConversationId));

      // A system identity never counts as a person, even when linked.
      const [alice] = await fixture.sql
        .db()
        .select({ id: juniorUsers.id })
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, "alice@example.com"));
      const now = new Date("2026-06-14T10:00:00.000Z");
      await fixture.sql.db().insert(juniorIdentities).values({
        createdAt: now,
        email: "alice@example.com",
        emailNormalized: "alice@example.com",
        emailVerified: true,
        id: "system-identity",
        kind: "system",
        provider: "junior",
        providerSubjectId: "local-cli",
        updatedAt: now,
        userId: alice!.id,
      });
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({
          actorIdentityId: "system-identity",
          conversationId: "local:system-spend",
          createdAt: now,
          executionStatus: "idle",
          lastActivityAt: now,
          rootConversationId: "local:system-spend",
          schemaVersion: 1,
          source: "local",
          updatedAt: now,
          usage: { cost: { total: 5 } },
        });

      // Seeded Slack spend is 0.25 + 0.17; the web conversation adds 0.05.
      expect(
        await readPersonalSpendFromSql("alice@example.com", nowMs),
      ).toMatchObject({
        sevenDaysUsd: 0.47,
        thirtyDaysUsd: 0.47,
      });
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
