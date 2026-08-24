import { Hono } from "hono";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { codeOverviewReportSchema } from "../schema/code";
import { readCodeOverview } from "./overview";

/** Create the code analytics API. */
export function createCodeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", async () =>
    jsonResponse(codeOverviewReportSchema, await readCodeOverview()),
  );
  return app;
}
