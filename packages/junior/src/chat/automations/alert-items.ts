import { createHash } from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { automationTaskDescription } from "@/chat/automations/task";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { eventAutomationTriggerSchema } from "@/chat/event-automations/types";
import { mapBounded } from "@/chat/fan-out";
import { AUTOMATION_REVIEW_ITEM_KEY_PREFIX } from "@/chat/review-items/access";
import { automationCreatorUserId } from "@/chat/review-items/assignees";
import {
  dismissOpenReviewItems,
  insertReviewItem,
  updateReviewItemContent,
  type ReviewItemContent,
} from "@/chat/review-items/store";
import { fallbackShortTitle } from "@/chat/services/short-title";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorDestinations,
  juniorReviewItems,
} from "@/db/schema";

// An Automation alert is a Review item that the Automation owns. It asks the
// creator to fix an Automation that needs attention: blocked, a trigger that
// the enabled plugins cannot serve, or a last run that failed or blocked.
// These are the rules of the `attention` scope in `collection.ts`. Core adds,
// changes, and closes the alert at each write that can change them. A
// different alert closes the old item and adds a new one. When a person
// dismisses an alert, no alert of that Automation shows again until it
// recovers: it is active, and its last run did not fail or block.

type AutomationRow = {
  kind: "scheduled" | "event";
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

/** The alert that an Automation needs now, if any, as the Inbox orders them. */
function automationAlert(
  row: AutomationRow,
): { body: string; identity: unknown[] } | undefined {
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
      identity: ["blocked", row.statusReason, row.lastRunId],
    };
  }
  const problems = row.kind === "event" ? triggerProblems(row.record) : [];
  if (problems.length > 0) {
    return {
      body: `Trigger unavailable: ${problems.join(" ")} Update the trigger.`,
      identity: ["trigger", ...problems],
    };
  }
  if (row.lastRunStatus === "failed" || row.lastRunStatus === "blocked") {
    const error = row.lastRunError ? oneLine(row.lastRunError) : undefined;
    return {
      body: `Last run ${row.lastRunStatus}${error ? `: ${error}` : "."}`,
      identity: ["run", row.lastRunId],
    };
  }
  return undefined;
}

/** The dedupe key of one alert. The same alert keeps the same key. */
function alertKey(automationId: string, identity: unknown[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
  return `${AUTOMATION_REVIEW_ITEM_KEY_PREFIX}${automationId}:${hash}`;
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
    const key = alert ? alertKey(automationId, alert.identity) : undefined;
    const owned = and(
      eq(juniorReviewItems.ownerKind, "automation"),
      eq(juniorReviewItems.ownerId, automationId),
    );
    const stale = await tx
      .select({ id: juniorReviewItems.id })
      .from(juniorReviewItems)
      .where(
        and(
          owned,
          eq(juniorReviewItems.status, "open"),
          key ? notInArray(juniorReviewItems.dedupeKey, [key]) : undefined,
        ),
      );
    await dismissOpenReviewItems(tx, {
      ids: stale.map((item) => item.id),
      nowMs,
      reason: alert
        ? "A newer alert replaced it."
        : "The Automation no longer needs attention.",
    });
    // A person dismissed an alert after the Automation last recovered, so
    // its alerts stay hidden. An alert that core closed hides nothing.
    const [dismissed] = await tx
      .select({ id: juniorReviewItems.id })
      .from(juniorReviewItems)
      .where(
        and(
          owned,
          isNotNull(juniorReviewItems.closedByUserId),
          row.alertRecoveredAtMs === null
            ? undefined
            : gt(juniorReviewItems.closedAt, new Date(row.alertRecoveredAtMs)),
        ),
      )
      .limit(1);
    const hidden = dismissed !== undefined;
    if (!needed && row.status === "active" && hidden) {
      await tx
        .update(juniorAutomations)
        .set({ alertRecoveredAtMs: nowMs })
        .where(eq(juniorAutomations.id, automationId));
      return;
    }
    if (!alert || !key || !creatorId || hidden) return;
    const [open] = await tx
      .select({
        body: juniorReviewItems.body,
        id: juniorReviewItems.id,
        title: juniorReviewItems.title,
        visibility: juniorReviewItems.visibility,
      })
      .from(juniorReviewItems)
      .where(
        and(
          owned,
          eq(juniorReviewItems.dedupeKey, key),
          eq(juniorReviewItems.status, "open"),
        ),
      );
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
    const content: ReviewItemContent = {
      assignedToEveryone: false,
      assigneeUserIds: [creatorId],
      body: alert.body,
      conversationIds: [],
      kind: "action",
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
        await updateReviewItemContent(tx, {
          ...content,
          id: open.id,
          nowMs,
        });
      }
      return;
    }
    await insertReviewItem(tx, {
      ...content,
      dedupeKey: key,
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
 * Review items has never synced. The heartbeat calls this. It syncs each
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
    .selectDistinct({ id: juniorReviewItems.ownerId })
    .from(juniorReviewItems)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorReviewItems.ownerId),
    )
    .where(
      and(
        eq(juniorReviewItems.ownerKind, "automation"),
        eq(juniorAutomations.kind, "event"),
        // An open alert, or a dismiss that hides alerts until a recovery
        // that a fixed trigger can bring without a run. Only an active
        // Automation can recover so; any other status waits for a write.
        or(
          eq(juniorReviewItems.status, "open"),
          and(
            eq(juniorAutomations.status, "active"),
            isNotNull(juniorReviewItems.closedByUserId),
            or(
              isNull(juniorAutomations.alertRecoveredAtMs),
              sql`${juniorReviewItems.closedAt} > to_timestamp(${juniorAutomations.alertRecoveredAtMs} / 1000.0)`,
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
            .select({ id: juniorReviewItems.id })
            .from(juniorReviewItems)
            .where(
              and(
                eq(juniorReviewItems.ownerKind, "automation"),
                eq(juniorReviewItems.ownerId, juniorAutomations.id),
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
