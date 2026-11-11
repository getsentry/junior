import type { AutomationRun } from "@sentry/junior/api/schema";
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleX,
  MessageSquareText,
  Zap,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";

import { CopyButton } from "../../components/CopyButton";
import { DetailsPanel } from "../../components/DetailsPanel";
import { Fact, FactList, FactSection } from "../../components/FactSection";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { statusDotToneClass } from "../../components/StatusDot";
import { buttonVariants } from "../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  automationPath,
  formatCompactNumber,
  formatCostSummary,
  formatRelativeTime,
  formatRuntime,
  formatTime,
} from "../../format";
import { cn, dashboardInlineLinkClass } from "../../styles";
import {
  automationRunStatusTone,
  automationRunTitle,
  formatAutomationRunTime,
} from "./automationFormat";

/** Search param that owns the selected run, so a run link can be shared. */
export const AUTOMATION_RUN_PARAM = "run";

/**
 * Read the run that the URL selects, and change it, so any page that lists
 * runs opens details in place. Closing returns focus to the run row: the
 * first button or link inside its `data-run-id` element. Up and Down move the
 * selection while details are open.
 */
export function useAutomationRunSelection(runIds: readonly string[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  const runId = searchParams.get(AUTOMATION_RUN_PARAM) ?? undefined;
  const select = (id: string | undefined) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set(AUTOMATION_RUN_PARAM, id);
        else next.delete(AUTOMATION_RUN_PARAM);
        return next;
      },
      { replace: true },
    );
  const rowControl = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(
      `[data-run-id="${CSS.escape(id)}"] :is(button, a)`,
    );
  const close = () => {
    const trigger = runId ? rowControl(runId) : undefined;
    select(undefined);
    (trigger ?? listRef.current)?.focus({ preventScroll: true });
  };
  const toggle = (id: string) => select(id === runId ? undefined : id);
  // Run details are a modal panel over the page, so read Up and Down from
  // the whole page while a run is open. The panel stops key events from
  // bubbling, so listen in the capture phase.
  const steppedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    steppedRef.current = undefined;
  }, [runId]);
  useEffect(() => {
    if (!runId) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest("input, textarea, select")
      ) {
        return;
      }
      // Key repeats can land before the URL updates, so step from the last key.
      const index = runIds.indexOf(steppedRef.current ?? runId);
      const next = runIds[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (index === -1 || !next) return;
      event.preventDefault();
      steppedRef.current = next;
      select(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });
  return { close, listRef, runId, toggle };
}

// The panel scrolls on an element that stays mounted, so start each run at
// its top. Stop at the panel so the page behind it keeps its place.
function scrollPanelToTop(node: HTMLElement | null) {
  const panel = node?.closest("[data-dashboard-modal]");
  for (
    let el = node?.parentElement;
    el && panel?.contains(el);
    el = el.parentElement
  ) {
    el.scrollTop = 0;
  }
}

/** Open a run's Conversation from its row without opening run details. */
export function RunConversationLink(props: { conversationId?: string }) {
  if (!props.conversationId) return <span aria-hidden="true" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label="Open conversation"
            className={cn(buttonVariants({ size: "icon" }), "size-8")}
            to={conversationPath(props.conversationId)}
          >
            <MessageSquareText aria-hidden="true" size={15} />
          </Link>
        }
      />
      <TooltipContent size="compact">Open conversation</TooltipContent>
    </Tooltip>
  );
}

