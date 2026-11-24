import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { automationTaskDescription } from "@/chat/automations/task";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  inboxItemRequestSchema,
  type InboxItemRequest,
} from "@/chat/inbox-items/evidence";
import { USER_INPUT_LIMITS } from "@/chat/inbox-items/user-input-request";
import { eventAutomationTriggerSchema } from "@/chat/event-automations/types";
import { mapBounded } from "@/chat/fan-out";
import { automationCreatorUserId } from "@/chat/inbox-items/assignees";
import {
  dismissOpenInboxItems,
  insertInboxItem,
  updateInboxItemContent,
  type InboxItemContent,
} from "@/chat/inbox-items/store";
import { INBOX_SUBJECT_KINDS } from "@/chat/inbox-items/subjects";
import { fallbackShortTitle } from "@/chat/services/short-title";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorDestinations,
  juniorInboxItems,
} from "@/db/schema";

// An Automation alert is an Inbox item that the Automation owns. It asks the
// creator to fix an Automation that needs attention: blocked, a trigger that
// the enabled plugins cannot serve, or a last run that failed or blocked.
// These are the rules of the `attention` scope in `collection.ts`. Core adds,
// changes, and closes the alert at each write that can change them. A
// different alert closes the old item and adds a new one. A failed-run alert
// offers Run again and Pause, which core takes (`answerAutomationAlert`).
// An alert that a person closed does not open again. When a person
// dismisses an alert, no alert of that Automation shows again until it
// recovers: it is active, its last run succeeded, and its trigger is
// available.

