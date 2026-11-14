/** Statuses of a Plan item. `done` and `cancelled` close it. */
export const PLAN_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

/** One Plan item status. */
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

/** Whether an item with this status is still work to do. */
export function isOpenPlanItemStatus(status: PlanItemStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

/** Who works on a Plan item. */
export type PlanItemAssignee =
  | { kind: "self" }
  | { kind: "agent"; conversationId: string; name?: string | undefined }
  | {
      kind: "user";
      userId: string;
      email: string;
      name?: string | undefined;
    };

/** One stored Plan item, with its assignee resolved for display. */
export interface PlanItem {
  id: number;
  title: string;
  notes?: string | undefined;
  status: PlanItemStatus;
  assignee: PlanItemAssignee;
  /** Plan version of the latest change to the item. */
  version: number;
  /** The person who made the latest change. Unset when the plan's agent did. */
  changedBy?: { userId: string; name?: string | undefined } | undefined;
  createdAtMs: number;
  updatedAtMs: number;
}
