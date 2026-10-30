import type { AutomationSummary } from "@sentry/junior/api/schema";
import { CalendarClock, LockKeyhole, Zap } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";
import { ActorAvatar } from "../../components/ActorAvatar";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusChip } from "../../components/StatusChip";
import { formatRelativeTime, peoplePath } from "../../format";
import { eventTriggerText } from "@sentry/junior-plugin-api";
import {
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";

/**
 * Show one automation as a compact card: what it is, where it posts, who owns
 * it, and when it runs. Instructions, timezones, and event filters stay in
 * the details panel.
 */
export function AutomationRow(props: {
  onSelect(): void;
  selected: boolean;
  automation: AutomationSummary;
}) {
  const { automation } = props;
  const status = automationStatus(automation);
  const creator = (
    <>
      <ActorAvatar
        imageUrl={automation.createdByAvatarUrl}
        name={automation.createdBy}
        size="list"
      />
      <span className="truncate">{automation.createdBy}</span>
    </>
  );
  return (
    <article
      className="min-w-0 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint"
      data-automation-id={automation.id}
      role="listitem"
    >
      <SelectableRow
        className="flex items-start gap-3 rounded-lg px-4 py-3.5"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <div className="min-w-0 flex-1">
          <button
            aria-expanded={props.selected}
            aria-label={`View automation details: ${automation.title}`}
            className="block w-full min-w-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            onClick={props.onSelect}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="truncate font-display text-base font-medium text-dashboard-text"
                title={automation.title}
              >
                {automation.title}
              </span>
              {status ? (
                <StatusChip
                  className="shrink-0"
                  size="compact"
                  tone={
                    status === "completed" || status === "paused"
                      ? "neutral"
                      : "warning"
                  }
                >
                  {status}
                </StatusChip>
              ) : null}
            </span>
            <AutomationSummaryLine automation={automation} />
          </button>
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dashboard-text-muted">
            {automation.createdByEmail ? (
              <Link
                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md text-dashboard-text no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                title={automation.createdBy}
                to={peoplePath(automation.createdByEmail)}
              >
                {creator}
              </Link>
            ) : (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-2 text-dashboard-text"
                title={automation.createdBy}
              >
                {creator}
              </span>
            )}
            <AutomationTiming automation={automation} />
          </div>
        </div>
      </SelectableRow>
    </article>
  );
}

/** Return the one state worth flagging in the list, if the automation is not simply active. */
function automationStatus(automation: AutomationSummary): string | undefined {
  if (automation.kind === "scheduled") {
    return automation.status === "active" ? undefined : automation.status;
  }
  if (automation.status !== "active") return automation.status;
  return automation.trigger.problems.length === 0
    ? undefined
    : "Trigger unavailable";
}

/** Combine the trigger and Destination into one muted line under the title. */
function AutomationSummaryLine({
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
  const triggerDetail =
    automation.kind === "scheduled"
      ? automationScheduleLabel(automation)
      : trigger;
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
      <span className="min-w-0 truncate" title={triggerDetail}>
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
        className="min-w-0 max-w-[45%] truncate"
        title={automation.destination.label}
      >
        {automation.destination.label}
      </span>
    </span>
  );
}

/** Show next and last run as short relative times after the creator. */
function AutomationTiming({ automation }: { automation: AutomationSummary }) {
  const nextRunAt =
    automation.kind === "scheduled" && automation.status === "active"
      ? automation.nextRunAt
      : undefined;
  const lastRunTitle = automation.lastRunAt
    ? formatAutomationRunTime(automation.lastRunAt)
    : undefined;
  const lastRunFailed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  return (
    <>
      {nextRunAt ? (
        <MetaItem title={formatAutomationRunTime(nextRunAt)}>
          Next run {formatRelativeTime(nextRunAt)}
        </MetaItem>
      ) : null}
      <MetaItem title={lastRunTitle}>
        {lastRunFailed ? (
          <Link
            className="text-amber-300 underline"
            to={`/automations/${encodeURIComponent(automation.id)}/executions`}
          >
            Last run {automation.lastRunStatus}
            {automation.lastRunAt
              ? ` ${formatRelativeTime(automation.lastRunAt)}`
              : null}
          </Link>
        ) : automation.lastRunAt ? (
          `Last run ${formatRelativeTime(automation.lastRunAt)}`
        ) : (
          "Never run"
        )}
      </MetaItem>
    </>
  );
}

/** Keep each separator with the item after it so wrapped lines never end in a dot. */
function MetaItem(props: { children: ReactNode; title?: string }) {
  return (
    <span className="whitespace-nowrap" title={props.title}>
      <span aria-hidden="true" className="mr-2 opacity-45">
        ·
      </span>
      {props.children}
    </span>
  );
}