/** Show what one run did, what it cost, and why it failed. */
export function AutomationRunDetails(props: {
  loading: boolean;
  onClose(): void;
  /** Undefined while runs load, or when the selected run is not loaded. */
  run: AutomationRun | undefined;
  /** Name the Automation when the page around the panel does not. */
  showAutomation: boolean;
}) {
  const { run } = props;
  const title = run ? automationRunTitle(run, run.automationTitle) : "Run";
  return (
    <DetailsPanel
      actions={
        run?.conversationId ? (
          <Link
            className={cn(buttonVariants(), "shrink-0 whitespace-nowrap")}
            to={conversationPath(run.conversationId)}
          >
            Open conversation
          </Link>
        ) : undefined
      }
      label="Run details"
      onClose={props.onClose}
      // Run details slide over the page, so the page keeps its layout.
      overlay
      sheetTitle={title}
      title={
        <h2 className="m-0 line-clamp-2 break-words font-display text-base font-medium text-dashboard-text">
          {title}
        </h2>
      }
    >
      {/* Up and Down swap the run inside the open panel, so reset only the
          content, not the panel and its slide-in. */}
      <div
        className="p-4 [overflow-wrap:anywhere]"
        key={run?.executionId}
        ref={scrollPanelToTop}
      >
        {run ? (
          <AutomationRunContent
            run={run}
            showAutomation={props.showAutomation}
          />
        ) : props.loading ? (
          <PageContentSkeleton label="Loading run details" variant="panel" />
        ) : (
          <p className="m-0 text-sm text-dashboard-text-muted">
            This run is not in the loaded runs.
          </p>
        )}
      </div>
    </DetailsPanel>
  );
}

function AutomationRunContent(props: {
  run: AutomationRun;
  showAutomation: boolean;
}) {
  const { run } = props;
  return (
    <div className="grid min-w-0 gap-4">
      <RunOutcome run={run} />
      <RunMetrics run={run} />
      <RunTimeline run={run} />
      <FactSection title="Details">
        <FactList>
          {props.showAutomation ? (
            <Fact label="Automation">
              <Link
                className={dashboardInlineLinkClass}
                to={automationPath(run.automationId)}
              >
                {run.automationTitle}
              </Link>
            </Fact>
          ) : null}
          <Fact label="Trigger">
            <span className="inline-flex items-center gap-1.5">
              {run.kind === "scheduled" ? (
                <CalendarClock aria-hidden="true" size={13} />
              ) : (
                <Zap aria-hidden="true" size={13} />
              )}
              {run.kind === "scheduled" ? "Schedule" : "Event"}
            </span>
          </Fact>
          {run.automationVersion ? (
            <Fact label="Version">
              <Link
                className={dashboardInlineLinkClass}
                to={`${automationPath(run.automationId, "versions")}?version=${run.automationVersion}`}
              >
                Version {run.automationVersion}
              </Link>
            </Fact>
          ) : null}
          {run.credentialMode ? (
            <Fact label="Accounts">
              {run.credentialMode === "creator"
                ? "Creator’s connected accounts"
                : "Junior’s accounts only"}
            </Fact>
          ) : null}
          {run.conversationId ? null : (
            <Fact label="Conversation">
              <span className="text-dashboard-text-muted">Not recorded</span>
            </Fact>
          )}
          <Fact label="Run ID">
            <span className="font-mono">{run.executionId}</span>
          </Fact>
        </FactList>
      </FactSection>
    </div>
  );
}

const OUTCOME = {
  blocked: {
    className: "border-amber-300/30 bg-amber-300/[0.08]",
    icon: CircleAlert,
    iconClassName: "text-amber-300",
    label: "Blocked",
  },
  completed: {
    className: "border-emerald-300/25 bg-emerald-300/[0.06]",
    icon: CircleCheck,
    iconClassName: "text-emerald-300",
    label: "Completed",
  },
  failed: {
    className: "border-rose-300/30 bg-rose-300/[0.08]",
    icon: CircleX,
    iconClassName: "text-rose-300",
    label: "Failed",
  },
} satisfies Record<AutomationRun["status"], unknown>;

