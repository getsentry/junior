/**
 * Web edits and lifecycle actions. Anyone who can read an Automation can
 * manage it. Creator-only fields and credential rules still apply.
 */
import { getFirstRunAtMs } from "@/chat/scheduled-automations/cadence";
import { AutomationEditError, requireCredentialStart } from "./edit-rules";
import type { AutomationEditFields } from "./edit-schema";
import type { TaskOutcome, User } from "@sentry/junior-plugin-api";
import type { AutomationEdit, AutomationUpdate } from "@/api/schema/automation";
import { getDb } from "@/chat/db";
import { resolveTaskOutcomes } from "@/chat/task-outcomes";
import {
  deleteEventAutomation,
  saveEventAutomation,
  setEventAutomationStatus,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import { editEventAutomation } from "@/chat/event-automations/edit";
import type { EventAutomation } from "@/chat/event-automations/types";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  deleteScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { editScheduledAutomation } from "@/chat/scheduled-automations/edit";
import {
  weekdaySchema,
  type ScheduleIntent,
} from "@/chat/scheduled-automations/schedule-intent";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import type { AutomationViewer } from "./creator";
import { automationRevision, requireAutomationRevision } from "./revision";
import {
  resolveViewerTaskCandidate,
  ViewerTaskNotFoundError,
  type TaskCandidate,
} from "./read";
import {
  automationDefinition,
  readAutomationVersion,
  sameDefinitionValue,
} from "./versions";

type RestoredValues = {
  title: string | undefined;
  schedule?: ScheduledAutomation["schedule"];
};

type OwnedAutomation =
  | { kind: "scheduled"; task: ScheduledAutomation }
  | { kind: "event"; task: StoredEventAutomation };

/** Owners and public Destination readers can manage. Others get not found. */
async function requireEditableAutomation(
  user: User,
  id: string,
): Promise<TaskCandidate> {
  const candidate = await resolveViewerTaskCandidate(user, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  return candidate;
}

/**
 * Return the editor that a new version names: the creator, or the viewer's
 * account for the Destination provider and workspace.
 */
export function automationEditor(
  viewer: AutomationViewer,
  automation: TaskCandidate,
): EventAutomation["createdBy"] | undefined {
  if (automation.ownedByViewer) return automation.task.createdBy;
  const { destination } = automation.task;
  const identity = viewer.identities.find(
    (candidate) =>
      candidate.provider === destination.platform &&
      candidate.providerTenantId === destination.teamId,
  );
  if (!identity) return undefined;
  const editor: EventAutomation["createdBy"] = {
    slackUserId: identity.providerSubjectId,
  };
  if (identity.displayName) editor.fullName = identity.displayName;
  if (identity.handle) editor.userName = identity.handle;
  return editor;
}

function editView(
  automation: OwnedAutomation,
  ownedByViewer: boolean,
): AutomationEdit {
  const { task } = automation;
  const common = {
    ownedByViewer,
    id: task.id,
    revision: automationRevision(task),
    title: task.title ?? null,
    instruction: task.task.text,
    credentialMode: task.credentialMode,
    outcomes: task.outcomes,
    destination: task.destination,
    createdBy: task.createdBy,
  };
  if (automation.kind === "scheduled") {
    const status = automation.task.status;
    if (status === "deleted") throw new ViewerTaskNotFoundError();
    return {
      ...common,
      kind: "scheduled",
      status,
      schedule: automation.task.schedule,
      nextRunAtMs: automation.task.nextRunAtMs,
    };
  }
  return {
    ...common,
    kind: "event",
    status:
      automation.task.status === "deleted" ? "active" : automation.task.status,
    trigger: automation.task.trigger,
  };
}

/** Load exact editable values by ID, independent of list filters. */
export async function readViewerAutomationEdit(
  user: User,
  id: string,
): Promise<AutomationEdit> {
  const automation = await requireEditableAutomation(user, id);
  return editView(automation, automation.ownedByViewer);
}

/** Save a partial edit against the read revision, without dispatching work. */
export async function updateViewerAutomation(
  user: User,
  id: string,
  input: AutomationUpdate,
): Promise<AutomationEdit> {
  const current = await requireEditableAutomation(user, id);
  if (input.kind !== current.kind)
    throw new AutomationEditError("The trigger type cannot change.", "kind");
  requireAutomationRevision(current.task, input.revision);
  return saveViewerEdit(user, current, input);
}

/** `restored` carries version values that edit input cannot express, such as a cleared title. */
async function saveViewerEdit(
  user: User,
  current: TaskCandidate,
  input: AutomationUpdate,
  restored?: RestoredValues,
): Promise<AutomationEdit> {
  const isCreator = current.ownedByViewer;
  const editedBy = automationEditor(user, current);
  if (input.kind === "scheduled" && current.kind === "scheduled") {
    const next = await editScheduledAutomation(
      current.task,
      input,
      isCreator,
      Date.now(),
    );
    const task = await saveScheduledAutomation(
      getDb(),
      restored ? { ...next, ...restored } : next,
      input.revision,
      editedBy,
    );
    return editView({ kind: "scheduled", task }, isCreator);
  }
  if (input.kind === "event" && current.kind === "event") {
    const next = await editEventAutomation(
      current.task,
      input,
      isCreator,
      getEventCatalog(),
    );
    const task = await saveEventAutomation(
      getDb(),
      restored ? { ...next, title: restored.title } : next,
      input.revision,
      editedBy,
    );
    if (!task) throw new ViewerTaskNotFoundError();
    return editView({ kind: "event", task }, isCreator);
  }
  throw new ViewerTaskNotFoundError();
}

function scheduleIntent(
  schedule: ScheduledAutomation["schedule"],
): ScheduleIntent {
  const recurrence = schedule.recurrence;
  // A one-off version does not keep its run time, so it cannot be replayed.
  if (schedule.kind !== "recurring" || !recurrence) {
    throw new AutomationEditError(
      "A one-time Schedule cannot be restored. Set a new time in the editor.",
      "schedule",
    );
  }
  return {
    kind: "recurring",
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    time: `${String(recurrence.time.hour).padStart(2, "0")}:${String(recurrence.time.minute).padStart(2, "0")}`,
    weekdays: recurrence.weekdays?.map((day) => weekdaySchema.options[day]!),
    dayOfMonth: recurrence.dayOfMonth,
    month: recurrence.month,
    startDate: recurrence.startDate,
    timezone: schedule.timezone,
  };
}

/**
 * Turn saved outcomes back into edit input. Messages to the Automation
 * Destination or the creator DM are always allowed again. Other stored
 * Destinations must still be on the Automation.
 */
async function restorableOutcomes(
  current: TaskCandidate,
  outcomes: TaskOutcome[],
): Promise<NonNullable<AutomationEditFields["outcomes"]>> {
  const { task } = current;
  let creatorDm: TaskOutcome["destination"] | undefined;
  const restored: NonNullable<AutomationEditFields["outcomes"]> = [];
  for (const outcome of outcomes) {
    if (sameDefinitionValue(outcome.destination, task.destination)) {
      restored.push({
        action: outcome.action,
        destination: "current_conversation",
      });
      continue;
    }
    // Only the creator can change outcomes, so skip the Slack lookup for others.
    if (
      current.ownedByViewer &&
      !task.outcomes.some((stored) => sameDefinitionValue(stored, outcome))
    ) {
      creatorDm ??= (
        await resolveTaskOutcomes(
          [{ action: "send_message", destination: "task_creator" }],
          task.destination,
          task.createdBy.slackUserId,
        )
      )[0]!.destination;
      if (sameDefinitionValue(outcome.destination, creatorDm)) {
        restored.push({ action: outcome.action, destination: "task_creator" });
        continue;
      }
    }
    restored.push(outcome);
  }
  return restored;
}

/**
 * Make a saved version active. This saves its definition as a new version
 * through the same edit rules, so history is never rewritten.
 */
export async function activateViewerAutomationVersion(
  user: User,
  id: string,
  input: { version: number; revision: string },
): Promise<AutomationEdit> {
  const current = await requireEditableAutomation(user, id);
  requireAutomationRevision(current.task, input.revision);
  const saved = await readAutomationVersion(getDb(), id, input.version);
  if (!saved)
    throw new AutomationEditError("This version does not exist.", "version");
  const { definition } = saved;
  if (sameDefinitionValue(definition, automationDefinition(current.task)))
    return editView(current, current.ownedByViewer);
  if (!sameDefinitionValue(definition.destination, current.task.destination)) {
    throw new AutomationEditError(
      "This version delivers to another Destination. Move the automation from Slack instead.",
      "destination",
    );
  }
  const fields: AutomationEditFields = {};
  if (definition.instruction !== current.task.task.text)
    fields.instruction = definition.instruction;
  if (definition.credentialMode !== current.task.credentialMode)
    fields.credentialMode = definition.credentialMode;
  if (!sameDefinitionValue(definition.outcomes, current.task.outcomes))
    fields.outcomes = await restorableOutcomes(current, definition.outcomes);
  const title = definition.title ?? undefined;
  if (saved.kind === "scheduled" && current.kind === "scheduled") {
    const update: Extract<AutomationUpdate, { kind: "scheduled" }> = {
      kind: "scheduled",
      revision: input.revision,
      ...fields,
    };
    const restored: RestoredValues = { title };
    const { schedule } = saved.definition;
    if (!sameDefinitionValue(schedule, current.task.schedule)) {
      // Compile the Schedule for its next run, then keep its saved text.
      update.schedule = scheduleIntent(schedule);
      restored.schedule = schedule;
    }
    return saveViewerEdit(user, current, update, restored);
  }
  if (saved.kind === "event" && current.kind === "event") {
    const update: Extract<AutomationUpdate, { kind: "event" }> = {
      kind: "event",
      revision: input.revision,
      ...fields,
    };
    if (!sameDefinitionValue(saved.definition.trigger, current.task.trigger))
      update.trigger = saved.definition.trigger;
    return saveViewerEdit(user, current, update, { title });
  }
  throw new ViewerTaskNotFoundError();
}

/** Pause or resume future triggers from the dashboard. */
export async function changeViewerAutomationLifecycle(
  user: User,
  id: string,
  input: { action: "pause" | "resume"; revision: string },
): Promise<AutomationEdit> {
  const next = await changeAutomationLifecycle(
    await requireEditableAutomation(user, id),
    input,
  );
  return editView(next, next.ownedByViewer);
}

/**
 * Pause or resume future triggers. Already-claimed work can finish. A
 * non-creator cannot resume work that uses creator credentials.
 */
export async function changeAutomationLifecycle(
  current: TaskCandidate,
  input: { action: "pause" | "resume"; revision: string },
): Promise<TaskCandidate> {
  requireAutomationRevision(current.task, input.revision);
  const status = current.task.status;
  const ownedByViewer = current.ownedByViewer;
  if (status === "completed")
    throw new AutomationEditError("Completed Automations cannot be restarted.");
  if (input.action === "pause" && status === "paused") return current;
  if (input.action === "resume") {
    if (status !== "paused" && status !== "blocked")
      throw new AutomationEditError(
        "Only paused or blocked Automations can be resumed.",
      );
    requireCredentialStart(current.task, ownedByViewer);
  }
  if (current.kind === "event") {
    const task = await setEventAutomationStatus(
      getDb(),
      current.task.id,
      input.action === "pause" ? "paused" : "active",
      input.revision,
    );
    return { kind: "event", task, ownedByViewer };
  }
  const nowMs = Date.now();
  const next = { ...current.task, updatedAtMs: nowMs, runNowAtMs: undefined };
  if (input.action === "pause") {
    next.status = "paused";
    if (status === "blocked")
      next.statusReason ??=
        "A requirement blocked this Automation. Inspect its executions before resuming.";
  } else {
    // A pause must not erase an unresolved block. Resume blocked work explicitly.
    next.status =
      status === "paused" && next.statusReason ? "blocked" : "active";
    if (next.status === "active") {
      next.nextRunAtMs = next.schedule.recurrence
        ? getFirstRunAtMs({
            afterMs: nowMs,
            recurrence: next.schedule.recurrence,
            timezone: next.schedule.timezone,
          })
        : next.nextRunAtMs;
      if (!next.nextRunAtMs || next.nextRunAtMs <= nowMs) {
        throw new AutomationEditError(
          "This Schedule has no future occurrence. Set a future Schedule before resuming.",
          "schedule",
        );
      }
      next.statusReason = undefined;
    }
  }
  const task = await saveScheduledAutomation(getDb(), next, input.revision);
  return { kind: "scheduled", task, ownedByViewer };
}

/** Delete one Automation from the dashboard. */
export async function deleteViewerTask(user: User, id: string): Promise<void> {
  if (!(await deleteAutomation(await requireEditableAutomation(user, id))))
    throw new ViewerTaskNotFoundError();
}

/**
 * Delete one Automation that the caller may manage. The row stays for
 * history. Returns undefined when it was already deleted.
 */
export async function deleteAutomation(
  current: TaskCandidate,
): Promise<TaskCandidate | undefined> {
  if (current.kind === "event") {
    const task = await deleteEventAutomation(getDb(), current.task.id);
    return task ? { ...current, task } : undefined;
  }
  const task = await deleteScheduledAutomation(getDb(), current.task.id);
  return task ? { ...current, task } : undefined;
}
