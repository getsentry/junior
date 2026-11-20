import { Hono } from "hono";
import {
  createViewerSnooze,
  InboxRowNotFoundError,
  InboxSnoozeInputError,
  unsnoozeViewerRow,
} from "@/chat/inbox-snoozes/viewer";
import { emptyResponse, jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  inboxSnoozeCreateSchema,
  inboxSnoozeSchema,
  inboxSnoozeSubjectSchema,
} from "../schema/inbox-snooze";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

/**
 * Create authenticated routes for the viewer's Inbox snoozes. The snoozed
 * rows are listed by `GET /api/review-items?for=viewer&snoozed=true`.
 */
export function createInboxSnoozeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.post(
    "/",
    requireViewer,
    validateRequest("json", inboxSnoozeCreateSchema, "Invalid snooze."),
    async (context) => {
      const { wakeAt, ...subject } = context.req.valid("json");
      try {
        const reviewItemIds = await createViewerSnooze(context.get("viewer"), {
          subject,
          wakeAtMs: Date.parse(wakeAt),
        });
        return jsonResponse(
          inboxSnoozeSchema,
          { reviewItemIds },
          { status: 201 },
        );
      } catch (error) {
        if (error instanceof InboxRowNotFoundError) {
          throwApiError(404, error.message);
        }
        if (error instanceof InboxSnoozeInputError) {
          throwApiError(400, error.message);
        }
        throw error;
      }
    },
  );

  // Wake the row now. A row with no snooze of the viewer does not change.
  app.delete(
    "/",
    requireViewer,
    validateRequest("json", inboxSnoozeSubjectSchema, "Invalid snooze."),
    async (context) => {
      await unsnoozeViewerRow(context.get("viewer"), context.req.valid("json"));
      return emptyResponse();
    },
  );

  return app;
}
