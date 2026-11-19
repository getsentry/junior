import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import { apiErrorSchema, leadSchema } from "@sentry/junior/api/schema";
import { createMockLead } from "./sends";

/** Create the mock route that finds or starts the viewer's Lead. */
export function createMockLeadRoutes(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.get("/", (c) => {
    const viewer = c.get("viewer");
    if (!viewer) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
    const conversationId = createMockLead({
      email: viewer.email,
      fullName: viewer.displayName ?? viewer.email,
    });
    return jsonResponse(leadSchema, { conversationId });
  });
  return app;
}
