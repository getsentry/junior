import { Hono } from "hono";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { leadSchema } from "../schema/lead";
import { requireViewer } from "../viewer";
import { getLeadConversation } from "../../chat/lead/conversation";

/** Create the route that finds the viewer's Lead, and creates it on first use. */
export function createLeadRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) => {
    const lead = await getLeadConversation(context.get("viewer"));
    return jsonResponse(
      leadSchema,
      { conversationId: lead.conversationId },
      { headers: { "cache-control": "private, no-store" } },
    );
  });

  return app;
}
