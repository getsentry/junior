/**
 * Durable Plan items of a Conversation. The plan's own agent changes them
 * with `updatePlan`; a person can change a status in the dashboard. Each
 * change takes a new version from one global sequence, so the next Turn can
 * show the model only the changes that it has not seen.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorAgentBindings,
  juniorPlanItems,
  juniorPlanItemVersionSeq,
  juniorUsers,
} from "@/db/schema";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { PlanItem, PlanItemStatus } from "./types";

const PLAN_LOCK_PREFIX = "junior:plan";

/** Where a stored assignee points: a Conversation's agent or a User. */
export type StoredPlanAssignee =
  | { conversationId: string }
  | { userId: string };

/** Fields of a new Plan item. */
export interface NewPlanItem {
  title: string;
  notes?: string | undefined;
  status: PlanItemStatus;
  assignee: StoredPlanAssignee;
}

/** Changes to one Plan item. `notes: null` clears the notes. */
export interface PlanItemUpdate {
  id: number;
  title?: string | undefined;
  notes?: string | null | undefined;
  status?: PlanItemStatus | undefined;
  assignee?: StoredPlanAssignee | undefined;
}

/** One batch of agent changes, applied in one transaction. */
export interface PlanChange {
  add: NewPlanItem[];
  update: PlanItemUpdate[];
  remove: number[];
}

type PlanItemRow = typeof juniorPlanItems.$inferSelect;

function nextVersion() {
  return sql<number>`nextval(${juniorPlanItemVersionSeq.seqName}::regclass)`;
}

function assigneeColumns(assignee: StoredPlanAssignee) {
  return "userId" in assignee
    ? { assigneeConversationId: null, assigneeUserId: assignee.userId }
    : { assigneeConversationId: assignee.conversationId, assigneeUserId: null };
}

// An item without an assignee belongs to the plan's own agent.
function assigneeKey(
  row: { assigneeConversationId: string | null; assigneeUserId: string | null },
  conversationId: string,
): string {
  return row.assigneeUserId
    ? `user:${row.assigneeUserId}`
    : `conversation:${row.assigneeConversationId ?? conversationId}`;
}

function requireKnownIds(rows: Map<number, PlanItemRow>, ids: number[]) {
  const unknown = ids.filter((id) => !rows.has(id));
  if (unknown.length > 0) {
    throw new ToolInputError(
      `No plan item has id ${unknown.join(", ")}. Call updatePlan with no changes to list the open items.`,
    );
  }
}

/**
 * Check the plan that a change would leave: each id changes once, and each
 * assignee has at most one item in progress.
 */
function validateChange(
  conversationId: string,
  rows: Map<number, PlanItemRow>,
  change: PlanChange,
) {
  const touched = [...change.update.map((item) => item.id), ...change.remove];
  requireKnownIds(rows, touched);
  if (new Set(touched).size !== touched.length) {
    throw new ToolInputError(
      "Change each plan item once per call: an id is in more than one update or remove.",
    );
  }
  const removed = new Set(change.remove);
  const updates = new Map(change.update.map((item) => [item.id, item]));
  const after = [
    ...[...rows.values()]
      .filter((row) => !removed.has(row.id))
      .map((row) => {
        const update = updates.get(row.id);
        return {
          id: String(row.id),
          status: update?.status ?? row.status,
          ...(update?.assignee
            ? assigneeColumns(update.assignee)
            : {
                assigneeConversationId: row.assigneeConversationId,
                assigneeUserId: row.assigneeUserId,
              }),
        };
      }),
    ...change.add.map((item, index) => ({
      id: `new item ${index + 1}`,
      status: item.status,
      ...assigneeColumns(item.assignee),
    })),
  ];
  const inProgress = new Map<string, string[]>();
  for (const item of after) {
    if (item.status !== "in_progress") continue;
    const key = assigneeKey(item, conversationId);
    inProgress.set(key, [...(inProgress.get(key) ?? []), item.id]);
  }
  const conflict = [...inProgress.values()].find((ids) => ids.length > 1);
  if (conflict) {
    throw new ToolInputError(
      `Each assignee can have only one item in_progress, but ${conflict.join(" and ")} would be in_progress for the same assignee. Set the other item to pending, blocked, or done.`,
    );
  }
}

