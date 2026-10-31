import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { z } from "zod";
import { jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/common";
import {
  reviewItemActionSchema,
  reviewItemCountSchema,
  reviewItemListQuerySchema,
  reviewItemListSchema,
  reviewItemParamsSchema,
  reviewItemSchema,
  reviewItemWaitingConversationsSchema,
  type ReviewItemPayload,
} from "@/api/schema/review-item";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { getDb } from "@/chat/db";
import {
  actOnReviewItem,
  canActOnReviewItem,
  isOnlyAssignee,
  readReviewItemForUser,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import {
  countReviewItems,
  listWaitingConversationIds,
  reviewItemReaderForUser,
  searchReviewItems,
  type ReviewItem,
  type ReviewItemPosition,
} from "@/chat/review-items/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

const cursorSchema = z
  .object({
    filters: z.string(),
    id: z.string().min(1),
    updatedAtMs: z.number().int(),
    version: z.literal(1),
  })
  .strict();

/**
 * Encode the last item of a page as the cursor of the next page. The cursor
 * names the list filters, so it cannot page through a different list.
 */
function encodeCursor(item: ReviewItem, filters: string): string {
  return Buffer.from(
    JSON.stringify({
      filters,
      id: item.id,
      updatedAtMs: item.updatedAt.getTime(),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Decode a cursor for the same filters, or return undefined. */
function decodeCursor(
  cursor: string,
  filters: string,
): ReviewItemPosition | undefined {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.filters !== filters) return undefined;
    return { id: parsed.id, updatedAt: new Date(parsed.updatedAtMs) };
  } catch {
    return undefined;
  }
}

const ERROR_STATUS = {
  conflict: 409,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
} as const;

/** Build the API payload of one Review item for its viewer. */
export function reviewItemPayload(
  item: ReviewItem,
  viewer: User,
): ReviewItemPayload {
  return {
    addedByConversationId: item.addedByConversationId,
    assignedToEveryone: item.assignedToEveryone,
    assignees: item.assignees,
    body: item.body,
    canAct: canActOnReviewItem(item, viewer.id),
    canTake:
      canActOnReviewItem(item, viewer.id) && !isOnlyAssignee(item, viewer.id),
    conversationIds: item.conversationIds,
    createdAt: item.createdAt.toISOString(),
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    updatedAt: item.updatedAt.toISOString(),
    visibility: item.visibility,
    ...(item.answer ? { answer: item.answer } : undefined),
    ...(item.automationId ? { automationId: item.automationId } : undefined),
    ...(item.closeReason ? { closeReason: item.closeReason } : undefined),
    ...(item.closedAt ? { closedAt: item.closedAt.toISOString() } : undefined),
    ...(item.closedBy ? { closedBy: item.closedBy } : undefined),
    ...(item.request ? { request: item.request } : undefined),
    ...(item.subject ? { subject: item.subject } : undefined),
  };
}

function actionErrorResponse(error: unknown): Response {
  if (error instanceof ReviewItemActionError) {
    return jsonResponse(
      apiErrorSchema,
      { error: error.message },
      { status: ERROR_STATUS[error.code] },
    );
  }
  throw error;
}

/** Create the authenticated review desk routes. */
export function createReviewItemRoutes(services: {
  queue: ConversationWorkQueue;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    requireViewer,
    validateRequest(
      "query",
      reviewItemListQuerySchema,
      "Invalid review item query.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { cursor, limit, ...query } = context.req.valid("query");
      const view = query.view ?? "all";
      const filters = JSON.stringify([
        query.archived === "true",
        view,
        query.conversationId ?? null,
        query.q ?? null,
      ]);
      const after = cursor ? decodeCursor(cursor, filters) : undefined;
      if (cursor && !after) {
        return jsonResponse(
          apiErrorSchema,
          { error: "Invalid review item cursor." },
          { status: 400 },
        );
      }
      // Read one more item than a page to learn whether another page follows.
      const items = await searchReviewItems(
        getDb(),
        reviewItemReaderForUser(viewer),
        {
          limit: limit + 1,
          statuses:
            query.archived === "true" ? ["done", "dismissed"] : ["open"],
          ...(after ? { after } : undefined),
          ...(view === "mine"
            ? { assignee: { userId: viewer.id } }
            : view === "everyone"
              ? { assignee: { everyone: true } }
              : undefined),
          ...(query.conversationId
            ? { conversationId: query.conversationId }
            : undefined),
          ...(query.q ? { query: query.q } : undefined),
        },
      );
      const page = items.slice(0, limit);
      const last = page.at(-1);
      return jsonResponse(reviewItemListSchema, {
        items: page.map((item) => reviewItemPayload(item, viewer)),
        ...(items.length > limit && last
          ? { nextCursor: encodeCursor(last, filters) }
          : undefined),
      });
    },
  );
  app.get("/count", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(reviewItemCountSchema, {
      mine: await countReviewItems(getDb(), reviewItemReaderForUser(viewer), {
        assignee: { userId: viewer.id },
        statuses: ["open"],
      }),
    });
  });
  app.get("/waiting-conversations", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(reviewItemWaitingConversationsSchema, {
      conversationIds: await listWaitingConversationIds(getDb(), viewer),
    });
  });
  app.get(
    "/:id",
    requireViewer,
    validateRequest("param", reviewItemParamsSchema, "Invalid review item."),
    async (context) => {
      const viewer = context.get("viewer");
      try {
        const item = await readReviewItemForUser(
          viewer,
          context.req.valid("param").id,
        );
        return jsonResponse(reviewItemSchema, reviewItemPayload(item, viewer));
      } catch (error) {
        return actionErrorResponse(error);
      }
    },
  );
  app.post(
    "/:id/actions",
    requireViewer,
    validateRequest("param", reviewItemParamsSchema, "Invalid review item."),
    validateRequest("json", reviewItemActionSchema, "Invalid action."),
    async (context) => {
      const viewer = context.get("viewer");
      const body = context.req.valid("json");
      const { id } = context.req.valid("param");
      try {
        const item = await actOnReviewItem({
          action: body.action,
          getSlackAdapter: getProductionSlackAdapter,
          id,
          queue: services.queue,
          user: viewer,
          ...(body.action === "submit"
            ? { answer: { ...body.answer, requestId: id } }
            : undefined),
        });
        return jsonResponse(reviewItemSchema, reviewItemPayload(item, viewer));
      } catch (error) {
        return actionErrorResponse(error);
      }
    },
  );
  return app;
}
