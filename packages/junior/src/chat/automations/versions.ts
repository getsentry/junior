/** Automation versions keep each saved definition so people can see how it changed. */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  automationVersionSchema,
  type AutomationVersion,
} from "@/api/schema/automation";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationVersions } from "@/db/schema/automation-versions";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { canonicalJson } from "./revision";

type VersionedAutomation = ScheduledAutomation | EventAutomation;

function automationDefinition(task: VersionedAutomation) {
  const common = {
    title: task.title?.trim() || null,
    instruction: task.task.text,
    credentialMode: task.credentialMode,
    destination: task.destination,
    outcomes: task.outcomes,
  };
  return "schedule" in task
    ? { ...common, schedule: task.schedule }
    : { ...common, trigger: task.trigger };
}

/**
 * Save a version when the definition changed. Call this in the same
 * transaction and lock as the Automation write. Without `current`, the
 * Automation is new, so the creator saves version 1.
 */
export async function recordAutomationVersion(
  db: JuniorDatabase,
  kind: "scheduled" | "event",
  task: VersionedAutomation,
  current: VersionedAutomation | undefined,
  editedBy?: EventAutomation["createdBy"],
): Promise<void> {
  const definition = automationDefinition(task);
  if (
    current &&
    JSON.stringify(canonicalJson(automationDefinition(current))) ===
      JSON.stringify(canonicalJson(definition))
  )
    return;
  await db.insert(juniorAutomationVersions).values({
    kind,
    automationId: task.id,
    version: sql`(
      SELECT coalesce(max(${juniorAutomationVersions.version}), 0) + 1
      FROM ${juniorAutomationVersions}
      WHERE ${juniorAutomationVersions.kind} = ${kind}
        AND ${juniorAutomationVersions.automationId} = ${task.id}
    )`,
    createdAtMs: Date.now(),
    editedBy: editedBy ?? (current ? null : task.createdBy),
    definition,
  });
}

/** Read saved definitions, newest first. */
export async function listAutomationVersions(
  db: JuniorDatabase,
  kind: "scheduled" | "event",
  automationId: string,
  limit: number,
): Promise<AutomationVersion[]> {
  const rows = await db
    .select()
    .from(juniorAutomationVersions)
    .where(
      and(
        eq(juniorAutomationVersions.kind, kind),
        eq(juniorAutomationVersions.automationId, automationId),
      ),
    )
    .orderBy(desc(juniorAutomationVersions.version))
    .limit(limit);
  return rows.map((row) =>
    automationVersionSchema.parse({
      kind,
      version: row.version,
      createdAt: new Date(row.createdAtMs).toISOString(),
      editedBy: row.editedBy,
      definition: row.definition,
    }),
  );
}
