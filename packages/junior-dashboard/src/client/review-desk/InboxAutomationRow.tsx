import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import type { AutomationListItem } from "@sentry/junior/api/schema";

import { useAutomationExecutionsData } from "../api";
import { FormNotice } from "../components/FormNotice";
import { useConversationDensity } from "../conversations/conversationDensity";
import { Button } from "../components/ui/button";
import { conversationPath } from "../conversations/conversationRoutes";
import { automationPath } from "../format";
import { DashboardApiError } from "../http";
import { useAutomationLifecycle } from "../pages/automations/useAutomationLifecycle";
import { cn } from "../styles";
import {
  INBOX_ROW_DETAIL_CLASS,
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "./inboxRowStyles";
import { automationAttentionGroup } from "./inboxModel";
import type { SnoozeChoice } from "./inboxSnooze";
import { RowDismissButton, RowSnoozeButton } from "./RowSnoozeDismiss";
import { formatRelativeTime } from "../time";

const LAST_RUN_LABELS = {
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
} as const;

function lastRunLine(automation: AutomationListItem): string | undefined {
  // A run with no recorded result still says when it ran.
  if (!automation.lastRunStatus)
    return automation.lastRunAt
      ? `Ran ${formatRelativeTime(automation.lastRunAt)}`
      : undefined;
  const when = automation.lastRunAt
    ? ` ${formatRelativeTime(automation.lastRunAt)}`
    : "";
  return `Last run ${LAST_RUN_LABELS[automation.lastRunStatus]}${when}`;
}

/**
 * Why the Automation is here, as its status: the attention reason, or the
 * last run's own result when that is the reason.
 */
function attentionStatus(automation: AutomationListItem): string {
  const reason = automationAttentionGroup(automation);
  return reason === "Last run failed or blocked"
    ? (lastRunLine(automation) ?? reason)
    : reason;
}

/**
 * An Automation that needs attention, as an inbox row, on the same columns
 * as a Conversation row: its icon in the dot's place, then its title, its
 * status where the summary goes, and "Automation" with the ages. A click
 * expands it in place with its last run, the run's error when the status
 * gives no reason, and the actions that the Automation API supports. Only
 * the labelled buttons leave the inbox. A sweep never clears it; it leaves
 * when the Automation is fixed or resumed, or, in To do, when the viewer
 * dismisses or snoozes this alert.
 */
export function InboxAutomationRow(props: {
  automation: AutomationListItem;
  expanded: boolean;
  /** Names the row for keys and focus. */
  rowKey: string;
  onToggle(): void;
  /** In To do: Snooze and Dismiss, which hide the alert in this browser. */
  putAway?: {
    menuOpen: boolean;
    onDismiss(): void;
    onMenu(open: boolean): void;
    onSnooze(choice: SnoozeChoice): void;
  };
}) {
  const { putAway } = props;
  const { automation } = props;
  const [density] = useConversationDensity();
  const comfortable = density === "comfortable";
  const status = attentionStatus(automation);
  const problems =
    automation.kind === "event" ? automation.trigger.problems : [];
  const detail = automation.statusReason ?? problems[0];
  const lastRun = lastRunLine(automation);
  // The header says why the card is here. With no reason of its own, a
  // failed or blocked run's error says it.
  const why = useLastRunError(automation, props.expanded && !detail);
  const resume = useAutomationLifecycle(automation, "resume");
  const regionId = `inbox-automation-${automation.id}`;
  return (
    <li
      className={inboxCardClass(props.expanded)}
      data-expanded={props.expanded || undefined}
    >
      <button
        aria-controls={regionId}
        aria-expanded={props.expanded}
        className={cn(
          inboxHeadGridClass(),
          "w-full cursor-pointer border-0 bg-transparent pb-3 text-left font-sans text-inherit transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          // Open, the header ends flat on the detail's rule, inside the
          // card. A closed card lights as a whole instead.
          props.expanded && "rounded-b-none hover:bg-dashboard-fill-hover",
        )}
        data-inbox-row={props.rowKey}
        onClick={props.onToggle}
        type="button"
      >
        <TriangleAlert
          aria-hidden="true"
          className="col-start-1 row-start-1 mt-[0.25rem] size-3.5 justify-self-center text-amber-400 light:text-amber-700"
          data-inbox-slot="dot"
        />
        <span
          className="col-start-2 row-start-1 grid min-w-0 gap-1"
          data-inbox-slot="title"
        >
          <span className="truncate font-display text-base font-medium leading-snug text-dashboard-text">
            {automation.title}
          </span>
          {comfortable ? null : (
            <AttentionStatus detail={detail} status={status} />
          )}
        </span>
        {comfortable ? (
          <span
            className="col-span-2 col-start-2 row-start-2 min-w-0"
            data-inbox-slot="summary"
          >
            <AttentionStatus detail={detail} status={status} />
          </span>
        ) : null}
        <span className={INBOX_ROW_META_CLASS} data-inbox-slot="meta">
          Automation
        </span>
      </button>
      {props.expanded ? (
        <div
          aria-label={`${automation.title}: attention`}
          className={cn(INBOX_ROW_DETAIL_CLASS, "gap-3 font-sans text-sm")}
          id={regionId}
          role="region"
        >
          <dl className="m-0 grid gap-1.5">
            {why ? (
              <div className="flex min-w-0 gap-2">
                <dt className="w-20 shrink-0 text-dashboard-text-muted">Why</dt>
                <dd className="m-0 min-w-0 text-dashboard-text">{why}</dd>
              </div>
            ) : null}
            {problems.slice(automation.statusReason ? 0 : 1).map((problem) => (
              <div className="flex min-w-0 gap-2" key={problem}>
                <dt className="w-20 shrink-0 text-dashboard-text-muted">
                  Trigger
                </dt>
                <dd className="m-0 min-w-0 text-dashboard-text">{problem}</dd>
              </div>
            ))}
            <div className="flex min-w-0 gap-2">
              <dt className="w-20 shrink-0 text-dashboard-text-muted">
                Last run
              </dt>
              <dd className="m-0 min-w-0 text-dashboard-text">
                {lastRun ?? "No runs yet"}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {/* The lifecycle API resumes a blocked Automation. Other
                attention reasons need an edit. */}
            {automation.status === "blocked" ? (
              <Button
                disabled={resume.isPending}
                onClick={() => resume.mutate()}
                variant="outline"
              >
                {resume.isPending ? "Resuming…" : "Resume"}
              </Button>
            ) : null}
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
              to={automationPath(automation.id, "edit")}
            >
              Open editor
              <ArrowUpRight aria-hidden="true" size={14} />
            </Link>
            {putAway ? (
              <>
                <RowSnoozeButton
                  onOpenChange={putAway.onMenu}
                  onSnooze={putAway.onSnooze}
                  open={putAway.menuOpen}
                />
                <RowDismissButton onClick={putAway.onDismiss} />
              </>
            ) : null}
          </div>
          {resume.error ? (
            <FormNotice tone="error" title="Could not resume this automation.">
              {resume.error instanceof DashboardApiError
                ? (resume.error.apiError ?? "Try again.")
                : resume.error.message}
            </FormNotice>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The error of the newest run when it failed or was blocked. */
function useLastRunError(
  automation: AutomationListItem,
  enabled: boolean,
): string | undefined {
  const failed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  const latest = useAutomationExecutionsData(enabled && failed, automation.id)
    .data?.executions[0];
  return enabled && latest && latest.status !== "completed"
    ? latest.error
    : undefined;
}

function AttentionStatus(props: { detail?: string; status: string }) {
  return (
    <span className="line-clamp-3 min-w-0 text-xs leading-snug text-dashboard-text-muted">
      <span className="font-medium text-amber-400 light:text-amber-700">
        {props.status}
      </span>
      {props.detail ? ` · ${props.detail}` : null}
    </span>
  );
}
