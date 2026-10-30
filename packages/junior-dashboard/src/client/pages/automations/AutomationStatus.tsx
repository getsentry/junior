import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion";
import { FormNotice } from "../../components/FormNotice";
import { StatusChip } from "../../components/StatusChip";
import { conversationPath } from "../../conversations/conversationRoutes";
import { formatRelativeTime } from "../../format";
import { dashboardInlineLinkClass } from "../../styles";
import { formatAutomationRunTime } from "./automationFormat";

/** Separate the Automation's lifecycle, next trigger, and last execution result. */
export function AutomationStatus({
  automation,
}: {
  automation: AutomationSummary;
}) {
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  const completed = automation.status === "completed";
  const triggerProblems =
    automation.kind === "event" ? automation.trigger.problems : [];
  const unavailable = triggerProblems.length > 0;
  const failed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  const needsFix = blocked || (paused && Boolean(automation.statusReason));
  const showAttention = needsFix || unavailable || failed;
  const lastResult = automation.lastRunStatus
    ? `Last run ${automation.lastRunStatus}`
    : "Last run";
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <div aria-label="Automation state" aria-live="polite" role="status">
          <StatusChip
            tone={
              paused || completed
                ? "neutral"
                : blocked || unavailable
                  ? "warning"
                  : "success"
            }
          >
            {automation.status === "active" && unavailable
              ? "Trigger unavailable"
              : automation.status}
          </StatusChip>
        </div>
        <AutomationNextTrigger automation={automation} />
        <p className="m-0 text-xs text-dashboard-text-muted">
          {automation.lastRunAt ? (
            <>
              {lastResult} ·{" "}
              <time
                dateTime={automation.lastRunAt}
                title={formatAutomationRunTime(automation.lastRunAt)}
              >
                {formatRelativeTime(automation.lastRunAt)}
              </time>
            </>
          ) : automation.lastRunStatus ? (
            `${lastResult} · time not recorded`
          ) : automation.totalRuns === 0 ? (
            "No runs yet"
          ) : (
            "Last run time not recorded"
          )}
        </p>
      </div>
      {showAttention ? (
        <FormNotice
          title={
            needsFix
              ? "Fix this before resuming"
              : unavailable
                ? "Trigger unavailable"
                : "Check the last run"
          }
        >
          {needsFix ? (
            <p className="m-0 break-words">
              {automation.statusReason ??
                "Check the last run to see what needs fixing."}{" "}
              {!automation.ownedByViewer
                ? `Ask ${automation.createdBy} to resume after this is fixed.`
                : null}
            </p>
          ) : null}
          {unavailable ? (
            <>
              <ul className="my-1 list-disc pl-5">
                {triggerProblems.map((problem) => (
                  <li className="break-words" key={problem}>
                    {problem}
                  </li>
                ))}
              </ul>
              <p className="m-0">
                Edit the trigger, or enable its plugin again.
              </p>
            </>
          ) : null}
          {failed && !needsFix && !unavailable ? (
            <p className="m-0">
              {automation.status === "active"
                ? "Future runs are still on."
                : paused
                  ? "Review the last result before resuming."
                  : "Review the last result for details."}
            </p>
          ) : null}
          {automation.lastConversationId ? (
            <Link
              className={`${dashboardInlineLinkClass} mt-2 inline-block`}
              to={conversationPath(automation.lastConversationId)}
            >
              Open last run
            </Link>
          ) : automation.totalRuns > 0 ? (
            <Link
              className={`${dashboardInlineLinkClass} mt-2 inline-block`}
              to={`/automations/${encodeURIComponent(automation.id)}/executions`}
            >
              View run history
            </Link>
          ) : null}
        </FormNotice>
      ) : null}
    </div>
  );
}

function AutomationNextTrigger({
  automation,
}: {
  automation: AutomationSummary;
}) {
  let description: string;
  if (automation.status === "completed") description = "No future runs";
  else if (automation.status === "paused")
    description = "No new runs while paused";
  else if (automation.status === "blocked")
    description = "New runs are blocked until this is fixed";
  else if (automation.kind === "event")
    description =
      automation.trigger.problems.length === 0
        ? "Waiting for a matching event"
        : "Waiting for a trigger fix";
  else if (automation.nextRunAt) {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const scheduleTime = formatAutomationRunTime(
      automation.nextRunAt,
      automation.timezone,
    );
    const localTime = formatAutomationRunTime(
      automation.nextRunAt,
      browserZone,
    );
    const timingLabel =
      Date.parse(automation.nextRunAt) <= Date.now()
        ? "Run was due"
        : "Next run";
    return (
      <Accordion>
        <AccordionItem value="next-run">
          <AccordionTrigger className="py-1 text-sm font-normal">
            <span>
              {timingLabel}{" "}
              <time dateTime={automation.nextRunAt}>
                {formatRelativeTime(automation.nextRunAt)}
              </time>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <dl className="m-0 mt-1 grid gap-1 border-l border-dashboard-border pl-3 text-xs leading-relaxed">
              <dt className="text-dashboard-text-muted">Schedule time</dt>
              <dd className="m-0">
                <time dateTime={automation.nextRunAt}>{scheduleTime}</time>
              </dd>
              {localTime !== scheduleTime ? (
                <>
                  <dt className="mt-1 text-dashboard-text-muted">Your time</dt>
                  <dd className="m-0">
                    <time dateTime={automation.nextRunAt}>{localTime}</time>
                  </dd>
                </>
              ) : null}
            </dl>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  } else description = "Next run not scheduled";
  return <p className="m-0 text-sm text-dashboard-text">{description}</p>;
}
