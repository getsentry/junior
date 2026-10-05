/** Creator-only web edits. Public read access never grants write authority. */
import { getFirstRunAtMs } from "@/chat/scheduled-automations/cadence";
import { AutomationEditError } from "./edit-rules";
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
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { editScheduledAutomation } from "@/chat/scheduled-automations/edit";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { automationRevision, requireAutomationRevision } from "./revision";
import { ViewerTaskNotFoundError } from "./read";

type OwnedAutomation =
  | { kind: "scheduled"; task: ScheduledAutomation }
  | { kind: "event"; task: StoredEventAutomation };

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

function editView(automation: OwnedAutomation): AutomationEdit {
  const { task } = automation;
  const common = {
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
  return editView(await requireOwnedAutomation(user, kind, id));
}

/** Save a partial edit against the read revision, without dispatching work. */
export async function updateViewerAutomation(
  user: User,
  id: string,
  input: AutomationUpdate,
): Promise<AutomationEdit> {
  const current = await requireOwnedAutomation(user, input.kind, id);
  requireAutomationRevision(current.task, input.revision);
  if (input.kind === "scheduled" && current.kind === "scheduled") {
    const next = await editScheduledAutomation(
      current.task,
      input,
      true,
      Date.now(),
    );
    // Web edits are creator-only, so the creator is the editor.
    const task = await saveScheduledAutomation(
      getDb(),
      next,
      input.revision,
      current.task.createdBy,
    );
    return editView({ kind: "scheduled", task });
  }
  if (input.kind === "event" && current.kind === "event") {
    const next = await editEventAutomation(
      current.task,
      input,
      true,
      getEventCatalog(),
    );
    const task = await saveEventAutomation(
      getDb(),
      next,
      input.revision,
      current.task.createdBy,
    );
    if (!task) throw new ViewerTaskNotFoundError();
    return editView({ kind: "event", task });
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
  if (input.action === "pause" && status === "paused") return editView(current);
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
    return editView({ kind: "event", task });
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
  return editView({ kind: "scheduled", task });
}
