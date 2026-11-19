import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import * as z from "zod";
import { jsonResponse, throwApiError } from "@/api/http";
import { decodePageCursor, encodePageCursor } from "@/api/page-cursor";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/common";
import {
  reviewItemActionSchema,
  reviewItemCountQuerySchema,
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
  itemNeedsUser,
  reviewItemReaderForUser,
  reviewItemReaderForUserInConversation,
  type ReviewItemReader,
} from "@/chat/review-items/access";
import {
  actOnReviewItem,
  readReviewItemForUser,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import {
  readRelatedReviewWork,
  type RelatedReviewWork,
} from "@/chat/review-items/related";
import {
  countReviewItemsNeedingUserBySubject,
  listWaitingConversations,
  searchReviewItems,
  type ReviewItem,
  type ReviewItemFilters,
  type ReviewItemPosition,
} from "@/chat/review-items/store";
import type { ReviewItemDelivery } from "@/chat/review-items/changes";
import { countOwnedAutomationsNeedingAttention } from "@/chat/automations/collection";
import { countViewerSnoozes } from "@/chat/inbox-snoozes/viewer";
import { readLinkObjectType, readObjectLinkTypes } from "@/api/objects/resolve";
import { readItemRoots } from "./item-roots";

// A list of open items shows at most this many archived matches, with the
// first page. Open items page oldest first. Creation time never changes, and
// an item that closes while a person reads only leaves the open order, so a
// cursor never skips or repeats an item. A `status` list of closed items
// pages newest closed first: an item closes once, so its place never moves.
// The `waiting` sort pages what waits on the viewer first, newest first, so
// the first page holds what needs them now. An item that starts or stops
// waiting on the viewer while they read can move between the two groups;
// the next read of the first page shows it.
const ARCHIVED_LIMIT = 50;

/**
 * The list that a cursor belongs to. `status` names the closed statuses of
 * a closed list, such as `done,dismissed`; an open list has none. `sort`
 * names the waiting-first order of an open list.
 */
type ListFilters = Pick<
  ReviewItemFilters,
  "conversationId" | "forUserId" | "query" | "snoozedForUserId"
> & { sort?: "waiting"; status?: string };

const cursorSchema = z
  .object({
    closedAtMs: z.number().int().optional(),
    conversationId: z.string().min(1).optional(),
    createdAtMs: z.number().int(),
    forUserId: z.string().min(1).optional(),
    id: z.string().min(1),
    needsUser: z.boolean().optional(),
    query: z.string().min(1).optional(),
    snoozedForUserId: z.string().min(1).optional(),
    sort: z.literal("waiting").optional(),
    status: z.string().min(1).optional(),
    version: z.literal(2),
  })
  .strict();

const INVALID_CURSOR = "Invalid review item cursor.";

/**
 * Encode the last item of a page as the cursor of the next page. The
 * cursor names its list, so it cannot page through a different list.
 */
function encodeCursor(
  item: ReviewItem,
  filters: ListFilters,
  viewer: User,
): string {
  return encodePageCursor(cursorSchema, {
    ...filters,
    ...(filters.status && item.closedAt
      ? { closedAtMs: item.closedAt.getTime() }
      : undefined),
    ...(filters.sort
      ? { needsUser: itemNeedsUser(item, viewer.id) }
      : undefined),
    createdAtMs: item.createdAt.getTime(),
    id: item.id,
    version: 2,
  });
}

/** Decode a cursor of the same list, or stop the request with a 400. */
function decodeCursor(
  cursor: string,
  filters: ListFilters,
): ReviewItemPosition & { closedAt?: Date; needsUser?: boolean } {
  const parsed = decodePageCursor(cursorSchema, cursor, INVALID_CURSOR);
  if (
    parsed.conversationId !== filters.conversationId ||
    parsed.forUserId !== filters.forUserId ||
    parsed.query !== filters.query ||
    parsed.snoozedForUserId !== filters.snoozedForUserId ||
    parsed.sort !== filters.sort ||
    parsed.status !== filters.status ||
    (filters.status !== undefined && parsed.closedAtMs === undefined) ||
    (filters.sort !== undefined && parsed.needsUser === undefined)
  ) {
    throwApiError(400, INVALID_CURSOR);
  }
  return {
    ...(parsed.closedAtMs !== undefined
      ? { closedAt: new Date(parsed.closedAtMs) }
      : undefined),
    createdAt: new Date(parsed.createdAtMs),
    id: parsed.id,
    ...(parsed.needsUser !== undefined
      ? { needsUser: parsed.needsUser }
      : undefined),
  };
}

const ERROR_STATUS = {
  conflict: 409,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
} as const;

// The plugin that owns a link type recognizes the subject, such as a pull
// request from the GitHub plugin, so core keeps no provider URL rules.
function subjectPayload(
  subject: NonNullable<ReviewItem["subject"]>,
): NonNullable<ReviewItemPayload["subject"]> {
  const objectType = subject.url && readLinkObjectType(subject.url);
  return { ...subject, ...(objectType ? { objectType } : undefined) };
}

/** Build the API payload of one Review item for its viewer. */
function reviewItemPayload(
  item: ReviewItem,
  viewer: User,
  roots: Awaited<ReturnType<typeof readItemRoots>>,
  related: RelatedReviewWork | undefined,
): ReviewItemPayload {
  const root = roots.get(item.addedByConversationId);
  return {
    addedByConversationId: item.addedByConversationId,
    ...(root ? { addedByLabel: root.label } : undefined),
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
    rootConversationId: root?.rootConversationId ?? item.addedByConversationId,
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
    ...(related &&
    (related.items.length > 0 || related.conversationIds.length > 0)
      ? { related }
      : undefined),
    ...(item.request ? { request: item.request } : undefined),
    ...(item.subject ? { subject: subjectPayload(item.subject) } : undefined),
  };
}

/**
 * Build the payloads of a page of items, with the root of each one and the
 * related work of the open ones. Each read covers the page.
 */
async function reviewItemPayloads(
  items: readonly ReviewItem[],
  viewer: User,
  reader: ReviewItemReader,
): Promise<ReviewItemPayload[]> {
  const db = getDb();
  const [roots, related] = await Promise.all([
    readItemRoots(db, items, viewer),
    readRelatedReviewWork(db, reader, viewer, items),
  ]);
  return items.map((item) =>
    reviewItemPayload(item, viewer, roots, related.get(item.id)),
  );
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
        ...(query.snoozed ? { snoozedForUserId: viewer.id } : undefined),
        ...(query.status[0] === "open"
          ? query.sort
            ? { sort: query.sort }
            : undefined
          : { status: [...query.status].sort().join(",") }),
      };
      const after = query.cursor
        ? decodeCursor(query.cursor, filters)
        : undefined;
      const db = getDb();
      // A person in the Conversation sees every item linked to it.
      const reader = filters.conversationId
        ? await reviewItemReaderForUserInConversation(
            viewer,
            filters.conversationId,
          )
        : reviewItemReaderForUser(viewer);
      // Read one more item than a page to learn whether more follow.
      if (filters.status) {
        const closed = await searchReviewItems(db, reader, {
          ...filters,
          limit: query.limit + 1,
          order: "closed",
          statuses: query.status,
          ...(after?.closedAt
            ? { closedBefore: { closedAt: after.closedAt, id: after.id } }
            : undefined),
        });
        const page = closed.slice(0, query.limit);
        const last = page.at(-1);
        return jsonResponse(reviewItemListSchema, {
          items: await reviewItemPayloads(page, viewer, reader),
          ...(closed.length > query.limit && last
            ? { nextCursor: encodeCursor(last, filters, viewer) }
            : undefined),
        });
      }
      // The archived matches come once, with the first page. They do not
      // depend on the open page, so both reads run at once.
      const [open, archived] = await Promise.all([
        searchReviewItems(db, reader, {
          ...filters,
          // The viewer's Inbox hides the rows they snoozed until they wake. A
          // Conversation's own list and a search still show them.
          ...(query.for === "viewer" &&
          !filters.conversationId &&
          !filters.query &&
          !filters.snoozedForUserId
            ? { awakeForUserId: viewer.id }
            : undefined),
          limit: query.limit + 1,
          statuses: ["open"],
          ...(filters.sort
            ? {
                order: { needsUserId: viewer.id },
                ...(after
                  ? {
                      afterWaiting: {
                        createdAt: after.createdAt,
                        id: after.id,
                        needsUser: after.needsUser === true,
                      },
                    }
                  : undefined),
              }
            : { order: "oldest", ...(after ? { after } : undefined) }),
        }),
        (filters.query || query.include === "archived") && !after
          ? searchReviewItems(db, reader, {
              ...filters,
              limit: ARCHIVED_LIMIT + 1,
              statuses: ["done", "dismissed"],
            })
          : [],
      ]);
      const page = open.slice(0, query.limit);
      const last = page.at(-1);
      return jsonResponse(reviewItemListSchema, {
        items: await reviewItemPayloads(
          [...page, ...archived.slice(0, ARCHIVED_LIMIT)],
          viewer,
          reader,
        ),
        ...(archived.length > ARCHIVED_LIMIT
          ? { moreArchived: true }
          : undefined),
        ...(open.length > query.limit && last
          ? { nextCursor: encodeCursor(last, filters, viewer) }
          : undefined),
      });
    },
  );
  app.get(
    "/count",
    requireViewer,
    validateRequest(
      "query",
      reviewItemCountQuerySchema,
      "Invalid review item count query.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const query = context.req.valid("query");
      const db = getDb();
      // One query counts the badge and both bundles. The snoozed and
      // Automation counts run only when the request asks for them, so the
      // classic dashboard pays for one query.
      const [subjects, snoozed, automations] = await Promise.all([
        countReviewItemsNeedingUserBySubject(db, viewer.id),
        query.include.includes("snoozed") ? countViewerSnoozes(viewer) : 0,
        query.include.includes("automations")
          ? countOwnedAutomationsNeedingAttention(viewer)
          : undefined,
      ]);
      const linkTypes = readObjectLinkTypes();
      let codeChanges = 0;
      let decisions = 0;
      let needsViewer = 0;
      for (const subject of subjects) {
        needsViewer += subject.total;
        decisions += subject.decisions;
        if (
          subject.subjectUrl &&
          readLinkObjectType(subject.subjectUrl, linkTypes) === "code_change"
        ) {
          codeChanges += subject.total;
        }
      }
      return jsonResponse(reviewItemCountSchema, {
        ...(automations === undefined ? undefined : { automations }),
        codeChanges,
        decisions,
        needsViewer,
        snoozed,
      });
    },
  );
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
        const [payload] = await reviewItemPayloads(
          [item],
          viewer,
          reviewItemReaderForUser(viewer),
        );
        return jsonResponse(reviewItemSchema, payload!);
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
        const [payload] = await reviewItemPayloads(
          [item],
          viewer,
          reviewItemReaderForUser(viewer),
        );
        return jsonResponse(reviewItemSchema, payload!);
      } catch (error) {
        return actionErrorResponse(error);
      }
    },
  );
  return app;
}
