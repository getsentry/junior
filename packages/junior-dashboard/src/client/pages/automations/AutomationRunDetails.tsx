import type { AutomationRun } from "@sentry/junior/api/schema";
import { MessageSquareText } from "lucide-react";
import {
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useSearchParams } from "react-router";

import { DetailsPanel } from "../../components/DetailsPanel";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { StatusChip } from "../../components/StatusChip";
import { PageLayout } from "../../components/layout/PageLayout";
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
 * Read the run that the URL selects, and change it. Closing returns focus to
 * the run row. Up and Down move the selection while details are open.
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
  const rowButton = (id: string) =>
    listRef.current?.querySelector<HTMLButtonElement>(
      `[data-run-id="${CSS.escape(id)}"] button`,
    );
  const close = () => {
    const trigger = runId ? rowButton(runId) : undefined;
    select(undefined);
    (trigger ?? listRef.current)?.focus({ preventScroll: true });
  };
  const toggle = (id: string) => select(id === runId ? undefined : id);
  const onRowsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!runId || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    // Read the focused row. The URL can lag behind fast key repeats.
    const current = (event.target as Element)
      .closest("[data-run-id]")
      ?.getAttribute("data-run-id");
    const index = current ? runIds.indexOf(current) : -1;
    const next = runIds[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (index === -1 || !next) return;
    event.preventDefault();
    select(next);
    rowButton(next)?.focus();
  };
  return { close, listRef, onRowsKeyDown, runId, toggle };
}

/** Scroll a run list on its own, beside the selected run's details. */
export function AutomationRunsFrame(props: {
  children: ReactNode;
  details: ReactNode;
  label: string;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0",
        props.details ? "xl:grid-cols-[minmax(0,1fr)_25rem]" : undefined,
      )}
    >
      <div
        aria-label={props.label}
        className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        ref={props.listRef}
        role="region"
        tabIndex={0}
      >
        <PageLayout>{props.children}</PageLayout>
      </div>
      {props.details}
    </div>
  );
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
  /** The executions page already names its Automation. */
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
      sheetTitle={title}
      title={
        <h2 className="m-0 line-clamp-2 break-words font-display text-base font-medium text-dashboard-text">
          {title}
        </h2>
      }
    >
      <div className="p-4 [overflow-wrap:anywhere]">
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
  const versionsPath = `${automationPath(run.automationId)}/versions`;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusChip tone={automationRunStatusTone(run.status)}>
          {run.status}
        </StatusChip>
        <time
          className="text-xs text-dashboard-text-muted"
          dateTime={run.executedAt}
          title={formatAutomationRunTime(run.executedAt)}
        >
          {formatRelativeTime(run.executedAt)}
        </time>
      </div>
      {run.error ? (
        <p className="m-0 whitespace-pre-wrap rounded-md border border-rose-300/25 bg-rose-300/5 px-3 py-2 font-mono text-xs leading-relaxed text-rose-300">
          <span className="sr-only">Error: </span>
          {run.error}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-fill-hover">
        <RunMetric label="Duration" value={formatRuntime(run.durationMs)} />
        <RunMetric
          label="Tokens"
          value={
            run.totalTokens === undefined
              ? undefined
              : formatCompactNumber(run.totalTokens)
          }
        />
        <RunMetric
          label="Cost"
          value={
            run.costUsd === undefined
              ? undefined
              : formatCostSummary({ total: run.costUsd })
          }
        />
      </dl>
      <dl className="m-0 grid gap-2.5 text-xs leading-relaxed">
        {props.showAutomation ? (
          <RunFact label="Automation">
            <Link
              className={dashboardInlineLinkClass}
              to={automationPath(run.automationId)}
            >
              {run.automationTitle}
            </Link>
          </RunFact>
        ) : null}
        <RunFact label="Trigger">
          {run.kind === "scheduled"
            ? run.scheduledFor
              ? `Schedule · ${formatAutomationRunTime(run.scheduledFor)}`
              : "Schedule"
            : "Event"}
        </RunFact>
        {run.startedAt ? (
          <RunFact label="Started">
            {formatAutomationRunTime(run.startedAt)}
          </RunFact>
        ) : null}
        <RunFact label="Finished">
          {formatAutomationRunTime(run.executedAt)}
        </RunFact>
        {run.credentialMode ? (
          <RunFact label="Accounts">
            {run.credentialMode === "creator"
              ? "Creator’s connected accounts"
              : "Junior’s accounts only"}
          </RunFact>
        ) : null}
        {run.automationVersion ? (
          <RunFact label="Version">
            <Link className={dashboardInlineLinkClass} to={versionsPath}>
              Version {run.automationVersion}
            </Link>
          </RunFact>
        ) : null}
        <RunFact label="Run ID">
          <span className="font-mono text-dashboard-text-muted">
            {run.executionId}
          </span>
        </RunFact>
      </dl>
      {run.conversationId ? null : (
        <p className="m-0 text-xs text-dashboard-text-muted">
          No Conversation was recorded for this run.
        </p>
      )}
    </div>
  );
}

function RunMetric(props: { label: string; value: string | undefined }) {
  return (
    <div className="min-w-0 bg-dashboard-bg-elevated px-3 py-2">
      <dt className="text-xs font-medium text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd className="m-0 mt-0.5 truncate font-sans text-sm tabular-nums text-dashboard-text">
        {props.value || "—"}
      </dd>
    </div>
  );
}

function RunFact(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] gap-3">
      <dt className="text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0">{props.children}</dd>
    </div>
  );
}
