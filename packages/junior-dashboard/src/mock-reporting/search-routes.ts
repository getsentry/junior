import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import { searchReportSchema } from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import { NOW_MS, readMockAutomationList } from "./fixtures";
import { readMockInboxItems } from "./inbox-items";
import { mockSearchReport } from "./search";

/**
 * Mount the mock `/api/search` route over the mock Inbox and Automations.
 * The mock server holds no memories, so e2e specs mock them.
 */
export function registerMockSearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/search", (c) => {
    const report = mockSearchReport(
      {
        automations: readMockAutomationList().automations,
        inboxItems: [
          ...readMockInboxItems(NOW_MS, {}),
          ...readMockInboxItems(NOW_MS, { closed: true }),
        ],
        memories: [],
      },
      new URL(c.req.url).searchParams,
    );
    return report
      ? jsonResponse(searchReportSchema, report)
      : errorResponse("Invalid search query.", 400);
  });
}
