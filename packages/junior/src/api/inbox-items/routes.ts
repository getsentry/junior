import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import * as z from "zod";
import { jsonResponse, throwApiError } from "@/api/http";
import { decodePageCursor, encodePageCursor } from "@/api/page-cursor";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/response";
import {
  inboxItemActionSchema,
  inboxItemCountQuerySchema,
  inboxItemCountSchema,
  inboxItemListQuerySchema,
  inboxItemListSchema,
  inboxItemParamsSchema,
  inboxItemSchema,
  inboxItemWaitingConversationsSchema,
  type InboxItemPayload,
} from "@/api/schema/inbox-item";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  canActOnInboxItem,
  inboxItemTodo,
  isOnlyAssignee,
  itemNeedsUser,
  inboxItemReaderForUser,
  inboxItemReaderForUserInConversation,
  REPLY_NOTICE_KEY_PREFIX,
  type InboxItemReader,
} from "@/chat/inbox-items/access";
import {
  actOnInboxItem,
  readInboxItemForUser,
  InboxItemActionError,
} from "@/chat/inbox-items/actions";
import {
  readRelatedReviewWork,
  type RelatedReviewWork,
} from "@/chat/inbox-items/related";
import {
  countInboxItemsNeedingUserBySubject,
  ownerConversationId,
  searchInboxItems,
  type InboxItem,
  type InboxItemFilters,
  type InboxItemPosition,
} from "@/chat/inbox-items/store";
import { listWaitingConversations } from "@/chat/inbox-items/waiting";
import type { InboxItemDelivery } from "@/chat/inbox-items/changes";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  clearInboxWakeReasons,
  readViewerInboxSnoozes,
} from "@/chat/inbox-snoozes/store";
import { snoozeSubjectResource } from "@/chat/inbox-snoozes/subject";
import { countViewerSnoozes } from "@/chat/inbox-snoozes/viewer";
import { readLinkObjectType, readObjectLinkTypes } from "@/api/objects/resolve";
import type { ActorIdentity } from "@/api/schema/conversation";
import type { InboxSnoozeWake } from "@/api/schema/inbox-snooze";
import type { InboxSnoozeWakeReason } from "@/db/schema/inbox-snoozes";
import { readItemRoots } from "./item-roots";
import { readInboxItemMentions } from "./mentions";

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
  InboxItemFilters,
  "conversationId" | "forUserId" | "ownerKind" | "query" | "snoozedForUserId"
> & { sort?: "waiting"; status?: string };

const cursorSchema = z
  .object({
    closedAtMs: z.number().int().optional(),
    conversationId: z.string().min(1).optional(),
    createdAtMs: z.number().int(),
    forUserId: z.string().min(1).optional(),
    id: z.string().min(1),
    needsUser: z.boolean().optional(),
    ownerKind: z.enum(["automation", "conversation"]).optional(),
    query: z.string().min(1).optional(),
    snoozedForUserId: z.string().min(1).optional(),
    sort: z.literal("waiting").optional(),
    status: z.string().min(1).optional(),
    version: z.literal(2),
  })
  .strict();

const INVALID_CURSOR = "Invalid inbox item cursor.";

/**
 * Encode the last item of a page as the cursor of the next page. The
 * cursor names its list, so it cannot page through a different list.
 */
