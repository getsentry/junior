/**
 * Web edits. Owners and public Destination readers can edit. Creator-only
 * rules still apply, and lifecycle actions stay creator-only.
 */
import { getFirstRunAtMs } from "@/chat/scheduled-automations/cadence";
import { AutomationEditError } from "./edit-rules";
import type { AutomationEditFields } from "./edit-schema";
import type { User } from "@sentry/junior-plugin-api";
import type { AutomationEdit, AutomationUpdate } from "@/api/schema/automation";
import { getDb } from "@/chat/db";
import {
  eventAutomationBelongsToUser,
  getEventAutomation,
  saveEventAutomation,
  setEventAutomationStatus,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import { eventAutomationTriggerAvailable } from "@/chat/event-automations/tool-support";
import { editEventAutomation } from "@/chat/event-automations/edit";
import type { EventAutomation } from "@/chat/event-automations/types";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { editScheduledAutomation } from "@/chat/scheduled-automations/edit";
import type { ScheduleIntent } from "@/chat/scheduled-automations/schedule-intent";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
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

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

async function requireOwnedAutomation(
  user: User,
  kind: AutomationEdit["kind"],
  id: string,
): Promise<OwnedAutomation> {
  if (kind === "scheduled") {
    const task = await readScheduledAutomation(getDb(), id);
    if (
      !task ||
      task.status === "deleted" ||
      !user.identities.some(
        (identity) => identity.id === task.creatorIdentityId,
      )
    )
      throw new ViewerTaskNotFoundError();
    return { kind, task };
  }
  const task = await getEventAutomation(getDb(), id);
  if (
    !task ||
    task.status === "deleted" ||
    !eventAutomationBelongsToUser(task, user)
  )
    throw new ViewerTaskNotFoundError();
  return { kind, task };
}

/** Owners and public Destination readers can edit. Others get not found. */
async function requireEditableAutomation(
  user: User,
  kind: AutomationEdit["kind"],
  id: string,
): Promise<TaskCandidate> {
  const candidate = await resolveViewerTaskCandidate(user, kind, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  return candidate;
}

/** Record the viewer's Slack identity in the Automation workspace as the editor. */
function viewerEditor(
  user: User,
  automation: TaskCandidate,
): EventAutomation["createdBy"] | undefined {
  if (automation.ownedByViewer) return automation.task.createdBy;
  const identity = user.identities.find(
    (candidate) =>
      candidate.provider === "slack" &&
      candidate.providerTenantId === automation.task.destination.teamId,
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
    status: automation.task.status === "paused" ? "paused" : "active",
    trigger: automation.task.trigger,
    triggerAvailable: eventAutomationTriggerAvailable(
      automation.task,
      getEventCatalog(),
    ),
  };
}

/** Load exact editable values by ID, independent of list filters. */
export async function readViewerAutomationEdit(
  user: User,
  kind: AutomationEdit["kind"],
  id: string,
): Promise<AutomationEdit> {
  const automation = await requireEditableAutomation(user, kind, id);
  return editView(automation, automation.ownedByViewer);
}

/** Save a partial edit against the read revision, without dispatching work. */
export async function updateViewerAutomation(
  user: User,
  id: string,
  input: AutomationUpdate,
): Promise<AutomationEdit> {
  const current = await requireEditableAutomation(user, input.kind, id);
  requireAutomationRevision(current.task, input.revision);
  return saveViewerEdit(user, current, input);
}

async function saveViewerEdit(
  user: User,
  current: TaskCandidate,
  input: AutomationUpdate,
  // Restored values that edit input cannot express, such as a cleared title.
  restored?: RestoredValues,
): Promise<AutomationEdit> {
  const isCreator = current.ownedByViewer;
  const editedBy = viewerEditor(user, current);
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
    weekdays: recurrence.weekdays?.map((day) => WEEKDAYS[day]!),
    dayOfMonth: recurrence.dayOfMonth,
    month: recurrence.month,
    startDate: recurrence.startDate,
    timezone: schedule.timezone,
  };
}

/**
 * Make a saved version active. This saves its definition as a new version
 * through the same edit rules, so history is never rewritten.
 */
export async function activateViewerAutomationVersion(
  user: User,
  kind: AutomationEdit["kind"],
  id: string,
  input: { version: number; revision: string },
): Promise<AutomationEdit> {
  const current = await requireEditableAutomation(user, kind, id);
  requireAutomationRevision(current.task, input.revision);
  const saved = await readAutomationVersion(getDb(), kind, id, input.version);
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
  if (!sameDefinitionValue(definition.outcomes, current.task.outcomes)) {
    // Messages to the Automation Destination are always allowed again.
    fields.outcomes = definition.outcomes.map((outcome) =>
      sameDefinitionValue(outcome.destination, current.task.destination)
        ? { action: outcome.action, destination: "current_conversation" }
        : outcome,
    );
  }
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

/** Pause or resume future triggers. Already-claimed work can finish. */
export async function changeViewerAutomationLifecycle(
  user: User,
  kind: AutomationEdit["kind"],
  id: string,
  input: { action: "pause" | "resume"; revision: string },
): Promise<AutomationEdit> {
  const current = await requireOwnedAutomation(user, kind, id);
  requireAutomationRevision(current.task, input.revision);
  const status = current.task.status;
  if (status === "completed")
    throw new AutomationEditError("Completed Automations cannot be restarted.");
  if (input.action === "pause" && status === "paused")
    return editView(current, true);
  if (
    input.action === "resume" &&
    status !== "paused" &&
    status !== "blocked"
  ) {
    throw new AutomationEditError(
      "Only paused or blocked Automations can be resumed.",
    );
  }
  if (current.kind === "event") {
    const task = await setEventAutomationStatus(
      getDb(),
      id,
      input.action === "pause" ? "paused" : "active",
      input.revision,
    );
    return editView({ kind: "event", task }, true);
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
  return editView({ kind: "scheduled", task }, true);
}
