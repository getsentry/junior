import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  codeOverviewQuerySchema,
  codeOverviewReportSchema,
  codeRepositoryParamsSchema,
  codeRepositoryReportSchema,
} from "../schema/code";
import { validateRequest } from "../validation";
import { readCodeOverview } from "./overview";
import { readCodeRepository } from "./repository";

/** Create the code analytics API. */
export function createCodeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    validateRequest(
      "query",
      codeOverviewQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { repository } = context.req.valid("query");
      return jsonResponse(
        codeOverviewReportSchema,
        await readCodeOverview({ repositoryNames: repository }),
      );
    },
  );
  app.get(
    "/repositories/:repositoryId",
    validateRequest(
      "param",
      codeRepositoryParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { repositoryId } = context.req.valid("param");
      const report = await readCodeRepository(repositoryId);
      if (!report) throwApiError(404, "Repository not found.");
      return jsonResponse(codeRepositoryReportSchema, report);
    },
  );
  return app;
}
