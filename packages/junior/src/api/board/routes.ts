import { Hono } from "hono";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { boardReportSchema } from "../schema/board";
import { requireViewer } from "../viewer";
import { readBoard } from "./read";

/** Create the viewer's Board API. */
export function createBoardRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", requireViewer, async (context) =>
    jsonResponse(
      boardReportSchema,
      await readBoard({ nowMs: Date.now(), userId: context.get("viewer").id }),
      { headers: { "cache-control": "private, no-store" } },
    ),
  );
  return app;
}
