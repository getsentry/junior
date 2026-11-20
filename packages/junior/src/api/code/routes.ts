import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  codeChangeSearchQuerySchema,
  codeChangeSearchReportSchema,
  codeOverviewReportSchema,
  codeRepositoryParamsSchema,
  codeRepositoryQuerySchema,
  codeRepositoryReportSchema,
} from "../schema/code";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { readCodeOverview } from "./overview";
import { readCodeRepository } from "./repository";
import { readCodeChangeSearchFromSql } from "./search.query";

/** Create the code analytics API. */
export function createCodeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", async () =>
    jsonResponse(codeOverviewReportSchema, await readCodeOverview()),
  );
  app.get(
    "/changes/search",
    requireViewer,
    validateRequest(
      "query",
      codeChangeSearchQuerySchema,
      "Invalid search query.",
    ),
    async (context) =>
      jsonResponse(codeChangeSearchReportSchema, {
        changes: await readCodeChangeSearchFromSql(
          context.req.valid("query").q,
          context.get("viewer").id,
        ),
      }),
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
