import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { clearInboxWakeReasons } from "@/chat/inbox-snoozes/store";
import { viewerSnoozeResource } from "@/chat/inbox-snoozes/subject";
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
  inboxSnoozeResourceQuerySchema,
  inboxSnoozeResourceSchema,
  inboxSnoozeSchema,
  inboxSnoozeSubjectSchema,
  inboxSnoozeWakesClearSchema,
} from "../schema/inbox-snooze";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

/**
 * Create authenticated routes for the viewer's Inbox snoozes. The snoozed
 * rows are listed by `GET /api/inbox-items?for=viewer&snoozed=true`.
 */
export function createInboxSnoozeRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.post(
    "/",
    requireViewer,
    validateRequest("json", inboxSnoozeCreateSchema, "Invalid snooze."),
    async (context) => {
      const { triggers, wakeAt, ...subject } = context.req.valid("json");
      try {
        const inboxItemIds = await createViewerSnooze(context.get("viewer"), {
          subject,
          ...(triggers ? { triggers } : undefined),
          ...(wakeAt ? { wakeAtMs: Date.parse(wakeAt) } : undefined),
        });
        return jsonResponse(
          inboxSnoozeSchema,
          { inboxItemIds },
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

  // The Events of a page that the viewer names for a snooze, such as
  // another pull request. A page that they cannot see is not found.
  app.get(
    "/resource",
    requireViewer,
    validateRequest("query", inboxSnoozeResourceQuerySchema, "Invalid link."),
    async (context) => {
      const resource = await viewerSnoozeResource(
        context.get("viewer"),
        getEventCatalog(),
        context.req.valid("query").url,
      );
      if (!resource) throwApiError(404, "A snooze cannot wait on this link.");
      return jsonResponse(inboxSnoozeResourceSchema, {
        events: [...resource.events],
        namespace: resource.namespace,
        phrases: { ...resource.phrases },
        resourceType: resource.resourceType,
      });
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

  // The viewer opened these items, so they no longer say why they woke.
  // Only the viewer's own snoozes change.
  app.delete(
    "/wakes",
    requireViewer,
    validateRequest("json", inboxSnoozeWakesClearSchema, "Invalid items."),
    async (context) => {
      await clearInboxWakeReasons(getDb(), {
        inboxItemIds: context.req.valid("json").inboxItemIds,
        userId: context.get("viewer").id,
      });
      return emptyResponse();
    },
  );

  return app;
}
