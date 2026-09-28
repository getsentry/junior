import type {
  AutomationEdit,
  AutomationScheduleIntent,
  AutomationUpdate,
} from "@sentry/junior/api/schema";

export const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type AutomationScheduleDraft =
  | Extract<AutomationScheduleIntent, { kind: "recurring" }>
  | {
      kind: "one_off";
      timezone: string;
      timing: { type: "at"; date: string; time: string };
    };

export type AutomationDraft = {
  title: string;
  instruction: string;
  credentialMode: AutomationEdit["credentialMode"];
  outcomes: NonNullable<AutomationUpdate["outcomes"]>;
  schedule?: AutomationScheduleDraft;
  trigger?: Extract<AutomationEdit, { kind: "event" }>["trigger"];
};

/** Keep stored values intact until a user edits that field. */
export function createAutomationDraft(value: AutomationEdit): AutomationDraft {
  return {
    title: value.title ?? "",
    instruction: value.instruction,
    credentialMode: value.credentialMode,
    outcomes: value.outcomes,
    trigger: value.kind === "event" ? value.trigger : undefined,
  };
}

/** Populate calendar controls without changing the saved start date. */
export function scheduleDraft(
  value: Extract<AutomationEdit, { kind: "scheduled" }>,
): AutomationScheduleDraft {
  const recurrence = value.schedule.recurrence;
  if (value.schedule.kind === "recurring" && recurrence) {
    const { time, weekdays: days, ...fields } = recurrence;
    return {
      kind: "recurring",
      ...fields,
      timezone: value.schedule.timezone,
      time: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
      weekdays: days?.map((day) => weekdays[day]),
    };
  }
  if (value.nextRunAtMs) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: value.schedule.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value.nextRunAtMs);
    const part = (name: string) =>
      parts.find((p) => p.type === name)?.value ?? "";
    return {
      kind: "one_off",
      timezone: value.schedule.timezone,
      timing: {
        type: "at",
        date: `${part("year")}-${part("month")}-${part("day")}`,
        time: `${part("hour")}:${part("minute")}`,
      },
    };
  }
  return {
    kind: "recurring",
    frequency: "daily",
    time: "09:00",
    timezone: value.schedule.timezone,
  };
}

/** Keep metadata edits from replacing unchanged triggers or outcomes. */
export function automationDraftChanges(
  original: AutomationEdit,
  draft: AutomationDraft,
): Partial<AutomationDraft> {
  const changes: Partial<AutomationDraft> = {};
  if (draft.title !== (original.title ?? "")) changes.title = draft.title;
  if (draft.instruction !== original.instruction)
    changes.instruction = draft.instruction;
  if (draft.credentialMode !== original.credentialMode)
    changes.credentialMode = draft.credentialMode;
  if (JSON.stringify(draft.outcomes) !== JSON.stringify(original.outcomes))
    changes.outcomes = draft.outcomes;
  if (original.kind === "scheduled" && draft.schedule)
    changes.schedule = draft.schedule;
  if (
    original.kind === "event" &&
    JSON.stringify(draft.trigger) !== JSON.stringify(original.trigger)
  )
    changes.trigger = draft.trigger;
  return changes;
}
