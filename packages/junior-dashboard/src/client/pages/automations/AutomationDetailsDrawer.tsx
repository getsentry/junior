import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { MapPin } from "lucide-react";
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
          { label: "Schedule", value: automation.schedule },
          {
            label: "Next run",
            value: automation.nextRunAt
              ? formatRunDate(automation.nextRunAt)
              : "None",
          },
        ]
      : [
          { label: "Resource", value: automation.resource },
          { label: "Events", value: automation.events.join(", ") },
        ];
  const statusLabel =
    automation.kind === "scheduled"
      ? automation.status
      : automation.triggerAvailable
        ? "ready"
        : "unavailable";

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
          <div className="mt-1 break-words font-mono text-xs leading-snug text-dashboard-text-muted capitalize">
            {automation.kind} automation · {statusLabel} ·{" "}
            {formatDate(automation.createdAt)}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={`${automation.kind}:${automation.id}`}
      titleId={titleId}
    >
      <section className="grid gap-5">
        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
            Instruction
          </div>
          <TranscriptText text={automation.instruction} />
        </div>
        <DetailList>
          {details.map((detail) => (
            <Detail key={detail.label} label={detail.label}>
              {detail.value}
            </Detail>
          ))}
          <Detail label="Outcomes">
            {automation.outcomes.length === 0
              ? "None"
              : `${automation.outcomes.length} message${automation.outcomes.length === 1 ? "" : "s"}`}
          </Detail>
          <Detail label="Destination">
            <span className="inline-flex items-center gap-1.5">
              <MapPin
                aria-hidden="true"
                className="text-cyan-300/70"
                size={13}
              />
              {automation.destination.label} ·{" "}
              {automation.destination.visibility}
            </span>
          </Detail>
          <Detail label="Created">
            {createdBy} · {formatDate(automation.createdAt)}
          </Detail>
          <Detail label="Executions">
            <AutomationExecutionSummary
              range={props.range}
              automation={automation}
            />
          </Detail>
        </DetailList>
        {automation.totalRuns > 0 ? (
          <div className="pt-1">
            <Link
              className="inline-flex items-center justify-center rounded border border-white/12 bg-white/[0.03] px-3 py-2 font-mono text-xs font-medium text-dashboard-text no-underline transition-colors hover:border-white/25 hover:bg-white/[0.06]"
              to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
            >
              View all executions
            </Link>
          </div>
        ) : null}
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
        {automation.lastRunAt ? " · Last execution " : " · Never run"}
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