type AutomationRow = {
  kind: "scheduled" | "event";
  lastRunEndedAtMs: number | null;
  lastRunError: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  record: typeof juniorAutomations.$inferSelect.record;
  status: typeof juniorAutomations.$inferSelect.status;
  statusReason: string | null;
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The trigger problems of an event Automation with the enabled plugins. */
function triggerProblems(
  record: AutomationRow["record"],
  catalog = automationEventCatalog(getEventCatalog()),
): string[] {
  if (!("trigger" in record)) return [];
  const trigger = eventAutomationTriggerSchema.safeParse(record.trigger);
  if (!trigger.success) return ["The trigger is not valid."];
  return registeredEventTriggerProblems(catalog, trigger.data).map(
    (problem) => problem.message,
  );
}

/** Field id of the step that a person picks on a failed-run alert. */
export const AUTOMATION_ALERT_STEP_FIELD_ID = "step";

/** The steps of a failed-run alert, by the label that the person picks. */
export const AUTOMATION_ALERT_STEPS = {
  Pause: "pause",
  "Run again": "run",
} as const;

type AutomationAlertStepLabel = keyof typeof AUTOMATION_ALERT_STEPS;

/** The request that shows a failed-run alert's steps as buttons. */
function stepsRequest(
  body: string,
  steps: readonly AutomationAlertStepLabel[],
): InboxItemRequest {
  return inboxItemRequestSchema.parse({
    question: body.slice(0, USER_INPUT_LIMITS.maxQuestionChars),
    fields: [
      {
        id: AUTOMATION_ALERT_STEP_FIELD_ID,
        kind: "choice",
        label: "Next step",
        options: steps.map((label) => ({ label })),
      },
    ],
  });
}

/** The alert that an Automation needs now, if any, as the Inbox orders them. */
function automationAlert(row: AutomationRow):
  | {
      body: string;
      /**
       * When the cause of the alert began, such as the end of the run that
       * failed. A person who closed the same text since then saw this alert.
       */
      sinceMs?: number;
      steps?: AutomationAlertStepLabel[];
    }
  | undefined {
  if (
    row.status === "paused" ||
    row.status === "completed" ||
    row.status === "deleted"
  ) {
    return undefined;
  }
  if (row.status === "blocked") {
    const reason = row.statusReason ? oneLine(row.statusReason) : undefined;
    return {
      body: reason
        ? `Blocked: ${reason} Fix the problem, then resume it.`
        : "Blocked. Fix the problem, then resume it.",
      ...(row.lastRunEndedAtMs === null
        ? undefined
        : { sinceMs: row.lastRunEndedAtMs }),
    };
  }
  const problems = row.kind === "event" ? triggerProblems(row.record) : [];
  if (problems.length > 0) {
    return {
      body: `Trigger unavailable: ${problems.join(" ")} Update the trigger.`,
    };
  }
  if (row.lastRunStatus === "failed" || row.lastRunStatus === "blocked") {
    const error = row.lastRunError ? oneLine(row.lastRunError) : undefined;
    return {
      body: `Last run ${row.lastRunStatus}${error ? `: ${error}` : "."}`,
      ...(row.lastRunEndedAtMs === null
        ? undefined
        : { sinceMs: row.lastRunEndedAtMs }),
      // Only a scheduled Automation can run now. An event one runs when a
      // matching event arrives.
      steps: row.kind === "scheduled" ? ["Run again", "Pause"] : ["Pause"],
    };
  }
  return undefined;
}

/**
 * Add, change, or close the Automation alert of one Automation, to match
 * its state now. Call it after each write that can change whether the
 * Automation needs attention: a run outcome, a status change, an edit, or a
 * delete. It locks the Automation row, so concurrent calls for one
 * Automation run one after another. It writes nothing when the alert is
 * already right.
 */
export async function syncAutomationAlert(
  db: JuniorDatabase,
  automationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        alertRecoveredAtMs: juniorAutomations.alertRecoveredAtMs,
        channelId: juniorAutomations.channelId,
        kind: juniorAutomations.kind,
        lastRunEndedAtMs: sql<
          number | null
        >`coalesce(${juniorAutomationRuns.completedAtMs}, ${juniorAutomationRuns.startedAtMs})`.mapWith(
          (value: string | number | null) =>
            value === null ? null : Number(value),
        ),
        lastRunError: juniorAutomationRuns.errorMessage,
        lastRunId: juniorAutomations.lastRunId,
        lastRunStatus: juniorAutomationRuns.status,
        record: juniorAutomations.record,
        status: juniorAutomations.status,
        statusReason: juniorAutomations.statusReason,
        teamId: juniorAutomations.teamId,
        title: juniorAutomations.title,
      })
      .from(juniorAutomations)
      .leftJoin(
        juniorAutomationRuns,
        eq(juniorAutomationRuns.id, juniorAutomations.lastRunId),
      )
      .where(eq(juniorAutomations.id, automationId))
      .for("update", { of: juniorAutomations });
    if (!row) return;
    const creatorId = await automationCreatorUserId(tx, automationId);
    const needed = automationAlert(row);
    // Nobody can see an alert without a User, so it needs none.
    const alert = creatorId ? needed : undefined;
    // The Automation is the subject, so it has at most one open alert. A
    // newer alert changes that item.
    const owned = and(
      eq(juniorInboxItems.ownerKind, "automation"),
      eq(juniorInboxItems.ownerId, automationId),
    );
    if (!alert) {
      const stale = await tx
        .select({ id: juniorInboxItems.id })
        .from(juniorInboxItems)
        .where(and(owned, eq(juniorInboxItems.status, "open")));
      await dismissOpenInboxItems(tx, {
        ids: stale.map((item) => item.id),
        nowMs,
        reason: "The Automation no longer needs attention.",
      });
    }
    // Since the Automation last recovered, a person dismissed one of its
    // alerts, so they stay hidden, or a person closed this same alert, such
    // as with Run again, so it stays closed. The same alert has the same
    // text, and the person closed it after its cause began. An alert that
    // core closed hides nothing.
    const [closedByPerson] = await tx
      .select({ id: juniorInboxItems.id })
      .from(juniorInboxItems)
      .where(
        and(
          owned,
          isNotNull(juniorInboxItems.closedByUserId),
          row.alertRecoveredAtMs === null
            ? undefined
            : gt(juniorInboxItems.closedAt, new Date(row.alertRecoveredAtMs)),
          or(
            eq(juniorInboxItems.status, "dismissed"),
            alert
              ? and(
                  eq(juniorInboxItems.body, alert.body),
                  alert.sinceMs === undefined
                    ? undefined
                    : gte(juniorInboxItems.closedAt, new Date(alert.sinceMs)),
                )
              : undefined,
          ),
        ),
      )
      .limit(1);
    const hidden = closedByPerson !== undefined;
    // Recovered: active, its last run succeeded, and it needs no alert, so
    // its trigger is available. A paused Automation needs no alert, but its
    // problem can still be there, so a pause is no recovery.
    const recovered =
      !needed && row.status === "active" && row.lastRunStatus === "completed";
    if (recovered && hidden) {
      await tx
        .update(juniorAutomations)
        .set({ alertRecoveredAtMs: nowMs })
        .where(eq(juniorAutomations.id, automationId));
      return;
    }
    if (!alert || !creatorId || hidden) return;
    const [open] = await tx
      .select({
        body: juniorInboxItems.body,
        id: juniorInboxItems.id,
        title: juniorInboxItems.title,
        visibility: juniorInboxItems.visibility,
      })
      .from(juniorInboxItems)
      .where(and(owned, eq(juniorInboxItems.status, "open")));
    const [destination] = await tx
      .select({ visibility: juniorDestinations.visibility })
      .from(juniorDestinations)
      .where(
        and(
          eq(juniorDestinations.provider, "slack"),
          eq(juniorDestinations.providerTenantId, row.teamId),
          eq(juniorDestinations.providerDestinationId, row.channelId),
        ),
      );
    const content: InboxItemContent = {
      assignedToEveryone: false,
      assigneeUserIds: [creatorId],
      body: alert.body,
      conversationIds: [],
      kind: "action",
      subject: { id: automationId, kind: INBOX_SUBJECT_KINDS.automation },
      ...(alert.steps
        ? { request: stepsRequest(alert.body, alert.steps) }
        : undefined),
      title:
        row.title ??
        fallbackShortTitle(
          automationTaskDescription(row.record.task),
          row.kind === "scheduled"
            ? "Scheduled automation"
            : "Event automation",
        ),
      // The Automation's Destination decides who can see its alerts.
      visibility: destination?.visibility === "public" ? "public" : "private",
    };
    if (open) {
      // A private alert stays private, as a private Conversation's items do
      // when it becomes public.
      if (open.visibility === "private") content.visibility = "private";
      // A rename or a private Destination changes the open alert.
      if (
        open.title !== content.title ||
        open.body !== content.body ||
        open.visibility !== content.visibility
      ) {
        await updateInboxItemContent(tx, {
          ...content,
          id: open.id,
          nowMs,
        });
      }
      return;
    }
    await insertInboxItem(tx, {
      ...content,
      nowMs,
      owner: { id: automationId, kind: "automation" },
      tenant: { provider: "slack", providerTenantId: row.teamId },
    });
  });
}

