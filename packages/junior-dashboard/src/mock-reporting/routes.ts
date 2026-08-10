import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  apiErrorSchema,
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  conversationDetailQuerySchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  conversationStatsReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
  personalSpendReportSchema,
  personParamsSchema,
  taskExecutionListSchema,
  taskListSchema,
  taskParamsSchema,
  taskRunListSchema,
} from "@sentry/junior/api/schema";
import {
  readMockConversationDetail,
  readMockConversationEvents,
  readMockConversationFeed,
  readMockConversationStats,
  readMockLocationDetail,
  readMockLocationDirectory,
  readMockPeopleDirectory,
  readMockPeopleProfile,
  readMockPersonalSpend,
  readMockTaskExecutions,
  readMockTaskList,
} from "./fixtures";

function errorResponse(error: string, status: 400 | 404): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}

/** Create the reporting API used exclusively by local dashboard mocks. */
export function createMockReportingApi(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();

  app.get("/people", () =>
    jsonResponse(actorDirectoryReportSchema, readMockPeopleDirectory()),
  );
  app.get("/people/me/spend", (context) => {
    const email = context.get("verifiedViewerEmail");
    const report = email ? readMockPersonalSpend(email) : undefined;
    return report
      ? jsonResponse(personalSpendReportSchema, report)
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
    return jsonResponse(
      conversationFeedSchema,
      readMockConversationFeed(query.data.actorEmail),
    );
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
    const report = readMockConversationEvents(
      params.data.conversationId,
      query.data.before,
      query.data.limit,
    );
    return report
      ? jsonResponse(conversationEventPageSchema, report)
      : errorResponse("Invalid conversation cursor.", 400);
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
    return report
      ? jsonResponse(conversationDetailReportSchema, report)
      : errorResponse("Conversation not found.", 404);
  });
  app.get("/tasks", () => jsonResponse(taskListSchema, readMockTaskList()));
  app.get("/tasks/runs", () => {
    const tasks = readMockTaskList().tasks;
    const runs = tasks.flatMap((task) => {
      const report = readMockTaskExecutions(task.kind, task.id);
      return (report?.executions ?? []).map((run) => ({
        ...run,
        kind: task.kind,
        taskId: task.id,
        taskTitle: task.title,
      }));
    });
    return jsonResponse(taskRunListSchema, {
      runs: runs.sort((left, right) =>
        right.executedAt.localeCompare(left.executedAt),
      ),
      truncated: false,
    });
  });
  app.get("/tasks/:kind/:id/executions", (c) => {
    const params = taskParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockTaskExecutions(params.data.kind, params.data.id);
    return report
      ? jsonResponse(taskExecutionListSchema, report)
      : errorResponse("Task not found.", 404);
  });

  return app;
}
