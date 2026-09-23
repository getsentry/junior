import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { getDb } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { memoryApiSchema, memoryListResponseSchema } from "@/chat/memory/api";
import { createMemoryFeature } from "@/chat/memory/feature";
import { createMemoryStore } from "@/chat/memory/store";
import { setCoreFeatures } from "@/chat/plugins/core-features";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

const VIEWER_EMAIL = "memory-api@example.com";

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

async function seedPrivateMemory(fixture: {
  sql: Parameters<typeof migrateSchema>[0];
}) {
  const conversationId = "slack:D123:1718800001.000000";
  const conversations = createSqlStore(fixture.sql);
  await conversations.recordActivity({
    actor: {
      email: VIEWER_EMAIL,
      platform: "slack",
      slackUserId: "U123",
      teamId: "T123",
    },
    conversationId,
    destination: { channelId: "D123", platform: "slack", teamId: "T123" },
    nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
    source: "slack",
    visibility: "private",
  });
  const viewer = await resolveViewerUser(VIEWER_EMAIL);
  if (!viewer) {
    throw new Error("Viewer did not resolve");
  }
  const created = await createMemoryStore(getDb(), {
    conversationId,
    actor: { platform: "slack", teamId: "T123", userId: "U123" },
    source: createSlackSource({
      teamId: "T123",
      channelId: "D123",
      messageTs: "1718800001.000000",
      visibility: "private",
    }),
    userId: viewer.id,
  }).createMemory({
    content: "Prefers terse status updates.",
    idempotencyKey: "api-memory-private",
    kind: "preference",
  });
  return created.memory;
}

describe("memory API routes", () => {
  afterEach(() => setCoreFeatures([]));

  test("lists, reads, and forgets memory through the core routes", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    setCoreFeatures([createMemoryFeature()]);
    try {
      await migrateSchema(fixture.sql);
      const memory = await seedPrivateMemory(fixture);
      const api = authenticatedApi(VIEWER_EMAIL);

      const listResponse = await api.request(
        "http://localhost/api/memory/memories",
      );
      expect(listResponse.status).toBe(200);
      expect(
        memoryListResponseSchema
          .parse(await listResponse.json())
          .memories.map((entry) => entry.id),
      ).toEqual([memory.id]);

      const detailResponse = await api.request(
        `http://localhost/api/memory/memories/${encodeURIComponent(memory.id)}`,
      );
      expect(detailResponse.status).toBe(200);
      expect(memoryApiSchema.parse(await detailResponse.json())).toMatchObject({
        id: memory.id,
        visibility: "private",
      });

      const deleteResponse = await api.request(
        `http://localhost/api/memory/memories/${encodeURIComponent(memory.id)}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(204);
      const forgottenResponse = await api.request(
        `http://localhost/api/memory/memories/${encodeURIComponent(memory.id)}`,
      );
      expect(forgottenResponse.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  test("requires an authenticated viewer", async () => {
    setCoreFeatures([createMemoryFeature()]);
    const response = await createJuniorApi().request(
      "http://localhost/api/memory/memories",
    );
    expect(response.status).toBe(401);
  });

  test("returns not found when Memory is disabled", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    setCoreFeatures([createMemoryFeature({ enabled: false })]);
    try {
      await migrateSchema(fixture.sql);
      await seedPrivateMemory(fixture);
      const response = await authenticatedApi(VIEWER_EMAIL).request(
        "http://localhost/api/memory/memories",
      );
      expect(response.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });
});
