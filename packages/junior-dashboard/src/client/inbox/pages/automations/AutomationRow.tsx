import { useRef, type ReactNode } from "react";
import type { AutomationListItem } from "@sentry/junior/api/schema";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  LockKeyhole,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { Link } from "react-router";
import { usePrefetchAutomation } from "../../../api";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { FormNotice } from "../../../components/FormNotice";
import { statusDotToneClass } from "../../../components/StatusDot";
import { Button } from "../../../components/ui/button";
import { conversationPath } from "../../../conversations/conversationRoutes";
import { DashboardApiError } from "../../../http";
import { eventTriggerText } from "@sentry/junior-plugin-api";
import {
  INBOX_ROW_DETAIL_CLASS,
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "../../../review-desk/inboxRowStyles";
import { useAnimatedHeight } from "../../../review-desk/rowMotion";
import { pathWithSearch } from "../../../searchParams";
import { automationPath } from "../../../format";
import { cn } from "../../../styles";
import {
  automationRunStatusTone,
  automationScheduleLabel,
  formatAutomationRunTime,
} from "../../../pages/automations/automationFormat";
import { AutomationRunStrip } from "../../../pages/automations/AutomationRunStrip";
import { automationProblemSummary } from "../../../pages/automations/AutomationStatus";
import { useAutomationLifecycle } from "../../../pages/automations/useAutomationLifecycle";
import { formatRelativeTime, formatRuntime } from "../../../time";

/** Number of recent runs each row shows. Matches the summary limit. */
export const AUTOMATION_ROW_RUN_SLOTS = 20;

/** Problem text, readable on both themes. */
const PROBLEM_TONE_CLASS = {
  danger: "text-rose-300 light:text-rose-700",
  warning: "text-amber-300 light:text-amber-700",
} as const;

/** Runs that an open row lists by name, newest first. */
const DETAIL_RUNS = 5;

/**
 * Show one Automation as an Inbox card: its kind's icon where a
 * Conversation's dot goes, what it does and where it posts, then who owns
 * it, how its recent runs went, and when it runs next. A problem adds what
 * is wrong and the link that fixes it. The title opens the Automation. A
 * click anywhere else on the card, or its Details button, expands it in
 * place, as an Inbox row does, with the trigger, the last runs, and the
 * quick actions.
 */
export function AutomationRow(props: {
  automation: AutomationListItem;
  expanded: boolean;
  onToggle(): void;
  /** The list's query, so Back from the Automation returns to the same list. */
  search: string;
}) {
  const { automation } = props;
  const to = pathWithSearch(automationPath(automation.id), props.search);
  const problem = automationProblemSummary(automation);
  const inactive =
    automation.status === "paused" || automation.status === "completed";
  const ref = useRef<HTMLLIElement>(null);
  useAnimatedHeight(ref, String(props.expanded));
  const regionId = `automation-row-${automation.id}`;
  const prefetch = usePrefetchAutomation(automation.id);
  return (
    <li
      {...prefetch}
      className={cn(inboxCardClass(props.expanded), "cursor-pointer")}
      data-automation-id={automation.id}
      data-dock-key={`automation:${automation.id}`}
      data-expanded={props.expanded || undefined}
      // Inbox focus and click-outside read open cards by this key.
      data-inbox-row={automation.id}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          (event.target.closest("a, button") ||
            event.target.closest(`#${CSS.escape(regionId)}`))
        )
          return;
        props.onToggle();
      }}
      ref={ref}
    >
      <div className={cn(inboxHeadGridClass(), "pb-3")}>
        {problem ? (
          <TriangleAlert
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 mt-[0.25rem] size-3.5 justify-self-center",
              PROBLEM_TONE_CLASS[problem.tone],
            )}
          />
        ) : null}
        <div
          className={cn(
            "col-start-2 row-start-1 grid min-w-0 gap-1",
            inactive && "opacity-60",
          )}
        >
          <Link
            aria-label={`Open automation: ${automation.title}`}
            className="min-w-0 truncate rounded-md font-display text-base leading-snug font-medium text-dashboard-text no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            title={automation.title}
            to={to}
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
                // Links into this Automation keep the list's query too.
                to={
                  problem.action.to.startsWith(
                    `${automationPath(automation.id)}/`,
                  )
                    ? pathWithSearch(problem.action.to, props.search)
                    : problem.action.to
                }
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
          <button
            aria-controls={regionId}
            aria-expanded={props.expanded}
            aria-label={`Details: ${automation.title}`}
            className="grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            onClick={props.onToggle}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                props.expanded && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>
      {props.expanded ? (
        <AutomationRowDetail automation={automation} id={regionId} to={to} />
      ) : null}
    </li>
  );
}

/**
 * The open row: what starts a run, the last runs, the next run, the owner,
 * and the Destination, then the actions that the list can take at once.
 */
