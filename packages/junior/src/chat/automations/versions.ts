/** Automation versions keep each saved definition so people can see how it changed. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationVersions } from "@/db/schema/automation-versions";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { canonicalJson } from "./revision";
import {
  automationEditorSchema,
  eventAutomationDefinitionSchema,
  scheduledAutomationDefinitionSchema,
  type AutomationEditor,
  type EventAutomationDefinition,
  type ScheduledAutomationDefinition,
} from "./version-schema";

/** One saved definition of an Automation. */
export type AutomationVersion =
  | {
      kind: "scheduled";
      version: number;
      createdAtMs: number;
      editedBy: AutomationEditor | null;
      definition: ScheduledAutomationDefinition;
    }
  | {
      kind: "event";
      version: number;
      createdAtMs: number;
      editedBy: AutomationEditor | null;
      definition: EventAutomationDefinition;
    };

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

function sameDefinition(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

/**
 * Save a new version when the definition changed. Call this in the same
 * transaction and lock as the Automation write. A missing `current` means the
 * Automation was just created, so a version is always saved.
 */
export async function recordAutomationVersion(
  db: JuniorDatabase,
  args: {
    kind: "scheduled" | "event";
    task: VersionedAutomation;
    current: VersionedAutomation | undefined;
    editedBy: AutomationEditor | undefined;
    nowMs?: number;
  },
): Promise<void> {
  const { kind, task, current } = args;
  const definition = automationDefinition(task);
  if (current && sameDefinition(automationDefinition(current), definition))
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
    createdAtMs: args.nowMs ?? Date.now(),
    editedBy: args.editedBy ?? null,
    definition,
  });
}

/** Read the newest saved definitions first. Undecodable retained rows are skipped. */
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
  const editor = automationEditorSchema.nullable();
  return rows.flatMap((row): AutomationVersion[] => {
    const editedBy = editor.safeParse(row.editedBy ?? null);
    if (!editedBy.success) return [];
    const common = {
      version: row.version,
      createdAtMs: row.createdAtMs,
      editedBy: editedBy.data,
    };
    if (kind === "scheduled") {
      const definition = scheduledAutomationDefinitionSchema.safeParse(
        row.definition,
      );
      return definition.success
        ? [{ ...common, kind, definition: definition.data }]
        : [];
    }
    const definition = eventAutomationDefinitionSchema.safeParse(
      row.definition,
    );
    return definition.success
      ? [{ ...common, kind, definition: definition.data }]
      : [];
  });
}
