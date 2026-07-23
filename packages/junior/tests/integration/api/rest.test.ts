import { afterEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  apiErrorSchema,
  archiveConversationResponseSchema,
  conversationDetailReportSchema,
  conversationFeedSchema,
  conversationStatsReportSchema,
  healthReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  pluginOperationalReportFeedSchema,
  pluginReportsSchema,
  runtimeInfoReportSchema,
  skillReportsSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { juniorDestinations } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("Junior REST API", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
  });

  test.each([
    ["/api/health", healthReportSchema],
    ["/api/runtime", runtimeInfoReportSchema],
    ["/api/plugins", pluginReportsSchema],
    ["/api/skills", skillReportsSchema],
    ["/api/plugin-reports", pluginOperationalReportFeedSchema],
  ] as const)("serves %s through its response schema", async (path, schema) => {
    const response = await createJuniorApi().request(`http://localhost${path}`);

    expect(response.status).toBe(200);
    schema.parse(await response.json());
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
    const unidentifiedConversationId = "slack:C1:unidentified-rest-api";
    await store.recordActivity({
      channelName: "product",
      conversationId: unidentifiedConversationId,
      destination: {
        channelId: "C1",
        platform: "slack",
        teamId: "T1",
      },
      nowMs: Date.parse("2026-06-15T11:45:00.000Z"),
      source: "slack",
      title: "Unidentified public conversation",
      visibility: "public",
    });
    await store.recordActivity({
      channelName: "secret-plans",
      conversationId: "slack:C2:private-rest-api",
      destination: {
        channelId: "C2",
        platform: "slack",
        teamId: "T1",
      },
      nowMs: Date.parse("2026-06-15T11:40:00.000Z"),
      source: "slack",
      title: "Private title",
      visibility: "private",
    });
    await store.recordActivity({
      conversationId: "internal:historical-rest-api",
      nowMs: Date.parse("2026-06-15T11:30:00.000Z"),
      source: "internal",
      title: "Historical internal title",
    });

    const app = createJuniorApi();

    const feed = await app.request("http://localhost/api/conversations");
    expect(feed.status).toBe(200);
    const feedReport = conversationFeedSchema.parse(await feed.json());
    expect(feedReport).toMatchObject({
      conversations: expect.arrayContaining([
        expect.objectContaining({
          conversationId,
          cumulativeDurationMs: 1_500,
          cumulativeUsage: { totalTokens: 120 },
        }),
      ]),
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

    const activeProfile = await app.request(
      "http://localhost/api/people/Person%40Example.com",
    );
    expect(activeProfile.status).toBe(200);
    expect(
      actorProfileReportSchema.parse(await activeProfile.json()),
    ).toMatchObject({
      recentConversations: [
        expect.objectContaining({
          conversationId,
          cumulativeUsage: { totalTokens: 120 },
          isParticipant: false,
        }),
      ],
    });

    const invalidFeed = await app.request(
      "http://localhost/api/conversations?actorEmail=not-an-email",
    );
    expect(invalidFeed.status).toBe(400);
    expect(apiErrorSchema.parse(await invalidFeed.json())).toEqual({
      error: "Invalid query parameters.",
    });

    const stats = await app.request("http://localhost/api/conversations/stats");
    expect(stats.status).toBe(200);
    expect(
      conversationStatsReportSchema.parse(await stats.json()),
    ).toMatchObject({
      conversations: 4,
      durationMs: 1_500,
      tokens: 120,
    });

    const invalidArchive = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/archive`,
      {
        body: JSON.stringify({ archived: "yes" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(invalidArchive.status).toBe(400);
    expect(apiErrorSchema.parse(await invalidArchive.json())).toEqual({
      error: "Invalid request body.",
    });

    const archive = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: "2026-06-15T11:51:00.000Z",
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    expect(
      archiveConversationResponseSchema.parse(await archive.json()),
    ).toEqual({ archived: true });

    const defaultFeedAfterArchive = await app.request(
      "http://localhost/api/conversations",
    );
    expect(
      (
        (await defaultFeedAfterArchive.json()) as {
          conversations: Array<{ conversationId: string }>;
        }
      ).conversations,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ conversationId })]),
    );

    const statsAfterArchive = await app.request(
      "http://localhost/api/conversations/stats",
    );
    await expect(statsAfterArchive.json()).resolves.toMatchObject({
      conversations: 4,
      durationMs: 1_500,
      tokens: 120,
    });

    const detail = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    expect(detail.status).toBe(200);
    const detailReport = conversationDetailReportSchema.parse(
      await detail.json(),
    );
    expect(detailReport).toMatchObject({
      actorIdentity: { email: "Person@Example.com" },
      conversationId,
    });

    const removedSubagentDetail = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/subagents/legacy-subagent`,
    );
    expect(removedSubagentDetail.status).toBe(404);

    const people = await app.request("http://localhost/api/people");
    expect(people.status).toBe(200);
    expect(actorDirectoryReportSchema.parse(await people.json())).toMatchObject(
      {
        people: [
          {
            actor: { email: "person@example.com" },
            conversations: 1,
            durationMs: 1_500,
            tokens: 120,
          },
        ],
      },
    );

    const profile = await app.request(
      "http://localhost/api/people/Person%40Example.com",
    );
    expect(profile.status).toBe(200);
    expect(actorProfileReportSchema.parse(await profile.json())).toMatchObject({
      actor: { email: "person@example.com" },
      recentConversations: [],
      totals: { conversations: 1, durationMs: 1_500, tokens: 120 },
    });

    const locations = await app.request("http://localhost/api/locations");
    expect(locations.status).toBe(200);
    const locationReport = locationDirectoryReportSchema.parse(
      await locations.json(),
    );
    expect(locationReport).toMatchObject({
      locations: [
        {
          label: "#product",
          providerDestinationId: "C1",
        },
      ],
      privateActivity: {
        conversations: 2,
        label: "Private activity",
      },
    });
    expect(JSON.stringify(locationReport)).not.toContain("secret-plans");
    expect(JSON.stringify(locationReport)).not.toContain("Private title");
    expect(JSON.stringify(locationReport)).not.toContain(
      "Historical internal title",
    );
    const publicLocationId = locationReport.locations[0]?.id;
    expect(
      feedReport.conversations.find(
        (conversation) => conversation.conversationId === conversationId,
      )?.locationId,
    ).toBe(publicLocationId);
    expect(detailReport.locationId).toBe(publicLocationId);
    expect(
      feedReport.conversations.find(
        (conversation) =>
          conversation.conversationId === "slack:C2:private-rest-api",
      ),
    ).not.toHaveProperty("locationId");
    expect(
      feedReport.conversations.find(
        (conversation) =>
          conversation.conversationId === "internal:historical-rest-api",
      ),
    ).not.toHaveProperty("locationId");

    await store.recordActivity({
      channelName: "product",
      conversationId: "scheduler:C1:rest-api",
      destination: {
        channelId: "C1",
        platform: "slack",
        teamId: "T1",
      },
      nowMs: Date.parse("2026-06-15T11:55:00.000Z"),
      source: "scheduler",
      title: "Scheduled public conversation",
      visibility: "public",
    });

    const location = await app.request(
      `http://localhost/api/locations/${locationReport.locations[0]?.id}`,
    );
    expect(location.status).toBe(200);
    const locationDetail = locationDetailReportSchema.parse(
      await location.json(),
    );
    expect(locationDetail).toMatchObject({
      actors: [
        {
          actor: { email: "person@example.com" },
          conversations: 1,
        },
      ],
      conversations: 3,
      label: "#product",
      recentConversations: expect.not.arrayContaining([
        expect.objectContaining({ conversationId }),
      ]),
    });

    const [privateDestination] = await getDb()
      .select({ id: juniorDestinations.id })
      .from(juniorDestinations)
      .where(eq(juniorDestinations.providerDestinationId, "C2"));
    const privateLocation = await app.request(
      `http://localhost/api/locations/${privateDestination?.id}`,
    );
    expect(privateLocation.status).toBe(404);

    const missing = await app.request(
      "http://localhost/api/conversations/missing",
    );
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json())).toEqual({
      error: "Conversation not found.",
    });

    const invalidPerson = await app.request("http://localhost/api/people/%20");
    expect(invalidPerson.status).toBe(400);
    expect(apiErrorSchema.parse(await invalidPerson.json())).toEqual({
      error: "Invalid route parameters.",
    });

    const percentEmail = await app.request(
      "http://localhost/api/people/person%25tag%40example.com",
    );
    expect(percentEmail.status).toBe(200);
    await expect(percentEmail.json()).resolves.toMatchObject({
      actor: { email: "person%tag@example.com" },
    });
  });

  test("marks a verified participant and exposes their private transcript", async () => {
    const conversationId = "slack:C-private:participant-rest-api";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "T1",
      },
      conversationId,
      destination: {
        channelId: "C-private",
        platform: "slack",
        teamId: "T1",
      },
      source: "slack",
      visibility: "private",
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "private-message",
          role: "user",
          text: "Private participant message",
        },
      },
    ]);

    const redacted = await createJuniorApi().request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    await expect(redacted.json()).resolves.toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });

    const anonymousFeed = await createJuniorApi().request(
      "http://localhost/api/conversations",
    );
    await expect(anonymousFeed.json()).resolves.toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId,
          isParticipant: false,
        }),
      ],
    });

    const participantApi = new Hono<{ Variables: JuniorApiVariables }>();
    participantApi.use("*", async (context, next) => {
      context.set("verifiedViewerEmail", "participant@example.COM");
      await next();
    });
    participantApi.route("/", createJuniorApi());

    const participantFeed = await participantApi.request(
      "http://localhost/api/conversations",
    );
    await expect(participantFeed.json()).resolves.toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId,
          isParticipant: true,
        }),
      ],
    });

    const participantProfile = await participantApi.request(
      "http://localhost/api/people/participant%40example.com",
    );
    expect(
      actorProfileReportSchema.parse(await participantProfile.json()),
    ).toMatchObject({
      recentConversations: [
        expect.objectContaining({
          conversationId,
          isParticipant: true,
        }),
      ],
    });

    const visible = await participantApi.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    await expect(visible.json()).resolves.toMatchObject({
      eventHistory: { status: "available" },
      events: [
        {
          data: { text: "Private participant message" },
        },
      ],
      isParticipant: true,
    });
  });
});