function AutomationRowDetail(props: {
  automation: AutomationListItem;
  id: string;
  to: string;
}) {
  const { automation } = props;
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  const lifecycle = useAutomationLifecycle(
    automation,
    paused || blocked ? "resume" : "pause",
  );
  const runs = automation.recentRuns.slice(-DETAIL_RUNS).reverse();
  const trigger =
    automation.kind === "scheduled"
      ? automationScheduleLabel(automation)
      : eventTriggerText(automation.resource, automation.trigger);
  return (
    <div
      aria-label={`${automation.title}: details`}
      className={cn(INBOX_ROW_DETAIL_CLASS, "cursor-default gap-4 text-sm")}
      id={props.id}
      role="region"
    >
      <dl className="m-0 grid gap-x-6 gap-y-2 md:grid-cols-2">
        <DetailFact
          label={automation.kind === "scheduled" ? "Schedule" : "Trigger"}
        >
          {trigger}
        </DetailFact>
        <DetailFact label="Next run">
          <AutomationNextRun automation={automation} />
        </DetailFact>
        <DetailFact label="Owner">
          <span className="flex min-w-0 items-center gap-2">
            <ActorAvatar
              imageUrl={automation.createdByAvatarUrl}
              name={automation.createdBy}
              size="list"
            />
            <span className="truncate">
              {automation.ownedByViewer ? "You" : automation.createdBy}
            </span>
          </span>
        </DetailFact>
        <DetailFact label="Destination">
          <span className="flex min-w-0 items-center gap-1.5">
            {automation.destination.visibility === "private" ? (
              <LockKeyhole
                aria-label="Private destination"
                className="shrink-0"
                role="img"
                size={12}
              />
            ) : null}
            <span className="truncate">{automation.destination.label}</span>
          </span>
        </DetailFact>
      </dl>
      <div className="grid gap-1.5">
        <span className="text-xs text-dashboard-text-muted">Last runs</span>
        {runs.length > 0 ? (
          <ol
            aria-label={`Last runs of ${automation.title}`}
            className="m-0 grid list-none gap-1 p-0"
          >
            {runs.map((run, index) => (
              <li
                className="flex min-w-0 items-center gap-2 text-xs"
                key={`${run.executedAt}:${index}`}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    statusDotToneClass[automationRunStatusTone(run.status)],
                  )}
                />
                <span className="w-20 shrink-0 text-dashboard-text first-letter:uppercase">
                  {run.status}
                </span>
                <time
                  className="text-dashboard-text-muted"
                  dateTime={run.executedAt}
                  title={formatAutomationRunTime(run.executedAt)}
                >
                  {formatRelativeTime(run.executedAt)}
                </time>
                {run.durationMs !== undefined ? (
                  <span className="text-dashboard-text-faint">
                    {formatRuntime(run.durationMs)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-xs text-dashboard-text-muted">No runs yet</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {automation.status === "completed" ? null : (
          <Button
            disabled={lifecycle.isPending}
            onClick={() => lifecycle.mutate()}
            variant="outline"
          >
            {lifecycle.isPending
              ? "Updating…"
              : paused || blocked
                ? "Resume"
                : "Pause"}
          </Button>
        )}
        {automation.lastConversationId ? (
          <Link
            className="inline-flex items-center gap-1.5 text-sm font-medium text-dashboard-text no-underline hover:underline"
            to={conversationPath(automation.lastConversationId)}
          >
            Open last run
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        ) : null}
        <Link
          className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-dashboard-text no-underline hover:underline"
          to={props.to}
        >
          Open automation
          <ArrowUpRight aria-hidden="true" size={14} />
        </Link>
      </div>
      {lifecycle.error ? (
        <FormNotice tone="error" title="Could not update this automation.">
          {lifecycle.error instanceof DashboardApiError
            ? (lifecycle.error.apiError ?? "Try again.")
            : lifecycle.error.message}
        </FormNotice>
      ) : null}
    </div>
  );
}

function DetailFact(props: { children: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-24 shrink-0 text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 text-dashboard-text">{props.children}</dd>
    </div>
  );
}

/** When the next run happens, in the Automation's own timezone. */
function AutomationNextRun({ automation }: { automation: AutomationListItem }) {
  const next = nextRun(automation);
  return (
    <span>{next.title ? `${next.label} · ${next.title}` : next.label}</span>
  );
}

/** Trigger and Destination in one muted line under the title. */
function AutomationTriggerLine({
  automation,
}: {
  automation: AutomationListItem;
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

/** What happens next: a time to run, or why nothing runs. */
function nextRun(automation: AutomationListItem): {
  label: string;
  title?: string;
} {
  if (automation.status === "paused") return { label: "Paused" };
  if (automation.status === "completed") return { label: "No future runs" };
  if (automation.status === "blocked") return { label: "Blocked" };
  if (automation.kind === "scheduled")
    return automation.nextRunAt
      ? {
          label: `Next ${formatRelativeTime(automation.nextRunAt)}`,
          title: formatAutomationRunTime(
            automation.nextRunAt,
            automation.timezone,
          ),
        }
      : { label: "No next run" };
  return automation.trigger.problems.length > 0
    ? { label: "Not listening" }
    : { label: "Listening" };
}

/** What happens next on top, the last run under it. */
function AutomationTiming({ automation }: { automation: AutomationListItem }) {
  const next = nextRun(automation);
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
