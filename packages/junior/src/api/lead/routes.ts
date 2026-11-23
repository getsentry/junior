import { Hono } from "hono";
import { readConversationLastEventSeq } from "../conversations/event-page";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { leadSchema } from "../schema/lead";
import { requireViewer } from "../viewer";
import { getSqlExecutor } from "../../chat/db";
import { getLeadConversation } from "../../chat/lead/conversation";
import { CONVERSATION_RESOURCE_TYPE } from "../../chat/conversations/watch-events";
import { CORE_EVENT_NAMESPACE } from "../../chat/events/catalog";
import { listWatches } from "../../chat/events/store";

/** Create the route that finds the viewer's Lead, and creates it on first use. */
export function createLeadRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) => {
    const lead = await getLeadConversation(context.get("viewer"));
    // Read the seq first: a Watch that changes after it adds a later event.
    const lastSeq = await readConversationLastEventSeq(
      getSqlExecutor(),
      lead.conversationId,
    );
    // The Lead is private to the viewer, so its Watch targets are theirs.
    const watches = await listWatches({ conversationId: lead.conversationId });
    const watchedConversationIds = [
      ...new Set(
        watches
          .filter(
            (watch) =>
              watch.namespace === CORE_EVENT_NAMESPACE &&
              watch.resourceType === CONVERSATION_RESOURCE_TYPE,
          )
          .map((watch) => watch.identifier),
      ),
    ];
    return jsonResponse(
      leadSchema,
      { conversationId: lead.conversationId, lastSeq, watchedConversationIds },
      { headers: { "cache-control": "private, no-store" } },
    );
  });

  return app;
}
