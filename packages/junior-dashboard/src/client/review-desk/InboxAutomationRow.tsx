import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import type { AutomationSummary } from "@sentry/junior/api/schema";

import { FormNotice } from "../components/FormNotice";
import { Button } from "../components/ui/button";
import { conversationPath } from "../conversations/conversationRoutes";
import { automationPath, formatRelativeTime } from "../format";
import { DashboardApiError } from "../http";
import { useAutomationLifecycle } from "../pages/automations/useAutomationLifecycle";
import { inboxCardClass, inboxRowButtonClass } from "./InboxBundleView";
import { automationAttentionGroup } from "./inboxModel";

const LAST_RUN_LABELS = {
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
} as const;

function lastRunLine(automation: AutomationSummary): string | undefined {
  if (!automation.lastRunStatus) return undefined;
  const when = automation.lastRunAt
    ? ` ${formatRelativeTime(automation.lastRunAt)}`
    : "";
  return `Last run ${LAST_RUN_LABELS[automation.lastRunStatus]}${when}`;
}

/**
 * An Automation that needs attention, as an inbox row. A click expands it
 * in place with why it is here, its last run, and the actions that the
 * Automation API supports. Only the labelled buttons leave the inbox. A
 * sweep never clears it; it leaves when the Automation is fixed or resumed.
 */
export function InboxAutomationRow(props: {
  active: boolean;
  automation: AutomationSummary;
  expanded: boolean;
  /** Names the row for keys and focus. */
  rowKey: string;
  onActivate(): void;
  onToggle(): void;
}) {
  const { automation } = props;
  const reason = automationAttentionGroup(automation);
  const problems =
    automation.kind === "event" ? automation.trigger.problems : [];
  const detail = automation.statusReason ?? problems[0];
  const lastRun = lastRunLine(automation);
  const resume = useAutomationLifecycle(automation, "resume");
  const regionId = `inbox-automation-${automation.id}`;
  return (
    <li className={inboxCardClass(props.expanded)} onFocus={props.onActivate}>
      <button
        aria-controls={regionId}
        aria-expanded={props.expanded}
        className={inboxRowButtonClass(props.active, props.expanded)}
        data-inbox-bundle={props.rowKey}
        onClick={props.onToggle}
        tabIndex={props.active ? 0 : -1}
        type="button"
      >
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-3.5 justify-self-center text-amber-400 light:text-amber-700"
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-semibold leading-snug text-dashboard-text">
            {automation.title}
          </span>
          <span className="truncate text-xs text-dashboard-text-muted">
            <span className="font-medium text-amber-400 light:text-amber-700">
              {reason}
            </span>
            {detail ? ` · ${detail}` : null}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs text-dashboard-text-faint">
          Automation
        </span>
      </button>
      {props.expanded ? (
        <div
          aria-label={`${automation.title}: attention`}
          className="grid min-w-0 gap-3 px-4 pb-4 font-sans text-sm md:px-6"
          id={regionId}
          role="region"
        >
          <dl className="m-0 grid gap-1.5 border-t border-dashboard-border pt-3">
            <div className="flex min-w-0 gap-2">
              <dt className="w-20 shrink-0 text-dashboard-text-muted">Why</dt>
              <dd className="m-0 min-w-0 text-dashboard-text">
                {detail ? `${reason}: ${detail}` : reason}
              </dd>
            </div>
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
