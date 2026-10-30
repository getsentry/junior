import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
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
  type ReviewItemPayload,
} from "@/api/schema/review-item";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import { getDb } from "@/chat/db";
import {
  actOnReviewItem,
  canActOnReviewItem,
  readReviewItemForUser,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import {
  countReviewItems,
  reviewItemReaderForUser,
  searchReviewItems,
  type ReviewItem,
} from "@/chat/review-items/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

const LIST_LIMIT = 100;

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
      const query = context.req.valid("query");
      const view = query.view ?? "all";
      const items = await searchReviewItems(
        getDb(),
        reviewItemReaderForUser(viewer),
        {
          limit: LIST_LIMIT,
          statuses:
            query.archived === "true" ? ["done", "dismissed"] : ["open"],
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
      return jsonResponse(reviewItemListSchema, {
        items: items.map((item) => reviewItemPayload(item, viewer)),
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
