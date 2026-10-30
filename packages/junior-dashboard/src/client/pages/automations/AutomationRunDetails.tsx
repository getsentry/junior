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
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
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
        <RunSection title="Error">
          <p className="m-0 whitespace-pre-wrap font-mono text-xs leading-relaxed text-rose-300">
            {run.error}
          </p>
        </RunSection>
      ) : null}
      <RunSection title="Run">
        <dl className={runFactsClass}>
          <RunFact label="Trigger">
            {run.kind === "scheduled" ? "Schedule" : "Event"}
          </RunFact>
          {run.scheduledFor ? (
            <RunFact label="Scheduled for">
              {formatAutomationRunTime(run.scheduledFor)}
            </RunFact>
          ) : null}
          {run.startedAt ? (
            <RunFact label="Started">
              {formatAutomationRunTime(run.startedAt)}
            </RunFact>
          ) : null}
          <RunFact label="Finished">
            {formatAutomationRunTime(run.executedAt)}
          </RunFact>
          <RunFact label="Duration">
            {formatRuntime(run.durationMs) || "—"}
          </RunFact>
          <RunFact label="Tokens">
            {run.totalTokens === undefined
              ? "—"
              : formatCompactNumber(run.totalTokens)}
          </RunFact>
          <RunFact label="Cost">
            {run.costUsd === undefined
              ? "—"
              : formatCostSummary({ total: run.costUsd })}
          </RunFact>
        </dl>
      </RunSection>
      <RunSection title="Setup">
        <dl className={runFactsClass}>
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
          {run.automationVersion ? (
            <RunFact label="Version">
              <Link
                className={dashboardInlineLinkClass}
                to={`${automationPath(run.automationId, "versions")}?version=${run.automationVersion}`}
              >
                Version {run.automationVersion}
              </Link>
            </RunFact>
          ) : null}
          {run.credentialMode ? (
            <RunFact label="Accounts">
              {run.credentialMode === "creator"
                ? "Creator’s connected accounts"
                : "Junior’s accounts only"}
            </RunFact>
          ) : null}
          <RunFact label="Run ID">
            <span className="font-mono">{run.executionId}</span>
          </RunFact>
        </dl>
      </RunSection>
      {run.conversationId ? null : (
        <p className="m-0 px-1 text-xs text-dashboard-text-muted">
          No Conversation was recorded for this run.
        </p>
      )}
    </div>
  );
}

// Match the Summary tab cards in conversation details.
const runFactsClass = "m-0 grid min-w-0 gap-2 text-xs leading-snug";

function RunSection(props: { children: ReactNode; title: string }) {
  return (
    <section className="grid min-w-0 gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3">
      <h3 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function RunFact(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="shrink-0 text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words text-right tabular-nums text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}
