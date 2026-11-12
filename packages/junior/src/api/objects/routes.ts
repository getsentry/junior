import { Hono } from "hono";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  objectLinksQuerySchema,
  objectLinksReportSchema,
} from "../schema/object-link";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { resolveObjectLinks } from "./resolve";

/** Create the viewer-scoped route that resolves links to object cards. */
export function createObjectRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    requireViewer,
    validateRequest("query", objectLinksQuerySchema, "Invalid object links."),
    async (context) =>
      jsonResponse(
        objectLinksReportSchema,
        {
          objects: await resolveObjectLinks(
            context.get("viewer"),
            context.req.valid("query").url,
          ),
        },
        // Each card holds only what this viewer may read.
        { headers: { "cache-control": "private, no-store" } },
      ),
  );
  return app;
}
