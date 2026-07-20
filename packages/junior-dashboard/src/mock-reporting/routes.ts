import { Hono } from "hono";
import {
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

/** Create the reporting API used exclusively by local dashboard mocks. */
export function createMockReportingApi(): Hono {
  const app = new Hono();

  app.get("/people", () =>
    Response.json(actorDirectoryReportSchema.parse(readMockPeopleDirectory())),
  );
  app.get("/people/:email", (c) => {
    const { email } = personParamsSchema.parse(c.req.param());
    const report = readMockPeopleProfile(email);
    return report
      ? Response.json(actorProfileReportSchema.parse(report))
      : Response.json({ error: "Person not found." }, { status: 404 });
  });
  app.get("/locations", () =>
    Response.json(
      locationDirectoryReportSchema.parse(readMockLocationDirectory()),
    ),
  );
  app.get("/locations/:locationId", (c) => {
    const { locationId } = locationParamsSchema.parse(c.req.param());
    const report = readMockLocationDetail(locationId);
    return report
      ? Response.json(locationDetailReportSchema.parse(report))
      : Response.json({ error: "Location not found." }, { status: 404 });
  });
  app.get("/conversations", (c) => {
    const query = conversationFeedQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return Response.json(
        { error: "Invalid query parameters." },
        { status: 400 },
      );
    }
    return Response.json(
      conversationFeedSchema.parse(
        readMockConversationFeed(query.data.actorEmail),
      ),
    );
  });
  app.get("/conversations/stats", () =>
    Response.json(
      conversationStatsReportSchema.parse(readMockConversationStats()),
    ),
  );
  app.get("/conversations/:conversationId", (c) => {
    const { conversationId } = conversationParamsSchema.parse(c.req.param());
    const report = readMockConversationDetail(conversationId);
    return report
      ? Response.json(conversationDetailReportSchema.parse(report))
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  });

  return app;
}
