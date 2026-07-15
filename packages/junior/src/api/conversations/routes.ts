import { Hono } from "hono";
import { z } from "zod";
import { parseParams, parseQuery } from "../http";
import {
  conversationFeedQuerySchema,
  conversationParamsSchema,
  subagentParamsSchema,
} from "../schema";
import { setConversationArchived } from "./archive";
import { readConversationDetail } from "./detail";
import { readConversationFeed } from "./list";
import { readConversationStats } from "./stats";
import { readConversationSubagent } from "./subagent";

const archiveBodySchema = z.object({ archived: z.boolean() }).strict();

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const { actorEmail, includeArchived } = parseQuery(
      conversationFeedQuerySchema,
      c.req.query(),
    );
    return Response.json(
      await readConversationFeed({ actorEmail, includeArchived }),
    );
  });
  app.get("/stats", async () => Response.json(await readConversationStats()));
  app.patch("/:conversationId/archive", async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const body = archiveBodySchema.parse(await c.req.json());
    const updated = await setConversationArchived({
      archived: body.archived,
      conversationId,
    });
    return updated
      ? Response.json({ archived: body.archived })
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  });
  app.get("/:conversationId", async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const report = await readConversationDetail(conversationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  });
  app.get("/:conversationId/subagents/:subagentId", async (c) => {
    const { conversationId, subagentId } = parseParams(
      subagentParamsSchema,
      c.req.param(),
    );
    const report = await readConversationSubagent(conversationId, subagentId);
    return report.unavailableReason === "not_found"
      ? Response.json(report, { status: 404 })
      : Response.json(report);
  });

  return app;
}
