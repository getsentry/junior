import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import { searchReportSchema } from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import { NOW_MS, readMockAutomationList } from "./fixtures";
import { readMockInboxItems } from "./inbox-items";
import { mockSearchReport } from "./search";
import { readMockSearchTodos } from "./todos";

/** The rows that the mock `/api/search` route searches. */
export function readMockSearchRows() {
  return {
    automations: readMockAutomationList().automations,
    inboxItems: [
      ...readMockInboxItems(NOW_MS, {}),
      ...readMockInboxItems(NOW_MS, { closed: true }),
    ],
    memories: [],
    todos: readMockSearchTodos(),
  };
}

/**
 * Mount the mock `/api/search` route over the mock Inbox, Automations, and
 * To-dos.
 * The mock server holds no memories, so e2e specs mock them.
 */
export function registerMockSearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/search", (c) => {
    const report = mockSearchReport(
      readMockSearchRows(),
      new URL(c.req.url).searchParams,
    );
    return report
      ? jsonResponse(searchReportSchema, report)
      : errorResponse("Invalid search query.", 400);
  });
}