/**
 * Sync the alerts that no write to an Automation syncs. A plugin change can
 * make an event trigger unavailable, or available again, with no write to
 * the Automation. An Automation that needed attention before alerts were
 * Inbox items has never synced. The heartbeat calls this. It syncs each
 * event Automation whose trigger cannot work, each one with an open alert,
 * and each blocked or failed Automation that has never had an alert.
 */
export async function syncAutomationAlerts(
  db: JuniorDatabase,
  nowMs: number,
): Promise<void> {
  const catalog = automationEventCatalog(getEventCatalog());
  const live = await db
    .select({ id: juniorAutomations.id, record: juniorAutomations.record })
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "event"),
        inArray(juniorAutomations.status, ["active", "blocked"]),
      ),
    );
  const unavailable = live.flatMap((automation) =>
    triggerProblems(automation.record, catalog).length > 0
      ? [automation.id]
      : [],
  );
  const alerted = await db
    .selectDistinct({ id: juniorInboxItems.ownerId })
    .from(juniorInboxItems)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorInboxItems.ownerId),
    )
    .where(
      and(
        eq(juniorInboxItems.ownerKind, "automation"),
        eq(juniorAutomations.kind, "event"),
        // An open alert, or a dismiss that hides alerts until a recovery
        // that a fixed trigger can bring without a run. Only an active
        // Automation can recover so; any other status waits for a write.
        or(
          eq(juniorInboxItems.status, "open"),
          and(
            eq(juniorAutomations.status, "active"),
            eq(juniorInboxItems.status, "dismissed"),
            isNotNull(juniorInboxItems.closedByUserId),
            or(
              isNull(juniorAutomations.alertRecoveredAtMs),
              sql`${juniorInboxItems.closedAt} > to_timestamp(${juniorAutomations.alertRecoveredAtMs} / 1000.0)`,
            ),
          ),
        ),
      ),
    );
  const neverAlerted = await db
    .select({ id: juniorAutomations.id })
    .from(juniorAutomations)
    .leftJoin(
      juniorAutomationRuns,
      eq(juniorAutomationRuns.id, juniorAutomations.lastRunId),
    )
    .where(
      and(
        or(
          eq(juniorAutomations.status, "blocked"),
          and(
            eq(juniorAutomations.status, "active"),
            inArray(juniorAutomationRuns.status, ["failed", "blocked"]),
          ),
        ),
        notExists(
          db
            .select({ id: juniorInboxItems.id })
            .from(juniorInboxItems)
            .where(
              and(
                eq(juniorInboxItems.ownerKind, "automation"),
                eq(juniorInboxItems.ownerId, juniorAutomations.id),
              ),
            ),
        ),
      ),
    );
  const ids = [
    ...new Set([
      ...unavailable,
      ...alerted.map((row) => row.id),
      ...neverAlerted.map((row) => row.id),
    ]),
  ];
  await mapBounded(ids, (id) => syncAutomationAlert(db, id, nowMs));
}
