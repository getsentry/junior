import { mockAutomationCollection } from "./automation-collection";
import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import type { User } from "@sentry/junior-plugin-api";
import {
  acceptedConversationMessageSchema,
  apiErrorSchema,
  createConversationBodySchema,
  createConversationMessageBodySchema,
  forkConversationBodySchema,
  forkConversationResponseSchema,
  webMessageId,
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  archiveConversationBodySchema,
  archiveConversationResponseSchema,
  pinConversationBodySchema,
  pinConversationResponseSchema,
  conversationSubscriptionBodySchema,
  conversationSubscriptionResponseSchema,
  markConversationUnreadBodySchema,
  reorderPinnedConversationsBodySchema,
  reorderPinnedConversationsResponseSchema,
  renameConversationBodySchema,
  renameConversationResponseSchema,
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
  conversationChildAgentsReportSchema,
  conversationDetailQuerySchema,
  conversationDetailReportSchema,
  conversationDetailWithMailboxReportSchema,
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  continueConversationInSlackBodySchema,
  continueConversationInSlackResponseSchema,
  conversationReadPositionSchema,
  conversationReadReportSchema,
  conversationUnreadSchema,
  conversationOutlineSchema,
  conversationPendingMessagesReportSchema,
  conversationStatsReportSchema,
  conversationWatchesReportSchema,
  boardReportSchema,
  codeOverviewReportSchema,
  codePersonReportSchema,
  codeRepositoryParamsSchema,
  codeRepositoryReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
  personalSpendReportSchema,
  personParamsSchema,
  pluginOperationalReportFeedSchema,
  reviewItemCountSchema,
  reviewItemListSchema,
  reviewItemWaitingConversationsSchema,
  versionsSchema,
  automationExecutionListSchema,
  automationListSchema,
  automationParamsSchema,
  automationSummarySchema,
  automationRunListSchema,
  conversationCatchUpBodySchema,
  conversationCatchUpSchema,
  DEFAULT_NOTIFICATION_SCHEDULE,
  notificationScheduleSchema,
  notificationSettingsSchema,
  type NotificationSchedule,
} from "@sentry/junior/api/schema";
import { mockChartPng } from "./chart-png";
import { mockDemoMp4 } from "./demo-mp4";
import { readMockConversationOutline } from "./outline";
import {
  markMockConversationRead,
  setMockConversationReadState,
  withMockReadPosition,
} from "./read-positions";
import {
  filterMockConversationsByRepository,
  readMockCodeRepository,
} from "./code-repository";
import { readMockBoard } from "./board";
import {
  readMockConversationChildAgents,
  continueMockConversationInSlack,
  readMockConversationDetail,
  readMockConversationEvents,
  readMockConversationEventsAround,
  readMockConversationFeed,
  readMockConversationPendingMessages,
  readMockConversationStats,
  readMockCodeOverview,
  readMockLocationDetail,
  readMockLocationDirectory,
  readMockPeopleCode,
  readMockPeopleDirectory,
  readMockPeoplePluginReports,
  readMockPeopleProfile,
  readMockPluginReports,
  readMockPersonalSpend,
  readMockAutomationExecutions,
  readMockAutomationList,
  setMockConversationArchived,
  setMockConversationPinned,
  setMockConversationSubscribed,
  setMockPinOrder,
  setMockConversationTitle,
  setMockConversationAutoArchive,
  archiveMockDoneConversations,
} from "./fixtures";
import {
  createMockConversation,
  forkMockConversation,
  keepMockQuickQuestion,
  recordMockSend,
} from "./sends";
import { readMockConversationWatches } from "./watches";

function errorResponse(error: string, status: 400 | 401 | 404 | 409): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}

function viewerIdentity(viewer: User) {
  return { email: viewer.email, fullName: viewer.displayName ?? viewer.email };
}

/** Add one web message to a mock Conversation and answer like the API. */
async function acceptMockSend(
  conversationId: string,
  body: { idempotencyKey: string; message: string },
  viewer: User,
): Promise<Response> {
  const messageId = await webMessageId({
    conversationId,
    idempotencyKey: body.idempotencyKey,
  });
  const status = recordMockSend(conversationId, {
    actorIdentity: viewerIdentity(viewer),
    messageId,
    text: body.message,
  });
  return jsonResponse(acceptedConversationMessageSchema, {
    conversationId,
    messageId,
    status,
  });
}

