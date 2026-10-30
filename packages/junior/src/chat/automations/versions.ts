/** Automation versions keep each saved definition so people can see how it changed. */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  automationVersionSchema,
  type AutomationVersion,
} from "@/api/schema/automation";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationVersions } from "@/db/schema/automation-versions";
import { juniorAutomations } from "@/db/schema/automations";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { canonicalJson } from "./revision";

type VersionedAutomation = ScheduledAutomation | EventAutomation;

/** The person who saves a version, or `"junior"` when Junior saves it. */
export type AutomationVersionEditor = NonNullable<
  AutomationVersion["editedBy"]
>;

/** Return the versioned part of an Automation. Lifecycle and run state are excluded. */
export function automationDefinition(task: VersionedAutomation) {
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

/** Compare definition values after key sorting. */
export function sameDefinitionValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

/**
 * Save a version when the definition changed. Call this in the same
 * transaction and lock as the Automation write. Without `current`, the
 * Automation is new, so the creator saves version 1.
 */
export async function recordAutomationVersion(
  db: JuniorDatabase,
  task: VersionedAutomation,
  current: VersionedAutomation | undefined,
  editedBy?: AutomationVersionEditor,
): Promise<void> {
  const definition = automationDefinition(task);
  if (current && sameDefinitionValue(automationDefinition(current), definition))
    return;
  await db.insert(juniorAutomationVersions).values({
    automationId: task.id,
    version: sql`(
      SELECT coalesce(max(${juniorAutomationVersions.version}), 0) + 1
      FROM ${juniorAutomationVersions}
      WHERE ${juniorAutomationVersions.automationId} = ${task.id}
    )`,
    createdAtMs: Date.now(),
    editedBy: editedBy ?? (current ? null : task.createdBy),
    definition,
  });
}

/**
 * Select the newest saved version with the same definition as `task`.
 *
 * An Automation run stores this version so that a reader can see the
 * instruction that ran after the definition changes. The value is null when
 * no saved version has this definition.
 */
export function automationVersionOf(task: VersionedAutomation): SQL {
  return sql`(
    SELECT max(${juniorAutomationVersions.version})
    FROM ${juniorAutomationVersions}
    WHERE ${juniorAutomationVersions.automationId} = ${task.id}
      AND ${juniorAutomationVersions.definition} = ${JSON.stringify(automationDefinition(task))}::jsonb
  )`;
}

const versionColumns = {
  createdAtMs: juniorAutomationVersions.createdAtMs,
  definition: juniorAutomationVersions.definition,
  editedBy: juniorAutomationVersions.editedBy,
  kind: juniorAutomations.kind,
  version: juniorAutomationVersions.version,
};

function parseVersionRow(row: {
  createdAtMs: number;
  definition: unknown;
  editedBy: unknown;
  kind: "scheduled" | "event";
  version: number;
}): AutomationVersion {
  return automationVersionSchema.parse({
    kind: row.kind,
    version: row.version,
    createdAt: new Date(row.createdAtMs).toISOString(),
    editedBy: row.editedBy,
    definition: row.definition,
  });
}

/** Read one saved definition. */
export async function readAutomationVersion(
  db: JuniorDatabase,
  automationId: string,
  version: number,
): Promise<AutomationVersion | undefined> {
  const [row] = await db
    .select(versionColumns)
    .from(juniorAutomationVersions)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationVersions.automationId),
    )
    .where(
      and(
        eq(juniorAutomationVersions.automationId, automationId),
        eq(juniorAutomationVersions.version, version),
      ),
    )
    .limit(1);
  return row ? parseVersionRow(row) : undefined;
}

/** Read saved definitions, newest first. */
export async function listAutomationVersions(
  db: JuniorDatabase,
  automationId: string,
  limit: number,
): Promise<AutomationVersion[]> {
  const rows = await db
    .select(versionColumns)
    .from(juniorAutomationVersions)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationVersions.automationId),
    )
    .where(eq(juniorAutomationVersions.automationId, automationId))
    .orderBy(desc(juniorAutomationVersions.version))
    .limit(limit);
  return rows.map(parseVersionRow);
}
