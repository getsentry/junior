import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  apiErrorSchema,
  wakeAutomationCreateSchema,
  wakeAutomationListSchema,
  wakeAutomationSchema,
} from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";
import { readMockSnoozes, snoozeMockRow, wakeMockSnooze } from "./review-items";

function errorResponse(message: string, status: 400 | 404) {
  return jsonResponse(apiErrorSchema, { error: message }, { status });
}

/**
 * Answer the snooze routes of `/api/automations` from the mock items, so
 * Snooze and Wake work without a database. Register them before
 * `/automations/:id`.
 */
export function addMockSnoozeRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/automations/snoozes", () =>
    jsonResponse(wakeAutomationListSchema, {
      snoozes: readMockSnoozes(NOW_MS),
    }),
  );
  app.post("/automations", async (c) => {
    const body = wakeAutomationCreateSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid snooze.", 400);
    return jsonResponse(
      wakeAutomationSchema,
      snoozeMockRow(NOW_MS, body.data),
      {
        status: 201,
      },
    );
  });
  app.delete("/automations/:id", (c) =>
    wakeMockSnooze(c.req.param("id"))
      ? new Response(null, { status: 204 })
      : errorResponse("Automation not found.", 404),
  );
}
