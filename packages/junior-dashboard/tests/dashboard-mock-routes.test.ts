import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorDirectoryReportSchema,
  codeOverviewReportSchema,
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationChildAgentsReportSchema,
  conversationDetailReportSchema,
  conversationUnchangedDetailWithMailboxSchema,
  conversationEventPageSchema,
  conversationFeedSchema,
  type ConversationDetailReport,
  type ConversationSummaryReport,
} from "@sentry/junior/api/schema";

import { createDashboardApp, resetMockDashboardState } from "../src/app";
import {
  ARCHIVED_CONVERSATION_ID,
  conversationTimeBounds,
  DASHBOARD_QA_ARCHIVED_THREAD_ID,
  DASHBOARD_QA_CONVERSATION_ID,
  DASHBOARD_QA_THREAD_ID,
  NOW,
  resetMockConversationViewerState,
} from "../src/mock-reporting/fixtures";

const DASHBOARD_QA_CHILD_IDS = [
  "junior:internal:dashboard-qa:advisor-plan",
  "junior:internal:dashboard-qa:advisor-review",
];

describe("dashboard canonical-event mock routes", () => {
  afterEach(() => {
    // Keep the default archived fixture available for later visual/mock runs.
    resetMockConversationViewerState();
  });

  it("derives public location bounds independently of summary order", () => {
    const summary = (
      conversationId: string,
      startedAt: string,
      lastSeenAt: string,
    ): ConversationSummaryReport => ({
      kind: "root",
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
    const app = createDashboardApp({
      authRequired: false,
      allowedDomains: [],
      mockConversations: true,
    });

    const me = await app.fetch(new Request("http://localhost/api/me"));
    await expect(me.json()).resolves.toEqual({
      autoArchiveDefault: false,
      autoArchiveGraceHours: 24,
      user: { email: "dev@example.com", emailVerified: true, isAdmin: false },
    });

    const code = await app.fetch(new Request("http://localhost/api/code"));
    expect(code.status).toBe(200);
    const codeOverview = codeOverviewReportSchema.parse(await code.json());
    expect(codeOverview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: "getsentry/junior" }),
      ]),
    );

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
    expect(body.conversations.map((item) => item.conversationId)).not.toContain(
      ARCHIVED_CONVERSATION_ID,
    );
    expect(body.conversations.map((item) => item.conversationId)).not.toEqual(
      expect.arrayContaining(DASHBOARD_QA_CHILD_IDS),
    );

    const archived = await app.fetch(
      new Request("http://localhost/api/conversations?status=archived"),
    );
    expect(archived.status).toBe(200);
    const archivedBody = (await archived.json()) as typeof body;
    expect(
      archivedBody.conversations.map((item) => item.conversationId),
    ).toEqual([ARCHIVED_CONVERSATION_ID]);

    const restore = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(ARCHIVED_CONVERSATION_ID)}/archive`,
        {
          body: JSON.stringify({
            archived: false,
            lastSeenAt: NOW,
          }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      ),
    );
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toEqual({ archivedAt: null });

    const restoredFeed = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );
    const restoredBody = (await restoredFeed.json()) as typeof body;
    expect(
      restoredBody.conversations.map((item) => item.conversationId),
    ).toContain(ARCHIVED_CONVERSATION_ID);
    resetMockConversationViewerState();
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
    expect(statsBody.windowEnd).toBe(NOW);
    expect(statsBody.windowStart).toBe("2026-05-10T00:00:00.000Z");

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
      allowedDomains: [],
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
      expect.arrayContaining(["compaction"]),
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

  it("nests shown Threads under their root and archives children for everyone", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedDomains: [],
      mockConversations: true,
    });
    const qaThreads = async () =>
      conversationFeedSchema
        .parse(
          await (
            await app.fetch(new Request("http://localhost/api/conversations"))
          ).json(),
        )
        .conversations.find(
          (item) => item.conversationId === DASHBOARD_QA_CONVERSATION_ID,
        )
        ?.threads?.map((thread) => thread.conversationId);
    const archiveThread = (
      conversationId: string,
      archived: boolean,
      applyToChildren?: boolean,
    ) =>
      app.fetch(
        new Request(
          `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/archive`,
          {
            body: JSON.stringify({
              applyToChildren,
              archived,
              lastSeenAt: NOW,
            }),
            headers: { "content-type": "application/json" },
            method: "PATCH",
          },
        ),
      );

    try {
      await expect(qaThreads()).resolves.toEqual([DASHBOARD_QA_THREAD_ID]);
      const archivedThread = conversationDetailReportSchema.parse(
        await (
          await app.fetch(
            new Request(
              `http://localhost/api/conversations/${encodeURIComponent(DASHBOARD_QA_ARCHIVED_THREAD_ID)}`,
            ),
          )
        ).json(),
      );
      expect(archivedThread).toMatchObject({
        agentTree: [
          { conversationId: DASHBOARD_QA_CONVERSATION_ID, kind: "root" },
          { conversationId: DASHBOARD_QA_ARCHIVED_THREAD_ID, kind: "thread" },
        ],
        kind: "thread",
        parentConversationId: DASHBOARD_QA_CONVERSATION_ID,
        archivedAt: expect.any(String),
      });
      // The child-agents report keeps archived Threads for "Show archived".
      const childAgents = conversationChildAgentsReportSchema.parse(
        await (
          await app.fetch(
            new Request(
              `http://localhost/api/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}/agents`,
            ),
          )
        ).json(),
      );
      expect(
        childAgents.agents.map(({ conversationId, kind, archivedAt }) => ({
          conversationId,
          kind,
          archivedAt,
        })),
      ).toEqual([
        {
          conversationId: DASHBOARD_QA_THREAD_ID,
          kind: "thread",
          archivedAt: null,
        },
        {
          conversationId: DASHBOARD_QA_ARCHIVED_THREAD_ID,
          kind: "thread",
          archivedAt: archivedThread.archivedAt,
        },
        expect.objectContaining({ kind: "task" }),
        expect.objectContaining({ kind: "task" }),
      ]);

      expect((await archiveThread(DASHBOARD_QA_THREAD_ID, true)).status).toBe(
        200,
      );
      await expect(qaThreads()).resolves.toBeUndefined();
      expect(
        (await archiveThread(DASHBOARD_QA_ARCHIVED_THREAD_ID, false)).status,
      ).toBe(200);
      await expect(qaThreads()).resolves.toEqual([
        DASHBOARD_QA_ARCHIVED_THREAD_ID,
      ]);

      // Like the API, a Task with an unarchived child needs applyToChildren,
      // and its child cannot be restored while the Task is archived.
      const planId = DASHBOARD_QA_CHILD_IDS[0]!;
      const refused = await archiveThread(planId, true);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toEqual({
        error:
          "1 child conversation is not archived. Pass applyToChildren to archive it too.",
      });
      expect((await archiveThread(planId, true, true)).status).toBe(200);
      const restoreChild = await archiveThread(`${planId}:claim-check`, false);
      expect(restoreChild.status).toBe(409);
      await expect(restoreChild.json()).resolves.toEqual({
        error: `Conversation ${planId} above this one is archived. Restore it first.`,
      });
    } finally {
      resetMockConversationViewerState();
    }
  });

  it("loads canonical child conversations through the ordinary detail route", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedDomains: [],
      mockConversations: true,
    });
    const parentPath = `http://localhost/api/conversations/${encodeURIComponent(
      DASHBOARD_QA_CONVERSATION_ID,
    )}`;
    const parentResponse = await app.fetch(new Request(parentPath));
    const parent = conversationDetailReportSchema.parse(
      await parentResponse.json(),
    );
    const version = {
      [CONVERSATION_DETAIL_VERSION_HEADER]: parentResponse.headers.get(
        CONVERSATION_DETAIL_VERSION_HEADER,
      )!,
    };
    const unchanged = await app.fetch(
      new Request(parentPath, { headers: version }),
    );
    expect(unchanged.status).toBe(304);
    // The mailbox changes apart from the version, so a poll gets it alone.
    const withMailbox = await app.fetch(
      new Request(`${parentPath}?mailbox=true`, { headers: version }),
    );
    expect(withMailbox.status).toBe(200);
    expect(
      conversationUnchangedDetailWithMailboxSchema.parse(
        await withMailbox.json(),
      ).mailbox.conversationId,
    ).toBe(DASHBOARD_QA_CONVERSATION_ID);
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

