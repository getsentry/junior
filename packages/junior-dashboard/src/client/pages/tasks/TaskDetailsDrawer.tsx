import type { TaskSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { MapPin } from "lucide-react";
import { Detail, DetailList } from "../../components/DetailList";
import { Drawer } from "../../components/Drawer";
import { conversationPath, formatTime, peoplePath } from "../../format";
import { TranscriptText } from "../../conversations/TranscriptText";

/** Show one task's instruction and metadata in a right-side slide-out. */
export function TaskDetailsDrawer(props: {
  onClose(): void;
  task: TaskSummary | undefined;
}) {
  if (!props.task) return null;

  const { task } = props;
  const createdBy = task.createdByEmail ? (
    <Link
      className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
      to={peoplePath(task.createdByEmail)}
    >
      {task.ownedByViewer ? "you" : task.createdBy}
    </Link>
  ) : task.ownedByViewer ? (
    "you"
  ) : (
    task.createdBy
  );
  const details =
    task.kind === "scheduled"
      ? [
          { label: "Schedule", value: task.schedule },
          {
            label: "Next run",
            value: task.nextRunAt ? formatRunDate(task.nextRunAt) : "None",
          },
        ]
      : [
          { label: "Resource", value: task.resource },
          { label: "Events", value: task.events.join(", ") },
        ];
  const statusLabel =
    task.kind === "scheduled"
      ? task.status
      : task.triggerAvailable
        ? "ready"
        : "unavailable";

  const titleId = "task-details-drawer-title";

  return (
    <Drawer
      dismissLabel="Close task details"
      header={
        <>
          <h2
            className="m-0 font-display text-lg font-medium tracking-normal text-dashboard-text"
            id={titleId}
          >
            {task.title}
          </h2>
          <div className="mt-1 break-words font-mono text-xs leading-snug text-dashboard-text-muted capitalize">
            {task.kind} task · {statusLabel} · {formatDate(task.createdAt)}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={`${task.kind}:${task.id}`}
      titleId={titleId}
    >
      <section className="grid gap-5">
        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
            Instruction
          </div>
          <TranscriptText text={task.instruction} />
        </div>
        <DetailList>
          {details.map((detail) => (
            <Detail key={detail.label} label={detail.label}>
              {detail.value}
            </Detail>
          ))}
          <Detail label="Destination">
            <span className="inline-flex items-center gap-1.5">
              <MapPin
                aria-hidden="true"
                className="text-cyan-300/70"
                size={13}
              />
              {task.destination.label} · {task.destination.visibility}
            </span>
          </Detail>
          <Detail label="Created">
            {createdBy} · {formatDate(task.createdAt)}
          </Detail>
          <Detail label="Executions">
            <TaskExecutionSummary task={task} />
          </Detail>
        </DetailList>
        {task.totalRuns > 0 ? (
          <div className="pt-1">
            <Link
              className="inline-flex items-center justify-center rounded border border-white/12 bg-white/[0.03] px-3 py-2 font-mono text-xs font-medium text-dashboard-text no-underline transition-colors hover:border-white/25 hover:bg-white/[0.06]"
              to={`/tasks/${task.kind}/${encodeURIComponent(task.id)}/executions`}
            >
              View all executions
            </Link>
          </div>
        ) : null}
      </section>
    </Drawer>
  );
}

function TaskExecutionSummary(props: {
  task: Pick<
    TaskSummary,
    | "id"
    | "kind"
    | "lastConversationId"
    | "lastRunAt"
    | "runsLast7Days"
    | "totalRuns"
  >;
}) {
  const { task } = props;
  const executionsPath = `/tasks/${task.kind}/${encodeURIComponent(task.id)}/executions`;
  return (
    <div className="text-sm text-dashboard-text-muted">
      {task.totalRuns > 0 ? (
        <Link
          className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
          to={executionsPath}
        >
          {task.runsLast7Days} runs / 7d
        </Link>
      ) : (
        <span className="text-dashboard-text">
          {task.runsLast7Days} runs / 7d
        </span>
      )}
      <span className="mx-2 opacity-45">·</span>
      <span>
        {task.totalRuns > 0 ? (
          <Link
            className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            to={executionsPath}
          >
            {task.totalRuns} total
          </Link>
        ) : (
          <>{task.totalRuns} total</>
        )}
        {task.lastRunAt ? " · Last execution " : " · Never run"}
        {task.lastRunAt && task.lastConversationId ? (
          <Link
            className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            to={conversationPath(task.lastConversationId)}
          >
            {formatRunDate(task.lastRunAt)}
          </Link>
        ) : task.lastRunAt ? (
          formatRunDate(task.lastRunAt)
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
