import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  codeOverviewReportSchema,
  codeRepositoryParamsSchema,
  codeRepositoryQuerySchema,
  codeRepositoryReportSchema,
} from "../schema/code";
import { validateRequest } from "../validation";
import { readCodeOverview } from "./overview";
import { readCodeRepository } from "./repository";

/** Create the code analytics API. */
export function createCodeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", async () =>
    jsonResponse(codeOverviewReportSchema, await readCodeOverview()),
  );
  app.get(
    "/repositories/:repositoryId",
    validateRequest(
      "param",
      codeRepositoryParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "query",
      codeRepositoryQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { repositoryId } = context.req.valid("param");
      const { state } = context.req.valid("query");
      const report = await readCodeRepository(repositoryId, { state });
      if (!report) throwApiError(404, "Repository not found.");
      return jsonResponse(codeRepositoryReportSchema, report);
    },
  );
  return app;
}
