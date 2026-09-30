import { AutomationLifecycle } from "./AutomationLifecycle";
import { automationOutcomeLabel } from "./automationOutcomes";
import {
  automationEventConditions,
  automationEventNames,
  automationScheduleLabel,
} from "./AutomationRow";
import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Link, useLocation } from "react-router";
import { Detail, DetailList } from "../../components/DetailList";
import { Drawer } from "../../components/Drawer";
import {
  timeRangeLabel,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { conversationPath } from "../../conversations/conversationRoutes";
import { formatTime, peoplePath } from "../../format";
import { TranscriptText } from "../../conversations/TranscriptText";

/** Show one automation's instruction and metadata in a right-side slide-out. */
export function AutomationDetailsDrawer(props: {
  onClose(): void;
  range: TimeRangeDays;
  automation: AutomationSummary | undefined;
}) {
  const location = useLocation();
  if (!props.automation) return null;

  const { automation } = props;
  const createdBy = automation.createdByEmail ? (
    <Link
      className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
      to={peoplePath(automation.createdByEmail)}
    >
      {automation.ownedByViewer ? "you" : automation.createdBy}
    </Link>
  ) : automation.ownedByViewer ? (
    "you"
  ) : (
    automation.createdBy
  );
  const details =
    automation.kind === "scheduled"
      ? [
          { label: "Schedule", value: automationScheduleLabel(automation) },
          {
            label: "Next run",
            value:
              automation.status === "active" && automation.nextRunAt
                ? formatRunDate(automation.nextRunAt)
                : "None",
          },
        ]
      : [
          { label: "Watching", value: automation.resource },
          { label: "Events", value: automationEventNames(automation) },
          ...(automationEventConditions(automation)
            ? [
                {
                  label: "Conditions",
                  value: automationEventConditions(automation),
                },
              ]
            : []),
        ];
  const titleId = "automation-details-drawer-title";

  return (
    <Drawer
      closeLabel="Close automation details"
      dismissLabel="Dismiss automation details"
      header={
        <>
          <h2
            className="m-0 font-display text-lg font-medium tracking-normal text-dashboard-text"
            id={titleId}
          >
            {automation.title}
          </h2>
          <div className="mt-1 break-words text-sm text-dashboard-text-muted">
            Created by {createdBy} · {automation.destination.label}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={`${automation.kind}:${automation.id}`}
      titleId={titleId}
    >
      <section className="grid gap-5">
        <div>
          <h3 className="mt-0 mb-2 text-sm font-medium text-dashboard-text-muted">
            What to do
          </h3>
          <TranscriptText text={automation.instruction} />
        </div>
        <AutomationLifecycle
          key={`${automation.kind}:${automation.id}`}
          automation={automation}
          editPath={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/edit${location.search}`}
        />
        <DetailList>
          {details.map((detail) => (
            <Detail key={detail.label} label={detail.label}>
              {detail.value}
            </Detail>
          ))}
          <Detail label="On success">
            {automation.outcomes.length === 0 ? (
              "No message on success"
            ) : (
              <ol className="m-0 pl-4">
                {automation.outcomes.map((outcome, index) => (
                  <li key={index}>
                    {automationOutcomeLabel(outcome, automation.destination)}
                  </li>
                ))}
              </ol>
            )}
          </Detail>
        </DetailList>
        {automation.totalRuns > 0 &&
        automation.lastRunStatus !== "failed" &&
        automation.lastRunStatus !== "blocked" ? (
          <Link
            className="w-fit py-2 text-sm text-dashboard-text underline underline-offset-2"
            to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
          >
            View all runs
          </Link>
        ) : null}
        <details>
          <summary className="cursor-pointer py-3 text-sm text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline focus-visible:outline-dashboard-focus">
            More details
          </summary>
          <DetailList>
            <Detail label="Connected accounts">
              {automation.credentialMode === "creator" ? (
                <>
                  Uses accounts connected by{" "}
                  {automation.ownedByViewer ? "you" : automation.createdBy}.
                </>
              ) : (
                "Junior’s accounts only"
              )}
            </Detail>
            <Detail label="Created">{formatDate(automation.createdAt)}</Detail>
            <Detail label="Run history">
              <AutomationExecutionSummary
                range={props.range}
                automation={automation}
              />
            </Detail>
          </DetailList>
        </details>
      </section>
    </Drawer>
  );
}

function AutomationExecutionSummary(props: {
  range: TimeRangeDays;
  automation: Pick<
    AutomationSummary,
    "id" | "kind" | "lastConversationId" | "lastRunAt" | "runs" | "totalRuns"
  >;
}) {
  const { range, automation } = props;
  const runCount = automation.runs[range];
  const rangeLabel = timeRangeLabel(range);
  const executionsPath = `/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`;
  return (
    <div className="text-sm text-dashboard-text-muted">
      {automation.totalRuns > 0 ? (
        <Link
          className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
          to={executionsPath}
        >
          {runCount} runs / {rangeLabel}
        </Link>
      ) : (
        <span className="text-dashboard-text">
          {runCount} runs / {rangeLabel}
        </span>
      )}
      <span className="mx-2 opacity-45">·</span>
      <span>
        {automation.totalRuns > 0 ? (
          <Link
            className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            to={executionsPath}
          >
            {automation.totalRuns} total
          </Link>
        ) : (
          <>{automation.totalRuns} total</>
        )}
        {automation.lastRunAt ? " · Last run " : " · Never run"}
        {automation.lastRunAt && automation.lastConversationId ? (
          <Link
            className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            to={conversationPath(automation.lastConversationId)}
          >
            {formatRunDate(automation.lastRunAt)}
          </Link>
        ) : automation.lastRunAt ? (
          formatRunDate(automation.lastRunAt)
        ) : null}
      </span>
    </div>
  );
}

function formatDate(value: string): string {
  return formatTime(value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRunDate(value: string): string {
  return formatTime(value, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  });
}
