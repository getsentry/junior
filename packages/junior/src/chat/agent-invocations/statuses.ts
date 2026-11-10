// Kept apart from the Drizzle table so browser code that imports these
// values does not bundle drizzle-orm and the table definitions.

export const AGENT_INVOCATION_STATUSES = [
  "pending",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const;

export const AGENT_INVOCATION_MAILBOX_STATUSES = [
  "pending",
  "appended",
] as const;

/**
 * Parent mailbox append state. Only terminal invocations have a value.
 * `replaced` means the child still had open work, so a later agent invocation
 * on the same child sends the result instead. `skipped` means a stop ended
 * the work, so the result is never used. `steered` means the agent invocation
 * that was running read the input as a steering message, so its result covers
 * this one.
 */
export const AGENT_INVOCATION_PARENT_MAILBOX_STATUSES = [
  "pending",
  "appended",
  "replaced",
  "skipped",
  "steered",
] as const;

/**
 * Where an agent invocation's work came from. A `parent_task` comes from a
 * parent `spawnAgent` or `messageAgent` tool call. `own_work` is work that the
 * runtime started on the child, such as a Watch Event or a result from the
 * child's own child agent.
 */
export const AGENT_INVOCATION_KINDS = ["parent_task", "own_work"] as const;
export type AgentInvocationKind = (typeof AGENT_INVOCATION_KINDS)[number];

export const AGENT_INVOCATION_RESULT_DELIVERIES = [
  "waiting",
  "sent",
  "dropped",
  "merged",
  "not_needed",
] as const;
export type AgentInvocationResultDelivery =
  (typeof AGENT_INVOCATION_RESULT_DELIVERIES)[number];
type ParentMailboxStatus =
  (typeof AGENT_INVOCATION_PARENT_MAILBOX_STATUSES)[number];

/**
 * How the result of one agent invocation reaches its parent. This table is
 * the only place that maps it to `parent_mailbox_status`. Only terminal
 * agent invocations have a value.
 *
 * `parentMailboxStatus` lists the old values that mean the same state. A
 * write stores the first one in the old column too, so a runtime that reads
 * only the old column acts the same. An old value reads as the first state
 * that lists it, so `steered` reads as `merged`. `not_needed` is stored as
 * `steered`, because no runtime treats `steered` as a stop or sends it.
 *
 * `next` lists the states that a later write can move a state to.
 */
export const RESULT_DELIVERY_STATES = {
  waiting: {
    meaning: "The parent is owed the result, and it is not sent yet.",
    parentMailboxStatus: ["pending"],
    next: ["sent", "dropped"],
  },
  sent: {
    meaning: "The result is in the parent's mailbox.",
    parentMailboxStatus: ["appended"],
    next: ["dropped"],
  },
  dropped: {
    meaning: "A stop ended the work, so the result is never sent.",
    parentMailboxStatus: ["skipped"],
    next: [],
  },
  merged: {
    meaning: "Another agent invocation of the same child sends this result.",
    parentMailboxStatus: ["steered", "replaced"],
    next: ["waiting", "dropped"],
  },
  not_needed: {
    meaning: "The child's own work finished. The parent is owed no result.",
    parentMailboxStatus: ["steered"],
    next: [],
  },
} as const satisfies Record<
  AgentInvocationResultDelivery,
  {
    meaning: string;
    next: readonly AgentInvocationResultDelivery[];
    parentMailboxStatus: readonly [
      ParentMailboxStatus,
      ...ParentMailboxStatus[],
    ];
  }
>;

/** Read an old `parent_mailbox_status` value as its result delivery. */
export function resultDeliveryFor(
  status: ParentMailboxStatus,
): AgentInvocationResultDelivery {
  return AGENT_INVOCATION_RESULT_DELIVERIES.find((delivery) =>
    (
      RESULT_DELIVERY_STATES[delivery]
        .parentMailboxStatus as readonly ParentMailboxStatus[]
    ).includes(status),
  )!;
}