describe("dashboard mock sends", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetMockDashboardState();
  });

  const app = createDashboardApp({
    authRequired: false,
    allowedDomains: [],
    mockConversations: true,
  });
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://localhost/api${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
  const readDetail = async (conversationId: string) =>
    conversationDetailReportSchema.parse(
      await (
        await app.fetch(
          new Request(
            `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
          ),
        )
      ).json(),
    );
  const readFeedIds = async () =>
    conversationFeedSchema
      .parse(
        await (
          await app.fetch(new Request("http://localhost/api/conversations"))
        ).json(),
      )
      .conversations.map((conversation) => conversation.conversationId);
  const messages = (detail: ConversationDetailReport) =>
    detail.events.flatMap(({ data }) =>
      data.type === "message" ? [`${data.role}: ${data.text}`] : [],
    );

  it("starts a Conversation that shows a working Turn, then a fixed reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const created = await post("/conversations", {
      idempotencyKey: "new-1",
      message: "Draw the release checklist",
    });
    expect(created.status).toBe(200);
    const accepted = (await created.json()) as {
      conversationId: string;
      messageId: string;
      status: string;
    };
    expect(accepted.status).toBe("accepted");
    expect(await readFeedIds()).toContain(accepted.conversationId);

    const working = await readDetail(accepted.conversationId);
    expect(working).toMatchObject({
      displayTitle: "Draw the release checklist",
      isParticipant: true,
      status: "active",
      surface: "api",
    });
    expect(messages(working)).toEqual(["user: Draw the release checklist"]);

    vi.advanceTimersByTime(2_000);
    const replied = await readDetail(accepted.conversationId);
    expect(replied.status).toBe("completed");
    expect(messages(replied)).toEqual([
      "user: Draw the release checklist",
      "assistant: Mock reply. No agent ran.\n\n> Draw the release checklist",
    ]);

    const retry = await post("/conversations", {
      idempotencyKey: "new-1",
      message: "Draw the release checklist",
    });
    await expect(retry.json()).resolves.toEqual({
      ...accepted,
      status: "duplicate",
    });

    // A fork at the reply copies the end of its Turn too.
    const fork = await post(
      `/conversations/${encodeURIComponent(accepted.conversationId)}/forks`,
      {
        idempotencyKey: "fork-1",
        messageId: `mock-reply:${accepted.messageId}`,
      },
    );
    const { conversationId: forkId } = (await fork.json()) as {
      conversationId: string;
    };
    expect(
      (await readDetail(forkId)).events.flatMap(({ data }) =>
        data.type === "turn_lifecycle" ? [data.state] : [],
      ),
    ).toEqual(["started", "succeeded"]);
  });

  it("adds a send to a fixture Conversation", async () => {
    const before = await readDetail(DASHBOARD_QA_CONVERSATION_ID);
    const response = await post(
      `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}/messages`,
      { idempotencyKey: "append-1", message: "One more thing" },
    );
    expect(response.status).toBe(200);
    const after = await readDetail(DASHBOARD_QA_CONVERSATION_ID);
    expect(after.status).toBe("active");
    expect(messages(after)).toEqual([
      ...messages(before),
      "user: One more thing",
    ]);
  });

  it("keeps a Quick question unlisted until the reader keeps it", async () => {
    const fork = await post(
      `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}/forks`,
      {
        idempotencyKey: "quick-1",
        messageId: "qa-assistant",
        quickQuestion: { quote: "the plan" },
      },
    );
    expect(fork.status).toBe(200);
    const { conversationId } = (await fork.json()) as {
      conversationId: string;
    };
    const asked = await post(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { idempotencyKey: "quick-ask-1", message: "Why this order?" },
    );
    expect(asked.status).toBe(200);

    const thread = await readDetail(conversationId);
    expect(thread).toMatchObject({
      canFork: false,
      forkedFromConversationId: DASHBOARD_QA_CONVERSATION_ID,
    });
    expect(messages(thread).at(-1)).toBe("user: Why this order?");
    expect(await readFeedIds()).not.toContain(conversationId);
    expect(
      (await readDetail(DASHBOARD_QA_CONVERSATION_ID)).forks,
    ).toBeUndefined();

    const kept = await post(
      `/conversations/${encodeURIComponent(conversationId)}/quick-question/keep`,
      {},
    );
    expect(kept.status).toBe(200);
    expect(await readFeedIds()).toContain(conversationId);
    expect((await readDetail(DASHBOARD_QA_CONVERSATION_ID)).forks).toEqual([
      conversationId,
    ]);
  });
});
