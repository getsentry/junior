import type { AutomationSummary } from "@sentry/junior/api/schema";
import { CalendarClock, LockKeyhole, TriangleAlert, Zap } from "lucide-react";
import { Link } from "react-router";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { eventTriggerText } from "@sentry/junior-plugin-api";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "../../../review-desk/inboxRowStyles";
import { cn } from "../../../styles";
import {
  automationScheduleLabel,
  formatAutomationRunTime,
} from "../../../pages/automations/automationFormat";
import { AutomationRunStrip } from "../../../pages/automations/AutomationRunStrip";
import { automationProblemSummary } from "../../../pages/automations/AutomationStatus";
import { formatRelativeTime } from "../../../time";

/** Number of recent runs each row shows. Matches the summary limit. */
export const AUTOMATION_ROW_RUN_SLOTS = 20;

/** Problem text, readable on both themes. */
const PROBLEM_TONE_CLASS = {
  danger: "text-rose-300 light:text-rose-700",
  warning: "text-amber-300 light:text-amber-700",
} as const;

/**
 * Show one Automation as an Inbox card: its kind's icon where a
 * Conversation's dot goes, what it does and where it posts, then who owns
 * it, how its recent runs went, and when it runs next. A problem adds what
 * is wrong and the link that fixes it. A click anywhere off a link opens
 * the Automation.
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
  const Icon = automation.kind === "scheduled" ? CalendarClock : Zap;
  return (
    <li
      className={cn(inboxCardClass(false), "cursor-pointer")}
      data-automation-id={automation.id}
      data-dock-key={`automation:${automation.id}`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a, button")
        )
          return;
        props.onSelect();
      }}
    >
      <div className={cn(inboxHeadGridClass(), "pb-3")}>
        {problem ? (
          <TriangleAlert
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 mt-[0.2rem] size-3.5 justify-self-center",
              PROBLEM_TONE_CLASS[problem.tone],
            )}
          />
        ) : (
          <Icon
            aria-hidden="true"
            className="col-start-1 row-start-1 mt-[0.2rem] size-3.5 justify-self-center text-dashboard-text-muted"
            strokeWidth={1.9}
          />
        )}
        <div
          className={cn(
            "col-start-2 row-start-1 grid min-w-0 gap-1",
            inactive && "opacity-60",
          )}
        >
          <Link
            aria-label={`Open automation: ${automation.title}`}
            className="min-w-0 truncate rounded-md text-sm leading-snug font-medium text-dashboard-text no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            title={automation.title}
            to={props.to}
          >
            {automation.title}
          </Link>
          <AutomationTriggerLine automation={automation} />
          {problem ? (
            <p
              className={cn(
                "m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs md:flex-nowrap",
                PROBLEM_TONE_CLASS[problem.tone],
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
        <div className={cn(INBOX_ROW_META_CLASS, "items-start gap-5")}>
          <span
            className="hidden min-w-0 items-center gap-2 text-dashboard-text-muted md:flex"
            title={automation.createdBy}
          >
            <ActorAvatar
              imageUrl={automation.createdByAvatarUrl}
              name={automation.createdBy}
              size="list"
            />
            <span className="max-w-28 truncate">
              {automation.ownedByViewer ? "You" : automation.createdBy}
            </span>
          </span>
          <span className="hidden lg:block">
            <AutomationRunStrip
              label={`Recent runs of ${automation.title}`}
              // Runs can share a completion time, so the order breaks ties.
              runs={(automation.recentRuns ?? []).map((run, index) => ({
                ...run,
                key: `${run.executedAt}:${index}`,
              }))}
              slots={AUTOMATION_ROW_RUN_SLOTS}
            />
          </span>
          <AutomationTiming automation={automation} />
        </div>
      </div>
    </li>
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
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-dashboard-text-muted">
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
    <div className="grid w-32 min-w-0 justify-items-end gap-1 text-right text-xs whitespace-nowrap">
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
