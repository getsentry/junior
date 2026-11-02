import type {
  AutomationEdit,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/layout/Card";
import { cn } from "../../styles";
import { automationOutcomeLabel } from "./automationOutcomes";
import {
  createAutomationDraft,
  scheduleDraft,
  type AutomationDraft,
  type AutomationScheduleDraft,
} from "./automationDraft";

/** In form order, so the list reads top to bottom like the form. */
const CHANGE_LABELS: Record<keyof AutomationDraft, string> = {
  title: "Title",
  instruction: "Instruction",
  schedule: "Schedule",
  trigger: "Trigger",
  outcomes: "Where results go",
  credentialMode: "Credentials",
};

/**
 * List unsaved fields with the saved value, the new value, and an Undo.
 * It sits beside the form on wide screens and below it on small screens.
 */
export function AutomationDraftChanges(props: {
  changes: Partial<AutomationDraft>;
  disabled: boolean;
  onUndo(key: keyof AutomationDraft): void;
  original: AutomationEdit;
  summary: AutomationSummary;
}) {
  const keys = (Object.keys(CHANGE_LABELS) as (keyof AutomationDraft)[]).filter(
    (key) => props.changes[key] !== undefined,
  );
  const saved = savedDraft(props.original);
  const label = (draft: Partial<AutomationDraft>, key: keyof AutomationDraft) =>
    draftValueLabel(draft, key, props.summary);
  return (
    <aside
      aria-label="Your changes"
      className={cn(
        "min-w-0 lg:sticky lg:top-4 lg:self-start",
        keys.length === 0 && "max-lg:hidden",
      )}
    >
      <Card padding="sm">
        <h2 className="m-0 mb-3 font-sans text-xs font-medium text-dashboard-text-muted">
          Your changes
        </h2>
        {keys.length === 0 ? (
          <p className="m-0 text-sm text-dashboard-text-muted">
            No changes yet. Edit a section to see it here.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {keys.map((key) => (
              <li className="grid min-w-0 gap-1 text-sm" key={key}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{CHANGE_LABELS[key]}</span>
                  <Button
                    aria-label={`Undo ${CHANGE_LABELS[key].toLowerCase()} change`}
                    disabled={props.disabled}
                    onClick={() => props.onUndo(key)}
                  >
                    Undo
                  </Button>
                </div>
                <p className="m-0 line-clamp-3 break-words whitespace-pre-wrap text-xs text-dashboard-text-muted line-through decoration-dashboard-text-muted/50">
                  <span className="sr-only">Saved: </span>
                  {label(saved, key)}
                </p>
                <p className="m-0 line-clamp-3 break-words whitespace-pre-wrap text-xs">
                  <span className="sr-only">New: </span>
                  {label(props.changes, key)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 mb-0 text-xs leading-relaxed text-dashboard-text-muted">
          Saving creates a new version. It does not run this automation.
        </p>
      </Card>
    </aside>
  );
}

/** The saved values in draft form, including the saved schedule. */
function savedDraft(original: AutomationEdit): AutomationDraft {
  const draft = createAutomationDraft(original);
  return original.kind === "scheduled"
    ? { ...draft, schedule: scheduleDraft(original) }
    : draft;
}

function draftValueLabel(
  draft: Partial<AutomationDraft>,
  key: keyof AutomationDraft,
  summary: AutomationSummary,
): string {
  switch (key) {
    case "title":
      return draft.title || "First line of the instruction";
    case "instruction":
      return draft.instruction || "Empty";
    case "credentialMode":
      return draft.credentialMode === "creator"
        ? summary.ownedByViewer
          ? "Your connected accounts"
          : `${summary.createdBy}'s connected accounts`
        : "System credentials only";
    case "outcomes":
      return draft.outcomes?.length
        ? draft.outcomes
            .map((outcome) =>
              automationOutcomeLabel(outcome, summary.destination),
            )
            .join(", ")
        : "No success message";
    case "schedule":
      return draft.schedule ? scheduleDraftLabel(draft.schedule) : "Not set";
    case "trigger": {
      const trigger = draft.trigger;
      if (!trigger) return "Not set";
      const filters = Object.keys(trigger.match ?? {}).length;
      return [
        trigger.label,
        trigger.events.join(", "),
        filters ? `${filters} ${filters === 1 ? "filter" : "filters"}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

const FREQUENCY_UNITS = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
} as const;

/** Describe a schedule draft. Saved and new values use the same words. */
function scheduleDraftLabel(schedule: AutomationScheduleDraft): string {
  if (schedule.kind === "one_off") {
    return `Once on ${schedule.timing.date} at ${schedule.timing.time} (${schedule.timezone})`;
  }
  const interval = schedule.interval ?? 1;
  const unit = FREQUENCY_UNITS[schedule.frequency];
  const cadence = interval === 1 ? unit : `${interval} ${unit}s`;
  const detail =
    schedule.frequency === "weekly" && schedule.weekdays?.length
      ? ` on ${schedule.weekdays.map((day) => day.slice(0, 1).toUpperCase() + day.slice(1, 3)).join(", ")}`
      : schedule.frequency === "monthly" && schedule.dayOfMonth
        ? ` on day ${schedule.dayOfMonth}`
        : schedule.frequency === "yearly" &&
            schedule.month &&
            schedule.dayOfMonth
          ? ` on ${String(schedule.month).padStart(2, "0")}-${String(schedule.dayOfMonth).padStart(2, "0")}`
          : "";
  return `Every ${cadence}${detail} at ${schedule.time} (${schedule.timezone})`;
}
