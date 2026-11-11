import type { AutomationRun } from "@sentry/junior/api/schema";
import { CalendarClock, MessageSquareText, Zap } from "lucide-react";
import { Children, Fragment, useEffect, useRef, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

import { CopyButton } from "../../components/CopyButton";
import { DetailsPanel } from "../../components/DetailsPanel";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { StatusChip } from "../../components/StatusChip";
import { buttonVariants } from "../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { conversationPath } from "../../conversations/conversationRoutes";
import { useConversationData } from "../../conversations/queries";
import { TranscriptLoading } from "../../conversations/TranscriptLoading";
import { Transcript } from "../../conversations/TranscriptView";
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

/**
 * Show one run as its Conversation, so you read what Junior did. The result,
 * cost, and setup sit above the transcript; the error leads when it failed.
 */
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
      // The summary sticks above the transcript, so this view owns padding.
      flush
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
      <div className="min-w-0 [overflow-wrap:anywhere]" key={run?.executionId}>
        {run ? (
          <>
            {/* The transcript opens at its latest message, so the result
                and the error stay in view above it. */}
            <div className="sticky top-0 z-10 grid gap-3 border-b border-dashboard-border-subtle bg-dashboard-bg-elevated px-4 py-3 md:px-5">
              <RunSummary run={run} showAutomation={props.showAutomation} />
              {run.error ? <RunError run={run} /> : null}
            </div>
            <div className="px-4 py-4 md:px-5">
              {run.conversationId ? (
                <RunConversation conversationId={run.conversationId} />
              ) : (
                <EmptyTelemetry>
                  No Conversation was recorded for this run.
                </EmptyTelemetry>
              )}
            </div>
          </>
        ) : (
          <div className="p-4 md:px-5">
            {props.loading ? (
              <PageContentSkeleton
                label="Loading run details"
                variant="panel"
              />
            ) : (
              <p className="m-0 text-sm text-dashboard-text-muted">
                This run is not in the loaded runs.
              </p>
            )}
          </div>
        )}
      </div>
    </DetailsPanel>
  );
}

/** Result and cost on one line; the setup that ran on the next. */
function RunSummary(props: { run: AutomationRun; showAutomation: boolean }) {
  const { run } = props;
  const usage = [
    formatRuntime(run.durationMs),
    run.totalTokens === undefined
      ? ""
      : `${formatCompactNumber(run.totalTokens)} tokens`,
    run.costUsd === undefined ? "" : formatCostSummary({ total: run.costUsd }),
  ].filter(Boolean);
  const setup: ReactNode[] = [
    props.showAutomation ? (
      <Link
        className={dashboardInlineLinkClass}
        key="automation"
        to={automationPath(run.automationId)}
      >
        {run.automationTitle}
      </Link>
    ) : null,
    run.automationVersion ? (
      <Link
        className={dashboardInlineLinkClass}
        key="version"
        to={`${automationPath(run.automationId, "versions")}?version=${run.automationVersion}`}
      >
        Version {run.automationVersion}
      </Link>
    ) : null,
    <span className="inline-flex items-center gap-1" key="trigger">
      {run.kind === "scheduled" ? (
        <CalendarClock aria-hidden="true" size={13} />
      ) : (
        <Zap aria-hidden="true" size={13} />
      )}
      {run.kind === "scheduled" ? "Schedule" : "Event"}
    </span>,
    run.credentialMode ? (
      <span key="accounts">
        {run.credentialMode === "creator"
          ? "Creator’s connected accounts"
          : "Junior’s accounts only"}
      </span>
    ) : null,
  ].filter(Boolean);
  return (
    <div className="grid min-w-0 gap-1.5 text-xs">
      <MetaLine>
        <StatusChip size="compact" tone={automationRunStatusTone(run.status)}>
          {run.status}
        </StatusChip>
        <time
          className="text-dashboard-text"
          dateTime={run.executedAt}
          title={formatAutomationRunTime(run.executedAt)}
        >
          {formatRelativeTime(run.executedAt)}
        </time>
        {usage.map((value) => (
          <span className="tabular-nums" key={value}>
            {value}
          </span>
        ))}
      </MetaLine>
      <MetaLine>{setup}</MetaLine>
    </div>
  );
}

/** Items in one muted row, split by dots. */
function MetaLine(props: { children: ReactNode }) {
  const items = Children.toArray(props.children);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-dashboard-text-muted">
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden="true" className="opacity-45">
              ·
            </span>
          ) : null}
          {item}
        </Fragment>
      ))}
    </div>
  );
}

/** Why the run failed or was blocked, in its status color. */
function RunError({ run }: { run: AutomationRun }) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border py-2.5 pr-1.5 pl-3",
        run.status === "blocked"
          ? "border-amber-300/30 bg-amber-300/[0.08]"
          : "border-rose-300/30 bg-rose-300/[0.08]",
      )}
    >
      <p className="thin-scrollbar m-0 max-h-24 self-center overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-dashboard-text">
        {run.error}
      </p>
      <CopyButton getText={() => run.error ?? ""} label="Copy error" />
    </div>
  );
}

/** The run's Conversation, loaded through the ordinary detail API. */
function RunConversation(props: { conversationId: string }) {
  const query = useConversationData(props.conversationId);
  const detail = query.data;
  if (query.isPending) return <TranscriptLoading />;
  if (!detail) {
    return (
      <EmptyTelemetry>
        This Conversation could not be loaded. Use Open conversation to view it
        on its own page.
      </EmptyTelemetry>
    );
  }
  return (
    <Transcript
      hasPreviousPage={query.hasPreviousPage}
      historyError={query.historyError}
      historyVersion={query.historyVersion}
      loadingPreviousPage={query.isLoadingPreviousPage}
      onLoadPreviousPage={query.loadPreviousPage}
      transcript={detail}
    />
  );
}
