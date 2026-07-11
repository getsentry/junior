import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  conversationParamsSchema,
  personParamsSchema,
  subagentParamsSchema,
} from "./api/schema";
import {
  readHealthReport,
  readPluginOperationalReportFeed,
  readPluginReports,
  readRuntimeInfoReport,
  readSkillReports,
} from "./reporting";

function parseParams<TSchema extends z.ZodType>(
  schema: TSchema,
  params: Record<string, string>,
): z.infer<TSchema> {
  const result = schema.safeParse(params);
  if (result.success) {
    return result.data;
  }
  throw new HTTPException(400, {
    cause: result.error,
    message: "Invalid route parameters.",
  });
}

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(): Hono {
  const app = new Hono();

  app.get("/api/health", async () => {
    return Response.json(await readHealthReport());
  });
  app.get("/api/runtime", async () => {
    return Response.json(await readRuntimeInfoReport());
  });
  app.get("/api/plugins", async () => {
    return Response.json(await readPluginReports());
  });
  app.get("/api/skills", async () => {
    return Response.json(await readSkillReports());
  });
  app.get("/api/plugin-reports", async () => {
    return Response.json(await readPluginOperationalReportFeed());
  });

  app.get("/api/conversations", async () => {
    const { readConversationFeed } = await import("./api/conversations/list");
    return Response.json(await readConversationFeed());
  });
  app.get("/api/conversations/stats", async () => {
    const { readConversationStats } = await import("./api/conversations/stats");
    return Response.json(await readConversationStats());
  });
  app.get("/api/conversations/:conversationId", async (c) => {
    const { readConversationDetail } =
      await import("./api/conversations/detail");
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const report = await readConversationDetail(conversationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  });
  app.get(
    "/api/conversations/:conversationId/subagents/:subagentId",
    async (c) => {
      const { readConversationSubagent } =
        await import("./api/conversations/subagent");
      const { conversationId, subagentId } = parseParams(
        subagentParamsSchema,
        c.req.param(),
      );
      const report = await readConversationSubagent(conversationId, subagentId);
      return report.unavailableReason === "not_found"
        ? Response.json(report, { status: 404 })
        : Response.json(report);
    },
  );

  app.get("/api/people", async () => {
    const { readPeopleList } = await import("./api/people/list");
    return Response.json(await readPeopleList());
  });
  app.get("/api/people/:email", async (c) => {
    const { email } = parseParams(personParamsSchema, c.req.param());
    const { readPeopleProfile } = await import("./api/people/profile");
    return Response.json(await readPeopleProfile(email));
  });

  return app;
}
