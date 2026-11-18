import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  apiErrorSchema,
  inboxSnoozeCreateSchema,
  inboxSnoozeSchema,
  inboxSnoozeSubjectSchema,
  reviewItemActionSchema,
  reviewItemCountSchema,
  reviewItemListSchema,
  reviewItemSchema,
  reviewItemWaitingConversationsSchema,
} from "@sentry/junior/api/schema";
import { mockAutomationCollection } from "./automation-collection";
import { NOW_MS, readMockAutomationList } from "./fixtures";
import {
  actOnMockReviewItem,
  readMockReviewItem,
  readMockReviewItemCounts,
  readMockReviewItems,
  readMockWaitingConversations,
  snoozeMockRow,
  wakeMockRow,
} from "./review-items";

function errorResponse(error: string, status: 400 | 404): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}

/**
 * Answer Review item reads and actions, and Inbox snoozes, from the mock
 * items, so the dashboard does not query a database that has no review
 * item tables.
 */
export function addMockReviewItemRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/review-items", (c) => {
    const {
      conversationId,
      for: forViewer,
      q,
      snoozed,
      status,
    } = c.req.query();
    return jsonResponse(reviewItemListSchema, {
      items: readMockReviewItems(NOW_MS, {
        closed: Boolean(status && status !== "open"),
        conversationId,
        // A search and a Conversation's own list still show snoozed rows.
        forViewer: forViewer === "viewer" && !q && !conversationId,
        q: q || undefined,
        snoozed: snoozed === "true",
      }),
    });
  });
  app.get("/review-items/count", (c) =>
    jsonResponse(reviewItemCountSchema, {
      ...(c.req.query("include")?.split(",").includes("automations")
        ? {
            automations: mockAutomationCollection(
              readMockAutomationList(),
              new URLSearchParams({ owner: "me", scope: "attention" }),
            ).total,
          }
        : undefined),
      ...readMockReviewItemCounts(NOW_MS),
    }),
  );
  app.get("/review-items/waiting-conversations", () =>
    jsonResponse(reviewItemWaitingConversationsSchema, {
      conversations: readMockWaitingConversations(NOW_MS).conversations,
    }),
  );
  app.get("/review-items/:id", (c) => {
    const item = readMockReviewItem(NOW_MS, c.req.param("id"));
    return item
      ? jsonResponse(reviewItemSchema, item)
      : errorResponse("Review item not found.", 404);
  });
  app.post("/review-items/:id/actions", async (c) => {
    const body = reviewItemActionSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid action.", 400);
    const item = actOnMockReviewItem(NOW_MS, c.req.param("id"), body.data);
    return item
      ? jsonResponse(reviewItemSchema, item)
      : errorResponse("Review item not found.", 404);
  });
  app.post("/inbox/snoozes", async (c) => {
    const body = inboxSnoozeCreateSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid snooze.", 400);
    return jsonResponse(inboxSnoozeSchema, snoozeMockRow(NOW_MS, body.data), {
      status: 201,
    });
  });
  app.delete("/inbox/snoozes", async (c) => {
    const body = inboxSnoozeSubjectSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid snooze.", 400);
    wakeMockRow(NOW_MS, body.data.conversationId);
    return new Response(null, { status: 204 });
  });
}
