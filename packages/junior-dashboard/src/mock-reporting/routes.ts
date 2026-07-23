import { Hono } from "hono";
import { jsonResponse } from "@sentry/junior/api";
import {
  apiErrorSchema,
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  conversationDetailReportSchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  conversationStatsReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
  personParamsSchema,
} from "@sentry/junior/api/schema";
import {
  readMockConversationDetail,
  readMockConversationFeed,
  readMockConversationStats,
  readMockLocationDetail,
  readMockLocationDirectory,
  readMockPeopleDirectory,
  readMockPeopleProfile,
} from "./fixtures";

function errorResponse(error: string, status: 400 | 404): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}

/** Create the reporting API used exclusively by local dashboard mocks. */
export function createMockReportingApi(): Hono {
  const app = new Hono();

  app.get("/people", () =>
    jsonResponse(actorDirectoryReportSchema, readMockPeopleDirectory()),
  );
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
  app.get("/conversations/:conversationId", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const { conversationId } = params.data;
    const report = readMockConversationDetail(conversationId);
    return report
      ? jsonResponse(conversationDetailReportSchema, report)
      : errorResponse("Conversation not found.", 404);
  });

  return app;
}