function encodeCursor(
  item: InboxItem,
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
): InboxItemPosition & { closedAt?: Date; needsUser?: boolean } {
  const parsed = decodePageCursor(cursorSchema, cursor, INVALID_CURSOR);
  if (
    parsed.conversationId !== filters.conversationId ||
    parsed.forUserId !== filters.forUserId ||
    parsed.ownerKind !== filters.ownerKind ||
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
  subject: NonNullable<InboxItem["subject"]>,
): NonNullable<InboxItemPayload["subject"]> {
  const objectType = subject.url && readLinkObjectType(subject.url);
  const resource =
    subject.url && snoozeSubjectResource(getEventCatalog(), subject.url);
  return {
    ...subject,
    ...(objectType ? { objectType } : undefined),
    ...(resource
      ? {
          resource: {
            events: [...resource.events],
            namespace: resource.namespace,
            phrases: { ...resource.phrases },
            resourceType: resource.resourceType,
          },
        }
      : undefined),
  };
}

// The Event's source says how it reads after the resource's name, such as
// "is merged" from the GitHub plugin.
function wakePayload(reason: InboxSnoozeWakeReason): InboxSnoozeWake {
  if (reason.kind === "time") return reason;
  const phrase =
    getEventCatalog()[reason.namespace]?.events[reason.eventType]?.phrase;
  return {
    eventType: reason.eventType,
    kind: "event",
    resource: reason.identifier,
    ...(phrase ? { phrase } : undefined),
  };
}

/** Build the API payload of one Inbox item for its viewer. */
function inboxItemPayload(
  item: InboxItem,
  viewer: User,
  roots: Awaited<ReturnType<typeof readItemRoots>>,
  mentions: readonly ActorIdentity[],
  related: RelatedReviewWork | undefined,
  wake: InboxSnoozeWakeReason | undefined,
): InboxItemPayload {
  const conversationId = ownerConversationId(item);
  const root = conversationId ? roots.get(conversationId) : undefined;
  const todo = inboxItemTodo(item);
  return {
    ...(root ? { addedByLabel: root.label } : undefined),
    assignedToEveryone: item.assignedToEveryone,
    assignees: item.assignees,
    body: item.body,
    canAct: canActOnInboxItem(item, viewer.id),
    canTake:
      canActOnInboxItem(item, viewer.id) && !isOnlyAssignee(item, viewer.id),
    conversationIds: item.conversationIds,
    createdAt: item.createdAt.toISOString(),
    id: item.id,
    kind: item.kind,
    owner: item.owner,
    status: item.status,
    title: item.title,
    updatedAt: item.updatedAt.toISOString(),
    visibility: item.visibility,
    ...(conversationId
      ? { rootConversationId: root?.rootConversationId ?? conversationId }
      : undefined),
    ...(item.answer ? { answer: item.answer } : undefined),
    ...(item.addedByTurnId ? { addedByTurnId: item.addedByTurnId } : undefined),
    ...(item.automationId ? { automationId: item.automationId } : undefined),
    ...(item.closeReason ? { closeReason: item.closeReason } : undefined),
    ...(item.closedAt ? { closedAt: item.closedAt.toISOString() } : undefined),
    ...(item.closedBy ? { closedBy: item.closedBy } : undefined),
    ...(mentions.length > 0 ? { mentions: [...mentions] } : undefined),
    ...(related &&
    (related.items.length > 0 || related.conversationIds.length > 0)
      ? { related }
      : undefined),
    // Derived from the reply notice's dedupe key, so nothing more is stored.
    ...(item.dedupeKey.startsWith(REPLY_NOTICE_KEY_PREFIX)
      ? { replyNotice: true as const }
      : undefined),
    ...(item.request ? { request: item.request } : undefined),
    ...(item.subject ? { subject: subjectPayload(item.subject) } : undefined),
    ...(todo ? { todoId: todo.id } : undefined),
    ...(wake ? { wake: wakePayload(wake) } : undefined),
  };
}

/**
 * Build the payloads of a page of items, with the root of each one, the
 * people they mention, and the related work and wake reason of the open
 * ones. Each read covers the page, and the reads run at once.
 */
async function inboxItemPayloads(
  items: readonly InboxItem[],
  viewer: User,
  reader: InboxItemReader,
): Promise<InboxItemPayload[]> {
  const db = getDb();
  const [roots, mentions, related, snoozes] = await Promise.all([
    readItemRoots(db, items, viewer),
    readInboxItemMentions(getSqlExecutor(), items),
    readRelatedReviewWork(db, reader, viewer, items),
    readViewerInboxSnoozes(db, {
      inboxItemIds: items
        .filter((item) => item.status === "open")
        .map((item) => item.id),
      userId: viewer.id,
    }),
  ]);
  return items.map((item, index) => {
    const payload = inboxItemPayload(
      item,
      viewer,
      roots,
      mentions[index]!,
      related.get(item.id),
      snoozes.wakeReasons.get(item.id),
    );
    return snoozes.snoozed.has(item.id)
      ? { ...payload, snoozedByViewer: true }
      : payload;
  });
}

function actionErrorResponse(error: unknown): Response {
  if (error instanceof InboxItemActionError) {
    return jsonResponse(
      apiErrorSchema,
      { error: error.message },
      { status: ERROR_STATUS[error.code] },
    );
  }
  throw error;
}

/** Create the authenticated Inbox routes. */
export function createInboxItemRoutes(services: {
  delivery: InboxItemDelivery;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    requireViewer,
    validateRequest(
      "query",
      inboxItemListQuerySchema,
      "Invalid inbox item query.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const query = context.req.valid("query");
      const filters: ListFilters = {
        ...(query.conversationId
          ? { conversationId: query.conversationId }
          : undefined),
        ...(query.for === "viewer" ? { forUserId: viewer.id } : undefined),
        ...(query.owner ? { ownerKind: query.owner } : undefined),
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
        ? await inboxItemReaderForUserInConversation(
            viewer,
            filters.conversationId,
          )
        : inboxItemReaderForUser(viewer);
      // Read one more item than a page to learn whether more follow.
      if (filters.status) {
        const closed = await searchInboxItems(db, reader, {
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
        return jsonResponse(inboxItemListSchema, {
          items: await inboxItemPayloads(page, viewer, reader),
          ...(closed.length > query.limit && last
            ? { nextCursor: encodeCursor(last, filters, viewer) }
            : undefined),
        });
      }
      // The archived matches come once, with the first page. They do not
      // depend on the open page, so both reads run at once.
      const [open, archived] = await Promise.all([
        searchInboxItems(db, reader, {
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
          ? searchInboxItems(db, reader, {
              ...filters,
              limit: ARCHIVED_LIMIT + 1,
              statuses: ["done", "dismissed"],
            })
          : [],
      ]);
      const page = open.slice(0, query.limit);
      const last = page.at(-1);
      return jsonResponse(inboxItemListSchema, {
        items: await inboxItemPayloads(
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
      inboxItemCountQuerySchema,
      "Invalid inbox item count query.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const query = context.req.valid("query");
      const db = getDb();
      // One query counts the badge, both bundles, and the Automation alerts.
      // The snoozed count runs only when the request asks for it, so the
      // classic dashboard pays for one query.
      const [subjects, snoozed] = await Promise.all([
        countInboxItemsNeedingUserBySubject(db, viewer.id),
        query.include.includes("snoozed") ? countViewerSnoozes(viewer) : 0,
      ]);
      // The Automations badge counts the alerts that its To do lists.
      let automations = 0;
      const linkTypes = readObjectLinkTypes();
      let codeChanges = 0;
      let decisions = 0;
      let needsViewer = 0;
      let todos = 0;
      for (const subject of subjects) {
        automations += subject.automations;
        needsViewer += subject.total;
        decisions += subject.decisions;
        todos += subject.todos;
        if (
          subject.subjectUrl &&
          readLinkObjectType(subject.subjectUrl, linkTypes) === "code_change"
        ) {
          codeChanges += subject.total;
        }
      }
      return jsonResponse(inboxItemCountSchema, {
        ...(query.include.includes("automations")
          ? { automations }
          : undefined),
        codeChanges,
        decisions,
        needsViewer,
        snoozed,
        todos,
      });
    },
  );
  app.get("/waiting-conversations", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(inboxItemWaitingConversationsSchema, {
      conversations: await listWaitingConversations(getDb(), viewer.id),
    });
  });
  app.get(
    "/:id",
    requireViewer,
    validateRequest("param", inboxItemParamsSchema, "Invalid inbox item."),
    async (context) => {
      const viewer = context.get("viewer");
      try {
        const item = await readInboxItemForUser(
          viewer,
          context.req.valid("param").id,
        );
        const [payload] = await inboxItemPayloads(
          [item],
          viewer,
          inboxItemReaderForUser(viewer),
        );
        return jsonResponse(inboxItemSchema, payload!);
      } catch (error) {
        return actionErrorResponse(error);
      }
    },
  );
  app.post(
    "/:id/actions",
    requireViewer,
    validateRequest("param", inboxItemParamsSchema, "Invalid inbox item."),
    validateRequest("json", inboxItemActionSchema, "Invalid action."),
    async (context) => {
      const viewer = context.get("viewer");
      const body = context.req.valid("json");
      const { id } = context.req.valid("param");
      try {
        const item = await actOnInboxItem({
          action: body.action,
          delivery: services.delivery,
          id,
          user: viewer,
          ...(body.action === "submit"
            ? { answer: { ...body.answer, requestId: id } }
            : undefined),
        });
        // The viewer acted on the item, so it no longer says why it woke.
        await clearInboxWakeReasons(getDb(), {
          inboxItemIds: [id],
          userId: viewer.id,
        });
        const [payload] = await inboxItemPayloads(
          [item],
          viewer,
          inboxItemReaderForUser(viewer),
        );
        return jsonResponse(inboxItemSchema, payload!);
      } catch (error) {
        return actionErrorResponse(error);
      }
    },
  );
  return app;
}
