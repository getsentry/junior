import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  apiErrorSchema,
  inboxSnoozeCreateSchema,
  inboxSnoozeResourceSchema,
  inboxSnoozeSchema,
  inboxSnoozeSubjectSchema,
  inboxSnoozeWakesClearSchema,
  inboxItemActionSchema,
  inboxItemCountSchema,
  inboxItemListSchema,
  inboxItemSchema,
  inboxItemWaitingConversationsSchema,
} from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";
import {
  actOnMockInboxItem,
  openMockWakes,
  readMockInboxItem,
  readMockInboxItemCounts,
  readMockInboxItems,
  readMockWaitingConversations,
  snoozeMockRow,
  wakeMockRow,
} from "./inbox-items";
import { readMockSnoozeResource } from "./snooze-resources";
import { setMockTodoStatus } from "./todos";

function errorResponse(error: string, status: 400 | 404): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}

/** Build what `GET /inbox-items` answers for its query. */
export function readMockInboxItemList(query: Record<string, string>) {
  const { conversationId, for: forViewer, owner, q, snoozed, status } = query;
  return {
    items: readMockInboxItems(NOW_MS, {
      closed: Boolean(status && status !== "open"),
      conversationId,
      // A search and a Conversation's own list still show snoozed rows.
      forViewer: forViewer === "viewer" && !q && !conversationId,
      q: q || undefined,
      snoozed: snoozed === "true",
    }).filter((item) => !owner || item.owner.kind === owner),
  };
}

/** Build what `GET /inbox-items/count` answers for its query. */
export function readMockInboxItemCount(query: Record<string, string>) {
  const { automations, ...counts } = readMockInboxItemCounts(NOW_MS);
  return {
    ...(query["include"]?.split(",").includes("automations")
      ? { automations }
      : undefined),
    ...counts,
  };
}

/**
 * Answer Inbox item reads and actions, and Inbox snoozes, from the mock
 * items, so the dashboard does not query a database that has no review
 * item tables.
 */
export function addMockInboxItemRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/inbox-items", (c) =>
    jsonResponse(inboxItemListSchema, readMockInboxItemList(c.req.query())),
  );
  app.get("/inbox-items/count", (c) =>
    jsonResponse(inboxItemCountSchema, readMockInboxItemCount(c.req.query())),
  );
  app.get("/inbox-items/waiting-conversations", () =>
    jsonResponse(inboxItemWaitingConversationsSchema, {
      conversations: readMockWaitingConversations(NOW_MS).conversations,
    }),
  );
  app.get("/inbox-items/:id", (c) => {
    const item = readMockInboxItem(NOW_MS, c.req.param("id"));
    return item
      ? jsonResponse(inboxItemSchema, item)
      : errorResponse("Inbox item not found.", 404);
  });
  app.post("/inbox-items/:id/actions", async (c) => {
    const body = inboxItemActionSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid action.", 400);
    // A To-do's item takes Done or Dismiss, which mark the To-do done or
    // drop it, and only a To-do's item takes Done, like the API.
    const { action } = body.data;
    const current = readMockInboxItem(NOW_MS, c.req.param("id"));
    const todo = current?.todoId !== undefined;
    if (
      current &&
      (todo ? action !== "done" && action !== "dismiss" : action === "done")
    )
      return errorResponse("Invalid action.", 400);
    if (current?.todoId !== undefined && current.status === "open")
      setMockTodoStatus(current.owner.id, current.todoId, {
        status: action === "done" ? "done" : "dropped",
      });
    const item = actOnMockInboxItem(NOW_MS, c.req.param("id"), body.data);
    return item
      ? jsonResponse(inboxItemSchema, item)
      : errorResponse("Inbox item not found.", 404);
  });
  app.get("/inbox/snoozes/resource", (c) => {
    const resource = readMockSnoozeResource(c.req.query("url") ?? "");
    return resource
      ? jsonResponse(inboxSnoozeResourceSchema, resource)
      : errorResponse("A snooze cannot wait on this link.", 404);
  });
  app.post("/inbox/snoozes", async (c) => {
    const body = inboxSnoozeCreateSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid snooze.", 400);
    return jsonResponse(inboxSnoozeSchema, snoozeMockRow(NOW_MS, body.data), {
      status: 201,
    });
  });
  app.delete("/inbox/snoozes/wakes", async (c) => {
    const body = inboxSnoozeWakesClearSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid items.", 400);
    openMockWakes(body.data.inboxItemIds);
    return new Response(null, { status: 204 });
  });
  app.delete("/inbox/snoozes", async (c) => {
    const body = inboxSnoozeSubjectSchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid snooze.", 400);
    wakeMockRow(NOW_MS, body.data);
    return new Response(null, { status: 204 });
  });
}
