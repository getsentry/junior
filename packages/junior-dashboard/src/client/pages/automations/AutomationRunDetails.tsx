import type { AutomationRun } from "@sentry/junior/api/schema";
import { CalendarClock, MessageSquareText, Zap } from "lucide-react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
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
import { ConversationDrawer } from "../../conversations/ConversationDrawer";
import {
  automationPath,
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
} from "../../format";
import { cn, dashboardInlineLinkClass } from "../../styles";
import {
  automationRunStatusTone,
  automationRunTitle,
} from "./automationFormat";

/** Search param that owns the selected run, so a run link can be shared. */
export const AUTOMATION_RUN_PARAM = "run";

/**
 * Read the run that the URL selects, and change it, so any page that lists
 * runs opens details in place. Closing returns focus to the run: the first
 * button or link inside its `data-run-id` element, else a button or link
 * tagged with it, else the list. Up and Down move the selection while
 * details are open.
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
  // A list row holds its controls; a strip bar is the control itself.
  const rowControl = (id: string) => {
    const run = `[data-run-id="${CSS.escape(id)}"]`;
    return (
      listRef.current?.querySelector<HTMLElement>(`${run} :is(button, a)`) ??
      listRef.current?.querySelector<HTMLElement>(`:is(button, a)${run}`)
    );
  };
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
 * Show one run. A run with a Conversation opens in the conversation drawer,
 * with its result, cost, and setup in the header. Other runs show only those.
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
  if (run?.conversationId) {
    const TriggerIcon = run.kind === "scheduled" ? CalendarClock : Zap;
    return (
      <ConversationDrawer
        details={<RunDetails run={run} showAutomation={props.showAutomation} />}
        icon={
          <TriggerIcon
            aria-hidden="true"
            className="shrink-0 text-dashboard-text-muted"
            size={16}
            strokeWidth={2}
          />
        }
        onClose={props.onClose}
        target={{
          conversationId: run.conversationId,
          label: automationRunTitle(run, run.automationTitle),
          status: run.status,
        }}
      />
    );
  }
  const title = run ? automationRunTitle(run, run.automationTitle) : "Run";
  return (
    <DetailsPanel
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
        className="grid min-w-0 gap-4 p-4 [overflow-wrap:anywhere]"
        key={run?.executionId}
      >
        {run ? (
          <>
            <StatusChip
              size="compact"
              tone={automationRunStatusTone(run.status)}
            >
              {run.status}
            </StatusChip>
            <RunDetails run={run} showAutomation={props.showAutomation} />
            <EmptyTelemetry>
              No Conversation was recorded for this run.
            </EmptyTelemetry>
          </>
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

/** When it ran, what it cost, the setup that ran, and why it failed. */
function RunDetails(props: { run: AutomationRun; showAutomation: boolean }) {
  const { run } = props;
  const items: ReactNode[] = [
    formatRuntime(run.durationMs),
    run.totalTokens === undefined
      ? null
      : `${formatCompactNumber(run.totalTokens)} tokens`,
    run.costUsd === undefined
      ? null
      : formatCostSummary({ total: run.costUsd }),
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
    run.credentialMode === "creator"
      ? "Creator’s connected accounts"
      : run.credentialMode === "system"
        ? "Junior’s accounts only"
        : null,
  ].filter(Boolean);
  return (
    <>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-dashboard-text-muted tabular-nums">
        {items.map((item, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden="true" className="opacity-45">
                ·
              </span>
            ) : null}
            {typeof item === "string" ? <span>{item}</span> : item}
          </Fragment>
        ))}
      </div>
      {run.error ? (
        <div
          className={cn(
            "mt-2.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border py-2 pr-1.5 pl-3",
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
      ) : null}
    </>
  );
}
