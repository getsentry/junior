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
export type AutomationDraft = {
  title: string;
  instruction: string;
  credentialMode: AutomationEdit["credentialMode"];
  outcomes: NonNullable<AutomationUpdate["outcomes"]>;
  schedule?: AutomationScheduleIntent;
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

/** Convert only a selected schedule into structured controls; retain its anchor date. */
export function scheduleDraft(
  value: Extract<AutomationEdit, { kind: "scheduled" }>,
): AutomationScheduleIntent {
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

/** Send changed fields only so metadata edits cannot reset execution state. */
export function automationDraftUpdate(
  value: AutomationEdit,
  draft: AutomationDraft,
): AutomationUpdate {
  const initial = createAutomationDraft(value);
  const changes = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, field]) =>
        JSON.stringify(field) !==
        JSON.stringify(initial[key as keyof AutomationDraft]),
    ),
  );
  return {
    kind: value.kind,
    revision: value.revision,
    ...changes,
  } as AutomationUpdate;
}

/** Report dirty state from the actual partial update, not from focus or keystrokes. */
export function automationDraftChanged(
  value: AutomationEdit,
  draft: AutomationDraft,
): boolean {
  return Object.keys(automationDraftUpdate(value, draft)).length > 2;
}
