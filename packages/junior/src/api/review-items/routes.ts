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
import { getDb } from "@/chat/db";
import {
  canActOnReviewItem,
  isOnlyAssignee,
  reviewItemReaderForUser,
} from "@/chat/review-items/access";
import {
  actOnReviewItem,
  readReviewItemForUser,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import {
  countReviewItemsNeedingUser,
  listWaitingConversations,
  searchReviewItems,
  type ReviewItem,
  type ReviewItemFilters,
  type ReviewItemPosition,
} from "@/chat/review-items/store";
import type { ReviewItemDelivery } from "@/chat/review-items/changes";

// A list shows at most this many archived matches, with the first page.
// Only open items page, oldest first. Creation time never changes, and an
// item that closes while a person reads only leaves the open order, so a
// cursor never skips or repeats an item.
const ARCHIVED_LIMIT = 50;

/** The list that a cursor belongs to. */
type ListFilters = Pick<
  ReviewItemFilters,
  "conversationId" | "forUserId" | "query"
>;

const cursorSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    createdAtMs: z.number().int(),
    forUserId: z.string().min(1).optional(),
    id: z.string().min(1),
    query: z.string().min(1).optional(),
    version: z.literal(2),
  })
  .strict();

/**
 * Encode the last open item of a page as the cursor of the next page. The
 * cursor names its list, so it cannot page through a different list.
 */
function encodeCursor(item: ReviewItem, filters: ListFilters): string {
  return Buffer.from(
    JSON.stringify({
      ...filters,
      createdAtMs: item.createdAt.getTime(),
      id: item.id,
      version: 2,
    }),
    "utf8",
  ).toString("base64url");
}

/** Decode a cursor of the same list, or return undefined. */
function decodeCursor(
  cursor: string,
  filters: ListFilters,
): ReviewItemPosition | undefined {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (
      parsed.conversationId !== filters.conversationId ||
      parsed.forUserId !== filters.forUserId ||
      parsed.query !== filters.query
    ) {
      return undefined;
    }
    return { createdAt: new Date(parsed.createdAtMs), id: parsed.id };
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
function reviewItemPayload(item: ReviewItem, viewer: User): ReviewItemPayload {
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
    ...(item.addedByTurnId ? { addedByTurnId: item.addedByTurnId } : undefined),
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
  delivery: ReviewItemDelivery;
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
      const filters: ListFilters = {
        ...(query.conversationId
          ? { conversationId: query.conversationId }
          : undefined),
        ...(query.for === "viewer" ? { forUserId: viewer.id } : undefined),
        ...(query.q ? { query: query.q } : undefined),
      };
      const after = query.cursor
        ? decodeCursor(query.cursor, filters)
        : undefined;
      if (query.cursor && !after) {
        return jsonResponse(
          apiErrorSchema,
          { error: "Invalid review item cursor." },
          { status: 400 },
        );
      }
      const db = getDb();
      const reader = reviewItemReaderForUser(viewer);
      // Read one more item than a page to learn whether more follow.
      const open = await searchReviewItems(db, reader, {
        ...filters,
        limit: query.limit + 1,
        order: "oldest",
        statuses: ["open"],
        ...(after ? { after } : undefined),
      });
      const page = open.slice(0, query.limit);
      const last = page.at(-1);
      // The archived matches come once, with the first page.
      const archived =
        (filters.query || query.include === "archived") && !after
          ? await searchReviewItems(db, reader, {
              ...filters,
              limit: ARCHIVED_LIMIT + 1,
              statuses: ["done", "dismissed"],
            })
          : [];
      return jsonResponse(reviewItemListSchema, {
        items: [...page, ...archived.slice(0, ARCHIVED_LIMIT)].map((item) =>
          reviewItemPayload(item, viewer),
        ),
        ...(archived.length > ARCHIVED_LIMIT
          ? { moreArchived: true }
          : undefined),
        ...(open.length > query.limit && last
          ? { nextCursor: encodeCursor(last, filters) }
          : undefined),
      });
    },
  );
  app.get("/count", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(reviewItemCountSchema, {
      needsViewer: await countReviewItemsNeedingUser(getDb(), viewer.id),
    });
  });
  app.get("/waiting-conversations", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(reviewItemWaitingConversationsSchema, {
      conversations: await listWaitingConversations(getDb(), viewer.id),
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
          delivery: services.delivery,
          id,
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