function mockNotificationSettings(schedule: NotificationSchedule) {
  return jsonResponse(notificationSettingsSchema, {
    deviceCount: 0,
    schedule,
    timezone: schedule.timezone ?? "America/Los_Angeles",
    timezoneSource: schedule.timezone ? "manual" : "slack",
  });
}

/** Create the reporting API used exclusively by local dashboard mocks. */
export function createMockReportingApi(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();

  // Mocks have no Web Push keys, so only notification hours can change.
  app.get("/notifications", () =>
    mockNotificationSettings(DEFAULT_NOTIFICATION_SCHEDULE),
  );
  app.put("/notifications/schedule", async (c) => {
    const parsed = notificationScheduleSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) return errorResponse("Invalid schedule.", 400);
    return mockNotificationSettings(parsed.data);
  });

  app.get("/board", () =>
    jsonResponse(boardReportSchema, readMockBoard(Date.now())),
  );
  app.get("/code", () =>
    jsonResponse(codeOverviewReportSchema, readMockCodeOverview()),
  );
  app.get("/code/repositories/:repositoryId", (c) => {
    const params = codeRepositoryParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockCodeRepository(params.data.repositoryId);
    return report
      ? jsonResponse(codeRepositoryReportSchema, report)
      : errorResponse("Repository not found.", 404);
  });
  app.get("/plugin-reports", () =>
    jsonResponse(pluginOperationalReportFeedSchema, readMockPluginReports()),
  );

  app.get("/people", () =>
    jsonResponse(actorDirectoryReportSchema, readMockPeopleDirectory()),
  );
  app.get("/people/me/spend", (context) => {
    const email = context.get("viewer")?.email;
    const report = email ? readMockPersonalSpend(email) : undefined;
    return report
      ? jsonResponse(personalSpendReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
  app.get("/people/:email/plugin-reports", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    return jsonResponse(
      pluginOperationalReportFeedSchema,
      readMockPeoplePluginReports(params.data.email),
    );
  });
  app.get("/people/:email/code", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockPeopleCode(params.data.email);
    return report
      ? jsonResponse(codePersonReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
  app.get("/people/:email", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const { email } = params.data;
    const report = readMockPeopleProfile(email);
    return report
      ? jsonResponse(actorProfileReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
  app.get("/locations", () =>
    jsonResponse(locationDirectoryReportSchema, readMockLocationDirectory()),
  );
  app.get("/locations/:locationId", (c) => {
    const params = locationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const { locationId } = params.data;
    const report = readMockLocationDetail(locationId);
    return report
      ? jsonResponse(locationDetailReportSchema, report)
      : errorResponse("Location not found.", 404);
  });
  app.get("/conversations", (c) => {
    const query = conversationFeedQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return errorResponse("Invalid query parameters.", 400);
    }
    const repositoryId = query.data.codeRepositoryId;
    const readFeed = (status: "active" | "archived") => {
      const feed = readMockConversationFeed(query.data.actorEmail, status);
      return repositoryId
        ? filterMockConversationsByRepository(feed, repositoryId)
        : feed;
    };
    const report = readFeed(query.data.status);
    if (!query.data.q) {
      return jsonResponse(conversationFeedSchema, report);
    }
    const archived = readFeed("archived");
    const search = query.data.q.toLowerCase();
    const conversations = new Map(
      [...report.conversations, ...archived.conversations].map(
        (conversation) => [conversation.conversationId, conversation],
      ),
    );
    return jsonResponse(conversationFeedSchema, {
      ...report,
      conversations: [...conversations.values()].filter((conversation) =>
        conversation.displayTitle.toLowerCase().includes(search),
      ),
    });
  });
  // Sends get a fixed reply instead of an agent run. See `./sends`.
  app.post("/conversations", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return errorResponse("Sign in to send messages.", 401);
    const body = createConversationBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    const conversationId = createMockConversation({
      actorIdentity: viewerIdentity(viewer),
      ...body.data,
    });
    return acceptMockSend(conversationId, body.data, viewer);
  });
  app.post("/conversations/:conversationId/messages", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return errorResponse("Sign in to send messages.", 401);
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) return errorResponse("Invalid route parameters.", 400);
    const body = createConversationMessageBodySchema.safeParse(
      await c.req.json(),
    );
    if (!body.success) return errorResponse("Invalid request body.", 400);
    if (!readMockConversationDetail(params.data.conversationId)) {
      return errorResponse("Conversation not found.", 404);
    }
    return acceptMockSend(params.data.conversationId, body.data, viewer);
  });
  app.post("/conversations/:conversationId/forks", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return errorResponse("Sign in to fork conversations.", 401);
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) return errorResponse("Invalid route parameters.", 400);
    const body = forkConversationBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    const source = readMockConversationDetail(params.data.conversationId);
    const reply = source?.events.find(
      ({ data }) =>
        data.type === "message" &&
        data.role === "assistant" &&
        data.messageId === body.data.messageId,
    );
    if (!source?.canFork || !reply) {
      return errorResponse("Conversation not found.", 404);
    }
    return jsonResponse(forkConversationResponseSchema, {
      conversationId: forkMockConversation({
        actorIdentity: viewerIdentity(viewer),
        idempotencyKey: body.data.idempotencyKey,
        messageId: body.data.messageId,
        quickQuestion: Boolean(body.data.quickQuestion),
        sourceConversationId: params.data.conversationId,
      }),
    });
  });
  app.post("/conversations/:conversationId/quick-question/keep", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) return errorResponse("Invalid route parameters.", 400);
    return keepMockQuickQuestion(params.data.conversationId)
      ? jsonResponse(forkConversationResponseSchema, params.data)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/conversations/stats", () =>
    jsonResponse(conversationStatsReportSchema, readMockConversationStats()),
  );
  app.get("/conversations/:conversationId/events", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const query = conversationEventsQuerySchema.safeParse(c.req.query());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    if (!query.success) {
      return errorResponse("Invalid query parameters.", 400);
    }
    if (!readMockConversationDetail(params.data.conversationId)) {
      return errorResponse("Conversation not found.", 404);
    }
    if ("event" in query.data || "turn" in query.data) {
      const around = readMockConversationEventsAround(
        params.data.conversationId,
        "event" in query.data
          ? { event: query.data.event }
          : { turn: query.data.turn },
      );
      return around === "turn-not-found"
        ? errorResponse("Turn not found.", 404)
        : around
          ? jsonResponse(conversationEventPageSchema, around)
          : errorResponse("Conversation not found.", 404);
    }
    // Mock details fit one page and have no unread cursor, so mock history
    // pages only backward from cursors.
    if (!("before" in query.data)) {
      return errorResponse("Invalid query parameters.", 400);
    }
    const report = readMockConversationEvents(
      params.data.conversationId,
      query.data.before,
      query.data.limit,
    );
    return report
      ? jsonResponse(conversationEventPageSchema, report)
      : errorResponse("Invalid conversation cursor.", 400);
  });
  app.get("/conversations/:conversationId/outline", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const outline = readMockConversationOutline(params.data.conversationId);
    return outline
      ? jsonResponse(conversationOutlineSchema, outline)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/conversations/:conversationId/agents", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockConversationChildAgents(params.data.conversationId);
    return report
      ? jsonResponse(conversationChildAgentsReportSchema, report)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/conversations/:conversationId/watches", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockConversationWatches(params.data.conversationId);
    return report
      ? jsonResponse(conversationWatchesReportSchema, report)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/conversations/:conversationId/pending-messages", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockConversationPendingMessages(
      params.data.conversationId,
    );
    return report
      ? jsonResponse(conversationPendingMessagesReportSchema, report)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/conversations/:conversationId", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const query = conversationDetailQuerySchema.safeParse(c.req.query());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    if (!query.success) {
      return errorResponse("Invalid query parameters.", 400);
    }
    const { conversationId } = params.data;
    const report = readMockConversationDetail(conversationId, query.data.limit);
    if (!report) return errorResponse("Conversation not found.", 404);
    const detail = withMockReadPosition(report);
    const mailbox = query.data.mailbox
      ? readMockConversationPendingMessages(conversationId)
      : undefined;
    return mailbox
      ? jsonResponse(conversationDetailWithMailboxReportSchema, {
          ...detail,
          mailbox,
        })
      : jsonResponse(conversationDetailReportSchema, detail);
  });
  app.put("/conversations/:conversationId/read-position", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = conversationReadPositionSchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = markMockConversationRead(
      params.data.conversationId,
      body.data.lastReadSeq,
    );
    return result
      ? jsonResponse(conversationReadReportSchema, result)
      : errorResponse("Conversation not found.", 404);
  });
  app.post("/conversations/:conversationId/catch-up", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = conversationCatchUpBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    if (!readMockConversationDetail(params.data.conversationId)) {
      return errorResponse("Conversation not found.", 404);
    }
    return jsonResponse(conversationCatchUpSchema, {
      needsYou: "Review the Safari fix on PR #12.",
      summary:
        "CI failed on Safari after you left. Junior pushed a fix to PR #12, and the checks pass now.",
    });
  });
  app.post("/conversations/:conversationId/continue-in-slack", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const body = continueConversationInSlackBodySchema.safeParse(
      await c.req.json(),
    );
    if (!params.success || !body.success) {
      return errorResponse("Invalid request.", 400);
    }
    const result = continueMockConversationInSlack(
      params.data.conversationId,
      body.data.locationId,
    );
    return result
      ? jsonResponse(continueConversationInSlackResponseSchema, result)
      : errorResponse("Conversation or channel not found.", 404);
  });
  app.patch("/conversations/:conversationId/archive", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = archiveConversationBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationArchived(
      params.data.conversationId,
      body.data.archived,
      body.data.applyToChildren,
    );
    if (!result) return errorResponse("Conversation not found.", 404);
    if ("error" in result) return errorResponse(result.error, 409);
    return jsonResponse(archiveConversationResponseSchema, result);
  });
  app.patch("/conversations/:conversationId/pin", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = pinConversationBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationPinned(
      params.data.conversationId,
      body.data.pinned,
    );
    if (!result) return errorResponse("Conversation not found.", 404);
    if ("error" in result) return errorResponse(result.error, 409);
    return jsonResponse(pinConversationResponseSchema, result);
  });
  app.patch("/conversations/:conversationId/subscription", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = conversationSubscriptionBodySchema.safeParse(
      await c.req.json(),
    );
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationSubscribed(
      params.data.conversationId,
      body.data.subscribed,
    );
    return result
      ? jsonResponse(conversationSubscriptionResponseSchema, result)
      : errorResponse("Conversation not found.", 404);
  });
  app.patch("/conversations/:conversationId/unread", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = markConversationUnreadBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationReadState(
      params.data.conversationId,
      body.data.unread,
    );
    return result
      ? jsonResponse(conversationUnreadSchema, result)
      : errorResponse("Conversation not found.", 404);
  });
  app.patch("/conversations/:conversationId/title", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = renameConversationBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationTitle(
      params.data.conversationId,
      body.data.title,
    );
    return result
      ? jsonResponse(renameConversationResponseSchema, result)
      : errorResponse("Conversation not found.", 404);
  });
  app.put("/conversations/pin-order", async (c) => {
    const body = reorderPinnedConversationsBodySchema.safeParse(
      await c.req.json(),
    );
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    return jsonResponse(
      reorderPinnedConversationsResponseSchema,
      setMockPinOrder(body.data.conversationIds),
    );
  });
  app.post("/conversations/archive-done", () =>
    jsonResponse(
      archiveDoneConversationsResponseSchema,
      archiveMockDoneConversations(),
    ),
  );
  app.patch("/conversations/:conversationId/auto-archive", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = conversationAutoArchiveSchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = setMockConversationAutoArchive(
      params.data.conversationId,
      body.data.autoArchive,
    );
    return result
      ? jsonResponse(conversationAutoArchiveSchema, result)
      : errorResponse("Conversation not found.", 404);
  });
  // Fixed bodies so dashboard mock can exercise image, video, file, and text
  // preview attachment cards.
  app.get("/conversations/:conversationId/attachments/:attachmentId", (c) => {
    const conversationId = c.req.param("conversationId");
    const attachmentId = c.req.param("attachmentId");
    if (!conversationId || !attachmentId) {
      return errorResponse("Invalid route parameters.", 400);
    }
    if (!readMockConversationDetail(conversationId)) {
      return errorResponse("Conversation not found.", 404);
    }
    if (attachmentId === "qa-chart-png") {
      return new Response(mockChartPng, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": 'inline; filename="chart.png"',
          "content-type": "image/png",
          "content-length": String(mockChartPng.byteLength),
        },
      });
    }
    if (attachmentId === "qa-demo-mp4") {
      return new Response(mockDemoMp4, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": 'inline; filename="demo.mp4"',
          "content-type": "video/mp4",
          "content-length": String(mockDemoMp4.byteLength),
        },
      });
    }
    if (attachmentId === "qa-notes-txt") {
      const body = "mock attachment notes\n";
      return new Response(body, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": 'attachment; filename="notes.txt"',
          "content-type": "text/plain",
          "content-length": String(Buffer.byteLength(body)),
        },
      });
    }
    if (attachmentId === "qa-readme-md") {
      const body =
        "# Release notes\n\nThis line wraps\nin the source.\n\n- Preview text files\n- Keep downloads\n\n```ts\nconst ok = true;\n```\n";
      return new Response(body, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": 'attachment; filename="README.md"',
          "content-type": "text/markdown",
          "content-length": String(Buffer.byteLength(body)),
        },
      });
    }
    return errorResponse("Attachment not found.", 404);
  });
  // Mock data changes only through this tab's writes, which refresh their
  // own reads, so the tokens stay fixed. Mock details have no tree token, so
  // the poll does not refresh them.
  app.get("/versions", () =>
    jsonResponse(versionsSchema, {
      conversations: "mock",
      reviewItems: "mock",
      spend: "mock",
    }),
  );
  // Mock reporting has no Review items. Answer the reads here so the
  // dashboard does not query a database that has no review item tables.
  app.get("/review-items", () =>
    jsonResponse(reviewItemListSchema, { items: [] }),
  );
  app.get("/review-items/count", () =>
    jsonResponse(reviewItemCountSchema, { needsViewer: 0 }),
  );
  app.get("/review-items/waiting-conversations", () =>
    jsonResponse(reviewItemWaitingConversationsSchema, { conversations: [] }),
  );
  app.get("/review-items/:id", () =>
    errorResponse("Review item not found.", 404),
  );
  app.post("/review-items/:id/actions", () =>
    errorResponse("Review item not found.", 404),
  );
  app.get("/automations", (c) => {
    const report = readMockAutomationList();
    return jsonResponse(
      automationListSchema,
      mockAutomationCollection(report, new URL(c.req.url).searchParams),
    );
  });
  app.get("/automations/runs", () => {
    const automations = readMockAutomationList().automations;
    const runs = automations.flatMap((automation) => {
      const report = readMockAutomationExecutions(automation.id);
      return (report?.executions ?? []).map((run) => ({
        ...run,
        kind: automation.kind,
        automationId: automation.id,
        automationTitle: automation.title,
      }));
    });
    return jsonResponse(automationRunListSchema, {
      runs: runs.sort((left, right) =>
        right.executedAt.localeCompare(left.executedAt),
      ),
      truncated: false,
    });
  });
  app.get("/automations/:id", (c) => {
    const automation = readMockAutomationList().automations.find(
      (automation) => automation.id === c.req.param("id"),
    );
    return automation
      ? jsonResponse(automationSummarySchema, automation)
      : errorResponse("Automation not found.", 404);
  });
  app.get("/automations/:id/executions", (c) => {
    const params = automationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockAutomationExecutions(params.data.id);
    return report
      ? jsonResponse(automationExecutionListSchema, report)
      : errorResponse("Task not found.", 404);
  });

  return app;
}
