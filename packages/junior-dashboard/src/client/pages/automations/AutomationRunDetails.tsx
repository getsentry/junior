import type { AutomationRun } from "@sentry/junior/api/schema";
import { MessageSquareText } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";

import { DetailsPanel } from "../../components/DetailsPanel";
import { Fact, FactList, FactSection } from "../../components/FactSection";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { StatusChip } from "../../components/StatusChip";
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
  // Run details are a modal panel over the list, so read Up and Down from
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
      // Run details slide over the list, so the list and filters keep their width.
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
      <div className="p-4 [overflow-wrap:anywhere]" key={run?.executionId}>
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
        <FactSection title="Error">
          <p className="m-0 whitespace-pre-wrap font-mono text-xs leading-relaxed text-rose-300">
            {run.error}
          </p>
        </FactSection>
      ) : null}
      <FactSection title="Run">
        <FactList>
          <Fact label="Trigger">
            {run.kind === "scheduled" ? "Schedule" : "Event"}
          </Fact>
          {run.scheduledFor ? (
            <Fact label="Scheduled for">
              {formatAutomationRunTime(run.scheduledFor)}
            </Fact>
          ) : null}
          {run.startedAt ? (
            <Fact label="Started">
              {formatAutomationRunTime(run.startedAt)}
            </Fact>
          ) : null}
          <Fact label="Finished">
            {formatAutomationRunTime(run.executedAt)}
          </Fact>
          <Fact label="Duration">{formatRuntime(run.durationMs) || "—"}</Fact>
          <Fact label="Tokens">
            {run.totalTokens === undefined
              ? "—"
              : formatCompactNumber(run.totalTokens)}
          </Fact>
          <Fact label="Cost">
            {run.costUsd === undefined
              ? "—"
              : formatCostSummary({ total: run.costUsd })}
          </Fact>
        </FactList>
      </FactSection>
      <FactSection title="Setup">
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
          <Fact label="Run ID">
            <span className="font-mono">{run.executionId}</span>
          </Fact>
        </FactList>
      </FactSection>
      {run.conversationId ? null : (
        <p className="m-0 px-1 text-xs text-dashboard-text-muted">
          No Conversation was recorded for this run.
        </p>
      )}
    </div>
  );
}
