import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorDirectoryReportSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  type ConversationSummaryReport,
} from "@sentry/junior/api/schema";

import { createDashboardApp } from "../src/app";
import {
  conversationTimeBounds,
  DASHBOARD_QA_CONVERSATION_ID,
} from "../src/mock-reporting/fixtures";

const DASHBOARD_QA_CHILD_IDS = [
  "junior:internal:dashboard-qa:advisor-plan",
  "junior:internal:dashboard-qa:advisor-review",
];

describe("dashboard canonical-event mock routes", () => {
  afterEach(() => vi.useRealTimers());

  it("derives public location bounds independently of summary order", () => {
    const summary = (
      conversationId: string,
      startedAt: string,
      lastSeenAt: string,
    ): ConversationSummaryReport => ({
      channel: "CQA123",
      channelName: "proj-checkout",
      conversationId,
      cumulativeDurationMs: 1_000,
      displayTitle: conversationId,
      isParticipant: false,
      lastProgressAt: lastSeenAt,
      lastSeenAt,
      startedAt,
      status: "completed",
      surface: "slack",
    });
    const summaries = [
      summary("middle", "2026-01-02T00:00:00.000Z", "2026-01-10T00:00:00.000Z"),
      summary(
        "earliest",
        "2026-01-01T00:00:00.000Z",
        "2026-01-05T00:00:00.000Z",
      ),
      summary("latest", "2026-01-03T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
    ];

    const ordered = conversationTimeBounds([
      summaries[0]!,
      ...summaries.slice(1),
    ]);
    const reversedSummaries = [...summaries].reverse();
    const reversed = conversationTimeBounds([
      reversedSummaries[0]!,
      ...reversedSummaries.slice(1),
    ]);
    expect(reversed).toEqual(ordered);
    expect(ordered.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(ordered.lastSeenAt).toBe("2026-01-20T00:00:00.000Z");
  });

  it("serves canonical detail, directory, and aggregate reports", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-30T00:00:00.000Z") });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
    });

    const me = await app.fetch(new Request("http://localhost/api/me"));
    await expect(me.json()).resolves.toEqual({
      user: { email: "dev@example.com", emailVerified: true },
    });

    const conversations = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );
    expect(conversations.status).toBe(200);
    const body = (await conversations.json()) as {
      conversations: Array<{
        actorIdentity?: { email?: string };
        channel?: string;
        conversationId: string;
        cumulativeDurationMs: number;
        locationId?: string;
      }>;
      source: string;
    };
    expect(body.source).toBe("conversation_index");
    expect(body.conversations[0]?.conversationId).toBe(
      "slack:CQA123:1770003600.000200",
    );
    expect(body.conversations.map((item) => item.conversationId)).toContain(
      DASHBOARD_QA_CONVERSATION_ID,
    );
    expect(body.conversations.map((item) => item.conversationId)).not.toEqual(
      expect.arrayContaining(DASHBOARD_QA_CHILD_IDS),
    );
    expect(
      body.conversations
        .filter((item) => item.channel?.startsWith("C"))
        .every((item) => item.locationId === `mock:${item.channel}`),
    ).toBe(true);
    expect(body.conversations[0]).not.toHaveProperty("events");

    const personal = await app.fetch(
      new Request(
        "http://localhost/api/conversations?actorEmail=dev%40example.com",
      ),
    );
    const personalBody = (await personal.json()) as typeof body;
    expect(
      personalBody.conversations.every(
        (item) => item.actorIdentity?.email === "dev@example.com",
      ),
    ).toBe(true);

    const stats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    const statsBody = (await stats.json()) as {
      conversations: number;
      costUsd?: number;
      durationMs: number;
      windowEnd: string;
      windowStart: string;
    };
    expect(statsBody.conversations).toBe(body.conversations.length);
    expect(statsBody.durationMs).toBe(
      body.conversations.reduce(
        (sum, conversation) => sum + conversation.cumulativeDurationMs,
        0,
      ),
    );
    expect(statsBody.costUsd).toBeGreaterThan(0);
    expect(
      Date.parse(statsBody.windowEnd) - Date.parse(statsBody.windowStart),
    ).toBe(89 * 24 * 60 * 60 * 1000);

    const people = await app.fetch(new Request("http://localhost/api/people"));
    const peopleBody = actorDirectoryReportSchema.parse(await people.json());
    expect(peopleBody.people.length).toBeGreaterThan(0);
    expect(peopleBody.activityDays).toHaveLength(90);
    const profileResponse = await app.fetch(
      new Request(
        `http://localhost/api/people/${encodeURIComponent(
          peopleBody.people[0]!.actor.email,
        )}`,
      ),
    );
    const profile = (await profileResponse.json()) as {
      activityDays: unknown[];
      locations: unknown[];
      surfaces: unknown[];
    };
    expect(profile.activityDays).toHaveLength(365);
    expect(profile.locations.length).toBeGreaterThan(0);
    expect(profile.surfaces.length).toBeGreaterThan(0);

    const locations = await app.fetch(
      new Request("http://localhost/api/locations"),
    );
    const locationBody = (await locations.json()) as {
      locations: Array<{
        conversations: number;
        id: string;
        label: string;
      }>;
      privateActivity: { conversations: number };
    };
    expect(locationBody.locations.map((item) => item.label)).toContain(
      "#proj-checkout",
    );
    expect(locationBody.privateActivity.conversations).toBeGreaterThan(0);
    expect(
      locationBody.locations.reduce(
        (sum, item) => sum + item.conversations,
        locationBody.privateActivity.conversations,
      ),
    ).toBe(body.conversations.length);
    const locationResponse = await app.fetch(
      new Request(
        `http://localhost/api/locations/${encodeURIComponent(
          locationBody.locations[0]!.id,
        )}`,
      ),
    );
    const location = (await locationResponse.json()) as {
      activityDays: unknown[];
      actors: unknown[];
      recentConversations: Array<{ locationId?: string }>;
    };
    expect(location.activityDays).toHaveLength(90);
    expect(location.actors.length).toBeGreaterThan(0);
    expect(
      location.recentConversations.every(
        (conversation) =>
          conversation.locationId === locationBody.locations[0]!.id,
      ),
    ).toBe(true);
  });

  it("serves direct canonical event fixtures for every dashboard state", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
    });

    const readDetail = async (conversationId: string) => {
      const response = await app.fetch(
        new Request(
          `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
        ),
      );
      expect(response.status).toBe(200);
      return conversationDetailReportSchema.parse(await response.json());
    };

    const active = await readDetail("slack:CQA123:1770003600.000200");
    expect(
      active.events.flatMap((event) =>
        event.data.type === "tool_calls"
          ? event.data.calls.map((call) => call.name)
          : [],
      ),
    ).toContain("webSearch");

    const dashboardQa = await readDetail(DASHBOARD_QA_CONVERSATION_ID);
    expect(dashboardQa.events[0]?.data).toMatchObject({
      type: "message",
      actorIdentity: {
        fullName: "Taylor Chen",
        slackUserName: "taylor",
      },
    });
    expect(
      dashboardQa.events.some(
        (event) =>
          event.data.type === "tool_calls" &&
          event.data.assistant !== undefined,
      ),
    ).toBe(true);
    expect(dashboardQa.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resource_link",
          key: "getsentry/getsentry#21571",
          plugin: "github",
          status: "merged",
        }),
        expect.objectContaining({
          kind: "resource_link",
          key: "getsentry/getsentry#21572",
          plugin: "github",
          status: "open",
        }),
        expect.objectContaining({
          kind: "resource_link",
          key: "getsentry/getsentry#21569",
          plugin: "github",
          status: "draft",
        }),
        expect.objectContaining({
          kind: "resource_link",
          key: "getsentry/sentry#121727",
          plugin: "github",
          status: "merged",
        }),
      ]),
    );
    expect(dashboardQa.annotations).toHaveLength(4);
    expect(dashboardQa.sidebarAnnotations).toEqual([
      {
        icon: "git-merge",
        key: "getsentry/getsentry#21571",
        label: "getsentry",
      },
      {
        icon: "git-pull-request",
        key: "getsentry/getsentry#21572",
        label: "getsentry",
      },
      {
        icon: "circle-dashed",
        key: "getsentry/getsentry#21569",
        label: "getsentry",
      },
      {
        icon: "git-merge",
        key: "getsentry/sentry#121727",
        label: "sentry",
      },
    ]);
    expect(dashboardQa.unfinishedWork).toBe(true);

    const failed = await readDetail("slack:CQA777:1770014400.000500");
    expect(failed.events.at(-1)?.data).toMatchObject({
      type: "turn_lifecycle",
      state: "failed",
    });

    const privateConversation = await readDetail(
      "slack:DQA123:1770007200.000300",
    );
    expect(privateConversation.eventHistory).toEqual({
      status: "redacted",
      reason: "non_public_conversation",
    });
    expect(privateConversation.events[0]?.data).toMatchObject({
      type: "message",
      redacted: true,
    });

    const long = await readDetail("slack:CQA456:1770021600.000600");
    expect(long.events.map((event) => event.data.type)).toEqual(
      expect.arrayContaining(["compaction", "handoff"]),
    );
    const historyResponse = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(long.conversationId)}/events?before=${encodeURIComponent(long.previousCursor!)}`,
      ),
    );
    expect(historyResponse.status).toBe(200);
    const history = conversationEventPageSchema.parse(
      await historyResponse.json(),
    );
    expect(history.events.map((event) => event.seq)).toEqual([0]);

    const limitedDetailResponse = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(long.conversationId)}?limit=2`,
      ),
    );
    const limitedDetail = conversationDetailReportSchema.parse(
      await limitedDetailResponse.json(),
    );
    expect(limitedDetail.events).toHaveLength(2);
    expect(limitedDetail.previousCursor).toBeDefined();

    const limitedHistoryResponse = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(long.conversationId)}/events?before=${encodeURIComponent(limitedDetail.previousCursor!)}&limit=2`,
      ),
    );
    const limitedHistory = conversationEventPageSchema.parse(
      await limitedHistoryResponse.json(),
    );
    expect(limitedHistory.events).toHaveLength(2);
    expect(limitedHistory.events.at(-1)!.seq).toBeLessThan(
      limitedDetail.events[0]!.seq,
    );
  });

  it("loads canonical child conversations through the ordinary detail route", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
    });
    const parentResponse = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(
          DASHBOARD_QA_CONVERSATION_ID,
        )}`,
      ),
    );
    const parent = conversationDetailReportSchema.parse(
      await parentResponse.json(),
    );
    const childIds = parent.events.flatMap((event) =>
      event.data.type === "subagent" && event.data.status === "running"
        ? [event.data.childConversationId]
        : [],
    );
    expect(childIds.length).toBeGreaterThan(0);

    for (const childId of childIds) {
      const response = await app.fetch(
        new Request(
          `http://localhost/api/conversations/${encodeURIComponent(childId)}`,
        ),
      );
      expect(response.status).toBe(200);
      const child = conversationDetailReportSchema.parse(await response.json());
      expect(child.conversationId).toBe(childId);
      expect(child.events.length).toBeGreaterThan(0);
    }
  });
});
