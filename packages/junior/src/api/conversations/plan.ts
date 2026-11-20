import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { listPlanItems, setPlanItemStatusByUser } from "@/chat/plan/store";
import { isOpenPlanItemStatus, type PlanItem } from "@/chat/plan/types";
import { throwApiError } from "../http";
import {
  type ConversationPlanItem,
  type ConversationPlanReport,
  type PlanItemStatusBody,
} from "../schema/plan";
import { readConversationAccessFromSql } from "./access";

/** Closed items that the report shows after the open ones. */
const RECENT_CLOSED_ITEMS = 5;

function reportItem(
  item: PlanItem,
  canViewPrivateContent: boolean,
): ConversationPlanItem {
  const { assignee } = item;
  return {
    id: item.id,
    status: item.status,
    updatedAt: new Date(item.updatedAtMs).toISOString(),
    ...(canViewPrivateContent
      ? {
          title: item.title,
          ...(item.notes ? { notes: item.notes } : undefined),
          assignee:
            assignee.kind === "user"
              ? { kind: "user", name: assignee.name ?? assignee.email }
              : assignee,
          ...(item.changedBy
            ? { changedBy: item.changedBy.name ?? item.changedBy.email }
            : undefined),
        }
      : {
          assignee:
            assignee.kind === "agent"
              ? { kind: "agent", conversationId: assignee.conversationId }
              : { kind: assignee.kind },
          redacted: true as const,
        }),
  };
}

/**
 * Load the plan of one Conversation: every open item, then the latest closed
 * ones. Throws a standard API not-found error. Viewers who cannot see
 * private content get no titles, notes, or names.
 */
export async function requireConversationPlan(
  conversationId: string,
  options: { viewer?: User | undefined } = {},
): Promise<ConversationPlanReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const [accessByConversation, items] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listPlanItems(getSqlExecutor(), conversationId),
  ]);
  const canViewPrivateContent =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;
  const closed = items
    .filter((item) => !isOpenPlanItemStatus(item.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, RECENT_CLOSED_ITEMS);
  return {
    conversationId,
    items: [
      ...items.filter((item) => isOpenPlanItemStatus(item.status)),
      ...closed,
    ].map((item) => reportItem(item, canViewPrivateContent)),
  };
}

/**
 * Set the status of one Plan item for a person. The plan is shared, so only
 * a Participant can change it, the same as the title. The agent sees the
 * change in a `<plan-delta>` on its next Turn.
 */
export async function setConversationPlanItemStatus(
  viewer: User,
  conversationId: string,
  itemId: number,
  body: PlanItemStatusBody,
): Promise<ConversationPlanItem> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  const conversationAccess = access.get(conversationId);
  if (!conversationAccess?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const item = await setPlanItemStatusByUser(getSqlExecutor(), {
    conversationId,
    id: itemId,
    nowMs: Date.now(),
    status: body.status,
    userId: viewer.id,
  });
  if (!item) throwApiError(404, "Plan item not found.");
  return reportItem(item, conversationAccess.canViewPrivateContent);
}