async function withPlanLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await executor.withLock(
    `${PLAN_LOCK_PREFIX}:${conversationId}`,
    async () => await executor.transaction(callback),
  );
}

/**
 * Apply one batch of changes from the plan's own agent. Return the items it
 * added or updated, and the items whose status a person set last and the
 * change replaced, as they were before it. Throws `ToolInputError` for an
 * unknown id or a second item in progress for one assignee.
 */
export async function changePlan(
  executor: JuniorSqlDatabase,
  args: { conversationId: string; change: PlanChange; nowMs: number },
): Promise<{ items: PlanItem[]; replacedPersonChanges: PlanItem[] }> {
  const { change, conversationId } = args;
  const now = new Date(args.nowMs);
  return await withPlanLock(executor, conversationId, async () => {
    const db = executor.db();
    const rows = new Map(
      (
        await db
          .select()
          .from(juniorPlanItems)
          .where(eq(juniorPlanItems.conversationId, conversationId))
      ).map((row) => [row.id, row]),
    );
    validateChange(conversationId, rows, change);
    // A person can change a status during a Turn, after the Turn context
    // showed the plan. The agent's change wins, and its result shows what it
    // replaced, since no later `<plan-delta>` can.
    const replacedIds = change.update
      .filter((update) => {
        const row = rows.get(update.id)!;
        return (
          row.changedByUserId !== null &&
          update.status !== undefined &&
          update.status !== row.status
        );
      })
      .map((update) => update.id);
    const replacedPersonChanges =
      replacedIds.length > 0
        ? (await listPlanItems(executor, conversationId)).filter((item) =>
            replacedIds.includes(item.id),
          )
        : [];
    if (change.remove.length > 0) {
      await db
        .delete(juniorPlanItems)
        .where(
          and(
            eq(juniorPlanItems.conversationId, conversationId),
            inArray(juniorPlanItems.id, change.remove),
          ),
        );
    }
    // Write items that end in progress as pending first, then set them in
    // progress. The unique index checks each statement, and only the final
    // state is checked above, so no step in between can break it.
    const endsInProgress = change.update
      .filter(
        (update) =>
          (update.status ?? rows.get(update.id)!.status) === "in_progress",
      )
      .map((update) => update.id);
    const changedIds: number[] = [];
    for (const update of change.update) {
      const status = endsInProgress.includes(update.id)
        ? "pending"
        : update.status;
      await db
        .update(juniorPlanItems)
        .set({
          ...(update.title !== undefined ? { title: update.title } : undefined),
          ...(update.notes !== undefined ? { notes: update.notes } : undefined),
          ...(status ? { status } : undefined),
          ...(update.assignee ? assigneeColumns(update.assignee) : undefined),
          changedByUserId: null,
          updatedAt: now,
          version: nextVersion(),
        })
        .where(
          and(
            eq(juniorPlanItems.conversationId, conversationId),
            eq(juniorPlanItems.id, update.id),
          ),
        );
      changedIds.push(update.id);
    }
    if (endsInProgress.length > 0) {
      await db
        .update(juniorPlanItems)
        .set({ status: "in_progress" })
        .where(
          and(
            eq(juniorPlanItems.conversationId, conversationId),
            inArray(juniorPlanItems.id, endsInProgress),
          ),
        );
    }
    // Insert one at a time, so ids follow the order of `add`.
    for (const item of change.add) {
      const [inserted] = await db
        .insert(juniorPlanItems)
        .values({
          conversationId,
          id: nextVersion(),
          title: item.title,
          notes: item.notes ?? null,
          status: item.status,
          ...assigneeColumns(item.assignee),
          version: nextVersion(),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: juniorPlanItems.id });
      changedIds.push(inserted!.id);
    }
    // Open detail views of the Conversation reload the plan on this bump.
    await touchConversationDetail(db, [conversationId]);
    const items = await listPlanItems(executor, conversationId);
    return {
      items: changedIds.flatMap(
        (id) => items.find((item) => item.id === id) ?? [],
      ),
      replacedPersonChanges,
    };
  });
}

