import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { closeDb, getConversationStore } from "@/chat/db";

describe("Junior REST API", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
  });

  test("serves conversation and People resources from migrated SQL", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    const store = getConversationStore();
    const conversationId = "slack:C1:rest-api";

    await store.recordActivity({
      actor: {
        email: "Person@Example.com",
        fullName: "Person Example",
        platform: "slack",
        slackUserId: "U1",
        teamId: "T1",
      },
      channelName: "product",
      conversationId,
      destination: {
        channelId: "C1",
        platform: "slack",
        teamId: "T1",
      },
      nowMs: Date.parse("2026-06-15T11:50:00.000Z"),
      source: "slack",
      title: "REST API conversation",
      visibility: "public",
    });
    await store.recordExecution({
      conversationId,
      createdAtMs: Date.parse("2026-06-15T11:50:00.000Z"),
      execution: {
        runId: "run-1",
        status: "idle",
        updatedAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
      },
      lastActivityAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
      metrics: {
        durationMs: 1_500,
        usage: { totalTokens: 120 },
      },
      source: "slack",
      updatedAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
    });

    const app = createJuniorApi();

    const feed = await app.request("http://localhost/api/conversations");
    expect(feed.status).toBe(200);
    await expect(feed.json()).resolves.toMatchObject({
      conversations: [
        {
          conversationId,
          cumulativeDurationMs: 1_500,
          cumulativeUsage: { totalTokens: 120 },
        },
      ],
      source: "conversation_index",
    });

    const personalFeed = await app.request(
      "http://localhost/api/conversations?actorEmail=Person%40Example.com",
    );
    expect(personalFeed.status).toBe(200);
    await expect(personalFeed.json()).resolves.toMatchObject({
      conversations: [
        {
          actorIdentity: { email: "Person@Example.com" },
          conversationId,
        },
      ],
    });

    const invalidFeed = await app.request(
      "http://localhost/api/conversations?actorEmail=not-an-email",
    );
    expect(invalidFeed.status).toBe(400);

    const stats = await app.request("http://localhost/api/conversations/stats");
    expect(stats.status).toBe(200);
    await expect(stats.json()).resolves.toMatchObject({
      conversations: 1,
      durationMs: 1_500,
      tokens: 120,
    });

    const detail = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      actorIdentity: { email: "Person@Example.com" },
      conversationId,
    });

    const people = await app.request("http://localhost/api/people");
    expect(people.status).toBe(200);
    await expect(people.json()).resolves.toMatchObject({
      people: [
        {
          actor: { email: "person@example.com" },
          conversations: 1,
          durationMs: 1_500,
          tokens: 120,
        },
      ],
    });

    const profile = await app.request(
      "http://localhost/api/people/Person%40Example.com",
    );
    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toMatchObject({
      actor: { email: "person@example.com" },
      totals: { conversations: 1, durationMs: 1_500, tokens: 120 },
    });

    const missing = await app.request(
      "http://localhost/api/conversations/missing",
    );
    expect(missing.status).toBe(404);

    const invalidPerson = await app.request("http://localhost/api/people/%20");
    expect(invalidPerson.status).toBe(400);

    const percentEmail = await app.request(
      "http://localhost/api/people/person%25tag%40example.com",
    );
    expect(percentEmail.status).toBe(200);
    await expect(percentEmail.json()).resolves.toMatchObject({
      actor: { email: "person%tag@example.com" },
    });
  });
});
