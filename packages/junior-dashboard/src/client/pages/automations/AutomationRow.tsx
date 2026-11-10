import type { AutomationSummary } from "@sentry/junior/api/schema";
import { CalendarClock, LockKeyhole, Zap } from "lucide-react";
import { Link } from "react-router";
import { ActorAvatar } from "../../components/ActorAvatar";
import { SelectableRow } from "../../components/SelectableRow";
import { formatRelativeTime } from "../../format";
import { eventTriggerText } from "@sentry/junior-plugin-api";
import { cn } from "../../styles";
import {
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";
import { AutomationRunStrip } from "./AutomationRunStrip";
import { automationProblemSummary } from "./AutomationStatus";

/** Number of recent runs each row shows. Matches the summary limit. */
export const AUTOMATION_ROW_RUN_SLOTS = 20;

/** Columns line up across groups so strips and times compare at a glance. */
const automationRowColumns =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 md:grid-cols-[minmax(0,1fr)_9rem_6rem_8.5rem]";

/**
 * Show one Automation as a row: what it does, where it posts, who owns it,
 * how its recent runs went, and when it runs next. A problem replaces the
 * owner line with what is wrong and the link that fixes it.
 */
export function AutomationRow(props: {
  automation: AutomationSummary;
  onSelect(): void;
  to: string;
}) {
  const { automation } = props;
  const problem = automationProblemSummary(automation);
  const inactive =
    automation.status === "paused" || automation.status === "completed";
  return (
    <div
      className="border-t border-dashboard-border-subtle first:border-t-0"
      data-automation-id={automation.id}
      role="listitem"
    >
      <SelectableRow
        className={cn(automationRowColumns, "px-4 py-3")}
        onSelect={props.onSelect}
        selected={false}
      >
        <div className={cn("min-w-0", inactive && "opacity-60")}>
          <Link
            aria-label={`Open automation: ${automation.title}`}
            className="block min-w-0 truncate rounded-md font-display text-base font-medium text-dashboard-text no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            title={automation.title}
            to={props.to}
          >
            {automation.title}
          </Link>
          <AutomationTriggerLine automation={automation} />
          {problem ? (
            <p
              className={cn(
                "m-0 mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs md:flex-nowrap",
                problem.tone === "danger" ? "text-rose-300" : "text-amber-300",
              )}
            >
              <span className="min-w-0 md:truncate" title={problem.message}>
                <span className="first-letter:uppercase">
                  {problem.message}
                </span>
              </span>
              <Link
                className="shrink-0 font-medium text-dashboard-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                to={problem.action.to}
              >
                {problem.action.label}
              </Link>
            </p>
          ) : null}
        </div>
        <span
          className="hidden min-w-0 items-center gap-2 text-xs text-dashboard-text-muted md:flex"
          title={automation.createdBy}
        >
          <ActorAvatar
            imageUrl={automation.createdByAvatarUrl}
            name={automation.createdBy}
            size="list"
          />
          <span className="truncate">
            {automation.ownedByViewer ? "You" : automation.createdBy}
          </span>
        </span>
        <div className="hidden md:block">
          <AutomationRunStrip
            label={`Recent runs of ${automation.title}`}
            runs={(automation.recentRuns ?? []).map((run) => ({
              ...run,
              key: run.executedAt,
            }))}
            slots={AUTOMATION_ROW_RUN_SLOTS}
          />
        </div>
        <AutomationTiming automation={automation} />
      </SelectableRow>
    </div>
  );
}

/** Trigger and Destination in one muted line under the title. */
function AutomationTriggerLine({
  automation,
}: {
  automation: AutomationSummary;
}) {
  const scheduled = automation.kind === "scheduled";
  const Icon = scheduled ? CalendarClock : Zap;
  const trigger =
    automation.kind === "scheduled"
      ? automation.schedule
      : eventTriggerText(automation.resource, automation.trigger);
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-dashboard-text-muted">
      <Icon
        aria-label={
          scheduled
            ? "Scheduled automation"
            : `${automation.source} event automation`
        }
        className="shrink-0"
        role="img"
        size={13}
      />
      <span
        className="min-w-0 truncate"
        title={
          automation.kind === "scheduled"
            ? automationScheduleLabel(automation)
            : trigger
        }
      >
        {trigger}
      </span>
      <span aria-hidden="true" className="shrink-0 opacity-45">
        ·
      </span>
      {automation.destination.visibility === "private" ? (
        <LockKeyhole
          aria-label="Private destination"
          className="shrink-0"
          role="img"
          size={12}
        />
      ) : null}
      <span
        className="min-w-0 max-w-[45%] shrink-0 truncate"
        title={automation.destination.label}
      >
        {automation.destination.label}
      </span>
    </span>
  );
}

/** What happens next on top, the last run under it. */
function AutomationTiming({ automation }: { automation: AutomationSummary }) {
  const next =
    automation.status === "paused"
      ? { label: "Paused" }
      : automation.status === "completed"
        ? { label: "No future runs" }
        : automation.status === "blocked"
          ? { label: "Blocked" }
          : automation.kind === "scheduled"
            ? automation.nextRunAt
              ? {
                  label: `Next ${formatRelativeTime(automation.nextRunAt)}`,
                  title: formatAutomationRunTime(
                    automation.nextRunAt,
                    automation.timezone,
                  ),
                }
              : { label: "No next run" }
            : automation.trigger.problems.length > 0
              ? { label: "Not listening" }
              : { label: "Listening" };
  return (
    <div className="grid min-w-0 justify-items-end gap-1 text-right text-xs">
      <span className="text-dashboard-text" title={next.title}>
        {next.label}
      </span>
      <span
        className="text-dashboard-text-muted"
        title={
          automation.lastRunAt
            ? formatAutomationRunTime(automation.lastRunAt)
            : undefined
        }
      >
        {automation.lastRunAt
          ? `Ran ${formatRelativeTime(automation.lastRunAt)}`
          : "Never run"}
      </span>
    </div>
  );
}
