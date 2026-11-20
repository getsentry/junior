import { createHash } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { automationTaskDescription } from "@/chat/automations/task";
import { getDb } from "@/chat/db";
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
// different alert closes the old item and adds a new one, so an alert that
// the creator closed stays closed until the Automation needs them again for
// a new reason.

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
function triggerProblems(row: AutomationRow): string[] {
  if (row.kind !== "event" || !("trigger" in row.record)) return [];
  const trigger = eventAutomationTriggerSchema.safeParse(row.record.trigger);
  if (!trigger.success) return ["The trigger is not valid."];
  return registeredEventTriggerProblems(
    automationEventCatalog(getEventCatalog()),
    trigger.data,
  ).map((problem) => problem.message);
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
  const problems = triggerProblems(row);
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
    // Nobody can see an alert without a User, so it needs none.
    const alert = creatorId ? automationAlert(row) : undefined;
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
    if (!alert || !key || !creatorId) return;
    const [current] = await tx
      .select({
        body: juniorReviewItems.body,
        closedByUserId: juniorReviewItems.closedByUserId,
        id: juniorReviewItems.id,
        status: juniorReviewItems.status,
        title: juniorReviewItems.title,
        visibility: juniorReviewItems.visibility,
      })
      .from(juniorReviewItems)
      .where(and(owned, eq(juniorReviewItems.dedupeKey, key)))
      .orderBy(desc(juniorReviewItems.createdAt))
      .limit(1);
    // A person closed this alert, so it shows again only for a new one. An
    // alert that core closed because it no longer applied shows again when
    // it applies again.
    if (current && current.status !== "open" && current.closedByUserId) return;
    const open = current?.status === "open" ? current : undefined;
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
 * Sync the alerts of event Automations with the enabled plugins. A trigger
 * becomes unavailable or available again only when the plugins change, with
 * no write to the Automation, so the heartbeat calls this. It syncs each
 * event Automation whose trigger cannot work, and each one with an open
 * alert. Returns how many it synced.
 */
export async function syncEventTriggerAlerts(
  db: JuniorDatabase = getDb(),
  nowMs = Date.now(),
): Promise<number> {
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
  const unavailable = live.flatMap((automation) => {
    const trigger =
      "trigger" in automation.record
        ? eventAutomationTriggerSchema.safeParse(automation.record.trigger)
        : undefined;
    return trigger?.success &&
      registeredEventTriggerProblems(catalog, trigger.data).length === 0
      ? []
      : [automation.id];
  });
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
        eq(juniorReviewItems.status, "open"),
        eq(juniorAutomations.kind, "event"),
      ),
    );
  const ids = [...new Set([...unavailable, ...alerted.map((row) => row.id)])];
  await mapBounded(ids, (id) => syncAutomationAlert(db, id, nowMs));
  return ids.length;
}