/** The result first, in its status color, with the reason when there is one. */
function RunOutcome({ run }: { run: AutomationRun }) {
  const outcome = OUTCOME[run.status];
  const Icon = outcome.icon;
  return (
    <section
      aria-label="Result"
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 rounded-lg border px-4 py-3",
        outcome.className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={outcome.iconClassName}
        size={20}
        strokeWidth={2}
      />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="font-display text-lg font-medium text-dashboard-text">
          {outcome.label}
        </span>
        <time
          className="text-xs text-dashboard-text-muted"
          dateTime={run.executedAt}
          title={formatAutomationRunTime(run.executedAt)}
        >
          {formatRelativeTime(run.executedAt)}
        </time>
      </div>
      {run.error ? (
        <CopyButton getText={() => run.error ?? ""} label="Copy error" />
      ) : (
        <span />
      )}
      {run.error ? (
        <p className="col-span-3 m-0 whitespace-pre-wrap rounded-md bg-dashboard-overlay-soft px-3 py-2.5 font-mono text-xs leading-relaxed text-dashboard-text-subtle">
          {run.error}
        </p>
      ) : null}
    </section>
  );
}

/** Duration, tokens, and cost as large values, so they read at a glance. */
function RunMetrics({ run }: { run: AutomationRun }) {
  const metrics: Array<[string, string]> = [
    ["Duration", formatRuntime(run.durationMs) || "—"],
    [
      "Tokens",
      run.totalTokens === undefined
        ? "—"
        : formatCompactNumber(run.totalTokens),
    ],
    [
      "Cost",
      run.costUsd === undefined
        ? "—"
        : formatCostSummary({ total: run.costUsd }),
    ],
  ];
  return (
    <dl className="m-0 grid min-w-0 grid-cols-3 divide-x divide-dashboard-border-subtle rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel">
      {metrics.map(([label, value]) => (
        <div className="grid min-w-0 gap-1.5 px-4 py-3" key={label}>
          <dt className="text-xs text-dashboard-text-muted">{label}</dt>
          <dd className="m-0 truncate font-display text-xl font-medium tabular-nums text-dashboard-text">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STEP_TIME: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};
const STEP_DATE: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

/**
 * Scheduled, started, and finished on one line each. The gap beside a step
 * is the time since the step before it, so a slow queue or a long run shows.
 */
function RunTimeline({ run }: { run: AutomationRun }) {
  const steps = [
    run.scheduledFor ? { at: run.scheduledFor, label: "Scheduled" } : null,
    run.startedAt ? { at: run.startedAt, label: "Started" } : null,
    { at: run.executedAt, label: OUTCOME[run.status].label },
  ].filter((step) => step !== null);
  const date = formatTime(steps[0]!.at, STEP_DATE);
  const tone = automationRunStatusTone(run.status);
  return (
    <FactSection
      action={<span className="text-dashboard-text-muted">{date}</span>}
      title="Timeline"
    >
      <ol className="m-0 grid list-none p-0">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const previous = steps[index - 1];
          const gap = previous
            ? formatRuntime(Date.parse(step.at) - Date.parse(previous.at))
            : "";
          const stepDate = formatTime(step.at, STEP_DATE);
          return (
            <li
              className="relative grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-3 pb-3.5 text-xs last:pb-0"
              key={step.label}
            >
              {last ? null : (
                <span
                  aria-hidden="true"
                  className="absolute top-2 -bottom-2 left-[0.28rem] w-px bg-dashboard-border-heavy"
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "relative size-2.5 rounded-full",
                  last
                    ? statusDotToneClass[tone]
                    : "border border-dashboard-border-heavy bg-dashboard-bg-elevated",
                )}
              />
              <span className="min-w-0 truncate text-dashboard-text">
                {step.label}
                {gap ? (
                  <span className="ml-2 tabular-nums text-dashboard-text-faint">
                    +{gap}
                  </span>
                ) : null}
              </span>
              <time
                className="tabular-nums text-dashboard-text-muted"
                dateTime={step.at}
                title={formatAutomationRunTime(step.at)}
              >
                {stepDate === date ? "" : `${stepDate}, `}
                {formatTime(step.at, STEP_TIME)}
              </time>
            </li>
          );
        })}
      </ol>
    </FactSection>
  );
}