/**
 * Set the status of one item for a person, and return the item. Returns
 * undefined when the plan has no such item.
 */
export async function setPlanItemStatusByUser(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    id: number;
    nowMs: number;
    status: Exclude<PlanItemStatus, "in_progress">;
    userId: string;
  },
): Promise<PlanItem | undefined> {
  return await withPlanLock(executor, args.conversationId, async () => {
    const updated = await executor
      .db()
      .update(juniorPlanItems)
      .set({
        status: args.status,
        changedByUserId: args.userId,
        updatedAt: new Date(args.nowMs),
        version: nextVersion(),
      })
      .where(
        and(
          eq(juniorPlanItems.conversationId, args.conversationId),
          eq(juniorPlanItems.id, args.id),
        ),
      )
      .returning({ id: juniorPlanItems.id });
    if (updated.length === 0) return undefined;
    await touchConversationDetail(executor.db(), [args.conversationId]);
    const items = await listPlanItems(executor, args.conversationId);
    return items.find((item) => item.id === args.id);
  });
}

/** List every item of one plan, oldest first, with assignees resolved. */
export async function listPlanItems(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<PlanItem[]> {
  const assignedUser = alias(juniorUsers, "assigned_user");
  const changedByUser = alias(juniorUsers, "changed_by_user");
  const rows = await executor
    .db()
    .select({
      item: juniorPlanItems,
      agentName: juniorAgentBindings.name,
      assignedUserEmail: assignedUser.primaryEmail,
      assignedUserName: assignedUser.displayName,
      changedByEmail: changedByUser.primaryEmail,
      changedByName: changedByUser.displayName,
    })
    .from(juniorPlanItems)
    .leftJoin(
      juniorAgentBindings,
      and(
        eq(juniorAgentBindings.parentConversationId, conversationId),
        eq(
          juniorAgentBindings.childConversationId,
          juniorPlanItems.assigneeConversationId,
        ),
      ),
    )
    .leftJoin(assignedUser, eq(assignedUser.id, juniorPlanItems.assigneeUserId))
    .leftJoin(
      changedByUser,
      eq(changedByUser.id, juniorPlanItems.changedByUserId),
    )
    .where(eq(juniorPlanItems.conversationId, conversationId))
    .orderBy(asc(juniorPlanItems.id));
  return rows.map(
    ({
      item,
      agentName,
      assignedUserEmail,
      assignedUserName,
      changedByEmail,
      changedByName,
    }) => ({
      id: item.id,
      title: item.title,
      ...(item.notes ? { notes: item.notes } : undefined),
      status: item.status,
      assignee: item.assigneeUserId
        ? {
            kind: "user" as const,
            userId: item.assigneeUserId,
            // The foreign key keeps the User while the item points to it.
            email: assignedUserEmail ?? "",
            ...(assignedUserName ? { name: assignedUserName } : undefined),
          }
        : (item.assigneeConversationId ?? conversationId) === conversationId
          ? { kind: "self" as const }
          : {
              kind: "agent" as const,
              conversationId: item.assigneeConversationId!,
              ...(agentName ? { name: agentName } : undefined),
            },
      version: item.version,
      ...(item.changedByUserId
        ? {
            changedBy: {
              userId: item.changedByUserId,
              email: changedByEmail ?? "",
              ...(changedByName ? { name: changedByName } : undefined),
            },
          }
        : undefined),
      createdAtMs: item.createdAt.getTime(),
      updatedAtMs: item.updatedAt.getTime(),
    }),
  );
}

/** Delete the plans of purged Conversations. Titles and notes are content. */
export async function deletePlanItems(
  executor: JuniorSqlDatabase,
  conversationIds: string[],
): Promise<void> {
  if (conversationIds.length === 0) return;
  await executor
    .db()
    .delete(juniorPlanItems)
    .where(inArray(juniorPlanItems.conversationId, conversationIds));
}
